"""MediaPipe palm detection + 21-point hand landmarks (OpenCV Zoo 2023feb ONNX),
plus the few poses LESLIE reacts to. Decoding follows opencv_zoo's mp_palmdet.py
and mp_handpose.py."""

import cv2
import numpy as np

from .models import session

# Landmark indices: wrist, then (mcp, pip, dip, tip) per finger.
WRIST = 0
THUMB = (1, 2, 3, 4)
FINGERS = {"index": (5, 6, 7, 8), "middle": (9, 10, 11, 12), "ring": (13, 14, 15, 16), "pinky": (17, 18, 19, 20)}


def palm_anchors():
    """SSD anchor centres for the 192x192 palm model: 24x24 cells x2, then 12x12 cells x6."""
    out = []
    for grid, per_cell in ((24, 2), (12, 6)):
        for y in range(grid):
            for x in range(grid):
                out.extend([[(x + 0.5) / grid, (y + 0.5) / grid]] * per_cell)
    return np.array(out, dtype=np.float32)


class PalmDetector:
    SIZE = 192

    def __init__(self, path, score=0.5, nms=0.3):
        self.sess = session(path)
        self.input = self.sess.get_inputs()[0].name
        self.score = score
        self.nms = nms
        self.anchors = palm_anchors()

    def detect(self, img):
        """Palms as (N, 19): box x1 y1 x2 y2, 7 landmarks (x, y), score."""
        h, w = img.shape[:2]
        ratio = self.SIZE / max(h, w)
        rh, rw = int(h * ratio), int(w * ratio)
        resized = cv2.resize(img, (rw, rh))
        left, top = (self.SIZE - rw) // 2, (self.SIZE - rh) // 2
        canvas = cv2.copyMakeBorder(resized, top, self.SIZE - rh - top, left, self.SIZE - rw - left,
                                    cv2.BORDER_CONSTANT, value=(0, 0, 0))
        blob = cv2.cvtColor(canvas, cv2.COLOR_BGR2RGB).astype(np.float32)[None] / 255.0
        deltas, scores = self.sess.run(None, {self.input: blob})
        scores = 1 / (1 + np.exp(-scores[0, :, 0].astype(np.float64)))
        deltas = deltas[0]
        scale = max(h, w)
        pad = np.array([left, top], dtype=np.float32) / ratio

        cxy = deltas[:, :2] / self.SIZE
        wh = deltas[:, 2:4] / self.SIZE
        boxes = np.concatenate([(cxy - wh / 2 + self.anchors) * scale, (cxy + wh / 2 + self.anchors) * scale], axis=1)
        boxes -= np.tile(pad, 2)
        keep = cv2.dnn.NMSBoxes(boxes.tolist(), scores.tolist(), self.score, self.nms)
        if len(keep) == 0:
            return np.empty((0, 19), np.float32)
        keep = np.array(keep).reshape(-1)
        marks = deltas[keep, 4:].reshape(-1, 7, 2) / self.SIZE + self.anchors[keep][:, None, :]
        marks = marks * scale - pad
        return np.c_[boxes[keep], marks.reshape(-1, 14), scores[keep]].astype(np.float32)


class HandLandmarker:
    SIZE = np.array([224, 224])

    def __init__(self, path, conf=0.8):
        self.sess = session(path)
        self.input = self.sess.get_inputs()[0].name
        self.conf = conf

    @staticmethod
    def _crop(image, box, rotation):
        shift, enlarge = ((0, 0), 4) if rotation else ((0, -0.4), 3)
        wh = box[1] - box[0]
        box = box + np.array(shift) * wh
        centre = box.sum(axis=0) / 2
        half = (box[1] - box[0]) * enlarge / 2
        box = np.array([centre - half, centre + half]).astype(np.int32)
        box[:, 0] = np.clip(box[:, 0], 0, image.shape[1])
        box[:, 1] = np.clip(box[:, 1], 0, image.shape[0])
        crop = image[box[0][1]:box[1][1], box[0][0]:box[1][0]]
        side = int(np.linalg.norm(crop.shape[:2]) if rotation else max(crop.shape[:2]))
        pad_h, pad_w = side - crop.shape[0], side - crop.shape[1]
        left, top = pad_w // 2, pad_h // 2
        crop = cv2.copyMakeBorder(crop, top, pad_h - top, left, pad_w - left, cv2.BORDER_CONSTANT, value=(0, 0, 0))
        return crop, box, box[0] - [left, top]

    def landmarks(self, image, palm):
        """(21, 2) landmarks in image pixels, or None below the confidence threshold."""
        crop, crop_box, bias = self._crop(image, palm[0:4].reshape(2, 2), rotation=True)
        if crop.size == 0:
            return None
        crop = cv2.cvtColor(crop, cv2.COLOR_BGR2RGB)
        marks = palm[4:18].reshape(7, 2) - bias
        base, middle = marks[0], marks[2]
        radians = np.pi / 2 - np.arctan2(-(middle[1] - base[1]), middle[0] - base[0])
        radians -= 2 * np.pi * np.floor((radians + np.pi) / (2 * np.pi))
        angle = np.rad2deg(radians)
        box = crop_box - bias
        matrix = cv2.getRotationMatrix2D(box.sum(axis=0) / 2, angle, 1.0)
        rotated = cv2.warpAffine(crop, matrix, (crop.shape[1], crop.shape[0]))
        rotated_marks = np.c_[marks, np.ones(len(marks))] @ matrix.T
        rotated_box = np.array([rotated_marks.min(axis=0), rotated_marks.max(axis=0)])
        hand, rotated_box, _ = self._crop(rotated, rotated_box, rotation=False)
        if hand.size == 0:
            return None
        blob = cv2.resize(hand, tuple(self.SIZE), interpolation=cv2.INTER_AREA).astype(np.float32)[None] / 255.0

        points, conf, _handedness, _world = self.sess.run(None, {self.input: blob})
        if conf[0][0] < self.conf:
            return None
        points = points[0].reshape(-1, 3)[:, :2]
        scale = max((rotated_box[1] - rotated_box[0]) / self.SIZE)
        points = (points - self.SIZE / 2) * scale
        points = points @ cv2.getRotationMatrix2D((0, 0), angle, 1.0)[:, :2]
        rot, trans = matrix[:, :2].T, matrix[:, 2]
        inverse = np.c_[rot, -rot @ trans]
        centre = inverse @ np.append(rotated_box.sum(axis=0) / 2, 1)
        return points + centre + bias


def _extended(pts, finger):
    mcp, pip, dip, tip = (pts[i] for i in finger)
    a, b = pip - mcp, tip - pip
    straight = float(a @ b) / max(np.linalg.norm(a) * np.linalg.norm(b), 1e-6)
    return straight > 0.6 and np.linalg.norm(tip - pts[WRIST]) > np.linalg.norm(pip - pts[WRIST]) * 1.1


def _raised(pts, faces):
    """Hand upright (wrist to middle knuckle within ~30 degrees of straight up) and, when a face
    is in view, fingertips reaching above the chin: a hand on the desk or mid-wave doesn't count."""
    axis = pts[9] - pts[WRIST]
    if -axis[1] < np.linalg.norm(axis) * 0.87:
        return False
    top = pts[[8, 12, 16, 20], 1].min()
    return not len(faces) or any(top < y + h for _x, y, _w, h in faces)


def classify(pts, faces=()):
    """'palm', 'point', 'shush' or None for one hand's (21, 2) landmarks."""
    up = {name: _extended(pts, f) for name, f in FINGERS.items()}
    if all(up.values()):
        return "palm" if _raised(pts, faces) else None
    if up["index"] and not (up["middle"] or up["ring"] or up["pinky"]):
        tip = pts[8]
        for box in faces:
            x, y, w, h = box
            # Fingertip over the lower half of the face, finger upright: a "shh".
            upright = pts[8][1] < pts[5][1] - 0.5 * np.linalg.norm(pts[8] - pts[5])
            if upright and x + 0.15 * w <= tip[0] <= x + 0.85 * w and y + 0.45 * h <= tip[1] <= y + 1.15 * h:
                return "shush"
        return "point"
    return None


def point_crop(frame, pts, scale=3.0):
    """Square region just beyond an extended index fingertip, where the thing being pointed at is."""
    tip, knuckle = pts[8], pts[5]
    direction = tip - knuckle
    length = max(np.linalg.norm(direction), 1.0)
    hand_size = np.linalg.norm(pts[WRIST] - pts[9])
    side = max(hand_size * scale, 160)
    centre = tip + direction / length * side * 0.35
    h, w = frame.shape[:2]
    x1 = int(np.clip(centre[0] - side / 2, 0, w - 1))
    y1 = int(np.clip(centre[1] - side / 2, 0, h - 1))
    x2 = int(np.clip(centre[0] + side / 2, x1 + 1, w))
    y2 = int(np.clip(centre[1] + side / 2, y1 + 1, h))
    return frame[y1:y2, x1:x2]
