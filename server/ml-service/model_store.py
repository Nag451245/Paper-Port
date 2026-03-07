"""
Persistent model storage — saves/loads trained ML models to disk.
"""

import os
import logging
import joblib

log = logging.getLogger("ModelStore")

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")


class ModelStore:
    def __init__(self):
        self._models: dict = {}
        os.makedirs(MODEL_DIR, exist_ok=True)

    def save(self, name: str, model) -> None:
        path = os.path.join(MODEL_DIR, f"{name}.joblib")
        joblib.dump(model, path)
        self._models[name] = model
        log.info(f"Model '{name}' saved to {path}")

    def load(self, name: str):
        if name in self._models:
            return self._models[name]
        path = os.path.join(MODEL_DIR, f"{name}.joblib")
        if os.path.exists(path):
            model = joblib.load(path)
            self._models[name] = model
            log.info(f"Model '{name}' loaded from {path}")
            return model
        return None

    def save_all(self) -> None:
        for name, model in self._models.items():
            path = os.path.join(MODEL_DIR, f"{name}.joblib")
            joblib.dump(model, path)
        log.info(f"Saved {len(self._models)} models")

    def load_all(self) -> None:
        if not os.path.exists(MODEL_DIR):
            return
        for fname in os.listdir(MODEL_DIR):
            if fname.endswith(".joblib"):
                name = fname[:-7]
                try:
                    self._models[name] = joblib.load(os.path.join(MODEL_DIR, fname))
                    log.info(f"Loaded model '{name}'")
                except Exception as e:
                    log.warning(f"Failed to load model '{name}': {e}")

    def list_models(self) -> list[str]:
        return list(self._models.keys())

    def get(self, name: str):
        return self._models.get(name)
