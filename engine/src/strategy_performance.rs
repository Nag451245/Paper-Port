use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

const MAX_OUTCOMES: usize = 500;
const DECAY_WINDOW: usize = 50;
const MIN_SIGNALS_FOR_CALIBRATION: usize = 20;
const RETIREMENT_THRESHOLD: f64 = 0.35;
const REINSTATEMENT_COOLDOWN_SIGNALS: usize = 100;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SignalOutcome {
    pub symbol: String,
    pub strategy: String,
    pub direction: String,
    pub predicted_confidence: f64,
    pub entry_price: f64,
    pub exit_price: f64,
    pub pnl_pct: f64,
    pub won: bool,
    pub regime: String,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyHealth {
    pub strategy_id: String,
    pub total_signals: usize,
    pub recent_signals: usize,
    pub win_rate_all: f64,
    pub win_rate_recent: f64,
    pub avg_pnl_pct: f64,
    pub sharpe: f64,
    pub consistency_score: f64,
    pub health_score: f64,
    pub is_retired: bool,
    pub retirement_reason: Option<String>,
    pub regime_performance: HashMap<String, RegimeStats>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RegimeStats {
    pub wins: usize,
    pub losses: usize,
    pub win_rate: f64,
    pub avg_pnl: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CalibrationBucket {
    pub predicted_range: (f64, f64),
    pub actual_win_rate: f64,
    pub count: usize,
    pub calibration_error: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
struct RetiredStrategy {
    strategy_id: String,
    reason: String,
    retired_at_signal_count: usize,
}

pub struct StrategyPerformanceTracker {
    outcomes: Mutex<Vec<SignalOutcome>>,
    retired: Mutex<Vec<RetiredStrategy>>,
    global_signal_count: Mutex<usize>,
}

impl StrategyPerformanceTracker {
    pub fn new() -> Self {
        Self {
            outcomes: Mutex::new(Vec::new()),
            retired: Mutex::new(Vec::new()),
            global_signal_count: Mutex::new(0),
        }
    }

    pub fn record_outcome(&self, outcome: SignalOutcome) {
        let mut outcomes = self.outcomes.lock().unwrap();
        outcomes.push(outcome);
        if outcomes.len() > MAX_OUTCOMES * 2 {
            let drain_count = outcomes.len() - MAX_OUTCOMES;
            outcomes.drain(..drain_count);
        }
        let mut count = self.global_signal_count.lock().unwrap();
        *count += 1;
    }

    pub fn load_outcomes(&self, data: Vec<SignalOutcome>) {
        let mut outcomes = self.outcomes.lock().unwrap();
        *outcomes = data;
        let mut count = self.global_signal_count.lock().unwrap();
        *count = outcomes.len();
    }

    pub fn get_all_outcomes(&self) -> Vec<SignalOutcome> {
        self.outcomes.lock().unwrap().clone()
    }

    pub fn get_strategy_health(&self, strategy_id: &str) -> StrategyHealth {
        let outcomes = self.outcomes.lock().unwrap();
        let strat_outcomes: Vec<&SignalOutcome> = outcomes.iter()
            .filter(|o| o.strategy == strategy_id)
            .collect();

        let total = strat_outcomes.len();
        let wins_all = strat_outcomes.iter().filter(|o| o.won).count();
        let win_rate_all = if total > 0 { wins_all as f64 / total as f64 } else { 0.5 };

        let recent = &strat_outcomes[strat_outcomes.len().saturating_sub(DECAY_WINDOW)..];
        let recent_wins = recent.iter().filter(|o| o.won).count();
        let win_rate_recent = if !recent.is_empty() { recent_wins as f64 / recent.len() as f64 } else { 0.5 };

        let pnls: Vec<f64> = strat_outcomes.iter().map(|o| o.pnl_pct).collect();
        let avg_pnl = if !pnls.is_empty() { pnls.iter().sum::<f64>() / pnls.len() as f64 } else { 0.0 };

        let sharpe = compute_sharpe(&pnls);
        let consistency = compute_consistency(&strat_outcomes);

        let health = 0.3 * win_rate_recent + 0.25 * (sharpe / 3.0).clamp(0.0, 1.0)
            + 0.25 * avg_pnl.clamp(-0.05, 0.05).remap(-0.05, 0.05, 0.0, 1.0)
            + 0.2 * consistency;

        let mut regime_perf = HashMap::new();
        for regime in &["trending", "mean_reverting", "volatile", "neutral"] {
            let r_outcomes: Vec<&&SignalOutcome> = strat_outcomes.iter()
                .filter(|o| o.regime == *regime)
                .collect();
            if !r_outcomes.is_empty() {
                let r_wins = r_outcomes.iter().filter(|o| o.won).count();
                let r_avg = r_outcomes.iter().map(|o| o.pnl_pct).sum::<f64>() / r_outcomes.len() as f64;
                regime_perf.insert(regime.to_string(), RegimeStats {
                    wins: r_wins,
                    losses: r_outcomes.len() - r_wins,
                    win_rate: r_wins as f64 / r_outcomes.len() as f64,
                    avg_pnl: r_avg,
                });
            }
        }

        let retired_list = self.retired.lock().unwrap();
        let is_retired = retired_list.iter().any(|r| r.strategy_id == strategy_id);
        let retirement_reason = retired_list.iter()
            .find(|r| r.strategy_id == strategy_id)
            .map(|r| r.reason.clone());

        StrategyHealth {
            strategy_id: strategy_id.to_string(),
            total_signals: total,
            recent_signals: recent.len(),
            win_rate_all,
            win_rate_recent,
            avg_pnl_pct: avg_pnl,
            sharpe,
            consistency_score: consistency,
            health_score: health.clamp(0.0, 1.0),
            is_retired,
            retirement_reason,
            regime_performance: regime_perf,
        }
    }

    pub fn get_all_strategy_health(&self) -> Vec<StrategyHealth> {
        let outcomes = self.outcomes.lock().unwrap();
        let mut strategies: Vec<String> = outcomes.iter().map(|o| o.strategy.clone()).collect();
        strategies.sort();
        strategies.dedup();
        drop(outcomes);

        strategies.iter().map(|s| self.get_strategy_health(s)).collect()
    }

    pub fn detect_and_retire_decaying(&self) -> Vec<String> {
        let health_list = self.get_all_strategy_health();
        let global_count = *self.global_signal_count.lock().unwrap();
        let mut newly_retired = Vec::new();

        let mut retired = self.retired.lock().unwrap();

        for h in &health_list {
            if h.is_retired || h.recent_signals < 10 {
                continue;
            }

            let should_retire = h.win_rate_recent < RETIREMENT_THRESHOLD
                && h.health_score < 0.3
                && h.sharpe < 0.0;

            if should_retire {
                let reason = format!(
                    "Decaying: WR={:.0}%, Health={:.2}, Sharpe={:.2}",
                    h.win_rate_recent * 100.0, h.health_score, h.sharpe
                );
                retired.push(RetiredStrategy {
                    strategy_id: h.strategy_id.clone(),
                    reason: reason.clone(),
                    retired_at_signal_count: global_count,
                });
                newly_retired.push(h.strategy_id.clone());
            }
        }

        retired.retain(|r| {
            let elapsed = global_count.saturating_sub(r.retired_at_signal_count);
            elapsed < REINSTATEMENT_COOLDOWN_SIGNALS
        });

        newly_retired
    }

    pub fn is_strategy_retired(&self, strategy_id: &str) -> bool {
        self.retired.lock().unwrap().iter().any(|r| r.strategy_id == strategy_id)
    }

    pub fn get_active_strategies(&self) -> Vec<String> {
        let outcomes = self.outcomes.lock().unwrap();
        let mut strategies: Vec<String> = outcomes.iter().map(|o| o.strategy.clone()).collect();
        strategies.sort();
        strategies.dedup();
        drop(outcomes);

        let retired = self.retired.lock().unwrap();
        strategies.into_iter()
            .filter(|s| !retired.iter().any(|r| &r.strategy_id == s))
            .collect()
    }

    pub fn get_retired_strategies(&self) -> Vec<(String, String)> {
        self.retired.lock().unwrap().iter()
            .map(|r| (r.strategy_id.clone(), r.reason.clone()))
            .collect()
    }

    pub fn calibrate_confidence(&self, raw_confidence: f64, strategy: &str) -> f64 {
        let outcomes = self.outcomes.lock().unwrap();
        let strat_outcomes: Vec<&SignalOutcome> = outcomes.iter()
            .filter(|o| o.strategy == strategy)
            .collect();

        if strat_outcomes.len() < MIN_SIGNALS_FOR_CALIBRATION {
            return raw_confidence;
        }

        let buckets = build_calibration_buckets(&strat_outcomes);
        isotonic_calibrate(raw_confidence, &buckets)
    }

    pub fn get_calibration_stats(&self) -> Vec<CalibrationBucket> {
        let outcomes = self.outcomes.lock().unwrap();
        let all_refs: Vec<&SignalOutcome> = outcomes.iter().collect();
        build_calibration_buckets(&all_refs)
    }

    pub fn get_regime_weighted_confidence(
        &self, raw_confidence: f64, strategy: &str, current_regime: &str,
    ) -> f64 {
        let health = self.get_strategy_health(strategy);

        let regime_multiplier = health.regime_performance
            .get(current_regime)
            .map(|r| {
                if r.wins + r.losses < 5 { 1.0 }
                else { (r.win_rate / 0.5).clamp(0.5, 1.5) }
            })
            .unwrap_or(1.0);

        let health_multiplier = (health.health_score / 0.5).clamp(0.5, 1.5);

        let calibrated = self.calibrate_confidence(raw_confidence, strategy);

        (calibrated * regime_multiplier * health_multiplier).clamp(0.0, 1.0)
    }

    pub fn persist_to_file(&self, path: &str) -> Result<(), String> {
        let outcomes = self.outcomes.lock().unwrap();
        let json = serde_json::to_string_pretty(&*outcomes)
            .map_err(|e| format!("Serialization error: {}", e))?;
        std::fs::write(path, json).map_err(|e| format!("Write error: {}", e))
    }

    pub fn load_from_file(&self, path: &str) -> Result<usize, String> {
        let data = std::fs::read_to_string(path).map_err(|e| format!("Read error: {}", e))?;
        let outcomes: Vec<SignalOutcome> = serde_json::from_str(&data)
            .map_err(|e| format!("Parse error: {}", e))?;
        let count = outcomes.len();
        self.load_outcomes(outcomes);
        Ok(count)
    }
}

fn compute_sharpe(pnls: &[f64]) -> f64 {
    if pnls.len() < 5 { return 0.0; }
    let mean = pnls.iter().sum::<f64>() / pnls.len() as f64;
    let variance = pnls.iter().map(|p| (p - mean).powi(2)).sum::<f64>() / (pnls.len() - 1) as f64;
    let std_dev = variance.sqrt();
    if std_dev < 1e-10 { return 0.0; }
    (mean / std_dev) * (252.0_f64).sqrt()
}

fn compute_consistency(outcomes: &[&SignalOutcome]) -> f64 {
    if outcomes.len() < 10 { return 0.5; }
    let window = 10;
    let mut streak_scores = Vec::new();
    for chunk in outcomes.windows(window) {
        let wins = chunk.iter().filter(|o| o.won).count();
        streak_scores.push(wins as f64 / window as f64);
    }
    if streak_scores.is_empty() { return 0.5; }
    let mean = streak_scores.iter().sum::<f64>() / streak_scores.len() as f64;
    let var = streak_scores.iter().map(|s| (s - mean).powi(2)).sum::<f64>()
        / streak_scores.len() as f64;
    (1.0 - var.sqrt() * 2.0).clamp(0.0, 1.0)
}

fn build_calibration_buckets(outcomes: &[&SignalOutcome]) -> Vec<CalibrationBucket> {
    let num_buckets = 10;
    let mut buckets = Vec::new();

    for i in 0..num_buckets {
        let lo = i as f64 / num_buckets as f64;
        let hi = (i + 1) as f64 / num_buckets as f64;
        let in_bucket: Vec<&&SignalOutcome> = outcomes.iter()
            .filter(|o| o.predicted_confidence >= lo && o.predicted_confidence < hi)
            .collect();
        if in_bucket.is_empty() { continue; }
        let actual = in_bucket.iter().filter(|o| o.won).count() as f64 / in_bucket.len() as f64;
        let predicted_mid = (lo + hi) / 2.0;
        buckets.push(CalibrationBucket {
            predicted_range: (lo, hi),
            actual_win_rate: actual,
            count: in_bucket.len(),
            calibration_error: (actual - predicted_mid).abs(),
        });
    }
    buckets
}

fn isotonic_calibrate(raw: f64, buckets: &[CalibrationBucket]) -> f64 {
    if buckets.is_empty() { return raw; }

    for bucket in buckets {
        if raw >= bucket.predicted_range.0 && raw < bucket.predicted_range.1 {
            let mid = (bucket.predicted_range.0 + bucket.predicted_range.1) / 2.0;
            let offset = raw - mid;
            return (bucket.actual_win_rate + offset * 0.5).clamp(0.0, 1.0);
        }
    }
    raw
}

trait Remap {
    fn remap(self, from_lo: f64, from_hi: f64, to_lo: f64, to_hi: f64) -> f64;
}
impl Remap for f64 {
    fn remap(self, from_lo: f64, from_hi: f64, to_lo: f64, to_hi: f64) -> f64 {
        let t = (self - from_lo) / (from_hi - from_lo);
        to_lo + t * (to_hi - to_lo)
    }
}

// ─── JSON API ───────────────────────────────────────────────────────────────

pub fn compute(data: Value) -> Result<Value, String> {
    let command = data.get("command").and_then(|v| v.as_str()).unwrap_or("health");

    match command {
        "record_outcome" => {
            let outcome: SignalOutcome = serde_json::from_value(
                data.get("outcome").cloned().ok_or("outcome field required")?
            ).map_err(|e| format!("Invalid outcome: {}", e))?;

            GLOBAL_TRACKER.record_outcome(outcome);
            let retired = GLOBAL_TRACKER.detect_and_retire_decaying();

            Ok(serde_json::json!({
                "recorded": true,
                "newly_retired": retired,
                "total_outcomes": GLOBAL_TRACKER.get_all_outcomes().len(),
            }))
        }

        "health" | "strategy_health" => {
            let strategy = data.get("strategy").and_then(|v| v.as_str());
            if let Some(s) = strategy {
                let health = GLOBAL_TRACKER.get_strategy_health(s);
                serde_json::to_value(health).map_err(|e| e.to_string())
            } else {
                let all = GLOBAL_TRACKER.get_all_strategy_health();
                serde_json::to_value(all).map_err(|e| e.to_string())
            }
        }

        "calibrate" => {
            let confidence = data.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.5);
            let strategy = data.get("strategy").and_then(|v| v.as_str()).unwrap_or("");
            let regime = data.get("regime").and_then(|v| v.as_str()).unwrap_or("neutral");

            let calibrated = GLOBAL_TRACKER.calibrate_confidence(confidence, strategy);
            let regime_adjusted = GLOBAL_TRACKER.get_regime_weighted_confidence(confidence, strategy, regime);

            Ok(serde_json::json!({
                "raw": confidence,
                "calibrated": (calibrated * 1000.0).round() / 1000.0,
                "regime_adjusted": (regime_adjusted * 1000.0).round() / 1000.0,
                "strategy": strategy,
                "regime": regime,
            }))
        }

        "calibration_stats" => {
            let buckets = GLOBAL_TRACKER.get_calibration_stats();
            serde_json::to_value(buckets).map_err(|e| e.to_string())
        }

        "active_strategies" => {
            let active = GLOBAL_TRACKER.get_active_strategies();
            let retired = GLOBAL_TRACKER.get_retired_strategies();
            Ok(serde_json::json!({
                "active": active,
                "retired": retired,
            }))
        }

        "persist" => {
            let path = data.get("path").and_then(|v| v.as_str())
                .unwrap_or("data/strategy_outcomes.json");
            GLOBAL_TRACKER.persist_to_file(path)?;
            Ok(serde_json::json!({ "persisted": true, "path": path }))
        }

        "load" => {
            let path = data.get("path").and_then(|v| v.as_str())
                .unwrap_or("data/strategy_outcomes.json");
            let count = GLOBAL_TRACKER.load_from_file(path)?;
            Ok(serde_json::json!({ "loaded": true, "outcomes": count }))
        }

        "batch_record" => {
            let outcomes: Vec<SignalOutcome> = serde_json::from_value(
                data.get("outcomes").cloned().ok_or("outcomes array required")?
            ).map_err(|e| format!("Invalid outcomes: {}", e))?;

            let count = outcomes.len();
            for o in outcomes {
                GLOBAL_TRACKER.record_outcome(o);
            }
            let retired = GLOBAL_TRACKER.detect_and_retire_decaying();

            Ok(serde_json::json!({
                "recorded": count,
                "newly_retired": retired,
            }))
        }

        "summary" => {
            let all_health = GLOBAL_TRACKER.get_all_strategy_health();
            let calibration = GLOBAL_TRACKER.get_calibration_stats();
            let active = GLOBAL_TRACKER.get_active_strategies();
            let retired = GLOBAL_TRACKER.get_retired_strategies();
            let total = GLOBAL_TRACKER.get_all_outcomes().len();

            let avg_health: f64 = if !all_health.is_empty() {
                all_health.iter().map(|h| h.health_score).sum::<f64>() / all_health.len() as f64
            } else { 0.0 };

            let avg_cal_error: f64 = if !calibration.is_empty() {
                calibration.iter().map(|b| b.calibration_error).sum::<f64>() / calibration.len() as f64
            } else { 0.0 };

            Ok(serde_json::json!({
                "total_outcomes": total,
                "strategies_tracked": all_health.len(),
                "active_strategies": active.len(),
                "retired_strategies": retired.len(),
                "avg_health_score": (avg_health * 1000.0).round() / 1000.0,
                "avg_calibration_error": (avg_cal_error * 1000.0).round() / 1000.0,
                "strategy_health": all_health,
                "calibration": calibration,
                "retired": retired,
            }))
        }

        _ => Err(format!("Unknown strategy_performance command: {}", command)),
    }
}

use std::sync::LazyLock;

pub static GLOBAL_TRACKER: LazyLock<StrategyPerformanceTracker> =
    LazyLock::new(StrategyPerformanceTracker::new);

#[cfg(test)]
mod tests {
    use super::*;

    fn make_outcome(strategy: &str, won: bool, confidence: f64, pnl: f64) -> SignalOutcome {
        SignalOutcome {
            symbol: "TEST".to_string(),
            strategy: strategy.to_string(),
            direction: if won { "BUY" } else { "SELL" }.to_string(),
            predicted_confidence: confidence,
            entry_price: 100.0,
            exit_price: if won { 100.0 + pnl } else { 100.0 - pnl.abs() },
            pnl_pct: pnl,
            won,
            regime: "trending".to_string(),
            timestamp: "2025-01-01T10:00:00".to_string(),
        }
    }

    #[test]
    fn test_record_and_health() {
        let tracker = StrategyPerformanceTracker::new();
        for i in 0..20 {
            tracker.record_outcome(make_outcome("ema_crossover", i % 3 != 0, 0.6, if i % 3 != 0 { 1.5 } else { -0.8 }));
        }
        let health = tracker.get_strategy_health("ema_crossover");
        assert_eq!(health.total_signals, 20);
        assert!(health.win_rate_all > 0.5);
        assert!(health.health_score > 0.0);
    }

    #[test]
    fn test_decay_detection() {
        let tracker = StrategyPerformanceTracker::new();
        for i in 0..60 {
            let pnl = -1.0 - (i as f64 * 0.1);
            tracker.record_outcome(make_outcome("bad_strategy", false, 0.7, pnl));
        }
        for i in 0..60 {
            tracker.record_outcome(make_outcome("good_strategy", true, 0.7, 1.0 + i as f64 * 0.05));
        }

        let bad_health = tracker.get_strategy_health("bad_strategy");
        assert!(bad_health.win_rate_recent < RETIREMENT_THRESHOLD, "bad WR={}", bad_health.win_rate_recent);
        assert!(bad_health.sharpe < 0.0, "bad sharpe={}", bad_health.sharpe);

        let retired = tracker.detect_and_retire_decaying();
        assert!(retired.contains(&"bad_strategy".to_string()), "bad_strategy should be retired, health={:?}", bad_health);
        assert!(!retired.contains(&"good_strategy".to_string()));
        assert!(tracker.is_strategy_retired("bad_strategy"));
    }

    #[test]
    fn test_calibration() {
        let tracker = StrategyPerformanceTracker::new();
        for i in 0..100 {
            let conf = (i as f64) / 100.0;
            let won = i > 40;
            tracker.record_outcome(make_outcome("test_strat", won, conf, if won { 1.0 } else { -1.0 }));
        }
        let calibrated = tracker.calibrate_confidence(0.75, "test_strat");
        assert!(calibrated > 0.0 && calibrated <= 1.0);
    }

    #[test]
    fn test_regime_weighted() {
        let tracker = StrategyPerformanceTracker::new();
        for i in 0..30 {
            let mut o = make_outcome("trend_strat", i % 2 == 0, 0.6, if i % 2 == 0 { 1.0 } else { -0.5 });
            o.regime = "trending".to_string();
            tracker.record_outcome(o);
        }
        let adjusted = tracker.get_regime_weighted_confidence(0.6, "trend_strat", "trending");
        assert!(adjusted > 0.0 && adjusted <= 1.0);
    }

    #[test]
    fn test_sharpe() {
        let pnls = vec![0.01, -0.005, 0.02, 0.01, -0.01, 0.015, 0.005, -0.003, 0.01, 0.008];
        let s = compute_sharpe(&pnls);
        assert!(s > 0.0, "Positive-skewed PnLs should have positive Sharpe, got {}", s);
    }

    #[test]
    fn test_api_summary() {
        let result = compute(serde_json::json!({ "command": "summary" }));
        assert!(result.is_ok());
    }
}
