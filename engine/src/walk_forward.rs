use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::backtest;
use crate::utils::round2;

#[derive(Deserialize)]
struct WalkForwardConfig {
    strategy: String,
    symbol: String,
    initial_capital: f64,
    candles: Vec<CandleWF>,
    param_grid: std::collections::HashMap<String, Vec<f64>>,
    in_sample_ratio: Option<f64>,
    num_folds: Option<usize>,
    #[serde(default = "default_window_mode")]
    window_mode: String,
    #[serde(default)]
    purge_bars: Option<usize>,
    #[serde(default)]
    monte_carlo_runs: Option<usize>,
}

fn default_window_mode() -> String { "rolling".to_string() }

#[derive(Deserialize, Clone)]
struct CandleWF {
    timestamp: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

#[derive(Serialize)]
struct WalkForwardResult {
    folds: Vec<FoldResult>,
    aggregate: AggregateMetrics,
    best_robust_params: Value,
    overfitting_score: f64,
    window_mode: String,
    p_value: Option<f64>,
}

#[derive(Serialize, Clone)]
struct FoldResult {
    fold: usize,
    in_sample_sharpe: f64,
    out_sample_sharpe: f64,
    in_sample_win_rate: f64,
    out_sample_win_rate: f64,
    best_params: Value,
    out_sample_trades: usize,
    out_sample_pnl: f64,
    degradation: f64,
}

#[derive(Serialize)]
struct AggregateMetrics {
    avg_in_sample_sharpe: f64,
    avg_out_sample_sharpe: f64,
    avg_degradation: f64,
    total_out_sample_trades: usize,
    total_out_sample_pnl: f64,
    consistency_score: f64,
}

pub fn compute(data: Value) -> Result<Value, String> {
    let config: WalkForwardConfig =
        serde_json::from_value(data).map_err(|e| format!("Invalid walk-forward config: {}", e))?;

    let n = config.candles.len();
    if n < 60 {
        return Err("Need at least 60 candles for walk-forward analysis".to_string());
    }

    let num_folds = config.num_folds.unwrap_or(5).max(2).min(10);
    let is_ratio = config.in_sample_ratio.unwrap_or(0.7).max(0.5).min(0.9);
    let purge_bars = config.purge_bars.unwrap_or(5);
    let is_expanding = config.window_mode == "expanding";
    let mc_runs = config.monte_carlo_runs.unwrap_or(0);

    let fold_size = n / num_folds;
    if fold_size < 20 {
        return Err("Not enough data for requested number of folds".to_string());
    }

    let param_combos = generate_combinations(&config.param_grid);
    if param_combos.is_empty() {
        return Err("Empty parameter grid".to_string());
    }

    let candles_json: Vec<Value> = config.candles.iter().map(|c| {
        serde_json::json!({
            "timestamp": c.timestamp, "open": c.open, "high": c.high,
            "low": c.low, "close": c.close, "volume": c.volume
        })
    }).collect();

    let mut folds: Vec<FoldResult> = Vec::new();
    let mut param_scores: std::collections::HashMap<String, Vec<f64>> = std::collections::HashMap::new();

    for fold in 0..num_folds {
        // Expanding window: in-sample always starts from index 0
        // Rolling window: in-sample starts from fold_start
        let fold_start = if is_expanding { 0 } else { fold * fold_size };
        let fold_end = if fold == num_folds - 1 { n } else { (fold + 1) * fold_size };
        let fold_candles = &candles_json[fold_start..fold_end];

        let split = (fold_candles.len() as f64 * is_ratio) as usize;
        if split < 15 || fold_candles.len() - split < 5 {
            continue;
        }

        // Purged cross-validation: add embargo gap between train and test
        let purge_end = (split + purge_bars).min(fold_candles.len());
        let in_sample = &fold_candles[..split];
        let out_sample = if purge_end < fold_candles.len() { &fold_candles[purge_end..] } else { continue };

        let mut best_is_sharpe = f64::NEG_INFINITY;
        let mut best_params = serde_json::json!({});

        for combo in &param_combos {
            let bt_input = serde_json::json!({
                "strategy": config.strategy,
                "symbol": config.symbol,
                "initial_capital": config.initial_capital,
                "candles": in_sample,
                "params": combo
            });

            if let Ok(result) = backtest::run(bt_input) {
                let sharpe = result.get("sharpe_ratio").and_then(|v| v.as_f64()).unwrap_or(f64::NEG_INFINITY);
                if sharpe > best_is_sharpe {
                    best_is_sharpe = sharpe;
                    best_params = combo.clone();
                }
            }
        }

        let oos_input = serde_json::json!({
            "strategy": config.strategy,
            "symbol": config.symbol,
            "initial_capital": config.initial_capital,
            "candles": out_sample,
            "params": best_params
        });

        let (oos_sharpe, oos_wr, oos_trades, oos_pnl) = match backtest::run(oos_input) {
            Ok(r) => (
                r.get("sharpe_ratio").and_then(|v| v.as_f64()).unwrap_or(0.0),
                r.get("win_rate").and_then(|v| v.as_f64()).unwrap_or(0.0),
                r.get("total_trades").and_then(|v| v.as_u64()).unwrap_or(0) as usize,
                r.get("equity_curve").and_then(|v| v.as_array())
                    .and_then(|a| a.last())
                    .and_then(|last| last.get("nav").and_then(|n| n.as_f64()))
                    .map(|nav| nav - config.initial_capital)
                    .unwrap_or(0.0),
            ),
            Err(_) => (0.0, 0.0, 0, 0.0),
        };

        let is_input = serde_json::json!({
            "strategy": config.strategy,
            "symbol": config.symbol,
            "initial_capital": config.initial_capital,
            "candles": in_sample,
            "params": best_params
        });
        let is_wr = match backtest::run(is_input) {
            Ok(r) => r.get("win_rate").and_then(|v| v.as_f64()).unwrap_or(0.0),
            Err(_) => 0.0,
        };

        let degradation = if best_is_sharpe > 0.0 {
            1.0 - (oos_sharpe / best_is_sharpe)
        } else {
            0.0
        };

        let param_key = best_params.to_string();
        param_scores.entry(param_key).or_default().push(oos_sharpe);

        folds.push(FoldResult {
            fold,
            in_sample_sharpe: round2(best_is_sharpe),
            out_sample_sharpe: round2(oos_sharpe),
            in_sample_win_rate: round2(is_wr),
            out_sample_win_rate: round2(oos_wr),
            best_params: best_params.clone(),
            out_sample_trades: oos_trades,
            out_sample_pnl: round2(oos_pnl),
            degradation: round2(degradation),
        });
    }

    if folds.is_empty() {
        return Err("No valid folds produced".to_string());
    }

    let n_folds = folds.len() as f64;
    let avg_is = folds.iter().map(|f| f.in_sample_sharpe).sum::<f64>() / n_folds;
    let avg_oos = folds.iter().map(|f| f.out_sample_sharpe).sum::<f64>() / n_folds;
    let avg_deg = folds.iter().map(|f| f.degradation).sum::<f64>() / n_folds;
    let total_oos_trades = folds.iter().map(|f| f.out_sample_trades).sum();
    let total_oos_pnl = folds.iter().map(|f| f.out_sample_pnl).sum::<f64>();

    let positive_folds = folds.iter().filter(|f| f.out_sample_sharpe > 0.0).count() as f64;
    let consistency = positive_folds / n_folds;

    let best_robust = param_scores.iter()
        .map(|(params, scores)| {
            let avg: f64 = scores.iter().sum::<f64>() / scores.len() as f64;
            (params.clone(), avg)
        })
        .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(p, _)| serde_json::from_str::<Value>(&p).unwrap_or(serde_json::json!({})))
        .unwrap_or(serde_json::json!({}));

    let overfit = if avg_is > 0.0 { (avg_is - avg_oos) / avg_is } else { 0.0 };

    // Monte Carlo permutation test for statistical significance
    let p_value = if mc_runs > 0 && total_oos_pnl != 0.0 {
        Some(monte_carlo_test(&folds, mc_runs))
    } else {
        None
    };

    let result = WalkForwardResult {
        folds,
        aggregate: AggregateMetrics {
            avg_in_sample_sharpe: round2(avg_is),
            avg_out_sample_sharpe: round2(avg_oos),
            avg_degradation: round2(avg_deg),
            total_out_sample_trades: total_oos_trades,
            total_out_sample_pnl: round2(total_oos_pnl),
            consistency_score: round2(consistency),
        },
        best_robust_params: best_robust,
        overfitting_score: round2(overfit.max(0.0).min(1.0)),
        window_mode: config.window_mode.clone(),
        p_value,
    };

    serde_json::to_value(result).map_err(|e| format!("Serialization error: {}", e))
}

fn monte_carlo_test(folds: &[FoldResult], num_runs: usize) -> f64 {
    use std::collections::hash_map::DefaultHasher;
    use std::hash::{Hash, Hasher};

    let real_sharpe: f64 = folds.iter().map(|f| f.out_sample_sharpe).sum::<f64>() / folds.len() as f64;

    let mut pnls: Vec<f64> = folds.iter().map(|f| f.out_sample_pnl).collect();
    if pnls.is_empty() { return 1.0; }

    let mut better_count = 0usize;

    for run in 0..num_runs {
        // Deterministic shuffle using hash-based seed
        let n = pnls.len();
        for i in 0..n {
            let mut hasher = DefaultHasher::new();
            (run, i).hash(&mut hasher);
            let j = hasher.finish() as usize % n;
            pnls.swap(i, j);
        }

        let mean = pnls.iter().sum::<f64>() / n as f64;
        let variance = pnls.iter().map(|p| (p - mean).powi(2)).sum::<f64>() / n as f64;
        let std = variance.sqrt();
        let shuffled_sharpe = if std > 0.0 { mean / std } else { 0.0 };

        if shuffled_sharpe >= real_sharpe {
            better_count += 1;
        }
    }

    let p = better_count as f64 / num_runs as f64;
    (p * 1000.0).round() / 1000.0
}

fn generate_combinations(grid: &std::collections::HashMap<String, Vec<f64>>) -> Vec<Value> {
    let keys: Vec<&String> = grid.keys().collect();
    let values: Vec<&Vec<f64>> = keys.iter().map(|k| grid.get(*k).unwrap()).collect();
    if keys.is_empty() { return vec![serde_json::json!({})]; }
    let mut combos = Vec::new();
    let mut indices = vec![0usize; keys.len()];
    loop {
        let mut combo = serde_json::Map::new();
        for (i, key) in keys.iter().enumerate() {
            combo.insert(key.to_string(), serde_json::json!(values[i][indices[i]]));
        }
        combos.push(Value::Object(combo));
        let mut carry = true;
        for i in (0..keys.len()).rev() {
            if carry { indices[i] += 1; if indices[i] >= values[i].len() { indices[i] = 0; } else { carry = false; } }
        }
        if carry { break; }
    }
    combos
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn trending_candles_json(n: usize, start: f64, step: f64) -> Vec<serde_json::Value> {
        (0..n).map(|i| {
            let close = start + i as f64 * step;
            json!({
                "timestamp": format!("2025-{:02}-{:02}", (i / 28) % 12 + 1, (i % 28) + 1),
                "open": close - step * 0.3,
                "high": close + step.abs() * 0.5,
                "low": close - step.abs() * 0.5,
                "close": close,
                "volume": 10000.0,
            })
        }).collect()
    }

    fn make_wf_input(n_candles: usize) -> serde_json::Value {
        let candles = trending_candles_json(n_candles, 100.0, 0.5);
        let mut grid = std::collections::HashMap::new();
        grid.insert("shortPeriod".to_string(), vec![5.0, 10.0]);
        grid.insert("longPeriod".to_string(), vec![20.0, 30.0]);

        json!({
            "strategy": "ema_crossover",
            "symbol": "TEST",
            "initial_capital": 100000.0,
            "candles": candles,
            "param_grid": grid,
            "in_sample_ratio": 0.7,
            "num_folds": 3,
        })
    }

    #[test]
    fn test_walk_forward_basic_runs() {
        let input = make_wf_input(120);
        let result = compute(input);
        assert!(result.is_ok(), "walk-forward with 120 candles should succeed: {:?}", result.err());
        let val = result.unwrap();
        assert!(val.get("folds").is_some(), "result should contain 'folds'");
        assert!(val.get("aggregate").is_some(), "result should contain 'aggregate'");
        assert!(val.get("overfitting_score").is_some(), "result should contain 'overfitting_score'");
    }

    #[test]
    fn test_walk_forward_too_few_candles() {
        let input = make_wf_input(20);
        let result = compute(input);
        assert!(result.is_err(), "walk-forward with only 20 candles should return an error");
        let err = result.unwrap_err();
        assert!(err.contains("at least 60") || err.contains("Not enough"),
            "error message should mention insufficient data, got: {}", err);
    }

    #[test]
    fn test_walk_forward_results_structure() {
        let input = make_wf_input(150);
        let result = compute(input).expect("walk-forward with 150 candles should succeed");

        let folds = result.get("folds").and_then(|v| v.as_array())
            .expect("'folds' should be an array");
        assert!(!folds.is_empty(), "should have at least one fold");

        for fold in folds {
            assert!(fold.get("fold").is_some(), "each fold should have 'fold' index");
            assert!(fold.get("in_sample_sharpe").is_some(), "each fold should have 'in_sample_sharpe'");
            assert!(fold.get("out_sample_sharpe").is_some(), "each fold should have 'out_sample_sharpe'");
            assert!(fold.get("best_params").is_some(), "each fold should have 'best_params'");
            assert!(fold.get("degradation").is_some(), "each fold should have 'degradation'");

            let is_sharpe = fold["in_sample_sharpe"].as_f64().unwrap();
            let oos_sharpe = fold["out_sample_sharpe"].as_f64().unwrap();
            assert!(is_sharpe.is_finite(), "in_sample_sharpe should be finite");
            assert!(oos_sharpe.is_finite(), "out_sample_sharpe should be finite");
        }

        let agg = result.get("aggregate").expect("should have 'aggregate'");
        assert!(agg.get("avg_in_sample_sharpe").is_some());
        assert!(agg.get("avg_out_sample_sharpe").is_some());
        assert!(agg.get("consistency_score").is_some());

        let overfit = result["overfitting_score"].as_f64().unwrap();
        assert!(overfit >= 0.0 && overfit <= 1.0,
            "overfitting_score should be in [0, 1], got {}", overfit);

        assert!(result.get("window_mode").is_some(), "should have 'window_mode'");
    }
}
