use std::sync::Arc;
use axum::{
    Router,
    extract::{State, Json, Path, WebSocketUpgrade, ws},
    response::IntoResponse,
    routing::{get, post},
    http::StatusCode,
};
use tower_http::cors::CorsLayer;
use tower_http::trace::TraceLayer;
use serde_json::json;
use tracing::{info, warn};

use crate::state::{AppState, Position};
use crate::{Request, Response, handle_request};

type SharedState = Arc<AppState>;

pub async fn run(state: SharedState) {
    let app = Router::new()
        // Health & meta
        .route("/health", get(health))
        .route("/metrics", get(metrics))
        .route("/config", get(get_config))

        // Generic JSON-RPC pass-through (backward-compatible)
        .route("/rpc", post(rpc_handler))

        // RESTful command endpoints
        .route("/api/backtest", post(cmd_backtest))
        .route("/api/signals", post(cmd_signals))
        .route("/api/risk", post(cmd_risk))
        .route("/api/greeks", post(cmd_greeks))
        .route("/api/scan", post(cmd_scan))
        .route("/api/optimize", post(cmd_optimize))
        .route("/api/walk_forward", post(cmd_walk_forward))
        .route("/api/advanced_signals", post(cmd_advanced_signals))
        .route("/api/iv_surface", post(cmd_iv_surface))
        .route("/api/monte_carlo", post(cmd_monte_carlo))
        .route("/api/portfolio/optimize", post(cmd_portfolio_opt))
        .route("/api/options_strategy", post(cmd_options_strategy))
        .route("/api/correlation", post(cmd_correlation))
        .route("/api/feature_store", post(cmd_feature_store))
        .route("/api/multi_timeframe", post(cmd_multi_timeframe))

        // Portfolio state
        .route("/api/portfolio/snapshot", get(portfolio_snapshot))
        .route("/api/portfolio/positions", get(list_positions))
        .route("/api/portfolio/positions", post(open_position))
        .route("/api/portfolio/positions/{symbol}", axum::routing::delete(close_position))

        // Strategies
        .route("/api/strategies", get(list_strategies))

        // Signals cache
        .route("/api/signals/cache/{symbol}", get(cached_signals))

        // WebSocket for live streaming
        .route("/ws", get(ws_handler))

        .layer(CorsLayer::permissive())
        .layer(TraceLayer::new_for_http())
        .with_state(state.clone());

    let addr = format!("{}:{}", state.config.server.host, state.config.server.port);
    info!("Listening on http://{}", addr);

    let listener = match tokio::net::TcpListener::bind(&addr).await {
        Ok(l) => l,
        Err(e) => {
            tracing::error!("Failed to bind to {}: {}", addr, e);
            return;
        }
    };
    if let Err(e) = axum::serve(listener, app).await {
        tracing::error!("Server error: {}", e);
    }
}

// ─── Health ───────────────────────────────────────────────────────────

async fn health(State(state): State<SharedState>) -> impl IntoResponse {
    Json(json!({
        "status": "healthy",
        "uptime_seconds": state.uptime_seconds(),
        "version": env!("CARGO_PKG_VERSION"),
        "positions": state.positions.len(),
        "nav": state.get_nav(),
    }))
}

async fn metrics(State(state): State<SharedState>) -> impl IntoResponse {
    let positions = state.positions.len();
    let nav = state.get_nav();
    let uptime = state.uptime_seconds();
    let daily_trades = state.daily_trade_count.load(std::sync::atomic::Ordering::Relaxed);

    let body = format!(
        "# HELP cg_rust_uptime_seconds Engine uptime in seconds\n\
         # TYPE cg_rust_uptime_seconds gauge\n\
         cg_rust_uptime_seconds {uptime}\n\
         # HELP cg_rust_open_positions Number of open positions\n\
         # TYPE cg_rust_open_positions gauge\n\
         cg_rust_open_positions {positions}\n\
         # HELP cg_rust_portfolio_nav Portfolio NAV\n\
         # TYPE cg_rust_portfolio_nav gauge\n\
         cg_rust_portfolio_nav {nav}\n\
         # HELP cg_rust_daily_trades Daily trade count\n\
         # TYPE cg_rust_daily_trades counter\n\
         cg_rust_daily_trades {daily_trades}\n"
    );

    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
}

async fn get_config(State(state): State<SharedState>) -> impl IntoResponse {
    Json(serde_json::to_value(&state.config).unwrap_or_default())
}

// ─── JSON-RPC pass-through ────────────────────────────────────────────

async fn rpc_handler(
    State(state): State<SharedState>,
    Json(req): Json<Request>,
) -> impl IntoResponse {
    let response = handle_request(req, &state);
    let status = if response.success { StatusCode::OK } else { StatusCode::BAD_REQUEST };
    (status, Json(response))
}

// ─── RESTful command wrappers ─────────────────────────────────────────

macro_rules! cmd_handler {
    ($fn_name:ident, $command:expr) => {
        async fn $fn_name(
            State(state): State<SharedState>,
            Json(data): Json<serde_json::Value>,
        ) -> impl IntoResponse {
            let req = Request {
                id: None,
                command: $command.to_string(),
                data,
            };
            let response = handle_request(req, &state);
            let status = if response.success { StatusCode::OK } else { StatusCode::BAD_REQUEST };
            (status, Json(response))
        }
    };
}

cmd_handler!(cmd_backtest, "backtest");
cmd_handler!(cmd_signals, "signals");
cmd_handler!(cmd_risk, "risk");
cmd_handler!(cmd_greeks, "greeks");
cmd_handler!(cmd_scan, "scan");
cmd_handler!(cmd_optimize, "optimize");
cmd_handler!(cmd_walk_forward, "walk_forward");
cmd_handler!(cmd_advanced_signals, "advanced_signals");
cmd_handler!(cmd_iv_surface, "iv_surface");
cmd_handler!(cmd_monte_carlo, "monte_carlo");
cmd_handler!(cmd_portfolio_opt, "optimize_portfolio");
cmd_handler!(cmd_options_strategy, "options_strategy");
cmd_handler!(cmd_correlation, "correlation");
cmd_handler!(cmd_feature_store, "feature_store");
cmd_handler!(cmd_multi_timeframe, "multi_timeframe_scan");

// ─── Portfolio endpoints ──────────────────────────────────────────────

async fn portfolio_snapshot(State(state): State<SharedState>) -> impl IntoResponse {
    Json(state.snapshot())
}

async fn list_positions(State(state): State<SharedState>) -> impl IntoResponse {
    let positions: Vec<Position> = state.positions.iter()
        .map(|entry| entry.value().clone())
        .collect();
    Json(positions)
}

#[derive(serde::Deserialize)]
struct OpenPositionRequest {
    symbol: String,
    side: String,
    qty: i64,
    price: f64,
    stop_loss: Option<f64>,
    take_profit: Option<f64>,
}

async fn open_position(
    State(state): State<SharedState>,
    Json(req): Json<OpenPositionRequest>,
) -> impl IntoResponse {
    let pos = Position {
        symbol: req.symbol,
        side: req.side,
        qty: req.qty,
        entry_price: req.price,
        current_price: req.price,
        unrealized_pnl: 0.0,
        realized_pnl: 0.0,
        entry_time: chrono::Utc::now().to_rfc3339(),
        stop_loss: req.stop_loss,
        take_profit: req.take_profit,
    };

    match state.open_position(pos) {
        Ok(()) => (StatusCode::CREATED, Json(json!({ "success": true }))),
        Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "success": false, "error": e }))),
    }
}

#[derive(serde::Deserialize)]
struct ClosePositionQuery {
    price: f64,
}

async fn close_position(
    State(state): State<SharedState>,
    Path(symbol): Path<String>,
    Json(query): Json<ClosePositionQuery>,
) -> impl IntoResponse {
    match state.close_position(&symbol, query.price) {
        Ok(pnl) => (StatusCode::OK, Json(json!({ "success": true, "realized_pnl": pnl }))),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "success": false, "error": e }))),
    }
}

// ─── Strategies ───────────────────────────────────────────────────────

async fn list_strategies() -> impl IntoResponse {
    Json(json!({
        "strategies": crate::strategy::available_strategies()
    }))
}

// ─── Signal cache ─────────────────────────────────────────────────────

async fn cached_signals(
    State(state): State<SharedState>,
    Path(symbol): Path<String>,
) -> impl IntoResponse {
    let signals = state.get_cached_signals(&symbol);
    Json(signals)
}

// ─── WebSocket ────────────────────────────────────────────────────────

async fn ws_handler(
    ws: WebSocketUpgrade,
    State(state): State<SharedState>,
) -> impl IntoResponse {
    ws.on_upgrade(move |socket| handle_ws(socket, state))
}

async fn handle_ws(mut socket: ws::WebSocket, state: SharedState) {
    info!("WebSocket client connected");

    while let Some(msg) = socket.recv().await {
        let msg = match msg {
            Ok(m) => m,
            Err(e) => {
                warn!("WebSocket receive error: {}", e);
                break;
            }
        };

        match msg {
            ws::Message::Text(text) => {
                let response = match serde_json::from_str::<Request>(&text) {
                    Ok(req) => handle_request(req, &state),
                    Err(e) => Response {
                        id: None,
                        success: false,
                        data: serde_json::Value::Null,
                        error: Some(format!("Invalid JSON: {}", e)),
                    },
                };

                let out = serde_json::to_string(&response).unwrap_or_default();
                if socket.send(ws::Message::Text(out.into())).await.is_err() {
                    break;
                }
            }
            ws::Message::Close(_) => break,
            _ => {}
        }
    }

    info!("WebSocket client disconnected");
}
