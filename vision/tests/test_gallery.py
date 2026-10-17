import numpy as np

from leslie_vision.gallery import Gallery, normalize


def unit(seed, dim=512):
    return normalize(np.random.default_rng(seed).standard_normal(dim))


def test_matches_the_closest_person_above_threshold(tmp_path):
    g = Gallery(tmp_path / "g.npz")
    alice, bob = unit(1), unit(2)
    g.set("alice", np.stack([alice, unit(3)]))
    g.set("bob", np.stack([bob]))
    person, sim = g.match(alice + 0.1 * unit(4), threshold=0.4)
    assert person == "alice"
    assert sim > 0.9


def test_unknown_face_falls_below_threshold(tmp_path):
    g = Gallery(tmp_path / "g.npz")
    g.set("alice", np.stack([unit(1)]))
    person, sim = g.match(unit(99), threshold=0.4)
    assert person is None
    assert sim < 0.4


def test_persists_privately_and_removes(tmp_path):
    path = tmp_path / "faces" / "g.npz"
    Gallery(path).set("alice", np.stack([unit(1)]))
    assert path.stat().st_mode & 0o777 == 0o600
    reloaded = Gallery(path)
    assert reloaded.ids() == ["alice"]
    assert reloaded.remove("alice") is True
    assert Gallery(path).ids() == []
