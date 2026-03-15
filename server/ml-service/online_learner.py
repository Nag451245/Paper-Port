import numpy as np
import logging
import time
from typing import Dict, List, Optional
from collections import deque

logger = logging.getLogger("online_learner")

try:
    from sklearn.linear_model import SGDClassifier
    from sklearn.preprocessing import StandardScaler
    HAS_SKLEARN = True
except ImportError:
    HAS_SKLEARN = False

try:
    import xgboost as xgb
    HAS_XGB = True
except ImportError:
    HAS_XGB = False


class OnlineSGDModel:
    def __init__(self, feature_names: Optional[List[str]] = None):
        self.model = SGDClassifier(
            loss="log_loss", penalty="l2", alpha=0.001,
            learning_rate="adaptive", eta0=0.01,
            warm_start=True,
        ) if HAS_SKLEARN else None
        self.scaler = StandardScaler() if HAS_SKLEARN else None
        self.feature_names = feature_names or []
        self.is_fitted = False
        self.update_count = 0
        self.recent_accuracy = deque(maxlen=100)
        self.ema_accuracy = 0.5

    def partial_update(self, features: Dict, outcome: float) -> Dict:
        if not self.model or not self.scaler:
            return {"status": "unavailable"}

        if not self.feature_names:
            self.feature_names = sorted(features.keys())

        x = np.array([[features.get(k, 0) for k in self.feature_names]])
        y = np.array([1.0 if outcome >= 0.5 else 0.0])

        if not self.is_fitted:
            self.scaler.partial_fit(x)
            x_s = self.scaler.transform(x)
            self.model.partial_fit(x_s, y, classes=[0, 1])
            self.is_fitted = True
        else:
            self.scaler.partial_fit(x)
            x_s = self.scaler.transform(x)
            
            pred = float(self.model.predict(x_s)[0])
            correct = float(pred == y[0])
            self.recent_accuracy.append(correct)
            self.ema_accuracy = 0.95 * self.ema_accuracy + 0.05 * correct
            
            self.model.partial_fit(x_s, y)

        self.update_count += 1
        return {"status": "updated", "update_count": self.update_count}

    def predict(self, features: Dict) -> float:
        if not self.is_fitted or not self.model:
            return 0.5
        
        x = np.array([[features.get(k, 0) for k in self.feature_names]])
        x_s = self.scaler.transform(x)
        
        if hasattr(self.model, "predict_proba"):
            try:
                return float(self.model.predict_proba(x_s)[0, 1])
            except Exception:
                return float(self.model.decision_function(x_s)[0])
        return 0.5

    def get_accuracy(self) -> float:
        if not self.recent_accuracy:
            return 0.5
        return float(np.mean(list(self.recent_accuracy)))


class IncrementalXGBoostModel:
    def __init__(self):
        self.model = None
        self.feature_names: List[str] = []
        self.buffer: List[Dict] = []
        self.buffer_limit = 20
        self.window = deque(maxlen=500)
        self.update_count = 0
        self.is_trained = False

    def add_observation(self, features: Dict, outcome: float):
        self.buffer.append({"features": features, "outcome": outcome})
        self.window.append({"features": features, "outcome": outcome})

        if len(self.buffer) >= self.buffer_limit:
            self._incremental_train()

    def _incremental_train(self):
        if not HAS_XGB or len(self.window) < 50:
            self.buffer.clear()
            return

        if not self.feature_names:
            self.feature_names = sorted(list(self.window)[0]["features"].keys())

        X = np.array([[item["features"].get(k, 0) for k in self.feature_names] for item in self.window])
        y = np.array([1.0 if item["outcome"] >= 0.5 else 0.0 for item in self.window])

        params = {
            "objective": "binary:logistic",
            "max_depth": 4,
            "learning_rate": 0.1,
            "n_estimators": 10,
            "subsample": 0.8,
            "colsample_bytree": 0.8,
        }

        try:
            new_model = xgb.XGBClassifier(**params)
            if self.model is not None:
                new_model.fit(X, y, xgb_model=self.model.get_booster())
            else:
                new_model.fit(X, y)
            
            self.model = new_model
            self.is_trained = True
            self.update_count += 1
            self.buffer.clear()
            logger.info(f"Incremental XGBoost updated (iteration {self.update_count}, window={len(self.window)})")
        except Exception as e:
            logger.error(f"Incremental XGBoost training failed: {e}")
            self.buffer.clear()

    def predict(self, features: Dict) -> float:
        if not self.is_trained or self.model is None:
            return 0.5
        
        x = np.array([[features.get(k, 0) for k in self.feature_names]])
        try:
            return float(self.model.predict_proba(x)[0, 1])
        except Exception:
            return 0.5


class OnlineLearningSystem:
    def __init__(self):
        self.sgd = OnlineSGDModel()
        self.incr_xgb = IncrementalXGBoostModel()
        self.batch_accuracy_baseline = 0.55
        self.drift_threshold = 0.10
        self.last_drift_check = 0
        self.drift_detected = False

    def update(self, features: Dict, outcome: float, trade_id: str = "") -> Dict:
        sgd_result = self.sgd.partial_update(features, outcome)
        self.incr_xgb.add_observation(features, outcome)
        
        self._check_drift()

        return {
            "status": "updated",
            "sgd_updates": self.sgd.update_count,
            "xgb_updates": self.incr_xgb.update_count,
            "trade_id": trade_id,
            "drift_detected": self.drift_detected,
        }

    def predict(self, features: Dict) -> float:
        sgd_prob = self.sgd.predict(features)
        xgb_prob = self.incr_xgb.predict(features)

        if self.sgd.is_fitted and self.incr_xgb.is_trained:
            return 0.4 * sgd_prob + 0.6 * xgb_prob
        elif self.sgd.is_fitted:
            return sgd_prob
        elif self.incr_xgb.is_trained:
            return xgb_prob
        return 0.5

    def _check_drift(self):
        if self.sgd.update_count < 50:
            return
        
        now = time.time()
        if now - self.last_drift_check < 300:
            return
        self.last_drift_check = now

        online_acc = self.sgd.get_accuracy()
        drift = abs(online_acc - self.batch_accuracy_baseline)
        
        if drift > self.drift_threshold:
            self.drift_detected = True
            logger.warning(f"Drift detected: online_acc={online_acc:.3f}, baseline={self.batch_accuracy_baseline:.3f}, gap={drift:.3f}")
        else:
            self.drift_detected = False

    def get_stats(self) -> Dict:
        return {
            "sgd_updates": self.sgd.update_count,
            "sgd_accuracy": round(self.sgd.get_accuracy(), 4),
            "sgd_ema_accuracy": round(self.sgd.ema_accuracy, 4),
            "xgb_updates": self.incr_xgb.update_count,
            "xgb_window_size": len(self.incr_xgb.window),
            "xgb_trained": self.incr_xgb.is_trained,
            "drift_detected": self.drift_detected,
            "batch_baseline": self.batch_accuracy_baseline,
        }

    def set_batch_baseline(self, accuracy: float):
        self.batch_accuracy_baseline = accuracy


online_learner = OnlineLearningSystem()
