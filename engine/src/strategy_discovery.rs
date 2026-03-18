use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::{LazyLock, Mutex};
use tracing::{info, warn};

use crate::optimize;
use crate::walk_forward;
use crate::strategy_performance::GLOBAL_TRACKER;
use crate::utils::round2;

const STRATEGIES: &[&str] = &[
    "ema_crossover",
    "supertrend",
    "rsi_reversal",
    "mean_reversion",
    "momentum",
    "volatility_breakout",
    "trend_following",
];

const PROMOTE_OOS_SHARPE: f64 = 0.5;
const PROMOTE_MAX_DEGRADATION: f64 = 0.3;
const PROMOTE_MIN_CONSISTENCY: f64 = 0.6;
const RETIRE_OOS_SHARPE: f64 = -0.2;
const RETIRE_DEGRADATION: f64 = 0.6;

static LAST_REPORT: LazyLock<Mutex<Option<DiscoveryReport>>> =
    LazyLock::new(|| Mutex::new(None));

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryResult {
    pub strategy: String,
    pub best_params: HashMap<String, f64>,
    pub in_sample_sharpe: f64,
    pub out_sample_sharpe: f64,
    pub degradation: f64,
    pub overfitting_score: f64,
    pub consistency: f64,
    pub action: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct DiscoveryReport {
    pub results: Vec<DiscoveryResult>,
    pub promoted: Vec<String>,
    pub retired: Vec<String>,
    pub timestamp: String,
}

fn default_param_grid(strategy: &str) -> HashMap<String, Vec<Value>> {
    let mut grid: HashMap<String, Vec<Value>> = HashMap::new();
    match strategy {
        "ema_crossover" => {
            grid.insert("shortPeriod".into(), vec![5.into(), 9.into(), 13.into()]);
            grid.insert("longPeriod".into(), vec![15.into(), 21.into(), 30.into()]);
        }
        "rsi_reversal" => {
            grid.insert("oversold".into(), vec![25.into(), 30.into(), 35.into()]);
            grid.insert("overbought".into(), vec![65.into(), 70.into(), 75.into()]);
        }
        "mean_reversion" => {
            grid.insert("period".into(), vec![15.into(), 20.into(), 30.into()]);
            grid.insert(
                "threshold".into(),
                vec![
                    serde_json::json!(1.5),
                    serde_json::json!(2.0),
                    serde_json::json!(2.5),
                ],
            );
        }
        "momentum" => {
            grid.insert("lookback".into(), vec![10.into(), 15.into(), 20.into(), 30.into()]);
            grid.insert("holdDays".into(), vec![5.into(), 10.into(), 15.into()]);
        }
        "supertrend" => {
            grid.insert("period".into(), vec![7.into(), 10.into(), 14.into()]);
            grid.insert(
                "multiplier".into(),
                vec![
                    serde_json::json!(2.0),
                    serde_json::json!(2.5),
                    serde_json::json!(3.0),
                ],
            );
        }
        "volatility_breakout" => {
            grid.insert("period".into(), vec![14.into(), 20.into()]);
            grid.insert(
                "threshold".into(),
                vec![
                    serde_json::json!(1.5),
                    serde_json::json!(2.0),
                    serde_json::json!(2.5),
                ],
            );
        }
        "trend_following" => {
            grid.insert("shortPeriod".into(), vec![5.into(), 10.into()]);
            grid.insert("longPeriod".into(), vec![20.into(), 30.into(), 50.into()]);
        }
        _ => {}
    }
    grid
}

fn evaluate_strategy(
    strategy: &str,
    candles: &[Value],
    param_grid: &HashMap<String, Vec<Value>>,
) -> Result<DiscoveryResult, String> {
    if GLOBAL_TRACKER.is_strategy_retired(strategy) {
        return Ok(DiscoveryResult {
            strategy: strategy.to_string(),
            best_params: HashMap::new(),
            in_sample_sharpe: 0.0,
            out_sample_sharpe: 0.0,
            degradation: 0.0,
            overfitting_score: 0.0,
            consistency: 0.0,
            action: "RETIRE".into(),
            reason: "Already retired by performance tracker".into(),
        });
    }

    let param_grid_f64: HashMap<String, Vec<f64>> = param_grid
        .iter()
        .map(|(k, vals)| {
            let floats: Vec<f64> = vals
                .iter()
                .filter_map(|v| v.as_f64())
                .collect();
            (k.clone(), floats)
        })
        .collect();

    let opt_input = serde_json::json!({
        "strategy": strategy,
        "symbol": "DISCOVERY",
        "initial_capital": 100000.0,
        "candles": candles,
        "param_grid": param_grid_f64,
    });

    let opt_result = optimize::compute(opt_input)?;

    let best_sharpe = opt_result
        .get("best_sharpe")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    let best_params_value = opt_result
        .get("best_params")
        .cloned()
        .unwrap_or(Value::Object(serde_json::Map::new()));

    let best_params: HashMap<String, f64> = match best_params_value.as_object() {
        Some(obj) => obj
            .iter()
            .filter_map(|(k, v)| v.as_f64().map(|f| (k.clone(), f)))
            .collect(),
        None => HashMap::new(),
    };

    let wf_input = serde_json::json!({
        "strategy": strategy,
        "symbol": "DISCOVERY",
        "initial_capital": 100000.0,
        "candles": candles,
        "param_grid": param_grid_f64,
        "in_sample_ratio": 0.7,
        "num_folds": 5,
        "window_mode": "rolling",
        "purge_bars": 5,
    });

    let wf_result = walk_forward::compute(wf_input)?;

    let aggregate = wf_result.get("aggregate");

    let oos_sharpe = aggregate
        .and_then(|a| a.get("avg_out_sample_sharpe"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    let degradation = aggregate
        .and_then(|a| a.get("avg_degradation"))
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);

    let consistency = aggregate
        .and_then(|a| a.get("consistency_score"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    let overfitting_score = wf_result
        .get("overfitting_score")
        .and_then(|v| v.as_f64())
        .unwrap_or(1.0);

    let (action, reason) = classify_action(oos_sharpe, degradation, consistency);

    Ok(DiscoveryResult {
        strategy: strategy.to_string(),
        best_params,
        in_sample_sharpe: round2(best_sharpe),
        out_sample_sharpe: round2(oos_sharpe),
        degradation: round2(degradation),
        overfitting_score: round2(overfitting_score),
        consistency: round2(consistency),
        action,
        reason,
    })
}

fn classify_action(oos_sharpe: f64, degradation: f64, consistency: f64) -> (String, String) {
    if oos_sharpe > PROMOTE_OOS_SHARPE
        && degradation < PROMOTE_MAX_DEGRADATION
        && consistency > PROMOTE_MIN_CONSISTENCY
    {
        (
            "PROMOTE".into(),
            format!(
                "OOS Sharpe {:.2} > {}, degradation {:.1}% < {}%, consistency {:.2} > {}",
                oos_sharpe,
                PROMOTE_OOS_SHARPE,
                degradation * 100.0,
                PROMOTE_MAX_DEGRADATION * 100.0,
                consistency,
                PROMOTE_MIN_CONSISTENCY,
            ),
        )
    } else if oos_sharpe < RETIRE_OOS_SHARPE || degradation > RETIRE_DEGRADATION {
        let mut reasons = Vec::new();
        if oos_sharpe < RETIRE_OOS_SHARPE {
            reasons.push(format!("OOS Sharpe {:.2} < {}", oos_sharpe, RETIRE_OOS_SHARPE));
        }
        if degradation > RETIRE_DEGRADATION {
            reasons.push(format!(
                "degradation {:.1}% > {}%",
                degradation * 100.0,
                RETIRE_DEGRADATION * 100.0,
            ));
        }
        ("RETIRE".into(), reasons.join("; "))
    } else {
        (
            "HOLD".into(),
            format!(
                "OOS Sharpe {:.2}, degradation {:.1}%, consistency {:.2} -- does not meet promote or retire thresholds",
                oos_sharpe,
                degradation * 100.0,
                consistency,
            ),
        )
    }
}

pub fn run_discovery(candles_by_symbol: &HashMap<String, Vec<Value>>) -> DiscoveryReport {
    info!(symbols = candles_by_symbol.len(), "Starting strategy discovery sweep");

    let merged: Vec<Value> = candles_by_symbol
        .values()
        .flat_map(|v| v.iter().cloned())
        .collect();

    if merged.is_empty() {
        warn!("No candle data provided for discovery");
        return DiscoveryReport {
            results: vec![],
            promoted: vec![],
            retired: vec![],
            timestamp: chrono::Utc::now().to_rfc3339(),
        };
    }

    let mut results: Vec<DiscoveryResult> = Vec::new();

    for &strat in STRATEGIES {
        let grid = default_param_grid(strat);
        if grid.is_empty() {
            warn!(strategy = strat, "No parameter grid defined, skipping");
            continue;
        }
        match evaluate_strategy(strat, &merged, &grid) {
            Ok(result) => {
                info!(
                    strategy = strat,
                    action = %result.action,
                    oos_sharpe = result.out_sample_sharpe,
                    "Discovery evaluation complete"
                );
                results.push(result);
            }
            Err(e) => {
                warn!(strategy = strat, error = %e, "Strategy evaluation failed");
                results.push(DiscoveryResult {
                    strategy: strat.to_string(),
                    best_params: HashMap::new(),
                    in_sample_sharpe: 0.0,
                    out_sample_sharpe: 0.0,
                    degradation: 0.0,
                    overfitting_score: 0.0,
                    consistency: 0.0,
                    action: "HOLD".into(),
                    reason: format!("Evaluation error: {}", e),
                });
            }
        }
    }

    GLOBAL_TRACKER.detect_and_retire_decaying();

    let promoted: Vec<String> = results
        .iter()
        .filter(|r| r.action == "PROMOTE")
        .map(|r| r.strategy.clone())
        .collect();

    let retired: Vec<String> = results
        .iter()
        .filter(|r| r.action == "RETIRE")
        .map(|r| r.strategy.clone())
        .collect();

    let report = DiscoveryReport {
        results,
        promoted,
        retired,
        timestamp: chrono::Utc::now().to_rfc3339(),
    };

    if let Ok(mut last) = LAST_REPORT.lock() {
        *last = Some(report.clone());
    }

    info!(
        promoted = report.promoted.len(),
        retired = report.retired.len(),
        total = report.results.len(),
        "Discovery sweep complete"
    );

    report
}

fn persist_report(report: &DiscoveryReport) -> Result<(), String> {
    let dir = std::path::Path::new("data");
    if !dir.exists() {
        std::fs::create_dir_all(dir)
            .map_err(|e| format!("Failed to create data directory: {}", e))?;
    }
    let json = serde_json::to_string_pretty(report)
        .map_err(|e| format!("Serialization error: {}", e))?;
    std::fs::write("data/discovery_results.json", json)
        .map_err(|e| format!("Failed to write discovery results: {}", e))?;
    Ok(())
}

fn load_report() -> Result<DiscoveryReport, String> {
    let contents = std::fs::read_to_string("data/discovery_results.json")
        .map_err(|e| format!("Failed to read discovery results: {}", e))?;
    serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse discovery results: {}", e))
}

pub fn compute(data: Value) -> Result<Value, String> {
    #[derive(Deserialize)]
    struct DiscoveryRequest {
        command: String,
        #[serde(default)]
        candles_by_symbol: Option<HashMap<String, Vec<Value>>>,
    }

    let req: DiscoveryRequest = serde_json::from_value(data)
        .map_err(|e| format!("Invalid discovery request: {}", e))?;

    match req.command.as_str() {
        "run" => {
            let candles = req.candles_by_symbol.unwrap_or_default();
            let report = run_discovery(&candles);

            if let Err(e) = persist_report(&report) {
                warn!(error = %e, "Failed to persist discovery report");
            }

            serde_json::to_value(&report)
                .map_err(|e| format!("Serialization error: {}", e))
        }

        "results" => {
            let report = load_report()?;
            serde_json::to_value(&report)
                .map_err(|e| format!("Serialization error: {}", e))
        }

        "status" => {
            let report = LAST_REPORT.lock().ok().and_then(|r| r.clone());
            match report {
                Some(r) => Ok(serde_json::json!({
                    "has_results": true,
                    "total_strategies": r.results.len(),
                    "promoted_count": r.promoted.len(),
                    "retired_count": r.retired.len(),
                    "promoted": r.promoted,
                    "retired": r.retired,
                    "timestamp": r.timestamp,
                })),
                None => Ok(serde_json::json!({
                    "has_results": false,
                    "total_strategies": 0,
                    "promoted_count": 0,
                    "retired_count": 0,
                    "promoted": [],
                    "retired": [],
                    "timestamp": null,
                })),
            }
        }

        other => Err(format!("Unknown discovery command: {}", other)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_param_grid() {
        for &strat in STRATEGIES {
            let grid = default_param_grid(strat);
            assert!(
                !grid.is_empty(),
                "Param grid for '{}' should not be empty",
                strat
            );
            for (param, values) in &grid {
                assert!(
                    !values.is_empty(),
                    "Param '{}' in strategy '{}' should have at least one value",
                    param,
                    strat
                );
            }
        }
    }

    #[test]
    fn test_compute_status() {
        let input = serde_json::json!({ "command": "status" });
        let result = compute(input).expect("status command should succeed");

        assert!(result.is_object(), "status should return a JSON object");
        assert!(result.get("has_results").is_some());
        assert!(result.get("total_strategies").is_some());
        assert!(result.get("promoted_count").is_some());
        assert!(result.get("retired_count").is_some());
        assert!(result.get("promoted").is_some());
        assert!(result.get("retired").is_some());
    }
}
