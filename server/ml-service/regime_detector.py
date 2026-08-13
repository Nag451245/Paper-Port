"""
Regime Detector — Hidden Markov Model for market regime classification.

States:
  0: trending_up   — sustained positive returns, low-moderate volatility
  1: trending_down  — sustained negative returns, rising volatility
  2: ranging        — low returns, low volatility, mean-reverting
  3: volatile       — high volatility, erratic returns, crisis mode
"""

import logging
import numpy as np

log = logging.getLogger("RegimeDetector")

REGIME_LABELS = {
    0: "trending_up",
    1: "trending_down",
    2: "ranging",
    3: "volatile",
}


class RegimeDetector:
    def __init__(self, cache_ttl_seconds: int = 300):
        self._model = None
        self._fitted = False
        self._cache: dict = {}
        self._cache_ttl = cache_ttl_seconds

    def _data_hash(self, returns, volatility, correlations, n_states) -> str:
        import hashlib
        raw = f"{returns[-5:]}{volatility[-5:]}{len(returns)}{n_states}"
        return hashlib.md5(raw.encode()).hexdigest()

    def detect(
        self,
        returns: list[float],
        volatility: list[float],
        correlations: list[float],
        n_states: int = 4,
    ) -> dict:
        # Check cache: return cached result if same data shape within TTL
        import time
        cache_key = self._data_hash(returns, volatility, correlations, n_states)
        cached = self._cache.get(cache_key)
        if cached and (time.time() - cached["ts"]) < self._cache_ttl:
            log.info("Returning cached HMM regime result")
            return cached["result"]
        """Detect current market regime using Gaussian HMM."""
        if len(returns) < 10:
            raise ValueError(f"Need at least 10 data points, got {len(returns)}")

        n = min(len(returns), len(volatility))
        ret_arr = np.array(returns[:n])
        vol_arr = np.array(volatility[:n])

        # Build observation matrix: [returns, volatility, (optional) correlation]
        if correlations and len(correlations) >= n:
            obs = np.column_stack([ret_arr, vol_arr, np.array(correlations[:n])])
        else:
            obs = np.column_stack([ret_arr, vol_arr])

        obs = np.nan_to_num(obs, nan=0.0, posinf=0.0, neginf=0.0)

        try:
            from hmmlearn.hmm import GaussianHMM

            model = GaussianHMM(
                n_components=min(n_states, 4),
                covariance_type="full",
                n_iter=100,
                random_state=42,
                tol=0.01,
            )
            model.fit(obs)
            self._model = model
            self._fitted = True

            hidden_states = model.predict(obs)
            current_state = int(hidden_states[-1])

            # State probabilities for the last observation
            log_prob, posteriors = model.score_samples(obs)
            current_probs = posteriors[-1]

            # Map states to regime labels by sorting means
            state_means = model.means_[:, 0]  # return dimension
            state_vols = model.means_[:, 1] if obs.shape[1] > 1 else np.zeros(n_states)

            regime_map = self._assign_regime_labels(state_means, state_vols, n_states)

            transition_matrix = model.transmat_.tolist()

            regime_name = regime_map.get(current_state, f"state_{current_state}")

            prob_dict = {}
            for s_id in range(min(n_states, len(current_probs))):
                label = regime_map.get(s_id, f"state_{s_id}")
                prob_dict[label] = round(float(current_probs[s_id]), 4)

        except ImportError:
            # hmmlearn not available — use simple rule-based fallback
            log.warning("hmmlearn not installed — using rule-based regime detection")
            return self._rule_based_regime(ret_arr, vol_arr)
        except Exception as e:
            log.warning(f"HMM fitting failed ({e}) — using rule-based fallback")
            return self._rule_based_regime(ret_arr, vol_arr)

        result = {
            "current_regime": regime_name,
            "regime_id": current_state,
            "regime_probabilities": prob_dict,
            "transition_matrix": transition_matrix,
            "regime_labels": regime_map,
        }
        self._cache[cache_key] = {"result": result, "ts": time.time()}
        return result

    def _assign_regime_labels(
        self, state_means: np.ndarray, state_vols: np.ndarray, n_states: int
    ) -> dict:
        """Assign human-readable labels to HMM states based on their characteristics."""
        labels = {}
        n = min(n_states, len(state_means))

        # Sort states by return mean
        sorted_by_return = np.argsort(state_means[:n])

        if n >= 4:
            # 4-state model: trending_down, ranging, trending_up, volatile
            vol_ranks = np.argsort(state_vols[:n])
            highest_vol = int(vol_ranks[-1])

            labels[highest_vol] = "volatile"

            remaining = [i for i in sorted_by_return if i != highest_vol]
            if len(remaining) >= 3:
                labels[remaining[0]] = "trending_down"
                labels[remaining[1]] = "ranging"
                labels[remaining[2]] = "trending_up"
            elif len(remaining) == 2:
                labels[remaining[0]] = "trending_down"
                labels[remaining[1]] = "trending_up"
        elif n == 3:
            labels[int(sorted_by_return[0])] = "trending_down"
            labels[int(sorted_by_return[1])] = "ranging"
            labels[int(sorted_by_return[2])] = "trending_up"
        elif n == 2:
            labels[int(sorted_by_return[0])] = "bearish"
            labels[int(sorted_by_return[1])] = "bullish"

        # Fill any gaps
        for i in range(n):
            if i not in labels:
                labels[i] = f"state_{i}"

        return {int(k): v for k, v in labels.items()}

    def _rule_based_regime(self, returns: np.ndarray, volatility: np.ndarray) -> dict:
        """Simple rule-based fallback when HMM is unavailable."""
        recent_ret = np.mean(returns[-10:]) if len(returns) >= 10 else np.mean(returns)
        recent_vol = np.mean(volatility[-10:]) if len(volatility) >= 10 else np.mean(volatility)

        median_vol = np.median(volatility)
        high_vol = recent_vol > median_vol * 1.5

        if high_vol:
            regime = "volatile"
            regime_id = 3
        elif recent_ret > 0.001:
            regime = "trending_up"
            regime_id = 0
        elif recent_ret < -0.001:
            regime = "trending_down"
            regime_id = 1
        else:
            regime = "ranging"
            regime_id = 2

        return {
            "current_regime": regime,
            "regime_id": regime_id,
            "regime_probabilities": {regime: 1.0},
            "transition_matrix": [[1.0]],
            "regime_labels": {regime_id: regime},
        }
