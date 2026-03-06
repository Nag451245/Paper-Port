pub mod backtest;
pub mod signals;
mod risk;
mod greeks;
mod scan;
mod optimize;
mod walk_forward;
mod advanced_signals;
mod iv_surface;
mod monte_carlo;
mod portfolio_opt;
mod options_strategy;
mod correlation;
mod feature_store;
mod multi_timeframe;

use serde::{Deserialize, Serialize};
use std::io::{self, BufRead, Read};

#[derive(Deserialize)]
struct Request {
    id: Option<String>,
    command: String,
    data: serde_json::Value,
}

#[derive(Serialize)]
struct Response {
    id: Option<String>,
    success: bool,
    data: serde_json::Value,
    error: Option<String>,
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let daemon_mode = args.iter().any(|a| a == "--daemon");

    if daemon_mode {
        run_daemon();
    } else {
        run_single_shot();
    }
}

fn run_single_shot() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap_or_default();

    let response = match serde_json::from_str::<Request>(&input) {
        Ok(req) => handle_request(req),
        Err(e) => Response {
            id: None,
            success: false,
            data: serde_json::Value::Null,
            error: Some(format!("Invalid JSON input: {}", e)),
        },
    };

    println!("{}", serde_json::to_string(&response).unwrap());
}

fn run_daemon() {
    eprintln!("[engine] Daemon mode started, reading newline-delimited JSON from stdin");
    let stdin = io::stdin();
    let reader = stdin.lock();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let response = match serde_json::from_str::<Request>(trimmed) {
            Ok(req) => handle_request(req),
            Err(e) => Response {
                id: None,
                success: false,
                data: serde_json::Value::Null,
                error: Some(format!("Invalid JSON: {}", e)),
            },
        };

        let out = serde_json::to_string(&response).unwrap();
        println!("{}", out);
    }
    eprintln!("[engine] Daemon shutting down");
}

fn handle_request(req: Request) -> Response {
    let id = req.id.clone();
    let result = match req.command.as_str() {
        "backtest" => backtest::run(req.data),
        "signals" => signals::compute(req.data),
        "risk" => risk::compute(req.data),
        "greeks" => greeks::compute(req.data),
        "scan" => scan::compute(req.data),
        "optimize" => optimize::compute(req.data),
        "walk_forward" => walk_forward::compute(req.data),
        "advanced_signals" => advanced_signals::compute(req.data),
        "iv_surface" => iv_surface::compute(req.data),
        "monte_carlo" => monte_carlo::compute(req.data),
        "optimize_portfolio" => portfolio_opt::compute(req.data),
        "options_strategy" => options_strategy::compute(req.data),
        "correlation" => correlation::compute(req.data),
        "feature_store" => feature_store::compute(req.data),
        "multi_timeframe_scan" => multi_timeframe::compute(req.data),
        _ => Err(format!("Unknown command: {}", req.command)),
    };
    match result {
        Ok(data) => Response { id, success: true, data, error: None },
        Err(e) => Response { id, success: false, data: serde_json::Value::Null, error: Some(e) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn req(command: &str, data: serde_json::Value) -> Response {
        handle_request(Request {
            id: Some("test".to_string()),
            command: command.to_string(),
            data,
        })
    }

    fn sample_candles() -> Vec<serde_json::Value> {
        (0..30).map(|i| json!({
            "timestamp": format!("2024-01-{:02}T10:00:00", (i % 28) + 1),
            "open": 100.0 + i as f64,
            "high": 102.0 + i as f64,
            "low": 99.0 + i as f64,
            "close": 101.0 + i as f64,
            "volume": 10000.0
        })).collect()
    }

    #[test]
    fn test_unknown_command() {
        let resp = req("foobar", json!({}));
        assert!(!resp.success);
        assert!(resp.error.as_ref().unwrap().contains("Unknown"));
    }

    #[test]
    fn test_signals_valid() {
        let resp = req("signals", json!({ "candles": sample_candles() }));
        assert!(resp.success, "signals failed: {:?}", resp.error);
    }

    #[test]
    fn test_signals_empty() {
        let resp = req("signals", json!({}));
        assert!(!resp.success);
    }

    #[test]
    fn test_risk_valid() {
        let returns: Vec<f64> = (0..60).map(|i| 0.01 * (i as f64 * 0.1).sin()).collect();
        let resp = req("risk", json!({ "returns": returns, "initial_capital": 100000.0 }));
        assert!(resp.success, "risk failed: {:?}", resp.error);
    }

    #[test]
    fn test_greeks_valid() {
        let resp = req("greeks", json!({
            "spot": 100.0,
            "strike": 100.0,
            "volatility": 0.2,
            "time_to_expiry": 0.25,
            "risk_free_rate": 0.05,
            "option_type": "call"
        }));
        assert!(resp.success, "greeks failed: {:?}", resp.error);
    }

    #[test]
    fn test_scan_empty_symbols() {
        let resp = req("scan", json!({ "symbols": [] }));
        assert!(resp.success, "scan failed: {:?}", resp.error);
        let signals = resp.data.get("signals").and_then(|v| v.as_array());
        assert_eq!(signals.map(|a| a.len()), Some(0));
    }

    #[test]
    fn test_backtest_valid() {
        let resp = req("backtest", json!({
            "strategy": "ema_crossover",
            "symbol": "TEST",
            "initial_capital": 100000.0,
            "candles": sample_candles()
        }));
        assert!(resp.success, "backtest failed: {:?}", resp.error);
    }

    #[test]
    fn test_options_strategy_valid() {
        let resp = req("options_strategy", json!({
            "legs": [
                { "option_type": "call", "strike": 100.0, "premium": 5.0, "quantity": 1 }
            ],
            "spot": 100.0
        }));
        assert!(resp.success, "options_strategy failed: {:?}", resp.error);
    }

    #[test]
    fn test_monte_carlo_valid() {
        let returns: Vec<f64> = (0..60).map(|i| 0.01 * (i as f64 * 0.1).sin()).collect();
        let resp = req("monte_carlo", json!({
            "returns": returns,
            "initial_capital": 100000.0,
            "num_simulations": 100,
            "time_horizon": 30
        }));
        assert!(resp.success, "monte_carlo failed: {:?}", resp.error);
    }

    #[test]
    fn test_request_id_preserved() {
        let resp = handle_request(Request {
            id: Some("my-unique-id-42".to_string()),
            command: "greeks".to_string(),
            data: json!({
                "spot": 100.0,
                "strike": 100.0,
                "volatility": 0.2,
                "time_to_expiry": 0.25,
                "risk_free_rate": 0.05,
                "option_type": "call"
            }),
        });
        assert_eq!(resp.id, Some("my-unique-id-42".to_string()));
    }
}
