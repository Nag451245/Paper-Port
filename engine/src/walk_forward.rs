use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::backtest;

#[derive(Deserialize)]
struct WalkForwardConfig {
    strategy: String,
    symbol: String,
    initial_capital: f64,
    candles: Vec<CandleWF>,
    param_grid: std::collections::HashMap<String, Vec<f64>>,
    in_sample_ratio: Option<f64>,
    num_folds: Option<usize>,
}

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
        let fold_start = fold * fold_size;
        let fold_end = if fold == num_folds - 1 { n } else { (fold + 1) * fold_size };
        let fold_candles = &candles_json[fold_start..fold_end];

        let split = (fold_candles.len() as f64 * is_ratio) as usize;
        if split < 15 || fold_candles.len() - split < 5 {
            continue;
        }

        let in_sample = &fold_candles[..split];
        let out_sample = &fold_candles[split..];

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
    };

    serde_json::to_value(result).map_err(|e| format!("Serialization error: {}", e))
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

fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
