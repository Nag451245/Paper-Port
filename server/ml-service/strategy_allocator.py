"""
Strategy Allocator — Thompson sampling + Bayesian optimization for capital allocation.

Allocates capital across strategies based on:
  - Historical win/loss (Beta posterior via Thompson sampling)
  - Sharpe ratio (risk-adjusted returns)
  - Current market regime (shift weights accordingly)
  - Exploration/exploitation balance
"""

import logging
import numpy as np

log = logging.getLogger("StrategyAllocator")

# Regime-specific strategy preferences (0-1 weight multiplier)
REGIME_STRATEGY_AFFINITY = {
    "trending_up": {
        "orb": 0.8, "sector_rotation": 1.0, "volatility_breakout": 0.7,
        "mean_reversion": 0.3, "pairs": 0.5, "gap_trading": 0.7,
        "vwap_reversion": 0.4, "expiry_theta": 0.3, "composite": 0.8,
    },
    "trending_down": {
        "orb": 0.6, "sector_rotation": 0.3, "volatility_breakout": 0.5,
        "mean_reversion": 0.7, "pairs": 0.8, "gap_trading": 0.6,
        "vwap_reversion": 0.7, "expiry_theta": 0.5, "composite": 0.5,
    },
    "ranging": {
        "orb": 0.3, "sector_rotation": 0.3, "volatility_breakout": 0.3,
        "mean_reversion": 1.0, "pairs": 1.0, "gap_trading": 0.4,
        "vwap_reversion": 1.0, "expiry_theta": 0.8, "composite": 0.5,
    },
    "volatile": {
        "orb": 0.4, "sector_rotation": 0.2, "volatility_breakout": 1.0,
        "mean_reversion": 0.5, "pairs": 0.6, "gap_trading": 0.5,
        "vwap_reversion": 0.5, "expiry_gamma": 1.0, "composite": 0.4,
    },
}

MIN_ALLOCATION_PCT = 5.0
MAX_ALLOCATION_PCT = 40.0


class StrategyAllocator:
    def allocate(
        self,
        strategy_stats: list,
        total_capital: float,
        current_regime: str,
        risk_budget_pct: float,
    ) -> dict:
        if not strategy_stats:
            return {
                "allocations": {},
                "capital_per_strategy": {},
                "method": "empty",
                "exploration_rate": 0.0,
            }

        n = len(strategy_stats)
        rng = np.random.default_rng(42)

        # Thompson sampling: draw from Beta(alpha, beta) for each strategy
        thompson_scores = np.zeros(n)
        for i, st in enumerate(strategy_stats):
            s = st if isinstance(st, dict) else st.dict() if hasattr(st, "dict") else {}
            alpha = max(1, s.get("wins", 0) + 1)
            beta_param = max(1, s.get("losses", 0) + 1)
            thompson_scores[i] = rng.beta(alpha, beta_param)

        # Sharpe-weighted adjustment
        sharpe_scores = np.zeros(n)
        for i, st in enumerate(strategy_stats):
            s = st if isinstance(st, dict) else st.dict() if hasattr(st, "dict") else {}
            sharpe = s.get("sharpe", 0.0)
            sharpe_scores[i] = max(0.0, 1.0 + sharpe * 0.3)

        # Regime affinity adjustment
        regime_key = current_regime.lower().replace("-", "_").replace(" ", "_")
        affinity = REGIME_STRATEGY_AFFINITY.get(regime_key, {})

        regime_scores = np.ones(n)
        for i, st in enumerate(strategy_stats):
            s = st if isinstance(st, dict) else st.dict() if hasattr(st, "dict") else {}
            sid = s.get("strategy_id", "")
            # Match by strategy ID or prefix
            matched_affinity = affinity.get(sid, None)
            if matched_affinity is None:
                for key, val in affinity.items():
                    if key in sid or sid in key:
                        matched_affinity = val
                        break
            if matched_affinity is not None:
                regime_scores[i] = matched_affinity

        # Decay penalty: reduce allocation for decaying strategies
        decay_penalty = np.ones(n)
        for i, st in enumerate(strategy_stats):
            s = st if isinstance(st, dict) else st.dict() if hasattr(st, "dict") else {}
            if s.get("is_decaying", False):
                decay_penalty[i] = 0.5

        # Combined score
        combined = thompson_scores * sharpe_scores * regime_scores * decay_penalty

        # Normalize to allocation percentages
        total_score = combined.sum()
        if total_score <= 0:
            raw_pcts = np.ones(n) / n * 100
        else:
            raw_pcts = combined / total_score * 100

        # Enforce min/max allocation
        clamped = np.clip(raw_pcts, MIN_ALLOCATION_PCT, MAX_ALLOCATION_PCT)

        # Re-normalize to sum to 100
        if clamped.sum() > 0:
            clamped = clamped / clamped.sum() * 100

        # Build result
        allocations = {}
        capital_per_strategy = {}
        for i, st in enumerate(strategy_stats):
            s = st if isinstance(st, dict) else st.dict() if hasattr(st, "dict") else {}
            sid = s.get("strategy_id", f"strategy_{i}")
            pct = round(float(clamped[i]), 2)
            allocations[sid] = pct
            capital_per_strategy[sid] = round(total_capital * pct / 100, 2)

        # Exploration rate: fraction of allocation driven by Thompson sampling vs pure performance
        thompson_entropy = float(-np.sum(
            np.where(thompson_scores > 0, thompson_scores * np.log(thompson_scores + 1e-10), 0)
        ))
        exploration_rate = min(1.0, thompson_entropy / max(1.0, np.log(n + 1)))

        log.info(
            f"Allocated {n} strategies, regime={current_regime}, "
            f"exploration={exploration_rate:.2f}, total_capital={total_capital}"
        )

        return {
            "allocations": allocations,
            "capital_per_strategy": capital_per_strategy,
            "method": "thompson_bayesian_regime",
            "exploration_rate": round(exploration_rate, 4),
        }
