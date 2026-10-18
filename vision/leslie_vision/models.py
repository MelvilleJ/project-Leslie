"""SCRFD face detection and ArcFace embeddings (InsightFace buffalo_l) on onnxruntime."""

import logging

import cv2
import numpy as np
import onnxruntime as ort

log = logging.getLogger("leslie-vision")

# Where ArcFace expects the eyes, nose and mouth corners in a 112x112 crop.
ARCFACE_DST = np.array(
    [[38.2946, 51.6963], [73.5318, 51.5014], [56.0252, 71.7366], [41.5493, 92.3655], [70.7299, 92.2041]],
    dtype=np.float32,
)


def session(path):
    cuda = "CUDAExecutionProvider" in ort.get_available_providers()
    if cuda and hasattr(ort, "preload_dlls"):
        # Loads the CUDA/cuDNN libraries shipped as pip wheels instead of the system CUDA.
        try:
            ort.preload_dlls()
        except Exception as err:  # noqa: BLE001
            log.warning("could not preload CUDA libraries: %s", err)
    providers = ["CUDAExecutionProvider", "CPUExecutionProvider"] if cuda else ["CPUExecutionProvider"]
    sess = ort.InferenceSession(str(path), providers=providers)
    if cuda and "CUDAExecutionProvider" not in sess.get_providers():
        log.warning("%s is running on the CPU; CUDA is unavailable", path)
    return sess


def nms(dets, threshold):
    x1, y1, x2, y2, scores = dets.T
    areas = (x2 - x1 + 1) * (y2 - y1 + 1)
    order = scores.argsort()[::-1]
    keep = []
    while order.size:
        i = order[0]
        keep.append(i)
        xx1 = np.maximum(x1[i], x1[order[1:]])
        yy1 = np.maximum(y1[i], y1[order[1:]])
        xx2 = np.minimum(x2[i], x2[order[1:]])
        yy2 = np.minimum(y2[i], y2[order[1:]])
        inter = np.maximum(0.0, xx2 - xx1 + 1) * np.maximum(0.0, yy2 - yy1 + 1)
        iou = inter / (areas[i] + areas[order[1:]] - inter)
        order = order[np.where(iou <= threshold)[0] + 1]
    return keep


class Detector:
    STRIDES = (8, 16, 32)
    ANCHORS = 2

    def __init__(self, path, size=640, score=0.5, iou=0.4):
        self.sess = session(path)
        self.input = self.sess.get_inputs()[0].name
        self.size = size
        self.score = score
        self.iou = iou
        self.centers = {}

    def _anchor_centers(self, h, w, stride):
        key = (h, w, stride)
        if key not in self.centers:
            grid = np.stack(np.mgrid[:h, :w][::-1], axis=-1).astype(np.float32)
            grid = (grid * stride).reshape(-1, 2)
            self.centers[key] = np.repeat(grid, self.ANCHORS, axis=0)
        return self.centers[key]

    def detect(self, img):
        """Faces as (N, 5) [x1, y1, x2, y2, score] and (N, 5, 2) landmarks, in image pixels."""
        h, w = img.shape[:2]
        scale = self.size / max(h, w)
        resized = cv2.resize(img, (int(w * scale), int(h * scale)))
        canvas = np.zeros((self.size, self.size, 3), dtype=np.uint8)
        canvas[: resized.shape[0], : resized.shape[1]] = resized
        blob = cv2.dnn.blobFromImage(canvas, 1.0 / 128, (self.size, self.size), (127.5, 127.5, 127.5), swapRB=True)
        outs = self.sess.run(None, {self.input: blob})
        if outs[0].ndim == 3:
            outs = [o[0] for o in outs]

        boxes, kpss, scores = [], [], []
        n = len(self.STRIDES)
        for i, stride in enumerate(self.STRIDES):
            score = outs[i].reshape(-1)
            bbox = outs[i + n] * stride
            kps = outs[i + 2 * n] * stride
            centers = self._anchor_centers(self.size // stride, self.size // stride, stride)
            keep = np.where(score >= self.score)[0]
            if not keep.size:
                continue
            c = centers[keep]
            b = bbox[keep]
            boxes.append(np.stack([c[:, 0] - b[:, 0], c[:, 1] - b[:, 1], c[:, 0] + b[:, 2], c[:, 1] + b[:, 3]], axis=-1))
            k = kps[keep].reshape(-1, 5, 2)
            kpss.append(k + c[:, None, :])
            scores.append(score[keep])
        if not boxes:
            return np.zeros((0, 5), np.float32), np.zeros((0, 5, 2), np.float32)

        dets = np.hstack([np.vstack(boxes), np.concatenate(scores)[:, None]]).astype(np.float32)
        kpss = np.vstack(kpss)
        keep = nms(dets, self.iou)
        dets, kpss = dets[keep], kpss[keep]
        dets[:, :4] /= scale
        kpss /= scale
        return dets, kpss


class Embedder:
    def __init__(self, path):
        self.sess = session(path)
        self.input = self.sess.get_inputs()[0].name

    def embed(self, img, landmarks):
        matrix, _ = cv2.estimateAffinePartial2D(landmarks.astype(np.float32), ARCFACE_DST, method=cv2.LMEDS)
        crop = cv2.warpAffine(img, matrix, (112, 112), borderValue=0.0)
        blob = cv2.dnn.blobFromImage(crop, 1.0 / 127.5, (112, 112), (127.5, 127.5, 127.5), swapRB=True)
        vec = self.sess.run(None, {self.input: blob})[0][0]
        return vec / max(np.linalg.norm(vec), 1e-12)
