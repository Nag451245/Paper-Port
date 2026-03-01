pub mod backtest;
pub mod signals;
mod risk;
mod greeks;
mod scan;
mod optimize;
mod walk_forward;
mod advanced_signals;
mod iv_surface;

use serde::{Deserialize, Serialize};
use std::io::{self, Read};

#[derive(Deserialize)]
struct Request {
    command: String,
    data: serde_json::Value,
}

#[derive(Serialize)]
struct Response {
    success: bool,
    data: serde_json::Value,
    error: Option<String>,
}

fn main() {
    let mut input = String::new();
    io::stdin().read_to_string(&mut input).unwrap_or_default();

    let response = match serde_json::from_str::<Request>(&input) {
        Ok(req) => handle_request(req),
        Err(e) => Response {
            success: false,
            data: serde_json::Value::Null,
            error: Some(format!("Invalid JSON input: {}", e)),
        },
    };

    println!("{}", serde_json::to_string(&response).unwrap());
}

fn handle_request(req: Request) -> Response {
    match req.command.as_str() {
        "backtest" => match backtest::run(req.data) {
            Ok(result) => Response { success: true, data: result, error: None },
            Err(e) => Response { success: false, data: serde_json::Value::Null, error: Some(e) },
        },
        "signals" => match signals::compute(req.data) {
            Ok(result) => Response { success: true, data: result, error: None },
            Err(e) => Response { success: false, data: serde_json::Value::Null, error: Some(e) },
        },
        "risk" => match risk::compute(req.data) {
            Ok(result) => Response { success: true, data: result, error: None },
            Err(e) => Response { success: false, data: serde_json::Value::Null, error: Some(e) },
        },
        "greeks" => match greeks::compute(req.data) {
            Ok(result) => Response { success: true, data: result, error: None },
            Err(e) => Response { success: false, data: serde_json::Value::Null, error: Some(e) },
        },
        "scan" => match scan::compute(req.data) {
            Ok(result) => Response { success: true, data: result, error: None },
            Err(e) => Response { success: false, data: serde_json::Value::Null, error: Some(e) },
        },
        "optimize" => match optimize::compute(req.data) {
            Ok(result) => Response { success: true, data: result, error: None },
            Err(e) => Response { success: false, data: serde_json::Value::Null, error: Some(e) },
        },
        "walk_forward" => match walk_forward::compute(req.data) {
            Ok(result) => Response { success: true, data: result, error: None },
            Err(e) => Response { success: false, data: serde_json::Value::Null, error: Some(e) },
        },
        "advanced_signals" => match advanced_signals::compute(req.data) {
            Ok(result) => Response { success: true, data: result, error: None },
            Err(e) => Response { success: false, data: serde_json::Value::Null, error: Some(e) },
        },
        "iv_surface" => match iv_surface::compute(req.data) {
            Ok(result) => Response { success: true, data: result, error: None },
            Err(e) => Response { success: false, data: serde_json::Value::Null, error: Some(e) },
        },
        _ => Response {
            success: false,
            data: serde_json::Value::Null,
            error: Some(format!("Unknown command: {}", req.command)),
        },
    }
}
