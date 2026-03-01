use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::backtest;

#[derive(Deserialize)]
struct OptimizeConfig {
    strategy: String,
    symbol: String,
    initial_capital: f64,
    candles: Vec<CandleInput>,
    param_grid: std::collections::HashMap<String, Vec<f64>>,
}

#[derive(Deserialize, Clone)]
struct CandleInput {
    timestamp: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

#[derive(Serialize)]
struct OptimizeResult {
    best_params: Value,
    best_sharpe: f64,
    best_win_rate: f64,
    best_profit_factor: f64,
    all_results: Vec<ParamResult>,
}

#[derive(Serialize, Clone)]
struct ParamResult {
    params: Value,
    sharpe_ratio: f64,
    win_rate: f64,
    profit_factor: f64,
    cagr: f64,
    max_drawdown: f64,
    total_trades: usize,
}

pub fn compute(data: Value) -> Result<Value, String> {
    let config: OptimizeConfig =
        serde_json::from_value(data).map_err(|e| format!("Invalid optimize config: {}", e))?;

    if config.candles.is_empty() {
        return Err("No candles provided for optimization".to_string());
    }

    let param_combos = generate_combinations(&config.param_grid);

    if param_combos.is_empty() {
        return Err("Empty parameter grid".to_string());
    }

    let candles_json: Vec<Value> = config.candles.iter().map(|c| {
        serde_json::json!({
            "timestamp": c.timestamp,
            "open": c.open,
            "high": c.high,
            "low": c.low,
            "close": c.close,
            "volume": c.volume
        })
    }).collect();

    let mut all_results: Vec<ParamResult> = Vec::with_capacity(param_combos.len());

    for combo in &param_combos {
        let backtest_input = serde_json::json!({
            "strategy": config.strategy,
            "symbol": config.symbol,
            "initial_capital": config.initial_capital,
            "candles": candles_json,
            "params": combo
        });

        match backtest::run(backtest_input) {
            Ok(result) => {
                let sharpe = result.get("sharpe_ratio").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let win_rate = result.get("win_rate").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let pf = result.get("profit_factor").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let cagr = result.get("cagr").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let mdd = result.get("max_drawdown").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let tt = result.get("total_trades").and_then(|v| v.as_u64()).unwrap_or(0) as usize;

                all_results.push(ParamResult {
                    params: combo.clone(),
                    sharpe_ratio: sharpe,
                    win_rate,
                    profit_factor: pf,
                    cagr,
                    max_drawdown: mdd,
                    total_trades: tt,
                });
            }
            Err(_) => {
                all_results.push(ParamResult {
                    params: combo.clone(),
                    sharpe_ratio: f64::NEG_INFINITY,
                    win_rate: 0.0,
                    profit_factor: 0.0,
                    cagr: 0.0,
                    max_drawdown: 100.0,
                    total_trades: 0,
                });
            }
        }
    }

    all_results.sort_by(|a, b| b.sharpe_ratio.partial_cmp(&a.sharpe_ratio).unwrap_or(std::cmp::Ordering::Equal));

    let best = all_results.first().cloned().unwrap_or(ParamResult {
        params: serde_json::json!({}),
        sharpe_ratio: 0.0,
        win_rate: 0.0,
        profit_factor: 0.0,
        cagr: 0.0,
        max_drawdown: 0.0,
        total_trades: 0,
    });

    let result = OptimizeResult {
        best_params: best.params,
        best_sharpe: best.sharpe_ratio,
        best_win_rate: best.win_rate,
        best_profit_factor: best.profit_factor,
        all_results,
    };

    serde_json::to_value(result).map_err(|e| format!("Serialization error: {}", e))
}

fn generate_combinations(grid: &std::collections::HashMap<String, Vec<f64>>) -> Vec<Value> {
    let keys: Vec<&String> = grid.keys().collect();
    let values: Vec<&Vec<f64>> = keys.iter().map(|k| grid.get(*k).unwrap()).collect();

    if keys.is_empty() {
        return vec![serde_json::json!({})];
    }

    let mut combos: Vec<Value> = Vec::new();
    let mut indices = vec![0usize; keys.len()];

    loop {
        let mut combo = serde_json::Map::new();
        for (i, key) in keys.iter().enumerate() {
            combo.insert(
                key.to_string(),
                serde_json::json!(values[i][indices[i]]),
            );
        }
        combos.push(Value::Object(combo));

        let mut carry = true;
        for i in (0..keys.len()).rev() {
            if carry {
                indices[i] += 1;
                if indices[i] >= values[i].len() {
                    indices[i] = 0;
                } else {
                    carry = false;
                }
            }
        }
        if carry {
            break;
        }
    }

    combos
}
