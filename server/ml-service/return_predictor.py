import numpy as np
import logging
from typing import Dict, List, Optional

logger = logging.getLogger("return_predictor")

try:
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False

class ReturnPredictor:
    def __init__(self):
        self.model = None
        self.feature_names: List[str] = []
        self.is_trained = False

    def train(self, training_data: List[Dict], target_col: str = "forward_return",
              walk_forward_days: int = 30, purge_gap_days: int = 5) -> Dict:
        if not HAS_XGB or len(training_data) < 100:
            return {"status": "skipped", "reason": "insufficient data or xgboost unavailable"}

        features_list = []
        targets = []
        for row in training_data:
            if target_col in row and "features" in row:
                features_list.append(row["features"])
                targets.append(float(row[target_col]))

        if len(features_list) < 100:
            return {"status": "skipped", "reason": f"only {len(features_list)} valid samples"}

        self.feature_names = sorted(features_list[0].keys()) if features_list else []
        X = np.array([[f.get(k, 0) for k in self.feature_names] for f in features_list])
        y = np.array(targets)

        split = int(len(X) * 0.7)
        X_train, X_val = X[:split], X[split + purge_gap_days:]
        y_train, y_val = y[:split], y[split + purge_gap_days:]

        if len(X_val) < 10:
            X_val = X[split:]
            y_val = y[split:]

        params = {
            "objective": "reg:squarederror",
            "max_depth": 5,
            "learning_rate": 0.05,
            "n_estimators": 200,
            "subsample": 0.8,
            "colsample_bytree": 0.8,
            "reg_alpha": 0.1,
            "reg_lambda": 1.0,
        }

        self.model = xgb.XGBRegressor(**params)
        self.model.fit(X_train, y_train, eval_set=[(X_val, y_val)],
                       verbose=False)
        self.is_trained = True

        preds = self.model.predict(X_val)
        mse = float(np.mean((preds - y_val) ** 2))
        mae = float(np.mean(np.abs(preds - y_val)))
        corr = float(np.corrcoef(preds, y_val)[0, 1]) if len(preds) > 1 else 0.0

        importance = {}
        if hasattr(self.model, "feature_importances_"):
            for i, name in enumerate(self.feature_names):
                importance[name] = float(self.model.feature_importances_[i])

        return {
            "status": "trained",
            "mse": round(mse, 6),
            "mae": round(mae, 6),
            "correlation": round(corr, 4),
            "training_samples": len(X_train),
            "validation_samples": len(X_val),
            "feature_importance": dict(sorted(importance.items(), key=lambda x: -x[1])[:20]),
        }

    def predict(self, features: List[Dict]) -> Dict:
        if not self.is_trained or self.model is None:
            return {"predictions": [0.0] * len(features), "confidence": 0.0, "available": False}

        X = np.array([[f.get(k, 0) for k in self.feature_names] for f in features])
        preds = self.model.predict(X)

        confidence = min(1.0, len(self.feature_names) / 50 * 0.8)

        return {
            "predictions": [round(float(p), 6) for p in preds],
            "confidence": round(confidence, 2),
            "available": True,
        }


return_predictor = ReturnPredictor()
