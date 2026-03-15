import numpy as np
import logging
import os
import json
from typing import Dict, List, Optional

logger = logging.getLogger("ensemble")

try:
    from sklearn.linear_model import LogisticRegression
    from sklearn.preprocessing import StandardScaler
    import joblib
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False


class EnsembleMetaLearner:
    MODEL_INPUTS = ["xgb_prob", "lgb_prob", "lstm_prob", "tft_prob", "return_pred", "online_prob", "regime_id", "vix_level"]
    
    def __init__(self):
        self.meta_model = None
        self.scaler = StandardScaler()
        self.is_trained = False
        self.model_weights: Dict[str, float] = {}
        self.model_dir = os.path.join(os.path.dirname(__file__), "models")
        self.model_path = os.path.join(self.model_dir, "ensemble_meta.pkl")
        self.scaler_path = os.path.join(self.model_dir, "ensemble_scaler.pkl")
        self._try_load()

    def _try_load(self):
        if not HAS_SKLEARN:
            return
        try:
            if os.path.exists(self.model_path) and os.path.exists(self.scaler_path):
                self.meta_model = joblib.load(self.model_path)
                self.scaler = joblib.load(self.scaler_path)
                self.is_trained = True
                logger.info("Ensemble meta-learner loaded from disk")
        except Exception as e:
            logger.warning(f"Failed to load ensemble model: {e}")

    def train(self, training_data: List[Dict]) -> Dict:
        if not HAS_SKLEARN:
            return {"status": "unavailable", "reason": "scikit-learn not installed"}

        if len(training_data) < 30:
            return {"status": "skipped", "reason": f"only {len(training_data)} samples, need 30+"}

        X, y = [], []
        for item in training_data:
            row = [float(item.get(col, 0.5 if "prob" in col else 0.0)) for col in self.MODEL_INPUTS]
            X.append(row)
            y.append(float(item.get("outcome", 0)))

        X = np.array(X)
        y = np.array(y)

        split = int(len(X) * 0.8)
        X_train, X_val = X[:split], X[split:]
        y_train, y_val = y[:split], y[split:]

        self.scaler.fit(X_train)
        X_train_s = self.scaler.transform(X_train)
        X_val_s = self.scaler.transform(X_val)

        self.meta_model = LogisticRegression(
            C=1.0, penalty="l2", solver="lbfgs", max_iter=500,
            class_weight="balanced",
        )
        self.meta_model.fit(X_train_s, y_train)
        self.is_trained = True

        val_probs = self.meta_model.predict_proba(X_val_s)[:, 1] if len(np.unique(y_train)) > 1 else np.full(len(X_val), 0.5)
        val_preds = (val_probs > 0.5).astype(float)
        accuracy = float(np.mean(val_preds == y_val))

        coefs = self.meta_model.coef_[0] if hasattr(self.meta_model, "coef_") else np.zeros(len(self.MODEL_INPUTS))
        abs_coefs = np.abs(coefs)
        total = abs_coefs.sum() if abs_coefs.sum() > 0 else 1
        self.model_weights = {name: round(float(abs_coefs[i] / total), 4) for i, name in enumerate(self.MODEL_INPUTS)}

        os.makedirs(self.model_dir, exist_ok=True)
        joblib.dump(self.meta_model, self.model_path)
        joblib.dump(self.scaler, self.scaler_path)

        return {
            "status": "trained",
            "accuracy": round(accuracy, 4),
            "training_samples": len(X_train),
            "validation_samples": len(X_val),
            "model_weights": self.model_weights,
        }

    def score(self, model_outputs: Dict) -> Dict:
        row = [float(model_outputs.get(col, 0.5 if "prob" in col else 0.0)) for col in self.MODEL_INPUTS]
        probs = [model_outputs.get(col, 0.5) for col in self.MODEL_INPUTS[:6]]
        valid_probs = [p for p in probs if isinstance(p, (int, float)) and 0 <= p <= 1]
        disagreement = float(np.std(valid_probs)) if len(valid_probs) >= 2 else 0.0

        if not self.is_trained or self.meta_model is None:
            avg_prob = float(np.mean(valid_probs)) if valid_probs else 0.5
            return {
                "ensemble_probability": round(avg_prob, 4),
                "model_weights": {k: round(1.0 / len(self.MODEL_INPUTS), 4) for k in self.MODEL_INPUTS},
                "disagreement_score": round(disagreement, 4),
                "confidence": round(max(0, 1.0 - disagreement * 3), 4),
                "available": False,
            }

        X = np.array([row])
        X_s = self.scaler.transform(X)
        
        if hasattr(self.meta_model, "predict_proba"):
            prob = float(self.meta_model.predict_proba(X_s)[0, 1])
        else:
            prob = float(self.meta_model.predict(X_s)[0])

        confidence = max(0, min(1.0, (1.0 - disagreement * 3) * abs(prob - 0.5) * 4))

        return {
            "ensemble_probability": round(prob, 4),
            "model_weights": self.model_weights,
            "disagreement_score": round(disagreement, 4),
            "confidence": round(confidence, 4),
            "available": True,
        }


ensemble_learner = EnsembleMetaLearner()
