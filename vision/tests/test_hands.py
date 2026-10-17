import numpy as np

from leslie_vision.hands import classify, palm_anchors, point_crop


def hand(extended, wrist=(300, 400), spread=40):
    """Synthetic upright right hand: fingers straight up when extended, folded back when not."""
    pts = np.zeros((21, 2), np.float32)
    pts[0] = wrist
    pts[1:5] = [(wrist[0] - 50, wrist[1] - 30 - 15 * i) for i in range(4)]
    for f, name in enumerate(["index", "middle", "ring", "pinky"]):
        x = wrist[0] - 30 + f * spread
        base = 5 + 4 * f
        pts[base] = (x, wrist[1] - 80)
        if name in extended:
            pts[base + 1:base + 4] = [(x, wrist[1] - 80 - 30 * (i + 1)) for i in range(3)]
        else:
            pts[base + 1] = (x, wrist[1] - 100)
            pts[base + 2] = (x, wrist[1] - 85)
            pts[base + 3] = (x, wrist[1] - 70)
    return pts


def test_open_palm():
    assert classify(hand({"index", "middle", "ring", "pinky"})) == "palm"


def test_sideways_palm_is_nothing():
    pts = hand({"index", "middle", "ring", "pinky"})
    wrist = pts[0].copy()
    pts = (pts - wrist) @ np.array([[0, 1], [-1, 0]], np.float32) + wrist
    assert classify(pts) is None


def test_palm_below_the_face_is_nothing():
    pts = hand({"index", "middle", "ring", "pinky"})
    assert classify(pts, [(250, 20, 120, 150)]) is None
    assert classify(pts, [(250, 150, 120, 150)]) == "palm"


def test_pointing_index():
    assert classify(hand({"index"})) == "point"


def test_index_over_mouth_is_shush():
    pts = hand({"index"})
    tip = pts[8]
    face = (int(tip[0]) - 60, int(tip[1]) - 120, 120, 150)
    assert classify(pts, [face]) == "shush"


def test_fist_is_nothing():
    assert classify(hand(set())) is None


def test_anchor_layout():
    a = palm_anchors()
    assert a.shape == (2016, 2)
    assert np.allclose(a[0], [0.5 / 24, 0.5 / 24]) and np.allclose(a[-1], [11.5 / 12, 11.5 / 12])


def test_point_crop_lies_beyond_the_fingertip():
    frame = np.zeros((1080, 1920, 3), np.uint8)
    pts = hand({"index"}, wrist=(900, 800))
    frame[:int(pts[8][1]), :] = 255
    crop = point_crop(frame, pts)
    assert crop.size and crop.mean() > 127


def test_exposure_steps_towards_target():
    from leslie_vision.exposure import next_setting
    assert next_setting(60, 300, 40) == (300, 46)
    assert next_setting(160, 300, 40) == (300, 34)
    assert next_setting(160, 300, 0) == (200, 0)
    assert next_setting(60, 100, 0) == (200, 0)
    assert next_setting(105, 300, 40) == (300, 40)
    assert next_setting(200, 100, 0) == (100, 0)
