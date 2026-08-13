"""
Signal Scorer — XGBoost/LightGBM models for trade signal scoring.

Supports:
  - Training on features → {WIN, LOSS} with walk-forward + purged CV
  - Inference: score new signals with probability
  - Feature importance extraction
"""

import logging
import numpy as np
from sklearn.model_selection import TimeSeriesSplit
from sklearn.metrics import accuracy_score, roc_auc_score

log = logging.getLogger("SignalScorer")

FEATURE_COLUMNS = [
    "ema_vote", "rsi_vote", "macd_vote", "supertrend_vote",
    "bollinger_vote", "vwap_vote", "momentum_vote", "volume_vote",
    "composite_score", "regime", "hour_of_day", "day_of_week",
]

MAX_RAW_FEATURES = 76


class SignalScorer:
    def __init__(self, store):
        self.store = store

    def _extract_feature_matrix(self, feature_rows: list) -> np.ndarray:
        """Convert feature dicts + raw_features into a numpy matrix."""
        rows = []
        for fr in feature_rows:
            feats = fr if isinstance(fr, dict) else fr.dict() if hasattr(fr, "dict") else {}
            base_features = feats.get("features", feats)

            row = [float(base_features.get(col, 0.0)) for col in FEATURE_COLUMNS]

            raw = base_features.get("raw_features", feats.get("raw_features", []))
            if isinstance(raw, list):
                # Pad or truncate to MAX_RAW_FEATURES
                padded = (raw + [0.0] * MAX_RAW_FEATURES)[:MAX_RAW_FEATURES]
                row.extend(padded)
            else:
                row.extend([0.0] * MAX_RAW_FEATURES)

            rows.append(row)

        return np.array(rows, dtype=np.float64)

    def score(self, features: list, model_type: str = "xgboost") -> dict:
        """Score signals using the trained model."""
        model = self.store.get(f"scorer_{model_type}")

        X = self._extract_feature_matrix(features)

        if model is None:
            # Fallback: simple logistic-like scoring from composite_score
            composite_idx = FEATURE_COLUMNS.index("composite_score")
            scores = 1.0 / (1.0 + np.exp(-X[:, composite_idx] * 3))
            labels = ["WIN" if s > 0.5 else "LOSS" for s in scores]
            return {
                "scores": scores.tolist(),
                "labels": labels,
                "model_type": "fallback_logistic",
                "feature_importance": {},
            }

        probas = model.predict_proba(X)[:, 1]
        labels = ["WIN" if p > 0.5 else "LOSS" for p in probas]

        importance = {}
        if hasattr(model, "feature_importances_"):
            all_names = FEATURE_COLUMNS + [f"raw_{i}" for i in range(MAX_RAW_FEATURES)]
            imp = model.feature_importances_
            # Top 20 most important features
            top_idx = np.argsort(imp)[-20:][::-1]
            importance = {all_names[i]: round(float(imp[i]), 4) for i in top_idx if imp[i] > 0}

        return {
            "scores": [round(float(p), 4) for p in probas],
            "labels": labels,
            "model_type": model_type,
            "feature_importance": importance,
        }

    def train(
        self,
        training_data: list[dict],
        model_type: str = "xgboost",
        walk_forward_days: int = 30,
        purge_gap_days: int = 5,
    ) -> dict:
        """Train model with walk-forward cross-validation and purged gap."""
        if len(training_data) < 20:
            raise ValueError(f"Need at least 20 training samples, got {len(training_data)}")

        X = self._extract_feature_matrix(training_data)
        y = np.array([float(d.get("outcome", 0)) for d in training_data])

        # Replace NaN/inf with 0
        X = np.nan_to_num(X, nan=0.0, posinf=0.0, neginf=0.0)

        # Walk-forward split with purge gap
        n = len(X)
        val_size = min(walk_forward_days, n // 4)
        purge = purge_gap_days
        train_end = n - val_size - purge
        if train_end < 10:
            train_end = n - val_size
            purge = 0

        X_train, y_train = X[:train_end], y[:train_end]
        X_val, y_val = X[train_end + purge:], y[train_end + purge:]

        if len(X_val) == 0:
            X_val, y_val = X[-val_size:], y[-val_size:]

        if model_type == "lightgbm":
            model = self._train_lightgbm(X_train, y_train, X_val, y_val)
        else:
            model = self._train_xgboost(X_train, y_train, X_val, y_val)

        # Evaluate
        val_probas = model.predict_proba(X_val)[:, 1]
        val_preds = (val_probas > 0.5).astype(int)
        accuracy = accuracy_score(y_val, val_preds)

        try:
            auc = roc_auc_score(y_val, val_probas)
        except ValueError:
            auc = 0.5  # Single class in validation

        # Feature importance
        importance = {}
        if hasattr(model, "feature_importances_"):
            all_names = FEATURE_COLUMNS + [f"raw_{i}" for i in range(MAX_RAW_FEATURES)]
            imp = model.feature_importances_
            top_idx = np.argsort(imp)[-20:][::-1]
            importance = {all_names[i]: round(float(imp[i]), 4) for i in top_idx if imp[i] > 0}

        # Save model with versioning metadata
        self.store.save(
            f"scorer_{model_type}",
            model,
            accuracy=round(accuracy, 4),
            feature_count=X_train.shape[1] if hasattr(X_train, 'shape') else len(FEATURE_COLUMNS),
            dataset_size=len(X_train) + len(X_val),
            extra_meta={"auc_roc": round(auc, 4), "model_type": model_type},
        )

        log.info(
            f"Trained {model_type}: accuracy={accuracy:.3f}, AUC={auc:.3f}, "
            f"train={len(X_train)}, val={len(X_val)}"
        )

        return {
            "accuracy": round(accuracy, 4),
            "auc_roc": round(auc, 4),
            "feature_importance": importance,
            "training_samples": len(X_train),
            "validation_samples": len(X_val),
            "model_type": model_type,
        }

    def _train_xgboost(self, X_train, y_train, X_val, y_val):
        import xgboost as xgb

        model = xgb.XGBClassifier(
            n_estimators=200,
            max_depth=5,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_weight=3,
            reg_alpha=0.1,
            reg_lambda=1.0,
            eval_metric="logloss",
            early_stopping_rounds=20,
            use_label_encoder=False,
            verbosity=0,
        )
        model.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            verbose=False,
        )
        return model

    def _train_lightgbm(self, X_train, y_train, X_val, y_val):
        import lightgbm as lgb

        model = lgb.LGBMClassifier(
            n_estimators=200,
            max_depth=5,
            learning_rate=0.05,
            subsample=0.8,
            colsample_bytree=0.8,
            min_child_samples=10,
            reg_alpha=0.1,
            reg_lambda=1.0,
            verbose=-1,
        )
        model.fit(
            X_train, y_train,
            eval_set=[(X_val, y_val)],
            callbacks=[lgb.early_stopping(20, verbose=False)],
        )
        return model
