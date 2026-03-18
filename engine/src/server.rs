use std::sync::Arc;
use std::sync::atomic::{AtomicU64, Ordering};
use axum::{
    Router,
    extract::{State, Json, Path, WebSocketUpgrade, ws},
    response::IntoResponse,
    routing::{get, post},
    http::StatusCode,
    middleware::{self, Next},
};
use tower_http::cors::{CorsLayer, AllowOrigin};
use tower_http::trace::TraceLayer;
use axum::http::{HeaderValue, Request as HttpRequest};
use serde_json::json;
use tracing::{info, warn, error};

use crate::state::{AppState, Position};
use crate::{Request, Response, handle_request};
use crate::config::TlsConfig;

type SharedState = Arc<AppState>;

// ─── Rate Limiter (token-bucket per server) ───────────────────────────

struct RateLimiter {
    tokens: AtomicU64,
    max_tokens: u64,
    last_refill: AtomicU64,
    window_secs: u64,
}

impl RateLimiter {
    fn new(max_requests: u64, window_secs: u64) -> Arc<Self> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        Arc::new(Self {
            tokens: AtomicU64::new(max_requests),
            max_tokens: max_requests,
            last_refill: AtomicU64::new(now),
            window_secs,
        })
    }

    fn try_acquire(&self) -> bool {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_secs();
        let last = self.last_refill.load(Ordering::Acquire);
        if now.saturating_sub(last) >= self.window_secs {
            self.tokens.store(self.max_tokens, Ordering::Release);
            self.last_refill.store(now, Ordering::Release);
        }
        loop {
            let current = self.tokens.load(Ordering::Acquire);
            if current == 0 {
                return false;
            }
            if self.tokens.compare_exchange_weak(
                current, current - 1,
                Ordering::AcqRel, Ordering::Relaxed,
            ).is_ok() {
                return true;
            }
        }
    }
}

async fn rate_limit_layer(
    State((state, limiter)): State<(SharedState, Arc<RateLimiter>)>,
    req: HttpRequest<axum::body::Body>,
    next: Next,
) -> impl IntoResponse {
    if !state.config.rate_limit.enabled {
        return next.run(req).await;
    }
    let path = req.uri().path();
    if path == "/health" || path == "/metrics" {
        return next.run(req).await;
    }
    if limiter.try_acquire() {
        next.run(req).await
    } else {
        state.log_audit("RATE_LIMITED", None, &format!("Request to {} rate-limited", path));
        (StatusCode::TOO_MANY_REQUESTS, Json(json!({
            "error": "Rate limit exceeded. Try again later.",
            "retry_after_secs": state.config.rate_limit.window_secs,
        }))).into_response()
    }
}

/// Auth middleware: checks X-API-Key header when auth is enabled
async fn auth_layer(
    State(state): State<SharedState>,
    req: HttpRequest<axum::body::Body>,
    next: Next,
) -> impl IntoResponse {
    if !state.config.auth.enabled {
        return next.run(req).await;
    }

    let path = req.uri().path();
    if path == "/health" || path == "/metrics" {
        return next.run(req).await;
    }

    let key = req.headers()
        .get("x-api-key")
        .and_then(|v| v.to_str().ok())
        .unwrap_or("");

    if key == state.config.auth.api_key {
        next.run(req).await
    } else {
        (StatusCode::UNAUTHORIZED, Json(json!({ "error": "Invalid or missing API key" }))).into_response()
    }
}

pub async fn run(state: SharedState) {
    let cors = if state.config.auth.allowed_origins.is_empty() {
        CorsLayer::permissive()
    } else {
        let origins: Vec<HeaderValue> = state.config.auth.allowed_origins.iter()
            .filter_map(|o| o.parse().ok())
            .collect();
        CorsLayer::new()
            .allow_origin(AllowOrigin::list(origins))
            .allow_methods(tower_http::cors::Any)
            .allow_headers(tower_http::cors::Any)
    };

    let app = Router::new()
        .route("/health", get(health))
        .route("/metrics", get(metrics))

        .route("/rpc", post(rpc_handler))

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

        .route("/api/portfolio/snapshot", get(portfolio_snapshot))
        .route("/api/portfolio/positions", get(list_positions))
        .route("/api/portfolio/positions", post(open_position))
        .route("/api/portfolio/positions/{symbol}", axum::routing::delete(close_position))

        .route("/api/kill_switch", post(kill_switch_on))
        .route("/api/kill_switch/off", post(kill_switch_off))
        .route("/api/audit_log", get(audit_log))

        .route("/api/oms/orders", get(oms_orders))
        .route("/api/oms/orders", post(oms_submit_order))
        .route("/api/oms/orders/{order_id}/modify", post(oms_modify_order))
        .route("/api/oms/orders/{order_id}/cancel", post(oms_cancel_order))
        .route("/api/oms/cancel_all", post(oms_cancel_all))
        .route("/api/oms/reconcile", post(oms_reconcile))

        .route("/api/alerts", get(alerts_list))
        .route("/api/alerts/counts", get(alert_counts))
        .route("/api/alerts/{alert_id}/acknowledge", post(alert_acknowledge))

        .route("/api/broker/status", get(broker_status))
        .route("/api/broker/init_session", post(broker_init_session))
        .route("/api/broker/quote/{symbol}", get(broker_quote))
        .route("/api/broker/historical/{symbol}", get(broker_historical))
        .route("/api/broker/option_chain/{symbol}", get(broker_option_chain))
        .route("/api/broker/expiries/{symbol}", get(broker_expiries))
        .route("/api/broker/lot_sizes", get(broker_lot_sizes))
        .route("/api/market_data/prices", get(market_data_prices))
        .route("/api/market_data/price/{symbol}", get(market_data_price))

        .route("/api/options/data/{symbol}", get(options_data_handler))
        .route("/api/options/signals", get(options_signals_handler))

        .route("/api/strategies", get(list_strategies))
        .route("/api/signals/cache/{symbol}", get(cached_signals))
        .route("/api/scan/active_symbols", get(scan_active_symbols))
        .route("/api/scan/status", get(scan_status))
        .route("/api/universe/refresh", post(universe_refresh))

        .route("/api/performance/summary", get(perf_summary))
        .route("/api/performance/health", get(perf_health))
        .route("/api/performance/health/{strategy}", get(perf_health_strategy))
        .route("/api/performance/calibrate", post(perf_calibrate))
        .route("/api/performance/record", post(perf_record_outcome))
        .route("/api/performance/strategies", get(perf_active_strategies))
        .route("/api/performance/training_data", get(perf_training_data))

        .route("/api/execution/plan", post(exec_plan))
        .route("/api/execution/quality", post(exec_quality))
        .route("/api/execution/optimal_size", post(exec_optimal_size))

        .route("/api/market_data/ticks/{symbol}", get(tick_data_handler))

        .route("/api/discovery/run", post(discovery_run))
        .route("/api/discovery/results", get(discovery_results))
        .route("/api/discovery/apply", post(discovery_apply))

        .route("/ws", get(ws_handler))

        .layer(middleware::from_fn_with_state(state.clone(), auth_layer))
        .layer(middleware::from_fn_with_state(
            (state.clone(), RateLimiter::new(
                state.config.rate_limit.max_requests,
                state.config.rate_limit.window_secs,
            )),
            rate_limit_layer,
        ))
        .layer(cors)
        .layer(TraceLayer::new_for_http())
        .layer(axum::extract::DefaultBodyLimit::max(2 * 1024 * 1024))
        .with_state(state.clone());

    let addr = format!("{}:{}", state.config.server.host, state.config.server.port);
    let tls_config = state.config.tls.clone();

    if tls_config.enabled {
        info!("Listening on https://{} (TLS)", addr);
        run_tls_server(app, &addr, &tls_config, state).await;
    } else {
        info!("Listening on http://{}", addr);
        run_plain_server(app, &addr, state).await;
    }
}

async fn run_plain_server(app: Router, addr: &str, state: SharedState) {
    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("Failed to bind to {}: {}", addr, e);
            std::process::exit(1);
        }
    };

    let shutdown_state = state.clone();
    let shutdown = async move {
        tokio::signal::ctrl_c().await.ok();
        info!("Shutting down gracefully...");
        save_final_snapshot(&shutdown_state);
    };

    if let Err(e) = axum::serve(listener, app)
        .with_graceful_shutdown(shutdown)
        .await
    {
        error!("Server error: {}", e);
        std::process::exit(1);
    }
}

async fn run_tls_server(app: Router, addr: &str, tls: &TlsConfig, state: SharedState) {
    use rustls::ServerConfig;
    use tokio_rustls::TlsAcceptor;
    use hyper::service::service_fn;
    use hyper_util::rt::TokioIo;
    use hyper_util::server::conn::auto::Builder;
    use hyper_util::rt::TokioExecutor;
    use tower::Service;

    let certs = load_certs(&tls.cert_path);
    let key = load_private_key(&tls.key_path);

    let tls_config = ServerConfig::builder()
        .with_no_client_auth()
        .with_single_cert(certs, key)
        .unwrap_or_else(|e| {
            error!("Invalid TLS configuration: {}", e);
            std::process::exit(1);
        });

    let acceptor = TlsAcceptor::from(Arc::new(tls_config));

    let listener = match tokio::net::TcpListener::bind(addr).await {
        Ok(l) => l,
        Err(e) => {
            error!("Failed to bind TLS to {}: {}", addr, e);
            std::process::exit(1);
        }
    };

    let shutdown_state = state;
    let shutdown_token = tokio::sync::watch::channel(false);
    let (tx, mut rx) = shutdown_token;

    let tx_clone = tx.clone();
    tokio::spawn(async move {
        tokio::signal::ctrl_c().await.ok();
        info!("Shutting down TLS server gracefully...");
        save_final_snapshot(&shutdown_state);
        let _ = tx_clone.send(true);
    });

    loop {
        tokio::select! {
            accept = listener.accept() => {
                let (stream, peer_addr) = match accept {
                    Ok(v) => v,
                    Err(e) => {
                        warn!("TCP accept error: {}", e);
                        continue;
                    }
                };

                let acceptor = acceptor.clone();
                let app = app.clone();
                let mut shutdown_rx = rx.clone();

                tokio::spawn(async move {
                    let tls_stream = match acceptor.accept(stream).await {
                        Ok(s) => s,
                        Err(e) => {
                            warn!("TLS handshake failed from {}: {}", peer_addr, e);
                            return;
                        }
                    };

                    let io = TokioIo::new(tls_stream);
                    let service = app;
                    let hyper_service = service_fn(move |req| {
                        let mut svc = service.clone();
                        async move { svc.call(req).await }
                    });

                    let builder = Builder::new(TokioExecutor::new());
                    let conn = builder.serve_connection(io, hyper_service);

                    tokio::pin!(conn);
                    tokio::select! {
                        result = &mut conn => {
                            if let Err(e) = result {
                                warn!("Connection error: {}", e);
                            }
                        }
                        _ = shutdown_rx.changed() => {
                            info!("Connection closed by shutdown");
                        }
                    }
                });
            }
            _ = rx.changed() => {
                info!("TLS server stopped");
                break;
            }
        }
    }
}

fn load_certs(path: &str) -> Vec<rustls::pki_types::CertificateDer<'static>> {
    let file = std::fs::File::open(path)
        .unwrap_or_else(|e| {
            error!("Cannot open TLS cert {}: {}", path, e);
            std::process::exit(1);
        });
    let mut reader = std::io::BufReader::new(file);
    rustls_pemfile::certs(&mut reader)
        .map(|result| result.unwrap_or_else(|e| {
            error!("Invalid cert in {}: {}", path, e);
            std::process::exit(1);
        }))
        .collect()
}

fn load_private_key(path: &str) -> rustls::pki_types::PrivateKeyDer<'static> {
    let file = std::fs::File::open(path)
        .unwrap_or_else(|e| {
            error!("Cannot open TLS key {}: {}", path, e);
            std::process::exit(1);
        });
    let mut reader = std::io::BufReader::new(file);
    rustls_pemfile::private_key(&mut reader)
        .unwrap_or_else(|e| {
            error!("Invalid key in {}: {}", path, e);
            std::process::exit(1);
        })
        .unwrap_or_else(|| {
            error!("No private key found in {}", path);
            std::process::exit(1);
        })
}

fn save_final_snapshot(state: &SharedState) {
    if state.config.persistence.enabled {
        if let Err(e) = state.save_snapshot(&state.config.persistence.snapshot_path) {
            error!("Final snapshot save failed: {}", e);
        } else {
            info!("Final state snapshot saved");
        }
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
    let peak_nav = state.get_peak_nav();
    let drawdown_pct = if peak_nav > 0.0 { (peak_nav - nav) / peak_nav * 100.0 } else { 0.0 };
    let uptime = state.uptime_seconds();
    let daily_trades = state.daily_trade_count.load(std::sync::atomic::Ordering::Relaxed);
    let total_orders = state.oms.total_orders.load(std::sync::atomic::Ordering::Relaxed);
    let total_fills = state.oms.total_fills.load(std::sync::atomic::Ordering::Relaxed);
    let total_rejections = state.oms.total_rejections.load(std::sync::atomic::Ordering::Relaxed);
    let killed = if state.is_killed() { 1 } else { 0 };
    let cash = state.get_cash();
    let realized_pnl = state.get_realized_pnl();

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
         # HELP cg_rust_peak_nav Peak NAV watermark\n\
         # TYPE cg_rust_peak_nav gauge\n\
         cg_rust_peak_nav {peak_nav}\n\
         # HELP cg_rust_drawdown_pct Current drawdown percentage\n\
         # TYPE cg_rust_drawdown_pct gauge\n\
         cg_rust_drawdown_pct {drawdown_pct:.4}\n\
         # HELP cg_rust_cash Available cash\n\
         # TYPE cg_rust_cash gauge\n\
         cg_rust_cash {cash}\n\
         # HELP cg_rust_realized_pnl Total realized PnL\n\
         # TYPE cg_rust_realized_pnl gauge\n\
         cg_rust_realized_pnl {realized_pnl}\n\
         # HELP cg_rust_daily_trades Daily trade count\n\
         # TYPE cg_rust_daily_trades counter\n\
         cg_rust_daily_trades {daily_trades}\n\
         # HELP cg_rust_total_orders Total orders submitted to OMS\n\
         # TYPE cg_rust_total_orders counter\n\
         cg_rust_total_orders {total_orders}\n\
         # HELP cg_rust_total_fills Total filled orders\n\
         # TYPE cg_rust_total_fills counter\n\
         cg_rust_total_fills {total_fills}\n\
         # HELP cg_rust_total_rejections Total rejected orders\n\
         # TYPE cg_rust_total_rejections counter\n\
         cg_rust_total_rejections {total_rejections}\n\
         # HELP cg_rust_kill_switch Kill switch status (0=off, 1=on)\n\
         # TYPE cg_rust_kill_switch gauge\n\
         cg_rust_kill_switch {killed}\n"
    );

    (
        StatusCode::OK,
        [("content-type", "text/plain; version=0.0.4; charset=utf-8")],
        body,
    )
}

// ─── Kill Switch ──────────────────────────────────────────────────────

async fn kill_switch_on(State(state): State<SharedState>) -> impl IntoResponse {
    state.activate_kill_switch();
    (StatusCode::OK, Json(json!({ "killed": true, "message": "Kill switch activated — all new orders rejected" })))
}

async fn kill_switch_off(State(state): State<SharedState>) -> impl IntoResponse {
    state.deactivate_kill_switch();
    (StatusCode::OK, Json(json!({ "killed": false, "message": "Kill switch deactivated" })))
}

async fn audit_log(State(state): State<SharedState>) -> impl IntoResponse {
    Json(state.get_audit_log())
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
    use crate::broker::{OrderRequest, OrderSide, OrderType, ProductType};

    let order_side = if req.side.eq_ignore_ascii_case("sell") || req.side.eq_ignore_ascii_case("short") {
        OrderSide::Sell
    } else {
        OrderSide::Buy
    };

    let order_req = OrderRequest {
        symbol: req.symbol.clone(),
        exchange: "NSE".into(),
        side: order_side,
        order_type: OrderType::Limit,
        quantity: req.qty,
        price: Some(req.price),
        trigger_price: None,
        product: ProductType::Delivery,
        tag: Some("position_api".into()),
        ..Default::default()
    };

    let ref_price = state.live_prices.get_ltp(&req.symbol);
    match state.oms.submit_order(order_req, None, ref_price) {
        Ok(order) => {
            let pos = Position {
                symbol: req.symbol,
                side: req.side,
                qty: req.qty,
                entry_price: if order.avg_fill_price > 0.0 { order.avg_fill_price } else { req.price },
                current_price: req.price,
                unrealized_pnl: 0.0,
                realized_pnl: 0.0,
                entry_time: chrono::Utc::now().to_rfc3339(),
                stop_loss: req.stop_loss,
                take_profit: req.take_profit,
                asset_class: crate::broker::AssetClass::Equity,
                expiry: None,
                strike: None,
                option_type: None,
            };

            match state.open_position(pos) {
                Ok(()) => (StatusCode::CREATED, Json(json!({
                    "success": true,
                    "oms_order_id": order.internal_id,
                    "broker_order_id": order.broker_order_id,
                }))),
                Err(e) => (StatusCode::BAD_REQUEST, Json(json!({ "success": false, "error": e }))),
            }
        }
        Err(e) => {
            state.log_audit("POSITION_REJECTED_BY_OMS", Some(&req.symbol),
                &format!("OMS rejected: {}", e));
            (StatusCode::BAD_REQUEST, Json(json!({ "success": false, "error": e })))
        }
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
    if state.is_killed() {
        state.log_audit("CLOSE_DURING_KILL_SWITCH", Some(&symbol),
            &format!("Closing position at {:.2} while kill switch is active (allowed for risk reduction)", query.price));
    }

    // Submit a sell/cover order through the broker before updating internal state
    {
        use crate::broker::{OrderRequest, OrderSide, OrderType, ProductType, AssetClass};

        let pos_snapshot = state.positions.get(&symbol)
            .map(|r| r.value().clone())
            .or_else(|| {
                state.positions.iter()
                    .find(|entry| entry.value().symbol == symbol)
                    .map(|entry| entry.value().clone())
            });

        if let Some(pos) = pos_snapshot {
            let exit_side = if pos.side == "buy" { OrderSide::Sell } else { OrderSide::Buy };
            let exchange = match pos.asset_class {
                AssetClass::Options | AssetClass::Futures => "NFO".to_string(),
                _ => "NSE".to_string(),
            };
            let req = OrderRequest {
                symbol: pos.symbol.clone(),
                exchange,
                side: exit_side,
                order_type: OrderType::Market,
                quantity: pos.qty.unsigned_abs() as i64,
                price: Some(query.price),
                trigger_price: None,
                product: ProductType::Intraday,
                tag: Some("EXIT".to_string()),
                asset_class: pos.asset_class,
                expiry: pos.expiry.clone(),
                strike: pos.strike,
                option_type: pos.option_type.clone(),
            };
            match state.broker_adapter.place_order(&req) {
                Ok(resp) => {
                    state.log_audit("BROKER_EXIT_ORDER", Some(&symbol),
                        &format!("Exit order submitted: broker_id={} status={:?}", resp.broker_order_id, resp.status));
                }
                Err(e) => {
                    state.log_audit("BROKER_EXIT_FAILED", Some(&symbol),
                        &format!("Broker exit order failed: {} — proceeding with internal close", e));
                }
            }
        }
    }

    match state.close_position(&symbol, query.price) {
        Ok(pnl) => (StatusCode::OK, Json(json!({ "success": true, "realized_pnl": pnl }))),
        Err(e) => (StatusCode::NOT_FOUND, Json(json!({ "success": false, "error": e }))),
    }
}

// ─── OMS endpoints ────────────────────────────────────────────────────

cmd_handler!(oms_submit_order, "oms_submit_order");
cmd_handler!(oms_cancel_all, "oms_cancel_all");
cmd_handler!(oms_reconcile, "oms_reconcile");

async fn oms_orders(
    State(state): State<SharedState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let data = match params.get("strategy_id") {
        Some(sid) => serde_json::json!({ "strategy_id": sid }),
        None => serde_json::json!({}),
    };
    let req = Request { id: None, command: "oms_orders".to_string(), data };
    let response = handle_request(req, &state);
    let status = if response.success { StatusCode::OK } else { StatusCode::BAD_REQUEST };
    (status, Json(response))
}

async fn oms_modify_order(
    State(state): State<SharedState>,
    Path(order_id): Path<String>,
    Json(body): Json<serde_json::Value>,
) -> impl IntoResponse {
    let mut data = body;
    data["order_id"] = serde_json::json!(order_id);
    let req = Request {
        id: None,
        command: "oms_modify_order".to_string(),
        data,
    };
    let response = handle_request(req, &state);
    let status = if response.success { StatusCode::OK } else { StatusCode::BAD_REQUEST };
    (status, Json(response))
}

async fn oms_cancel_order(
    State(state): State<SharedState>,
    Path(order_id): Path<String>,
) -> impl IntoResponse {
    let req = Request {
        id: None,
        command: "oms_cancel_order".to_string(),
        data: serde_json::json!({ "order_id": order_id }),
    };
    let response = handle_request(req, &state);
    let status = if response.success { StatusCode::OK } else { StatusCode::BAD_REQUEST };
    (status, Json(response))
}

// ─── Alert endpoints ──────────────────────────────────────────────────

async fn alerts_list(
    State(state): State<SharedState>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let mut data = serde_json::json!({});
    if let Some(sev) = params.get("min_severity") {
        data["min_severity"] = serde_json::json!(sev);
    }
    if let Some(limit) = params.get("limit") {
        if let Ok(n) = limit.parse::<u64>() {
            data["limit"] = serde_json::json!(n);
        }
    }
    let req = Request { id: None, command: "alerts".to_string(), data };
    let response = handle_request(req, &state);
    (StatusCode::OK, Json(response))
}

async fn alert_counts(State(state): State<SharedState>) -> impl IntoResponse {
    let req = Request { id: None, command: "alert_counts".to_string(), data: serde_json::json!({}) };
    let response = handle_request(req, &state);
    (StatusCode::OK, Json(response))
}

async fn alert_acknowledge(
    State(state): State<SharedState>,
    Path(alert_id): Path<String>,
) -> impl IntoResponse {
    let req = Request {
        id: None,
        command: "alert_acknowledge".to_string(),
        data: serde_json::json!({ "alert_id": alert_id }),
    };
    let response = handle_request(req, &state);
    let status = if response.success { StatusCode::OK } else { StatusCode::NOT_FOUND };
    (status, Json(response))
}

// ─── Broker & Market Data ─────────────────────────────────────────────

async fn broker_status(State(state): State<SharedState>) -> impl IntoResponse {
    use crate::broker_icici::IciciBreezeBroker;

    let broker_name = state.config.broker.adapter.clone();
    let connected = if let Some(icici) = state.broker_adapter.as_any().downcast_ref::<IciciBreezeBroker>() {
        icici.refresh_status()
    } else {
        state.broker_adapter.is_connected()
    };

    Json(json!({
        "broker": broker_name,
        "connected": connected,
        "bridge_url": state.config.broker.icici.bridge_url,
    }))
}

async fn broker_init_session(State(state): State<SharedState>) -> impl IntoResponse {
    use crate::broker_icici::IciciBreezeBroker;

    if let Some(icici) = state.broker_adapter.as_any().downcast_ref::<IciciBreezeBroker>() {
        match icici.init_session() {
            Ok(()) => {
                state.log_audit("BROKER_SESSION_INIT", None, "ICICI Breeze session initialized via bridge");
                (StatusCode::OK, Json(json!({ "success": true, "message": "Session initialized" })))
            }
            Err(e) => {
                (StatusCode::INTERNAL_SERVER_ERROR, Json(json!({ "success": false, "error": e })))
            }
        }
    } else {
        (StatusCode::BAD_REQUEST, Json(json!({ "success": false, "error": "Session init only supported for ICICI Breeze" })))
    }
}

async fn broker_quote(
    State(state): State<SharedState>,
    Path(symbol): Path<String>,
) -> impl IntoResponse {
    let bridge_url = &state.config.broker.icici.bridge_url;
    match crate::broker_icici::bridge_get_quote(bridge_url, &symbol) {
        Ok(data) => Json(data),
        Err(e) => Json(json!({ "error": e })),
    }
}

async fn broker_historical(
    State(state): State<SharedState>,
    Path(symbol): Path<String>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let bridge_url = &state.config.broker.icici.bridge_url;
    let interval = params.get("interval").map(|s| s.as_str()).unwrap_or("5minute");
    let from = params.get("from").map(|s| s.as_str()).unwrap_or("");
    let to = params.get("to").map(|s| s.as_str()).unwrap_or("");
    match crate::broker_icici::bridge_get_historical(bridge_url, &symbol, interval, from, to) {
        Ok(data) => Json(data),
        Err(e) => Json(json!({ "error": e })),
    }
}

async fn broker_option_chain(
    State(state): State<SharedState>,
    Path(symbol): Path<String>,
    axum::extract::Query(params): axum::extract::Query<std::collections::HashMap<String, String>>,
) -> impl IntoResponse {
    let bridge_url = &state.config.broker.icici.bridge_url;
    let expiry = params.get("expiry").map(|s| s.as_str());
    match crate::broker_icici::bridge_get_option_chain(bridge_url, &symbol, expiry) {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": e, "symbol": symbol, "strikes": [] }))),
    }
}

async fn broker_expiries(
    State(state): State<SharedState>,
    Path(symbol): Path<String>,
) -> impl IntoResponse {
    let bridge_url = &state.config.broker.icici.bridge_url;
    match crate::broker_icici::bridge_get_expiries(bridge_url, &symbol) {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": e, "symbol": symbol, "expiries": [] }))),
    }
}

async fn broker_lot_sizes(State(state): State<SharedState>) -> impl IntoResponse {
    let bridge_url = &state.config.broker.icici.bridge_url;
    match crate::broker_icici::bridge_get_lot_sizes(bridge_url) {
        Ok(data) => (StatusCode::OK, Json(data)),
        Err(e) => (StatusCode::SERVICE_UNAVAILABLE, Json(json!({ "error": e, "lotSizes": {} }))),
    }
}

async fn market_data_prices(State(state): State<SharedState>) -> impl IntoResponse {
    let prices = state.live_prices.all_prices();
    Json(json!({
        "count": prices.len(),
        "prices": prices,
    }))
}

async fn market_data_price(
    State(state): State<SharedState>,
    Path(symbol): Path<String>,
) -> impl IntoResponse {
    match state.live_prices.get_tick(&symbol) {
        Some(tick) => (StatusCode::OK, Json(json!(tick))),
        None => (StatusCode::NOT_FOUND, Json(json!({ "error": format!("No data for {}", symbol) }))),
    }
}

// ─── Options Data ─────────────────────────────────────────────────────

async fn options_data_handler(
    State(state): State<SharedState>,
    Path(symbol): Path<String>,
) -> impl IntoResponse {
    match state.options_data.get(&symbol) {
        Some(snap) => (StatusCode::OK, Json(json!(snap))),
        None => (StatusCode::NOT_FOUND, Json(json!({
            "error": format!("No options data for {}", symbol),
            "symbol": symbol,
        }))),
    }
}

async fn options_signals_handler(
    State(state): State<SharedState>,
) -> impl IntoResponse {
    let snapshots = state.options_data.all_snapshots();
    let mut all_signals = Vec::new();
    for snap in &snapshots {
        let signals = state.get_cached_signals(&snap.symbol);
        let options_signals: Vec<_> = signals.into_iter()
            .filter(|s| matches!(
                s.strategy.as_str(),
                "oi_buildup" | "pcr_extremes" | "iv_crush" | "max_pain_convergence"
            ))
            .collect();
        all_signals.extend(options_signals);
    }
    Json(json!({
        "count": all_signals.len(),
        "symbols_tracked": snapshots.len(),
        "signals": all_signals,
    }))
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

// ─── Scan status & active symbols ─────────────────────────────────────

async fn scan_active_symbols(
    State(state): State<SharedState>,
) -> impl IntoResponse {
    let symbols: Vec<String> = state.signal_cache.iter()
        .map(|e| e.value().symbol.clone())
        .collect::<std::collections::HashSet<_>>()
        .into_iter()
        .collect();
    Json(json!({
        "count": symbols.len(),
        "symbols": symbols,
    }))
}

async fn scan_status(
    State(state): State<SharedState>,
) -> impl IntoResponse {
    let ledger = &state.scan_ledger;
    let status = crate::continuous_scanner::get_status(ledger, 50);
    Json(json!({
        "total_signals": status.total_signals,
        "sector_count": status.sector_count,
        "top_signals": status.top_signals,
        "sector_scores": status.sector_scores,
    }))
}

async fn universe_refresh(
    State(state): State<SharedState>,
) -> impl IntoResponse {
    let bridge_url = state.config.broker.icici.bridge_url.clone();
    let universe = state.universe.clone();
    let result = tokio::task::spawn_blocking(move || {
        universe.refresh_from_bridge(&bridge_url)
    }).await;
    match result {
        Ok(Ok(count)) => Json(json!({"status": "ok", "count": count})),
        Ok(Err(e)) => Json(json!({"status": "error", "error": e})),
        Err(e) => Json(json!({"status": "error", "error": format!("{}", e)})),
    }
}

// ─── Strategy Performance Engine ──────────────────────────────────────

async fn perf_summary() -> impl IntoResponse {
    match crate::strategy_performance::compute(json!({"command": "summary"})) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

async fn perf_health() -> impl IntoResponse {
    match crate::strategy_performance::compute(json!({"command": "health"})) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

async fn perf_health_strategy(Path(strategy): Path<String>) -> impl IntoResponse {
    match crate::strategy_performance::compute(json!({"command": "health", "strategy": strategy})) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

async fn perf_calibrate(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let mut data = body;
    data["command"] = json!("calibrate");
    match crate::strategy_performance::compute(data) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

async fn perf_record_outcome(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let mut data = body;
    data["command"] = json!("record_outcome");
    match crate::strategy_performance::compute(data) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

async fn perf_active_strategies() -> impl IntoResponse {
    match crate::strategy_performance::compute(json!({"command": "active_strategies"})) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

// ─── Smart Execution Engine ──────────────────────────────────────────

async fn exec_plan(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let mut data = body;
    data["command"] = json!("plan");
    match crate::smart_executor::compute(data) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

async fn exec_quality(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let mut data = body;
    data["command"] = json!("quality");
    match crate::smart_executor::compute(data) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

async fn exec_optimal_size(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let mut data = body;
    data["command"] = json!("optimal_size");
    match crate::smart_executor::compute(data) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

// ─── Performance Training Data ────────────────────────────────────────

async fn perf_training_data() -> impl IntoResponse {
    let outcomes = crate::strategy_performance::GLOBAL_TRACKER.get_all_outcomes();

    let mut training_log: Vec<serde_json::Value> = Vec::new();
    let log_path = std::path::Path::new("data/ml_training_log.json");
    if log_path.exists() {
        if let Ok(contents) = std::fs::read_to_string(log_path) {
            if let Ok(parsed) = serde_json::from_str::<Vec<serde_json::Value>>(&contents) {
                training_log = parsed;
            }
        }
    }

    Json(json!({
        "outcomes": outcomes,
        "training_log": training_log,
        "total_outcomes": outcomes.len(),
        "total_log_entries": training_log.len(),
    }))
}

// ─── Tick Data ────────────────────────────────────────────────────────

async fn tick_data_handler(Path(symbol): Path<String>) -> impl IntoResponse {
    let input = json!({
        "command": "features",
        "candles": [],
    });
    match crate::tick_aggregator::TickAggregator::compute(input) {
        Ok(features) => Json(json!({
            "symbol": symbol,
            "features": features,
            "source": "tick_aggregator",
        })),
        Err(_) => Json(json!({
            "symbol": symbol,
            "features": crate::tick_aggregator::MicroFeatures::default(),
            "source": "default",
        })),
    }
}

// ─── Strategy Discovery ──────────────────────────────────────────────

async fn discovery_run(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let mut data = body;
    data["command"] = json!("run");
    match crate::strategy_discovery::compute(data) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

async fn discovery_results() -> impl IntoResponse {
    match crate::strategy_discovery::compute(json!({"command": "results"})) {
        Ok(v) => Json(v),
        Err(e) => Json(json!({"error": e})),
    }
}

async fn discovery_apply(Json(body): Json<serde_json::Value>) -> impl IntoResponse {
    let mut data = body;
    data["command"] = json!("run");
    match crate::strategy_discovery::compute(data) {
        Ok(report) => {
            let promoted = report.get("promoted").cloned().unwrap_or(json!([]));
            let retired = report.get("retired").cloned().unwrap_or(json!([]));
            Json(json!({
                "applied": true,
                "promoted": promoted,
                "retired": retired,
            }))
        }
        Err(e) => Json(json!({"error": e})),
    }
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
