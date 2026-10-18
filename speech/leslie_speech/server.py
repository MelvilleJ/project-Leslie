"""LESLIE speech sidecar: faster-whisper behind an OpenAI-style
/v1/audio/transcriptions endpoint, on an NVIDIA GPU or the CPU.

Audio is decoded in memory and never written to disk.
"""

import argparse
import ctypes
import glob
import io
import json
import logging
import os
import threading
import wave
from email.parser import BytesParser
from email.policy import HTTP
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path

log = logging.getLogger("leslie-speech")

# large-v3-turbo is quick on a GPU; on the CPU it takes seconds per utterance,
# so the CPU default trades some accuracy for speed.
DEFAULT_MODEL = {"cuda": "large-v3-turbo", "cpu": "small"}
COMPUTE = {"cuda": "float16", "cpu": "int8"}
MAX_UPLOAD = 50 * 1024 * 1024


def preload_cuda_libraries():
    """CTranslate2 dlopens cuBLAS and cuDNN by soname. The pip wheels put them in
    site-packages, which the loader never searches, and LD_LIBRARY_PATH can't be
    changed once the process runs, so load them by path first."""
    import site

    for root in site.getsitepackages():
        for pattern in ("nvidia/cublas/lib/libcublas*.so*", "nvidia/cudnn/lib/libcudnn*.so*"):
            for lib in sorted(glob.glob(os.path.join(root, pattern))):
                try:
                    ctypes.CDLL(lib, mode=ctypes.RTLD_GLOBAL)
                except OSError as err:
                    log.debug("could not preload %s: %s", lib, err)


def form_fields(content_type, body):
    """{name: bytes} from a multipart/form-data body."""
    message = BytesParser(policy=HTTP).parsebytes(
        b"Content-Type: " + content_type.encode() + b"\r\n\r\n" + body
    )
    fields = {}
    for part in message.iter_parts():
        name = part.get_param("name", header="content-disposition")
        if name:
            fields[name] = part.get_payload(decode=True) or b""
    return fields


def wav_samples(audio):
    """16 kHz mono float32 from a PCM WAV, or None for anything else. The voice
    window sends WAV, and this keeps it off PyAV, whose API shifts between
    releases under faster-whisper."""
    import numpy as np

    try:
        with wave.open(io.BytesIO(audio)) as w:
            if w.getsampwidth() != 2:
                return None
            rate, channels = w.getframerate(), w.getnchannels()
            pcm = np.frombuffer(w.readframes(w.getnframes()), dtype="<i2").astype(np.float32) / 32768.0
    except (wave.Error, EOFError):
        return None
    if channels > 1:
        pcm = pcm.reshape(-1, channels).mean(axis=1)
    if rate != 16000 and len(pcm):
        n = int(round(len(pcm) * 16000 / rate))
        pcm = np.interp(np.linspace(0, len(pcm) - 1, n), np.arange(len(pcm)), pcm).astype(np.float32)
    return pcm


class Transcriber:
    def __init__(self, model_name, device, models_dir):
        from faster_whisper import WhisperModel

        self.lock = threading.Lock()
        self.model_name = model_name
        self.device = device
        try:
            self.model = WhisperModel(model_name, device=device, compute_type=COMPUTE[device], download_root=models_dir,
                                      local_files_only=True)
        except Exception as err:  # noqa: BLE001
            if device != "cuda":
                raise
            log.warning("CUDA is unavailable (%s); falling back to the CPU", err)
            self.device = "cpu"
            self.model = WhisperModel(model_name, device="cpu", compute_type=COMPUTE["cpu"], download_root=models_dir,
                                      local_files_only=True)

    def transcribe(self, audio, language=None):
        # One utterance at a time: concurrent calls only slow each other down.
        with self.lock:
            samples = wav_samples(audio)
            source = samples if samples is not None else io.BytesIO(audio)
            segments, _info = self.model.transcribe(source, language=language or None, vad_filter=False,
                                                   beam_size=1, condition_on_previous_text=False)
            return "".join(s.text for s in segments).strip()


def make_handler(transcriber):
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

        def do_GET(self):
            if self.path == "/health":
                self.send_json(200, {"ok": True, "model": transcriber.model_name, "device": transcriber.device})
            elif self.path == "/v1/models":
                self.send_json(200, {"data": [{"id": transcriber.model_name, "object": "model"}]})
            else:
                self.send_json(404, {"error": "Not found"})

        def do_POST(self):
            if self.path != "/v1/audio/transcriptions":
                self.send_json(404, {"error": "Not found"})
                return
            length = int(self.headers.get("Content-Length") or 0)
            if not length or length > MAX_UPLOAD:
                self.send_json(413 if length else 400, {"error": "Send the audio as multipart form data."})
                return
            fields = form_fields(self.headers.get("Content-Type", ""), self.rfile.read(length))
            audio = fields.get("file")
            if not audio:
                self.send_json(400, {"error": "No file field."})
                return
            language = (fields.get("language") or b"").decode() or None
            try:
                text = transcriber.transcribe(audio, language)
            except Exception as err:  # noqa: BLE001
                log.warning("transcription failed: %s", err)
                self.send_json(500, {"error": str(err)})
                return
            self.send_json(200, {"text": text})

    return Handler


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8178)
    parser.add_argument("--models", default=str(Path.home() / ".local" / "share" / "leslie" / "models" / "speech"))
    parser.add_argument("--device", choices=["cuda", "cpu"], default="cpu")
    parser.add_argument("--model", help="Whisper model (default: large-v3-turbo on CUDA, small on the CPU)")
    parser.add_argument("--download-only", action="store_true", help="fetch the model and exit")
    parser.add_argument("--verbose", action="store_true")
    args = parser.parse_args()
    logging.basicConfig(level=logging.DEBUG if args.verbose else logging.INFO, format="%(levelname)s %(message)s")

    model = args.model or DEFAULT_MODEL[args.device]
    if args.download_only:
        from faster_whisper import download_model

        download_model(model, output_dir=None, cache_dir=args.models)
        return
    if args.device == "cuda":
        preload_cuda_libraries()
    transcriber = Transcriber(model, args.device, args.models)
    server = ThreadingHTTPServer((args.host, args.port), make_handler(transcriber))
    server.daemon_threads = True
    log.info("%s on %s, listening on http://%s:%d", model, transcriber.device, args.host, args.port)
    server.serve_forever()


if __name__ == "__main__":
    main()
