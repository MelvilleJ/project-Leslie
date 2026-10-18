"""Exposure control that keeps the camera at its full frame rate.

UVC auto-exposure lengthens the exposure in dim rooms, which drops a 30 fps
camera to ~17 fps and makes gestures sluggish. Instead the exposure is capped at
one frame (30 ms, a multiple of the 10 ms mains period so lights don't band) and
brightness is chased with gain, shortening the exposure only in bright light.
"""

import logging
import re
import shutil
import subprocess

log = logging.getLogger("leslie-vision")

EXPOSURES = (300, 200, 100)  # 100 µs units: 30, 20, 10 ms
GAIN_MIN, GAIN_MAX, GAIN_STEP = 0, 100, 6
TARGET = 105
TOLERANCE = 12


def next_setting(brightness, exposure, gain):
    """One step towards the target brightness: (exposure, gain)."""
    if brightness < TARGET - TOLERANCE:
        if exposure < EXPOSURES[0]:
            return EXPOSURES[EXPOSURES.index(exposure) - 1], gain
        return exposure, min(GAIN_MAX, gain + GAIN_STEP)
    if brightness > TARGET + TOLERANCE:
        if gain > GAIN_MIN:
            return exposure, max(GAIN_MIN, gain - GAIN_STEP)
        if exposure != EXPOSURES[-1]:
            return EXPOSURES[EXPOSURES.index(exposure) + 1], gain
    return exposure, gain


RESTORED = ("auto_exposure", "exposure_dynamic_framerate", "exposure_time_absolute", "gain")


def control_defaults(listing):
    """{control: default} from `v4l2-ctl -l` output."""
    found = re.finditer(r"^\s*(\w+) 0x[0-9a-f]+ \(\w+\)\s*:.*?\bdefault=(-?\d+)", listing, re.M)
    return {m.group(1): m.group(2) for m in found}


class Exposure:
    def __init__(self, device):
        self.device = device
        self.available = shutil.which("v4l2-ctl") is not None
        self.exposure, self.gain = EXPOSURES[0], 40

    def _set(self, controls):
        if not self.available:
            return False
        res = subprocess.run(["v4l2-ctl", "-d", self.device, "-c", controls], capture_output=True, text=True)
        if res.returncode != 0:
            log.warning("v4l2-ctl %s failed: %s", controls, res.stderr.strip())
            self.available = False
        return res.returncode == 0

    def start(self):
        if self._set(f"auto_exposure=1,exposure_dynamic_framerate=0,exposure_time_absolute={self.exposure},gain={self.gain}"):
            log.info("manual exposure: %d ms, gain %d", self.exposure // 10, self.gain)

    def adjust(self, brightness):
        exposure, gain = next_setting(brightness, self.exposure, self.gain)
        if (exposure, gain) != (self.exposure, self.gain) and self._set(f"exposure_time_absolute={exposure},gain={gain}"):
            self.exposure, self.gain = exposure, gain

    def stop(self):
        """Hand the camera back as other apps expect it. The controls live in the
        camera itself, so a gain left high here would wash out every other app."""
        if not self.available:
            return
        res = subprocess.run(["v4l2-ctl", "-d", self.device, "-l"], capture_output=True, text=True)
        defaults = control_defaults(res.stdout)
        controls = ",".join(f"{name}={defaults[name]}" for name in RESTORED if name in defaults)
        self._set(controls or "auto_exposure=3")
