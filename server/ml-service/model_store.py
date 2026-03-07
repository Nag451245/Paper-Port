"""
Persistent model storage with versioning, metadata, rollback, and auto-pruning.
"""

import os
import json
import logging
import time
import hashlib
from datetime import datetime
from typing import Optional

import joblib

log = logging.getLogger("ModelStore")

MODEL_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "models")
MAX_VERSIONS = 5


class ModelStore:
    def __init__(self):
        self._models: dict = {}
        self._metadata: dict = {}
        os.makedirs(MODEL_DIR, exist_ok=True)

    def _version_path(self, name: str, version: str) -> str:
        return os.path.join(MODEL_DIR, f"{name}_v{version}.joblib")

    def _latest_path(self, name: str) -> str:
        return os.path.join(MODEL_DIR, f"{name}_latest.joblib")

    def _meta_path(self, name: str, version: str) -> str:
        return os.path.join(MODEL_DIR, f"{name}_v{version}_meta.json")

    def save(
        self,
        name: str,
        model,
        accuracy: Optional[float] = None,
        feature_count: Optional[int] = None,
        dataset_size: Optional[int] = None,
        extra_meta: Optional[dict] = None,
    ) -> str:
        version = datetime.utcnow().strftime("%Y%m%d_%H%M%S")
        versioned = self._version_path(name, version)
        latest = self._latest_path(name)

        joblib.dump(model, versioned)
        joblib.dump(model, latest)
        self._models[name] = model

        meta = {
            "name": name,
            "version": version,
            "training_timestamp": datetime.utcnow().isoformat() + "Z",
            "accuracy": accuracy,
            "feature_count": feature_count,
            "dataset_size": dataset_size,
            "file_size_bytes": os.path.getsize(versioned),
        }
        if extra_meta:
            meta.update(extra_meta)
        self._metadata[name] = meta

        meta_path = self._meta_path(name, version)
        with open(meta_path, "w") as f:
            json.dump(meta, f, indent=2)

        log.info(f"Model '{name}' v{version} saved (acc={accuracy}, features={feature_count}, samples={dataset_size})")
        self._prune_old_versions(name)
        return version

    def load(self, name: str):
        if name in self._models:
            return self._models[name]
        latest = self._latest_path(name)
        if os.path.exists(latest):
            model = joblib.load(latest)
            self._models[name] = model
            log.info(f"Model '{name}' loaded from latest")
            return model
        return None

    def rollback(self, name: str) -> Optional[str]:
        """Revert to the previous version of a model. Returns the restored version or None."""
        versions = self._get_versions(name)
        if len(versions) < 2:
            log.warning(f"Cannot rollback '{name}': only {len(versions)} version(s) found")
            return None

        # Remove current latest
        current = versions[-1]
        previous = versions[-2]

        prev_path = self._version_path(name, previous)
        if not os.path.exists(prev_path):
            log.error(f"Previous version file missing: {prev_path}")
            return None

        model = joblib.load(prev_path)
        latest = self._latest_path(name)
        joblib.dump(model, latest)
        self._models[name] = model

        # Remove the rolled-back version
        cur_path = self._version_path(name, current)
        cur_meta = self._meta_path(name, current)
        for f in [cur_path, cur_meta]:
            if os.path.exists(f):
                os.remove(f)

        # Load previous metadata
        prev_meta_path = self._meta_path(name, previous)
        if os.path.exists(prev_meta_path):
            with open(prev_meta_path) as f:
                self._metadata[name] = json.load(f)

        log.info(f"Model '{name}' rolled back from v{current} to v{previous}")
        return previous

    def get_metadata(self, name: str) -> Optional[dict]:
        if name in self._metadata:
            return self._metadata[name]
        versions = self._get_versions(name)
        if versions:
            meta_path = self._meta_path(name, versions[-1])
            if os.path.exists(meta_path):
                with open(meta_path) as f:
                    meta = json.load(f)
                    self._metadata[name] = meta
                    return meta
        return None

    def list_all_metadata(self) -> list[dict]:
        """List all models with their latest metadata."""
        result = []
        seen = set()
        for fname in sorted(os.listdir(MODEL_DIR)):
            if fname.endswith("_meta.json"):
                try:
                    with open(os.path.join(MODEL_DIR, fname)) as f:
                        meta = json.load(f)
                        name = meta.get("name", fname.split("_v")[0])
                        if name not in seen:
                            seen.add(name)
                        result.append(meta)
                except Exception:
                    pass
        # Also include in-memory models that may not have metadata files
        for name in self._models:
            if name not in seen:
                result.append({"name": name, "version": "in_memory", "accuracy": None})
        return result

    def _get_versions(self, name: str) -> list[str]:
        """Get sorted list of version timestamps for a model."""
        prefix = f"{name}_v"
        versions = []
        for fname in os.listdir(MODEL_DIR):
            if fname.startswith(prefix) and fname.endswith(".joblib"):
                ver = fname[len(prefix):-7]
                versions.append(ver)
        return sorted(versions)

    def _prune_old_versions(self, name: str) -> None:
        """Keep only the last MAX_VERSIONS versions, remove older ones."""
        versions = self._get_versions(name)
        while len(versions) > MAX_VERSIONS:
            old_ver = versions.pop(0)
            for f in [self._version_path(name, old_ver), self._meta_path(name, old_ver)]:
                if os.path.exists(f):
                    os.remove(f)
                    log.info(f"Pruned old version: {f}")

    def save_all(self) -> None:
        for name, model in self._models.items():
            path = self._latest_path(name)
            joblib.dump(model, path)
        log.info(f"Saved {len(self._models)} models (latest)")

    def load_all(self) -> None:
        if not os.path.exists(MODEL_DIR):
            return
        loaded = set()
        for fname in os.listdir(MODEL_DIR):
            if fname.endswith("_latest.joblib"):
                name = fname[:-14]
                try:
                    self._models[name] = joblib.load(os.path.join(MODEL_DIR, fname))
                    loaded.add(name)
                    log.info(f"Loaded model '{name}' (latest)")
                except Exception as e:
                    log.warning(f"Failed to load '{name}': {e}")
            elif fname.endswith(".joblib") and "_v" not in fname and "_latest" not in fname:
                name = fname[:-7]
                if name not in loaded:
                    try:
                        self._models[name] = joblib.load(os.path.join(MODEL_DIR, fname))
                        log.info(f"Loaded legacy model '{name}'")
                    except Exception as e:
                        log.warning(f"Failed to load legacy '{name}': {e}")

    def list_models(self) -> list[str]:
        return list(self._models.keys())

    def get(self, name: str):
        return self._models.get(name)
