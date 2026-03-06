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
