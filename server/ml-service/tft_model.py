import numpy as np
import logging
import os
from typing import Dict, List, Optional

logger = logging.getLogger("tft_model")

try:
    import torch
    import torch.nn as nn
    import torch.nn.functional as F
    HAS_TORCH = True
except ImportError:
    HAS_TORCH = False
    logger.warning("PyTorch not available — TFT model will use heuristic fallback")


STATIC_FEATURES = ["sector_id", "cap_category", "is_nifty50", "exchange_id"]
KNOWN_FEATURES = ["day_of_week", "hour_of_day", "is_expiry_day"]
UNKNOWN_FEATURES = [
    "returns", "volume_ratio", "rsi", "macd", "atr", "bb_position",
    "obv", "vwap_dist", "spread_proxy", "adx", "momentum", "volatility",
]

if HAS_TORCH:
    class GatedResidualNetwork(nn.Module):
        def __init__(self, input_dim: int, hidden_dim: int, output_dim: int, dropout: float = 0.1):
            super().__init__()
            self.fc1 = nn.Linear(input_dim, hidden_dim)
            self.fc2 = nn.Linear(hidden_dim, output_dim)
            self.gate = nn.Linear(hidden_dim, output_dim)
            self.dropout = nn.Dropout(dropout)
            self.layer_norm = nn.LayerNorm(output_dim)
            self.skip = nn.Linear(input_dim, output_dim) if input_dim != output_dim else nn.Identity()

        def forward(self, x: torch.Tensor) -> torch.Tensor:
            h = F.elu(self.fc1(x))
            h = self.dropout(h)
            out = self.fc2(h)
            gate = torch.sigmoid(self.gate(h))
            gated = gate * out
            return self.layer_norm(gated + self.skip(x))

    class VariableSelectionNetwork(nn.Module):
        def __init__(self, input_dim: int, num_vars: int, hidden_dim: int, dropout: float = 0.1):
            super().__init__()
            self.grns = nn.ModuleList([
                GatedResidualNetwork(input_dim // num_vars, hidden_dim, hidden_dim, dropout)
                for _ in range(num_vars)
            ])
            self.softmax_layer = nn.Sequential(
                nn.Linear(input_dim, num_vars),
                nn.Softmax(dim=-1),
            )
            self.num_vars = num_vars
            self.var_dim = input_dim // num_vars

        def forward(self, x: torch.Tensor):
            weights = self.softmax_layer(x)
            
            var_outputs = []
            for i in range(self.num_vars):
                start = i * self.var_dim
                end = start + self.var_dim
                var_input = x[..., start:end]
                var_outputs.append(self.grns[i](var_input))
            
            stacked = torch.stack(var_outputs, dim=-2)
            weights_expanded = weights.unsqueeze(-1)
            selected = (stacked * weights_expanded).sum(dim=-2)
            
            return selected, weights

    class TFTNet(nn.Module):
        def __init__(self, static_dim: int = 4, known_dim: int = 3, unknown_dim: int = 12,
                     hidden_dim: int = 32, num_heads: int = 4, dropout: float = 0.1):
            super().__init__()
            self.static_dim = static_dim
            self.known_dim = known_dim
            self.unknown_dim = unknown_dim
            total_time_dim = known_dim + unknown_dim
            
            self.static_encoder = GatedResidualNetwork(static_dim, hidden_dim, hidden_dim, dropout)
            
            self.temporal_encoder = nn.LSTM(
                total_time_dim, hidden_dim, num_layers=1,
                batch_first=True, dropout=0,
            )
            
            self.attention = nn.MultiheadAttention(
                embed_dim=hidden_dim, num_heads=num_heads,
                dropout=dropout, batch_first=True,
            )
            self.attn_norm = nn.LayerNorm(hidden_dim)
            
            self.output_grn = GatedResidualNetwork(hidden_dim * 2, hidden_dim, hidden_dim, dropout)
            self.prob_head = nn.Sequential(nn.Linear(hidden_dim, 1), nn.Sigmoid())
            self.return_head = nn.Linear(hidden_dim, 1)

        def forward(self, static: torch.Tensor, temporal: torch.Tensor):
            static_enc = self.static_encoder(static)
            
            lstm_out, _ = self.temporal_encoder(temporal)
            
            attn_out, attn_weights = self.attention(lstm_out, lstm_out, lstm_out)
            attn_out = self.attn_norm(attn_out + lstm_out)
            
            temporal_summary = attn_out[:, -1, :]
            combined = torch.cat([temporal_summary, static_enc], dim=-1)
            
            output = self.output_grn(combined)
            prob = self.prob_head(output).squeeze(-1)
            expected_return = self.return_head(output).squeeze(-1)
            
            return prob, expected_return, attn_weights

    class TFTTrainer:
        def __init__(self, lr: float = 1e-3, epochs: int = 50, batch_size: int = 32):
            self.model = TFTNet()
            self.optimizer = torch.optim.Adam(self.model.parameters(), lr=lr)
            self.bce_loss = nn.BCELoss()
            self.mse_loss = nn.MSELoss()
            self.epochs = epochs
            self.batch_size = batch_size
            self.is_trained = False
            self.model_path = os.path.join(os.path.dirname(__file__), "models", "tft_signal.pth")

        def train(self, static_data: List[np.ndarray], temporal_data: List[np.ndarray],
                  labels: List[float], returns: List[float],
                  val_split: float = 0.2, purge_gap: int = 5) -> Dict:
            if len(static_data) < 50:
                return {"status": "skipped", "reason": f"only {len(static_data)} samples"}

            X_static = torch.FloatTensor(np.array(static_data))
            X_temporal = torch.FloatTensor(np.array(temporal_data))
            y_label = torch.FloatTensor(labels)
            y_return = torch.FloatTensor(returns)

            split = int(len(X_static) * (1 - val_split))
            train_s = slice(0, split - purge_gap)
            val_s = slice(split, None)

            self.model.train()
            best_val_loss = float("inf")
            patience_counter = 0

            for epoch in range(self.epochs):
                indices = torch.randperm(split - purge_gap)
                total_loss = 0
                n_batches = 0

                for start in range(0, len(indices), self.batch_size):
                    batch_idx = indices[start:start + self.batch_size]
                    
                    self.optimizer.zero_grad()
                    prob, ret, _ = self.model(X_static[batch_idx], X_temporal[batch_idx])
                    loss = self.bce_loss(prob, y_label[batch_idx]) + 0.3 * self.mse_loss(ret, y_return[batch_idx])
                    loss.backward()
                    torch.nn.utils.clip_grad_norm_(self.model.parameters(), 1.0)
                    self.optimizer.step()
                    total_loss += loss.item()
                    n_batches += 1

                self.model.eval()
                with torch.no_grad():
                    v_prob, v_ret, _ = self.model(X_static[val_s], X_temporal[val_s])
                    val_loss = self.bce_loss(v_prob, y_label[val_s]).item()

                if val_loss < best_val_loss:
                    best_val_loss = val_loss
                    patience_counter = 0
                else:
                    patience_counter += 1
                    if patience_counter >= 10:
                        break
                self.model.train()

            self.model.eval()
            with torch.no_grad():
                v_prob, _, _ = self.model(X_static[val_s], X_temporal[val_s])
                preds = (v_prob > 0.5).float()
                accuracy = float((preds == y_label[val_s]).float().mean())

            self.is_trained = True
            os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
            torch.save(self.model.state_dict(), self.model_path)

            return {
                "status": "trained",
                "accuracy": round(accuracy, 4),
                "val_loss": round(best_val_loss, 6),
                "training_samples": split - purge_gap,
                "validation_samples": len(X_static) - split,
            }

        def predict(self, static: np.ndarray, temporal: np.ndarray) -> Dict:
            if not self.is_trained:
                if os.path.exists(self.model_path):
                    self.model.load_state_dict(torch.load(self.model_path, weights_only=True))
                    self.is_trained = True
                else:
                    return self._empty_result()

            self.model.eval()
            with torch.no_grad():
                s = torch.FloatTensor(static).unsqueeze(0)
                t = torch.FloatTensor(temporal).unsqueeze(0)
                prob, expected_return, attn_weights = self.model(s, t)
                
                attn = attn_weights.squeeze(0).mean(dim=0).tolist()
                
                return {
                    "probability": round(float(prob.item()), 4),
                    "expected_return": round(float(expected_return.item()), 6),
                    "attention_weights": [round(float(w), 4) for w in attn[-5:]] if isinstance(attn[0], float) else [],
                    "feature_importance": {},
                    "available": True,
                }

        def _empty_result(self) -> Dict:
            return {
                "probability": 0.5,
                "expected_return": 0.0,
                "attention_weights": [],
                "feature_importance": {},
                "available": False,
            }


class HeuristicTFTScorer:
    def predict(self, static: Dict, temporal: List[Dict]) -> Dict:
        if not temporal or len(temporal) < 5:
            return {"probability": 0.5, "expected_return": 0.0, "attention_weights": [], "feature_importance": {}, "available": False}
        
        recent = temporal[-10:]
        returns = [float(b.get("returns", 0)) for b in recent]
        momentum = np.mean(returns) if returns else 0
        vol = np.std(returns) if len(returns) > 1 else 0.01
        
        signal = momentum / max(vol, 0.001) * 0.1
        prob = 0.5 + np.clip(signal, -0.3, 0.3)
        
        return {
            "probability": round(float(prob), 4),
            "expected_return": round(float(momentum * 5), 6),
            "attention_weights": [],
            "feature_importance": {},
            "available": False,
        }


class TemporalFusionTransformerModel:
    def __init__(self):
        self.trainer = TFTTrainer() if HAS_TORCH else None
        self.heuristic = HeuristicTFTScorer()

    def score(self, static_features: Dict, sequence: List[Dict], seq_len: int = 30) -> Dict:
        if self.trainer:
            static_arr = self._encode_static(static_features)
            temporal_arr = self._encode_temporal(sequence, seq_len)
            
            if temporal_arr is not None:
                if self.trainer.is_trained:
                    return self.trainer.predict(static_arr, temporal_arr)
                result = self.trainer.predict(static_arr, temporal_arr)
                if result["available"]:
                    return result

        return self.heuristic.predict(static_features, sequence)

    def train(self, training_data: List[Dict], seq_len: int = 30) -> Dict:
        if not self.trainer:
            return {"status": "unavailable", "reason": "PyTorch not installed"}

        static_list, temporal_list, labels, returns = [], [], [], []
        
        for item in training_data:
            static = self._encode_static(item.get("static_features", {}))
            temporal = self._encode_temporal(item.get("sequence", []), seq_len)
            if temporal is not None:
                static_list.append(static)
                temporal_list.append(temporal)
                labels.append(float(item.get("outcome", 0.5)))
                returns.append(float(item.get("forward_return", 0.0)))

        if len(static_list) < 50:
            return {"status": "skipped", "reason": f"only {len(static_list)} valid sequences"}

        return self.trainer.train(static_list, temporal_list, labels, returns)

    def _encode_static(self, features: Dict) -> np.ndarray:
        return np.array([
            float(features.get("sector_id", 0)),
            float(features.get("cap_category", 1)),
            float(features.get("is_nifty50", 0)),
            float(features.get("exchange_id", 0)),
        ], dtype=np.float32)

    def _encode_temporal(self, sequence: List[Dict], seq_len: int) -> Optional[np.ndarray]:
        if len(sequence) < 5:
            return None

        rows = []
        for bar in sequence[-seq_len:]:
            row = []
            for feat in KNOWN_FEATURES + UNKNOWN_FEATURES:
                row.append(float(bar.get(feat, 0)))
            rows.append(row)

        arr = np.array(rows, dtype=np.float32)
        
        for col in range(arr.shape[1]):
            col_std = arr[:, col].std()
            col_mean = arr[:, col].mean()
            if col_std > 0:
                arr[:, col] = (arr[:, col] - col_mean) / col_std

        if len(rows) < seq_len:
            pad = np.zeros((seq_len - len(rows), arr.shape[1]), dtype=np.float32)
            arr = np.vstack([pad, arr])

        return arr


tft_model = TemporalFusionTransformerModel()
