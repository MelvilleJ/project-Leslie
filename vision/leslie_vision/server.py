"""LESLIE vision sidecar: watches the camera and streams who is in front of it.

Reports raw observations only; LESLIE decides when someone has arrived or left.
Frames never touch the disk, and the camera is released whenever LESLIE is not
listening, so the camera light is only on while it is actually in use.
"""

import argparse
import json
import logging
import os
import queue
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

import cv2
import numpy as np

import base64
import collections

from .exposure import Exposure
from .gallery import Gallery
from .hands import HandLandmarker, PalmDetector, classify, point_crop
from .models import Detector, Embedder

log = logging.getLogger("leslie-vision")

IDLE_RELEASE_S = 10
BUSY_INTERVAL_S = 0.5
QUIET_INTERVAL_S = 1.0
FAST_INTERVAL_S = 0.15
MIN_ENROLL_DET = 0.7
# Gestures need every frame, but only while someone is at the desk. (A 1/30 s
# spacing would skip any frame that arrives a hair early, halving the rate.)
HAND_ACTIVE_S = 0.0
HAND_IDLE_S = 0.5
HAND_ACTIVE_FOR_S = 10
POINT_MEMORY_S = 8.0


def list_devices():
    by_id = Path("/dev/v4l/by-id")
    devices = []
    for link in sorted(by_id.glob("*-video-index0")) if by_id.exists() else []:
        node = os.path.realpath(link)
        name_file = Path("/sys/class/video4linux") / os.path.basename(node) / "name"
        name = name_file.read_text().strip() if name_file.exists() else link.name
        devices.append({"path": str(link), "node": node, "name": name})
    return devices


class Vision:
    def __init__(self, detector, embedder, gallery, palms=None, landmarker=None):
        self.detector = detector
        self.embedder = embedder
        self.gallery = gallery
        self.palms = palms
        self.landmarker = landmarker
        self.lock = threading.Lock()
        self.want = {"enabled": False, "device": "", "threshold": 0.4, "hands": True, "width": 1920, "height": 1080}
        self.cap = None
        self.opened_device = None
        self.error = None
        self.subscribers = set()
        self.last_wanted = 0.0
        self.fast_until = 0.0
        self.last_faces_at = 0.0
        self.last_frame = None
        self.last_frame_at = 0.0
        self.last_faces = []
        self.enrolling = None
        self.hands_seen = False
        self.last_point = None
        self.hand_times = collections.deque(maxlen=60)
        self.exposure = None
        self.next_exposure_at = 0.0

    # --- subscribers -------------------------------------------------------
    def subscribe(self):
        q = queue.Queue(maxsize=50)
        with self.lock:
            self.subscribers.add(q)
        return q

    def unsubscribe(self, q):
        with self.lock:
            self.subscribers.discard(q)

    def publish(self, event):
        with self.lock:
            subs = list(self.subscribers)
        for q in subs:
            try:
                q.put_nowait(event)
            except queue.Full:
                pass

    def status(self):
        return {
            "type": "status",
            "active": self.cap is not None,
            "device": self.opened_device,
            "error": self.error,
        }

    # --- camera ------------------------------------------------------------
    def configure(self, body):
        with self.lock:
            for key in ("enabled", "device", "threshold", "hands"):
                if key in body:
                    self.want[key] = body[key]
            self.want["enabled"] = bool(self.want["enabled"])
            self.want["hands"] = bool(self.want["hands"])
            self.want["threshold"] = float(self.want["threshold"])

    def needed(self):
        now = time.monotonic()
        with self.lock:
            busy = bool(self.subscribers) or self.enrolling is not None or now < self.fast_until
            if busy:
                self.last_wanted = now
            return self.want["enabled"] and (busy or now - self.last_wanted < IDLE_RELEASE_S)

    def device(self):
        wanted = self.want["device"]
        if wanted:
            return wanted
        devices = list_devices()
        return devices[0]["path"] if devices else "/dev/video0"

    def open(self):
        path = self.device()
        cap = cv2.VideoCapture(path, cv2.CAP_V4L2)
        if not cap.isOpened():
            self.error = f"could not open {path}"
            return False
        cap.set(cv2.CAP_PROP_FOURCC, cv2.VideoWriter_fourcc(*"MJPG"))
        cap.set(cv2.CAP_PROP_FRAME_WIDTH, self.want["width"])
        cap.set(cv2.CAP_PROP_FRAME_HEIGHT, self.want["height"])
        cap.set(cv2.CAP_PROP_FPS, 30)
        # Two buffers let the camera fill one while the other is being analysed;
        # with one, capture waits on processing and the rate roughly halves.
        cap.set(cv2.CAP_PROP_BUFFERSIZE, 2)
        self.exposure = Exposure(path)
        self.exposure.start()
        self.cap, self.opened_device, self.error = cap, path, None
        log.info("camera open: %s", path)
        self.publish(self.status())
        return True

    def close(self):
        if self.cap is not None:
            self.cap.release()
            if self.exposure:
                self.exposure.stop()
            log.info("camera released")
        self.cap, self.opened_device = None, None
        self.last_frame = None
        self.publish(self.status())

    # --- processing --------------------------------------------------------
    def interval(self):
        now = time.monotonic()
        if self.enrolling is not None or now < self.fast_until:
            return FAST_INTERVAL_S
        return BUSY_INTERVAL_S if now - self.last_faces_at < 5 else QUIET_INTERVAL_S

    def analyse(self, frame):
        dets, kpss = self.detector.detect(frame)
        faces = []
        for det, kps in zip(dets, kpss):
            emb = self.embedder.embed(frame, kps)
            person, sim = self.gallery.match(emb, self.want["threshold"])
            x1, y1, x2, y2, score = (float(v) for v in det)
            faces.append({
                "id": person,
                "similarity": round(sim, 3),
                "det": round(score, 3),
                "box": [round(x1), round(y1), round(x2 - x1), round(y2 - y1)],
                "_emb": emb,
            })
        return faces

    def collect_enrollment(self, faces):
        job = self.enrolling
        if job is None or len(faces) != 1 or faces[0]["det"] < MIN_ENROLL_DET:
            return
        job["samples"].append(faces[0]["_emb"])
        if len(job["samples"]) >= job["wanted"]:
            job["done"].set()

    def hands_on(self):
        return self.want["hands"] and self.palms is not None and self.landmarker is not None

    def hand_interval(self, now):
        return HAND_ACTIVE_S if now - self.last_faces_at < HAND_ACTIVE_FOR_S or self.hands_seen else HAND_IDLE_S

    def hand_fps(self):
        times = self.hand_times
        if len(times) < 2 or time.monotonic() - times[-1] > 1:
            return 0.0
        return round((len(times) - 1) / (times[-1] - times[0]), 1)

    def analyse_hands(self, frame, now):
        self.hand_times.append(now)
        boxes = [f["box"] for f in self.last_faces]
        hands = []
        for palm in self.palms.detect(frame):
            pts = self.landmarker.landmarks(frame, palm)
            if pts is None:
                continue
            gesture = classify(pts, boxes)
            hands.append({"gesture": gesture, "tip": [round(float(v)) for v in pts[8]], "score": round(float(palm[18]), 3)})
            if gesture == "point":
                self.last_point = (now, pts, frame)
        if hands or self.hands_seen:
            self.publish({"type": "hands", "ts": time.time() * 1000, "hands": hands})
        self.hands_seen = bool(hands)

    def run(self):
        next_at = 0.0
        next_hand_at = 0.0
        while True:
            if not self.needed():
                if self.cap is not None:
                    self.close()
                time.sleep(0.25)
                continue
            if self.cap is None and not self.open():
                self.publish(self.status())
                time.sleep(5)
                continue
            if self.want["device"] and self.want["device"] != self.opened_device:
                self.close()
                continue
            if not self.cap.grab():
                self.error = "camera stopped delivering frames"
                log.warning(self.error)
                self.close()
                time.sleep(2)
                continue
            now = time.monotonic()
            do_faces = now >= next_at
            do_hands = self.hands_on() and now >= next_hand_at
            if not (do_faces or do_hands):
                continue
            ok, frame = self.cap.retrieve()
            if not ok:
                continue
            if now >= self.next_exposure_at:
                self.next_exposure_at = now + 1.0
                self.exposure.adjust(float(frame[::16, ::16].mean()))
            if do_hands:
                next_hand_at = now + self.hand_interval(now)
                try:
                    self.analyse_hands(frame, now)
                except Exception:  # noqa: BLE001
                    log.exception("hand analysis failed")
            if not do_faces:
                self.last_frame, self.last_frame_at = frame, now
                continue
            next_at = now + self.interval()
            try:
                faces = self.analyse(frame)
            except Exception:  # noqa: BLE001
                log.exception("analysis failed")
                continue
            if faces:
                self.last_faces_at = now
            self.collect_enrollment(faces)
            self.last_frame, self.last_faces, self.last_frame_at = frame, faces, now
            public = [{k: v for k, v in f.items() if k != "_emb"} for f in faces]
            self.publish({"type": "observation", "ts": time.time() * 1000, "faces": public})

    # --- requests ----------------------------------------------------------
    def enroll(self, person_id, wanted, timeout):
        job = {"samples": [], "wanted": wanted, "done": threading.Event()}
        with self.lock:
            if self.enrolling is not None:
                return {"ok": False, "error": "Already enrolling someone."}
            if not self.want["enabled"]:
                return {"ok": False, "error": "The camera is turned off."}
            self.enrolling = job
        try:
            job["done"].wait(timeout)
        finally:
            with self.lock:
                self.enrolling = None
        count = len(job["samples"])
        if count < max(3, wanted // 3):
            return {"ok": False, "samples": count, "error": "Could not see a single clear face for long enough."}
        self.gallery.set(person_id, np.stack(job["samples"]))
        return {"ok": True, "samples": count}

    def snapshot(self, max_side=1280, timeout=4.0):
        """A clean frame taken after the request, so it shows what is in view now."""
        asked = time.monotonic()
        self.fast_until = asked + timeout
        while time.monotonic() - asked < timeout:
            if self.last_frame is not None and self.last_frame_at > asked:
                frame = self.last_frame
                scale = min(1.0, max_side / max(frame.shape[:2]))
                if scale < 1.0:
                    frame = cv2.resize(frame, (int(frame.shape[1] * scale), int(frame.shape[0] * scale)))
                ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 85])
                return jpg.tobytes() if ok else None
            time.sleep(0.05)
        return None

    @staticmethod
    def _jpeg(frame, max_side):
        scale = min(1.0, max_side / max(frame.shape[:2]))
        if scale < 1.0:
            frame = cv2.resize(frame, (int(frame.shape[1] * scale), int(frame.shape[0] * scale)))
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 88])
        return base64.b64encode(jpg.tobytes()).decode() if ok else None

    def look(self):
        """The current view, plus a close-up of whatever was pointed at in the last couple of seconds."""
        asked = time.monotonic()
        if self.snapshot(timeout=4.0) is None:
            return None
        result = {"image": self._jpeg(self.last_frame, 1280), "crop": None}
        point = self.last_point
        if point and asked - point[0] < POINT_MEMORY_S:
            region = point_crop(point[2], point[1])
            if region.size:
                result["crop"] = self._jpeg(region, 768)
        return result

    def preview(self):
        self.fast_until = time.monotonic() + 3
        frame, faces = self.last_frame, self.last_faces
        if frame is None:
            return None
        frame = frame.copy()
        for f in faces:
            x, y, w, h = f["box"]
            color = (90, 200, 120) if f["id"] else (60, 160, 240)
            cv2.rectangle(frame, (x, y), (x + w, y + h), color, 2)
            label = f"{f['id'] or 'unknown'} {f['similarity']:.2f}"
            cv2.putText(frame, label, (x, max(14, y - 6)), cv2.FONT_HERSHEY_SIMPLEX, 0.5, color, 1, cv2.LINE_AA)
        scale = 640 / frame.shape[1]
        frame = cv2.resize(frame, (640, int(frame.shape[0] * scale)))
        ok, jpg = cv2.imencode(".jpg", frame, [cv2.IMWRITE_JPEG_QUALITY, 80])
        return jpg.tobytes() if ok else None


def make_handler(vision):
    class Handler(BaseHTTPRequestHandler):
        protocol_version = "HTTP/1.1"

        def log_message(self, fmt, *args):
            log.debug(fmt, *args)

        def send_json(self, status, payload):
            body = json.dumps(payload).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def read_json(self):
            length = int(self.headers.get("Content-Length") or 0)
            if not length:
                return {}
            try:
                return json.loads(self.rfile.read(length))
            except json.JSONDecodeError:
                return {}

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, {"ok": True, **vision.status(), "people": vision.gallery.ids(),
                                     "hand_fps": vision.hand_fps()})
            elif self.path == "/devices":
                self.send_json(200, {"devices": list_devices()})
            elif self.path in ("/preview.jpg", "/snapshot.jpg"):
                if not vision.want["enabled"]:
                    self.send_json(409, {"error": "The camera is turned off."})
                    return
                jpg = vision.preview() if self.path == "/preview.jpg" else vision.snapshot()
                if jpg is None:
                    self.send_json(409, {"error": "No frame yet."})
                    return
                self.send_response(200)
                self.send_header("Content-Type", "image/jpeg")
                self.send_header("Content-Length", str(len(jpg)))
                self.send_header("Cache-Control", "no-store")
                self.end_headers()
                self.wfile.write(jpg)
            elif self.path == "/look":
                if not vision.want["enabled"]:
                    self.send_json(409, {"error": "The camera is turned off."})
                    return
                result = vision.look()
                if result is None:
                    self.send_json(409, {"error": "No frame yet."})
                else:
                    self.send_json(200, result)
            elif self.path == "/events":
                self.stream()
            else:
                self.send_json(404, {"error": "Not found"})

        def do_POST(self):
            body = self.read_json()
            if self.path == "/camera":
                vision.configure(body)
                self.send_json(200, {"ok": True, **vision.status()})
            elif self.path == "/enroll":
                person = str(body.get("personId") or "")
                if not person.replace("_", "").replace("-", "").isalnum():
                    self.send_json(400, {"ok": False, "error": "Bad person id."})
                    return
                wanted = max(5, min(40, int(body.get("samples") or 15)))
                result = vision.enroll(person, wanted, float(body.get("timeout") or 30))
                self.send_json(200 if result["ok"] else 422, result)
            else:
                self.send_json(404, {"error": "Not found"})

        def do_DELETE(self):
            if self.path.startswith("/people/"):
                self.send_json(200, {"ok": vision.gallery.remove(self.path.split("/", 2)[2])})
            else:
                self.send_json(404, {"error": "Not found"})

        def stream(self):
            self.send_response(200)
            self.send_header("Content-Type", "text/event-stream")
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            q = vision.subscribe()
            try:
                self.write_event(vision.status())
                while True:
                    try:
                        self.write_event(q.get(timeout=15))
                    except queue.Empty:
                        self.wfile.write(b": keepalive\n\n")
                        self.wfile.flush()
            except (BrokenPipeError, ConnectionResetError):
                pass
            finally:
                vision.unsubscribe(q)
                self.close_connection = True

        def write_event(self, event):
            self.wfile.write(f"data: {json.dumps(event)}\n\n".encode())
            self.wfile.flush()

    return Handler


def main():
    config_home = Path(os.environ.get("XDG_CONFIG_HOME", Path.home() / ".config"))
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8179)
    parser.add_argument("--models", default=str(Path.home() / "models" / "vision"))
    parser.add_argument("--gallery", default=str(config_home / "project-leslie" / "faces" / "gallery.npz"))
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")

    models = Path(args.models)
    palms = landmarker = None
    if (models / "palm_detection_mediapipe_2023feb.onnx").exists():
        palms = PalmDetector(models / "palm_detection_mediapipe_2023feb.onnx")
        landmarker = HandLandmarker(models / "handpose_estimation_mediapipe_2023feb.onnx")
    else:
        log.warning("hand models missing from %s; gestures are off", models)
    vision = Vision(Detector(models / "det_10g.onnx"), Embedder(models / "w600k_r50.onnx"), Gallery(args.gallery),
                    palms, landmarker)
    threading.Thread(target=vision.run, daemon=True).start()
    server = ThreadingHTTPServer((args.host, args.port), make_handler(vision))
    server.daemon_threads = True
    log.info("listening on http://%s:%d", args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
