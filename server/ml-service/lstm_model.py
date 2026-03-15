import numpy as np
import logging
import os
from typing import Dict, List, Optional

logger = logging.getLogger("lstm_model")

try:
    import torch
    import torch.nn as nn
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    logger.warning("PyTorch not available — LSTM model will use heuristic fallback")


class BarSequenceEncoder:
    FEATURES = ["open", "high", "low", "close", "volume", "returns", "volatility", "volume_ratio"]
    
    @staticmethod
    def encode(bars: List[Dict], seq_len: int = 60) -> Optional[np.ndarray]:
        if len(bars) < 10:
            return None
        
        raw = []
        for i, bar in enumerate(bars[-seq_len:]):
            close = float(bar.get("close", 0))
            prev_close = float(bars[max(0, len(bars) - seq_len + i - 1)].get("close", close))
            ret = (close - prev_close) / prev_close if prev_close > 0 else 0
            
            row = [
                float(bar.get("open", 0)),
                float(bar.get("high", 0)),
                float(bar.get("low", 0)),
                close,
                float(bar.get("volume", 0)),
                ret,
                abs(ret),
                float(bar.get("volume", 1)) / max(float(bar.get("avg_volume", 1)), 1),
            ]
            raw.append(row)
        
        arr = np.array(raw, dtype=np.float32)
        
        for col in range(arr.shape[1]):
            col_std = arr[:, col].std()
            col_mean = arr[:, col].mean()
            if col_std > 0:
                arr[:, col] = (arr[:, col] - col_mean) / col_std
        
        if len(raw) < seq_len:
            pad = np.zeros((seq_len - len(raw), 8), dtype=np.float32)
            arr = np.vstack([pad, arr])
        
        return arr


if HAS_TORCH:
    class BiLSTMNet(nn.Module):
        def __init__(self, input_dim: int = 8, hidden_dim: int = 64, num_layers: int = 2,
                     dropout: float = 0.2, embedding_dim: int = 32):
            super().__init__()
            self.lstm = nn.LSTM(
                input_dim, hidden_dim, num_layers=num_layers,
                batch_first=True, bidirectional=True, dropout=dropout if num_layers > 1 else 0,
            )
            self.fc = nn.Sequential(
                nn.Linear(hidden_dim * 2, 128),
                nn.ReLU(),
                nn.Dropout(dropout),
                nn.Linear(128, embedding_dim),
                nn.ReLU(),
            )
            self.output_head = nn.Linear(embedding_dim, 1)
            self.sigmoid = nn.Sigmoid()

        def forward(self, x: torch.Tensor):
            lstm_out, _ = self.lstm(x)
            last_hidden = lstm_out[:, -1, :]
            embedding = self.fc(last_hidden)
            logit = self.output_head(embedding)
            prob = self.sigmoid(logit)
            return prob.squeeze(-1), embedding

    class LSTMTrainer:
        def __init__(self, lr: float = 1e-3, epochs: int = 50, batch_size: int = 32):
            self.model = BiLSTMNet()
            self.optimizer = torch.optim.Adam(self.model.parameters(), lr=lr)
            self.criterion = nn.BCELoss()
            self.epochs = epochs
            self.batch_size = batch_size
            self.is_trained = False
            self.model_path = os.path.join(os.path.dirname(__file__), "models", "lstm_signal.pth")

        def train(self, sequences: List[np.ndarray], labels: List[float],
                  val_split: float = 0.2, purge_gap: int = 5) -> Dict:
            if len(sequences) < 50:
                return {"status": "skipped", "reason": f"only {len(sequences)} samples"}

            X = torch.FloatTensor(np.array(sequences))
            y = torch.FloatTensor(labels)

            split = int(len(X) * (1 - val_split))
            X_train, X_val = X[:split - purge_gap], X[split:]
            y_train, y_val = y[:split - purge_gap], y[split:]

            if len(X_val) < 10:
                X_val, y_val = X[split:], y[split:]

            self.model.train()
            best_val_loss = float("inf")
            patience_counter = 0

            for epoch in range(self.epochs):
                indices = torch.randperm(len(X_train))
                total_loss = 0
                n_batches = 0

                for start in range(0, len(X_train), self.batch_size):
                    batch_idx = indices[start:start + self.batch_size]
                    xb, yb = X_train[batch_idx], y_train[batch_idx]

                    self.optimizer.zero_grad()
                    probs, _ = self.model(xb)
                    loss = self.criterion(probs, yb)
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
                    self.optimizer.step()
                    total_loss += loss.item()
                    n_batches += 1

                self.model.eval()
                with torch.no_grad():
                    val_probs, _ = self.model(X_val)
                    val_loss = self.criterion(val_probs, y_val).item()

                if val_loss < best_val_loss:
                    best_val_loss = val_loss
                    patience_counter = 0
                else:
                    patience_counter += 1
                    if patience_counter >= 10:
                        logger.info(f"Early stopping at epoch {epoch}")
                        break

                self.model.train()

            self.model.eval()
            with torch.no_grad():
                val_probs, _ = self.model(X_val)
                preds = (val_probs > 0.5).float()
                accuracy = float((preds == y_val).float().mean())
                
            self.is_trained = True
            os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
            torch.save(self.model.state_dict(), self.model_path)

            return {
                "status": "trained",
                "accuracy": round(accuracy, 4),
                "val_loss": round(best_val_loss, 6),
                "training_samples": len(X_train),
                "validation_samples": len(X_val),
                "epochs_run": epoch + 1,
            }

        def predict(self, sequence: np.ndarray) -> Dict:
            if not self.is_trained:
                if os.path.exists(self.model_path):
                    self.model.load_state_dict(torch.load(self.model_path, weights_only=True))
                    self.is_trained = True
                else:
                    return {"probability": 0.5, "embedding": [], "available": False}

            self.model.eval()
            with torch.no_grad():
                x = torch.FloatTensor(sequence).unsqueeze(0)
                prob, embedding = self.model(x)
                return {
                    "probability": round(float(prob.item()), 4),
                    "embedding": [round(float(v), 4) for v in embedding.squeeze().tolist()],
                    "available": True,
                }


class HeuristicSequenceScorer:
    def predict(self, sequence: np.ndarray) -> Dict:
        if sequence is None or len(sequence) < 5:
            return {"probability": 0.5, "embedding": [], "available": False}
        
        recent = sequence[-10:]
        returns_col = recent[:, 5] if recent.shape[1] > 5 else np.zeros(len(recent))
        
        momentum = float(np.mean(returns_col))
        vol = float(np.std(returns_col)) if len(returns_col) > 1 else 0.01
        trend_strength = abs(momentum) / max(vol, 0.001)
        
        prob = 0.5 + np.clip(trend_strength * 0.1, -0.3, 0.3)
        
        return {"probability": round(float(prob), 4), "embedding": [], "available": False}


class LSTMSequenceModel:
    def __init__(self):
        if HAS_TORCH:
            self.trainer = LSTMTrainer()
        else:
            self.trainer = None
        self.heuristic = HeuristicSequenceScorer()
        self.encoder = BarSequenceEncoder()

    def score(self, bars: List[Dict], seq_len: int = 60) -> Dict:
        sequence = self.encoder.encode(bars, seq_len)
        if sequence is None:
            return {"probability": 0.5, "embedding": [], "available": False}

        if self.trainer and self.trainer.is_trained:
            return self.trainer.predict(sequence)
        
        if self.trainer:
            result = self.trainer.predict(sequence)
            if result["available"]:
                return result

        return self.heuristic.predict(sequence)

    def train(self, training_data: List[Dict], seq_len: int = 60) -> Dict:
        if not self.trainer:
            return {"status": "unavailable", "reason": "PyTorch not installed"}

        sequences = []
        labels = []
        for item in training_data:
            bars = item.get("bars", [])
            outcome = float(item.get("outcome", 0.5))
            seq = self.encoder.encode(bars, seq_len)
            if seq is not None:
                sequences.append(seq)
                labels.append(outcome)

        if len(sequences) < 50:
            return {"status": "skipped", "reason": f"only {len(sequences)} valid sequences"}

        return self.trainer.train(sequences, labels)


lstm_model = LSTMSequenceModel()
