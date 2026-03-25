import numpy as np
import logging
import json
import os
from typing import Dict, List, Optional

logger = logging.getLogger("rl_execution")

try:
    import torch
    import torch.nn as nn
    import torch.optim as optim
    HAS_TORCH = True
except (ImportError, OSError) as e:
    HAS_TORCH = False
    logger.warning(f"PyTorch not available — RL agent will use heuristic fallback ({e})")


class ExecutionState:
    """Observation space for the RL execution agent."""

    def __init__(self, features: Dict):
        self.remaining_pct = features.get("remaining_pct", 1.0)
        self.time_elapsed_pct = features.get("time_elapsed_pct", 0.0)
        self.price_move_pct = features.get("price_move_pct", 0.0)
        self.volume_ratio = features.get("volume_ratio", 1.0)
        self.spread_bps = features.get("spread_bps", 5.0)
        self.shortfall_bps = features.get("shortfall_bps", 0.0)
        self.volatility = features.get("volatility", 0.015)
        self.momentum = features.get("momentum", 0.0)

    def to_array(self) -> np.ndarray:
        return np.array([
            self.remaining_pct,
            self.time_elapsed_pct,
            self.price_move_pct,
            self.volume_ratio,
            self.spread_bps / 100.0,
            self.shortfall_bps / 100.0,
            self.volatility,
            self.momentum,
        ], dtype=np.float32)

    @staticmethod
    def dim() -> int:
        return 8


class HeuristicPolicy:
    """Fallback policy when PyTorch is unavailable."""

    def act(self, state: ExecutionState) -> float:
        base_rate = state.remaining_pct / max(0.01, 1.0 - state.time_elapsed_pct)
        base_rate = min(1.0, max(0.01, base_rate))

        if state.price_move_pct > 0.005:
            base_rate *= 1.3
        elif state.price_move_pct < -0.005:
            base_rate *= 0.7

        if state.volume_ratio > 1.5:
            base_rate *= 1.2
        elif state.volume_ratio < 0.5:
            base_rate *= 0.8

        if state.volatility > 0.02:
            base_rate *= 0.9

        return min(1.0, max(0.01, base_rate))


if HAS_TORCH:
    class PolicyNetwork(nn.Module):
        def __init__(self, state_dim: int = 8):
            super().__init__()
            self.shared = nn.Sequential(
                nn.Linear(state_dim, 64),
                nn.ReLU(),
                nn.Linear(64, 32),
                nn.ReLU(),
            )
            self.mu_head = nn.Sequential(nn.Linear(32, 1), nn.Sigmoid())
            self.log_std_head = nn.Linear(32, 1)
            self.value_head = nn.Linear(32, 1)

        def forward(self, x):
            shared = self.shared(x)
            mu = self.mu_head(shared)
            log_std = self.log_std_head(shared).clamp(-2, 0)
            value = self.value_head(shared)
            return mu, log_std, value

    class PPOAgent:
        def __init__(self, state_dim: int = 8, lr: float = 3e-4, gamma: float = 0.99,
                     clip_eps: float = 0.2, epochs: int = 4):
            self.policy = PolicyNetwork(state_dim)
            self.optimizer = optim.Adam(self.policy.parameters(), lr=lr)
            self.gamma = gamma
            self.clip_eps = clip_eps
            self.epochs = epochs
            self.buffer: List[Dict] = []

        def act(self, state: ExecutionState) -> float:
            with torch.no_grad():
                x = torch.FloatTensor(state.to_array()).unsqueeze(0)
                mu, log_std, _ = self.policy(x)
                std = log_std.exp()
                dist = torch.distributions.Normal(mu, std)
                action = dist.sample()
                return float(action.clamp(0.01, 1.0).item())

        def store_transition(self, state: ExecutionState, action: float,
                             reward: float, next_state: ExecutionState, done: bool):
            self.buffer.append({
                "state": state.to_array(),
                "action": action,
                "reward": reward,
                "next_state": next_state.to_array(),
                "done": done,
            })

        def train_step(self) -> Dict:
            if len(self.buffer) < 32:
                return {"status": "insufficient_data", "buffer_size": len(self.buffer)}

            states = torch.FloatTensor(np.array([t["state"] for t in self.buffer]))
            actions = torch.FloatTensor([t["action"] for t in self.buffer]).unsqueeze(1)
            rewards = [t["reward"] for t in self.buffer]
            dones = [t["done"] for t in self.buffer]

            returns = []
            G = 0
            for r, d in zip(reversed(rewards), reversed(dones)):
                G = r + self.gamma * G * (1 - float(d))
                returns.insert(0, G)
            returns = torch.FloatTensor(returns).unsqueeze(1)

            with torch.no_grad():
                mu_old, log_std_old, values_old = self.policy(states)
                std_old = log_std_old.exp()
                dist_old = torch.distributions.Normal(mu_old, std_old)
                log_probs_old = dist_old.log_prob(actions)

            advantages = returns - values_old
            if advantages.std() > 0:
                advantages = (advantages - advantages.mean()) / (advantages.std() + 1e-8)

            total_loss = 0
            for _ in range(self.epochs):
                mu, log_std, values = self.policy(states)
                std = log_std.exp()
                dist = torch.distributions.Normal(mu, std)
                log_probs = dist.log_prob(actions)

                ratio = (log_probs - log_probs_old).exp()
                surr1 = ratio * advantages
                surr2 = ratio.clamp(1 - self.clip_eps, 1 + self.clip_eps) * advantages
                policy_loss = -torch.min(surr1, surr2).mean()

                value_loss = nn.MSELoss()(values, returns)
                entropy = dist.entropy().mean()
                loss = policy_loss + 0.5 * value_loss - 0.01 * entropy

                self.optimizer.zero_grad()
                loss.backward()
                torch.nn.utils.clip_grad_norm_(self.policy.parameters(), 0.5)
                self.optimizer.step()
                total_loss += loss.item()

            self.buffer.clear()
            return {
                "status": "trained",
                "avg_loss": round(total_loss / self.epochs, 4),
                "training_samples": len(states),
            }

        def save(self, path: str):
            torch.save(self.policy.state_dict(), path)
            logger.info(f"RL model saved to {path}")

        def load(self, path: str):
            if os.path.exists(path):
                self.policy.load_state_dict(torch.load(path, weights_only=True))
                logger.info(f"RL model loaded from {path}")


class RLExecutionAgent:
    """Top-level API for the RL Execution Agent."""

    def __init__(self):
        self.agent = PPOAgent() if HAS_TORCH else None
        self.heuristic = HeuristicPolicy()
        self.mode = "shadow"
        self.shadow_log: List[Dict] = []
        self.model_path = os.path.join(os.path.dirname(__file__), "models", "rl_exec.pth")

    def get_action(self, state_features: Dict) -> Dict:
        state = ExecutionState(state_features)
        heuristic_action = self.heuristic.act(state)

        if self.agent:
            rl_action = self.agent.act(state)
        else:
            rl_action = heuristic_action

        if self.mode == "shadow":
            self.shadow_log.append({
                "rl_action": round(rl_action, 4),
                "heuristic_action": round(heuristic_action, 4),
                "state": state_features,
            })
            return {
                "action": round(heuristic_action, 4),
                "rl_suggestion": round(rl_action, 4),
                "mode": "shadow",
                "available": True,
            }

        return {
            "action": round(rl_action, 4),
            "heuristic_fallback": round(heuristic_action, 4),
            "mode": "live",
            "available": True,
        }

    def store_experience(self, state_features: Dict, action: float,
                         reward: float, next_state_features: Dict, done: bool):
        if self.agent:
            self.agent.store_transition(
                ExecutionState(state_features), action, reward,
                ExecutionState(next_state_features), done,
            )

    def train(self) -> Dict:
        if not self.agent:
            return {"status": "unavailable", "reason": "PyTorch not installed"}
        result = self.agent.train_step()
        if result.get("status") == "trained":
            os.makedirs(os.path.dirname(self.model_path), exist_ok=True)
            self.agent.save(self.model_path)
        return result

    def set_mode(self, mode: str):
        if mode in ("shadow", "live"):
            self.mode = mode
            logger.info(f"RL agent mode set to: {mode}")

    def get_shadow_log(self) -> List[Dict]:
        return self.shadow_log[-100:]


rl_agent = RLExecutionAgent()
