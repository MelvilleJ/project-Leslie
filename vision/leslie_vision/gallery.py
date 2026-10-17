"""Enrolled face embeddings, keyed by the person ids LESLIE assigns."""

import os
import threading
from pathlib import Path

import numpy as np


def normalize(v):
    v = np.asarray(v, dtype=np.float32)
    norm = np.linalg.norm(v, axis=-1, keepdims=True)
    return v / np.maximum(norm, 1e-12)


class Gallery:
    def __init__(self, path):
        self.path = Path(path)
        self.lock = threading.Lock()
        self.people = {}
        if self.path.exists():
            with np.load(self.path) as data:
                self.people = {key: normalize(data[key]) for key in data.files}

    def ids(self):
        with self.lock:
            return sorted(self.people)

    def set(self, person_id, embeddings):
        with self.lock:
            self.people[person_id] = normalize(embeddings)
            self._save()

    def remove(self, person_id):
        with self.lock:
            existed = self.people.pop(person_id, None) is not None
            if existed:
                self._save()
            return existed

    def match(self, embedding, threshold):
        """Best (person_id, similarity); person_id is None below the threshold."""
        query = normalize(embedding)
        best_id, best = None, -1.0
        with self.lock:
            for person_id, samples in self.people.items():
                # Max over samples, not the mean: enrollment covers several head
                # angles and a live face only resembles some of them.
                sim = float(np.max(samples @ query))
                if sim > best:
                    best_id, best = person_id, sim
        return (best_id if best >= threshold else None), best

    def _save(self):
        self.path.parent.mkdir(parents=True, exist_ok=True)
        tmp = self.path.with_name(self.path.name + ".tmp.npz")
        np.savez(tmp, **self.people)
        os.chmod(tmp, 0o600)
        os.replace(tmp, self.path)
