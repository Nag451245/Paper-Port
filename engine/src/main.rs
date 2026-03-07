pub mod utils;
pub mod config;
pub mod strategy;
pub mod state;
pub mod server;
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
mod ml_scorer;

use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tracing::{info, warn, error};

use crate::config::EngineConfig;
use crate::state::AppState;

#[derive(Deserialize)]
pub struct Request {
    pub id: Option<String>,
    pub command: String,
    pub data: serde_json::Value,
}

#[derive(Serialize)]
pub struct Response {
    pub id: Option<String>,
    pub success: bool,
    pub data: serde_json::Value,
    pub error: Option<String>,
}

#[tokio::main]
async fn main() {
    let config = EngineConfig::load("engine.toml");

    init_tracing(&config);

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "Capital Guard Engine starting"
    );

    let args: Vec<String> = std::env::args().collect();
    let mode = if args.iter().any(|a| a == "--http" || a == "--server") {
        "http"
    } else if args.iter().any(|a| a == "--daemon") {
        "daemon"
    } else {
        "single"
    };

    let state = AppState::new(config.clone(), 1_000_000.0);

    match mode {
        "http" => {
            info!(host = %config.server.host, port = config.server.port, "Starting HTTP server");
            server::run(state).await;
        }
        "daemon" => {
            info!("Starting daemon mode (stdin/stdout JSON-RPC)");
            run_daemon(state);
        }
        _ => {
            run_single_shot(state);
        }
    }
}

fn init_tracing(config: &EngineConfig) {
    use tracing_subscriber::{fmt, EnvFilter};

    let filter = EnvFilter::try_from_default_env()
        .unwrap_or_else(|_| EnvFilter::new(&config.logging.level));

    let subscriber = fmt()
        .with_env_filter(filter)
        .with_target(false)
        .with_writer(std::io::stderr);

    match config.logging.format.as_str() {
        "json" => { subscriber.json().init(); }
        "compact" => { subscriber.compact().init(); }
        _ => { subscriber.init(); }
    }
}

fn run_single_shot(state: Arc<AppState>) {
    use std::io::Read;
    let mut input = String::new();
    std::io::stdin().read_to_string(&mut input).unwrap_or_default();

    let response = match serde_json::from_str::<Request>(&input) {
        Ok(req) => handle_request(req, &state),
        Err(e) => Response {
            id: None,
            success: false,
            data: serde_json::Value::Null,
            error: Some(format!("Invalid JSON input: {}", e)),
        },
    };

    match serde_json::to_string(&response) {
        Ok(json) => println!("{}", json),
        Err(e) => error!("Failed to serialize response: {}", e),
    }
}

fn run_daemon(state: Arc<AppState>) {
    use std::io::BufRead;
    info!("Daemon mode started, reading newline-delimited JSON from stdin");
    let stdin = std::io::stdin();
    let reader = stdin.lock();

    for line in reader.lines() {
        let line = match line {
            Ok(l) => l,
            Err(_) => break,
        };
        let trimmed = line.trim();
        if trimmed.is_empty() { continue; }

        let response = match serde_json::from_str::<Request>(trimmed) {
            Ok(req) => handle_request(req, &state),
            Err(e) => Response {
                id: None,
                success: false,
                data: serde_json::Value::Null,
                error: Some(format!("Invalid JSON: {}", e)),
            },
        };

        match serde_json::to_string(&response) {
            Ok(out) => println!("{}", out),
            Err(e) => error!("Failed to serialize response: {}", e),
        }
    }
    info!("Daemon shutting down");
}

pub fn handle_request(req: Request, state: &Arc<AppState>) -> Response {
    let id = req.id.clone();
    let cmd = req.command.as_str();

    info!(command = cmd, id = ?id, "Handling request");

    let result = match cmd {
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
        "ml_score" => ml_scorer::compute(req.data),

        "portfolio_snapshot" => {
            Ok(serde_json::to_value(state.snapshot()).unwrap_or_default())
        }
        "list_positions" => {
            let positions: Vec<_> = state.positions.iter()
                .map(|entry| entry.value().clone())
                .collect();
            Ok(serde_json::to_value(positions).unwrap_or_default())
        }
        "list_strategies" => {
            Ok(serde_json::json!({
                "strategies": strategy::available_strategies()
            }))
        }
        "health" => {
            Ok(serde_json::json!({
                "status": "healthy",
                "uptime_seconds": state.uptime_seconds(),
                "version": env!("CARGO_PKG_VERSION"),
                "positions": state.positions.len(),
            }))
        }

        _ => Err(format!("Unknown command: {}", cmd)),
    };

    match &result {
        Ok(_) => info!(command = cmd, "Request completed successfully"),
        Err(e) => warn!(command = cmd, error = %e, "Request failed"),
    }

    match result {
        Ok(data) => Response { id, success: true, data, error: None },
        Err(e) => Response { id, success: false, data: serde_json::Value::Null, error: Some(e) },
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_state() -> Arc<AppState> {
        AppState::new(EngineConfig::default(), 1_000_000.0)
    }

    fn req(command: &str, data: serde_json::Value) -> Response {
        let state = make_state();
        handle_request(Request {
            id: Some("test".to_string()),
            command: command.to_string(),
            data,
        }, &state)
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
        let state = make_state();
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
        }, &state);
        assert_eq!(resp.id, Some("my-unique-id-42".to_string()));
    }

    #[test]
    fn test_health_endpoint() {
        let resp = req("health", json!({}));
        assert!(resp.success);
        assert_eq!(resp.data["status"], "healthy");
    }

    #[test]
    fn test_portfolio_snapshot() {
        let resp = req("portfolio_snapshot", json!({}));
        assert!(resp.success);
        assert_eq!(resp.data["nav"], 1_000_000.0);
    }

    #[test]
    fn test_list_strategies() {
        let resp = req("list_strategies", json!({}));
        assert!(resp.success);
        let strats = resp.data["strategies"].as_array().unwrap();
        assert!(strats.len() >= 6);
    }
}
