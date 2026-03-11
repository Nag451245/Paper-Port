pub mod utils;
pub mod config;
pub mod strategy;
pub mod state;
pub mod server;
pub mod backtest;
pub mod signals;
pub mod broker;
pub mod broker_icici;
pub mod broker_zerodha;
pub mod broker_upstox;
pub mod oms;
pub mod alerts;
pub mod market_data;
pub mod options_data;
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
pub mod live_executor;

use std::sync::Arc;
use serde::{Deserialize, Serialize};
use tracing::{info, warn, error};

use crate::config::EngineConfig;
use crate::state::AppState;
use crate::broker::{OrderRequest, OrderSide, OrderType, ProductType};
use crate::alerts::{AlertSeverity, AlertType};

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
    let args: Vec<String> = std::env::args().collect();

    let config_path = args.iter()
        .position(|a| a == "--config")
        .and_then(|i| args.get(i + 1))
        .map(|s| s.as_str())
        .unwrap_or("engine.toml");

    let config = match EngineConfig::load(config_path) {
        Ok(c) => c,
        Err(e) => {
            eprintln!("FATAL: {}", e);
            std::process::exit(1);
        }
    };

    init_tracing(&config);

    info!(
        version = env!("CARGO_PKG_VERSION"),
        "Capital Guard Engine starting"
    );

    let mode = if args.iter().any(|a| a == "--http" || a == "--server") {
        "http"
    } else if args.iter().any(|a| a == "--daemon") {
        "daemon"
    } else {
        "single"
    };

    let state = if config.persistence.enabled {
        let path = &config.persistence.snapshot_path;
        if std::path::Path::new(path).exists() {
            match AppState::load_snapshot(config.clone(), path) {
                Ok(s) => {
                    info!("Restored state from {}", path);
                    s
                }
                Err(e) => {
                    warn!("Failed to restore state from {}: {}, starting fresh", path, e);
                    AppState::new(config.clone(), config.initial_capital)
                }
            }
        } else {
            AppState::new(config.clone(), config.initial_capital)
        }
    } else {
        AppState::new(config.clone(), config.initial_capital)
    };

    AppState::start_price_update_loop(state.clone());

    // Periodic OMS fill sync — polls broker for fill updates every 5s
    let fill_sync_state = state.clone();
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(std::time::Duration::from_secs(5)).await;
            let st = fill_sync_state.clone();
            let updated = tokio::task::spawn_blocking(move || {
                st.oms.sync_pending_fills()
            }).await;
            if let Ok(fills) = updated {
                for order in &fills {
                    info!(
                        order_id = %order.internal_id,
                        status = ?order.status,
                        filled = order.filled_qty,
                        avg_price = order.avg_fill_price,
                        "OMS fill sync: order updated"
                    );
                }
            }
        }
    });

    match mode {
        "http" => {
            info!(host = %config.server.host, port = config.server.port, "Starting HTTP server");
            let persist_state = state.clone();
            if config.persistence.enabled {
                let interval = config.persistence.snapshot_interval_secs;
                let path = config.persistence.snapshot_path.clone();
                tokio::spawn(async move {
                    loop {
                        tokio::time::sleep(std::time::Duration::from_secs(interval)).await;
                        if let Err(e) = persist_state.save_snapshot(&path) {
                            tracing::warn!("Snapshot save failed: {}", e);
                        }
                    }
                });
            }

            // Start live market data feed if configured.
            // Prefers bridge polling (via Python Breeze Bridge) over direct WebSocket.
            if config.market_data.enabled && !config.market_data.symbols.is_empty() {
                let feed_store = state.live_prices.clone();
                let symbols = config.market_data.symbols.clone();
                let poll_interval = config.market_data.reconnect_delay_secs.max(1);

                let bridge_url = config.broker.icici.bridge_url.clone();
                if !bridge_url.is_empty() {
                    info!("Starting market data feed via Breeze Bridge at {}", bridge_url);
                    tokio::spawn(async move {
                        market_data::start_bridge_feed(
                            feed_store, &bridge_url, &symbols, poll_interval,
                        ).await;
                    });
                } else {
                    let ws_url = config.broker.icici.ws_url.clone();
                    let api_key = config.broker.icici.api_key.clone();
                    let session_token = config.broker.icici.session_token.clone();
                    info!("Starting market data feed via WebSocket at {}", ws_url);
                    tokio::spawn(async move {
                        market_data::start_feed(
                            feed_store, &ws_url, &symbols,
                            &api_key, &session_token, poll_interval,
                        ).await;
                    });
                }
            }

            if config.options.feed_enabled {
                let options_store = state.options_data.clone();
                let signal_state = state.clone();
                let oc_symbols = if config.options.feed_symbols.is_empty() {
                    config.market_data.symbols.clone()
                } else {
                    config.options.feed_symbols.clone()
                };
                let bridge_url = config.broker.icici.bridge_url.clone();
                let opts_config = config.options.clone();
                if !bridge_url.is_empty() {
                    info!("Starting options chain feed via Breeze Bridge at {}", bridge_url);
                    tokio::spawn(async move {
                        options_data::start_options_feed(
                            options_store, signal_state, &bridge_url, &oc_symbols, &opts_config,
                        ).await;
                    });
                }
            }

            live_executor::spawn(state.clone());

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

        "live_scan" => {
            #[derive(Deserialize)]
            struct LiveScanInput {
                symbols: Vec<String>,
                #[serde(default = "default_interval")]
                interval: String,
                #[serde(default = "default_lookback_days")]
                lookback_days: i64,
                #[serde(default)]
                aggressiveness: Option<String>,
            }
            fn default_interval() -> String { "1day".into() }
            fn default_lookback_days() -> i64 { 60 }

            let input: LiveScanInput = match serde_json::from_value(req.data) {
                Ok(v) => v,
                Err(e) => return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some(format!("Invalid live_scan input: {}", e)) },
            };
            if input.symbols.is_empty() {
                return Response { id, success: true,
                    data: serde_json::json!({ "signals": [] }), error: None };
            }

            let bridge_url = state.config.broker.icici.bridge_url.clone();
            if bridge_url.is_empty() {
                return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some("Bridge URL not configured — cannot fetch historical data".into()) };
            }

            let to_date = chrono::Utc::now().format("%Y-%m-%d").to_string();
            let from_date = (chrono::Utc::now() - chrono::Duration::days(input.lookback_days))
                .format("%Y-%m-%d").to_string();

            let mut sym_data_list = Vec::new();
            for symbol in &input.symbols {
                let hist = broker_icici::bridge_get_historical(
                    &bridge_url, symbol, &input.interval, &from_date, &to_date,
                );
                let mut candles_json: Vec<serde_json::Value> = match hist {
                    Ok(val) => {
                        if let Some(arr) = val.get("data").and_then(|d| d.as_array()) {
                            arr.clone()
                        } else if let Some(arr) = val.as_array() {
                            arr.clone()
                        } else {
                            warn!(symbol = %symbol, "No candle data from bridge");
                            continue;
                        }
                    }
                    Err(e) => {
                        warn!(symbol = %symbol, error = %e, "Failed to fetch historical from bridge");
                        continue;
                    }
                };

                if let Some(tick) = state.live_prices.get_tick(symbol) {
                    candles_json.push(serde_json::json!({
                        "timestamp": tick.timestamp,
                        "open": tick.open,
                        "high": tick.high,
                        "low": tick.low,
                        "close": tick.close,
                        "volume": tick.volume,
                    }));
                }

                sym_data_list.push(serde_json::json!({
                    "symbol": symbol,
                    "candles": candles_json,
                }));
            }

            let mut scan_input = serde_json::json!({ "symbols": sym_data_list });
            if let Some(agg) = &input.aggressiveness {
                scan_input["aggressiveness"] = serde_json::json!(agg);
            }
            scan::compute(scan_input)
        }

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
                "status": if state.is_killed() { "killed" } else { "healthy" },
                "uptime_seconds": state.uptime_seconds(),
                "version": env!("CARGO_PKG_VERSION"),
                "positions": state.positions.len(),
                "killed": state.is_killed(),
            }))
        }

        "kill_switch" => {
            state.activate_kill_switch();
            Ok(serde_json::json!({ "killed": true }))
        }
        "kill_switch_off" => {
            state.deactivate_kill_switch();
            Ok(serde_json::json!({ "killed": false }))
        }
        "audit_log" => {
            Ok(serde_json::to_value(state.get_audit_log()).unwrap_or_default())
        }

        "execute_signals" => {
            if state.is_killed() {
                return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some("Kill switch active — signal execution rejected".into()) };
            }

            #[derive(Deserialize)]
            struct ExecInput {
                #[serde(default)]
                symbols: Vec<String>,
                #[serde(default = "default_min_confidence")]
                min_confidence: f64,
                #[serde(default = "default_exec_exchange")]
                exchange: String,
                #[serde(default = "default_exec_product")]
                product: String,
                #[serde(default = "default_exec_qty")]
                default_qty: i64,
            }
            fn default_min_confidence() -> f64 { 0.7 }
            fn default_exec_exchange() -> String { "NSE".into() }
            fn default_exec_product() -> String { "intraday".into() }
            fn default_exec_qty() -> i64 { 1 }

            let input: ExecInput = match serde_json::from_value(req.data) {
                Ok(v) => v,
                Err(e) => return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some(format!("Invalid execute_signals input: {}", e)) },
            };

            let all_signals: Vec<crate::state::CachedSignal> = if input.symbols.is_empty() {
                state.signal_cache.iter()
                    .map(|entry| entry.value().clone())
                    .collect()
            } else {
                input.symbols.iter()
                    .flat_map(|s| state.get_cached_signals(s))
                    .collect()
            };

            let qualifying: Vec<_> = all_signals.into_iter()
                .filter(|s| s.confidence >= input.min_confidence)
                .collect();

            let product = match input.product.to_lowercase().as_str() {
                "delivery" | "cnc" => ProductType::Delivery,
                _ => ProductType::Intraday,
            };

            let mut results = Vec::new();
            for sig in &qualifying {
                let side = match sig.side.to_lowercase().as_str() {
                    "sell" | "short" => OrderSide::Sell,
                    _ => OrderSide::Buy,
                };
                let qty = sig.suggested_qty.unwrap_or(input.default_qty);
                let order_req = OrderRequest {
                    symbol: sig.symbol.clone(),
                    exchange: input.exchange.clone(),
                    side,
                    order_type: OrderType::Limit,
                    quantity: qty,
                    price: Some(sig.price),
                    trigger_price: sig.stop_loss,
                    product,
                    tag: Some(format!("auto:{}", sig.strategy)),
                };
                let ref_price = state.live_prices.get_ltp(&sig.symbol);
                match state.oms.submit_order(order_req, Some(sig.strategy.clone()), ref_price) {
                    Ok(order) => {
                        state.log_audit("SIGNAL_EXECUTED", Some(&sig.symbol),
                            &format!("strategy={} side={} qty={} price={:.2} conf={:.2}",
                                sig.strategy, sig.side, qty, sig.price, sig.confidence));
                        results.push(serde_json::json!({
                            "symbol": sig.symbol, "status": "submitted",
                            "order_id": order.internal_id,
                            "broker_order_id": order.broker_order_id,
                        }));
                    }
                    Err(e) => {
                        state.log_audit("SIGNAL_EXEC_FAILED", Some(&sig.symbol),
                            &format!("strategy={} error={}", sig.strategy, e));
                        state.alert_manager.fire(
                            AlertType::OrderRejected, AlertSeverity::Warning,
                            "Signal execution rejected",
                            &format!("Signal exec rejected for {}: {}", sig.symbol, e),
                            Some(&sig.symbol), Some(&sig.strategy),
                        );
                        results.push(serde_json::json!({
                            "symbol": sig.symbol, "status": "rejected", "reason": e,
                        }));
                    }
                }
            }

            Ok(serde_json::json!({
                "signals_evaluated": qualifying.len(),
                "orders": results,
            }))
        }

        "oms_submit_order" => {
            #[derive(Deserialize)]
            struct SubmitData {
                symbol: String,
                exchange: Option<String>,
                side: String,
                order_type: Option<String>,
                quantity: i64,
                price: Option<f64>,
                trigger_price: Option<f64>,
                product: Option<String>,
                strategy_id: Option<String>,
                reference_price: Option<f64>,
                tag: Option<String>,
            }
            let d: SubmitData = match serde_json::from_value(req.data) {
                Ok(v) => v,
                Err(e) => return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some(format!("Invalid order data: {}", e)) },
            };

            if state.is_killed() {
                return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some("Kill switch active — order rejected".into()) };
            }

            let side = match d.side.to_lowercase().as_str() {
                "buy" => OrderSide::Buy,
                "sell" => OrderSide::Sell,
                _ => return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some(format!("Invalid side: {}", d.side)) },
            };
            let order_type = match d.order_type.as_deref().unwrap_or("limit") {
                "market" => OrderType::Market,
                "limit" => OrderType::Limit,
                "stop_loss" | "sl" => OrderType::StopLoss,
                "stop_loss_market" | "slm" => OrderType::StopLossMarket,
                other => return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some(format!("Invalid order type: {}", other)) },
            };
            let product = match d.product.as_deref().unwrap_or("delivery") {
                "intraday" | "mis" => ProductType::Intraday,
                "delivery" | "cnc" | "nrml" => ProductType::Delivery,
                other => return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some(format!("Invalid product type: {}", other)) },
            };

            let order_req = OrderRequest {
                symbol: d.symbol.clone(), exchange: d.exchange.unwrap_or_else(|| "NSE".into()),
                side, order_type, quantity: d.quantity, price: d.price,
                trigger_price: d.trigger_price, product, tag: d.tag,
            };

            let ref_price = d.reference_price.or_else(|| {
                state.live_prices.get_tick(&d.symbol).map(|t| t.ltp)
            });

            match state.oms.submit_order(order_req, d.strategy_id, ref_price) {
                Ok(order) => {
                    state.log_audit("OMS_ORDER_SUBMITTED", Some(&order.symbol),
                        &format!("id={} side={:?} qty={}", order.internal_id, order.side, order.requested_qty));
                    Ok(serde_json::to_value(order).unwrap_or_default())
                }
                Err(e) => {
                    state.alert_manager.fire(
                        AlertType::OrderRejected, AlertSeverity::Warning,
                        "Order rejected", &e, None, None,
                    );
                    Err(e)
                }
            }
        }

        "oms_cancel_order" => {
            let order_id = match req.data.get("order_id").and_then(|v| v.as_str()) {
                Some(id) => id,
                None => return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some("Missing order_id".into()) },
            };
            match state.oms.cancel_order(order_id) {
                Ok(order) => {
                    state.log_audit("OMS_ORDER_CANCELLED", Some(&order.symbol),
                        &format!("id={}", order.internal_id));
                    Ok(serde_json::to_value(order).unwrap_or_default())
                }
                Err(e) => Err(e),
            }
        }

        "oms_modify_order" => {
            if state.is_killed() {
                return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some("Kill switch active — order modification rejected".into()) };
            }
            let order_id = match req.data.get("order_id").and_then(|v| v.as_str()) {
                Some(id) => id,
                None => return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some("Missing order_id".into()) },
            };
            let new_qty = req.data.get("quantity").and_then(|v| v.as_i64());
            let new_price = req.data.get("price").and_then(|v| v.as_f64());
            let new_trigger = req.data.get("trigger_price").and_then(|v| v.as_f64());
            match state.oms.modify_order(order_id, new_qty, new_price, new_trigger) {
                Ok(order) => {
                    state.log_audit("OMS_ORDER_MODIFIED", Some(&order.symbol),
                        &format!("id={} qty={} price={:?}", order.internal_id, order.requested_qty, order.price));
                    Ok(serde_json::to_value(order).unwrap_or_default())
                }
                Err(e) => Err(e),
            }
        }

        "oms_cancel_all" => {
            let cancelled = state.oms.cancel_all();
            state.log_audit("OMS_CANCEL_ALL", None, &format!("cancelled {} orders", cancelled.len()));
            Ok(serde_json::json!({ "cancelled": cancelled }))
        }

        "oms_orders" => {
            let strategy_filter = req.data.get("strategy_id").and_then(|v| v.as_str());
            let orders = match strategy_filter {
                Some(sid) => state.oms.get_orders_by_strategy(sid),
                None => state.oms.get_orders(),
            };
            Ok(serde_json::to_value(orders).unwrap_or_default())
        }

        "oms_reconcile" => {
            let engine_positions: Vec<(String, i64, f64)> = state.positions.iter()
                .map(|entry| {
                    let p = entry.value();
                    (p.symbol.clone(), p.qty, p.entry_price)
                })
                .collect();
            let report = state.oms.reconcile(&engine_positions);
            if !report.mismatches.is_empty() {
                state.alert_manager.fire(
                    AlertType::ReconciliationMismatch, AlertSeverity::Critical,
                    "Position reconciliation mismatch",
                    &format!("{} mismatches found", report.mismatches.len()),
                    None, None,
                );
            }
            state.log_audit("OMS_RECONCILE", None,
                &format!("matched={} mismatches={}", report.matched, report.mismatches.len()));
            Ok(serde_json::to_value(report).unwrap_or_default())
        }

        "alerts" => {
            let severity_filter = req.data.get("min_severity").and_then(|v| v.as_str());
            let min_sev = match severity_filter {
                Some("info") => Some(AlertSeverity::Info),
                Some("warning") => Some(AlertSeverity::Warning),
                Some("critical") => Some(AlertSeverity::Critical),
                Some("emergency") => Some(AlertSeverity::Emergency),
                _ => None,
            };
            let limit = req.data.get("limit").and_then(|v| v.as_u64()).unwrap_or(100) as usize;
            let alerts = state.alert_manager.get_alerts(min_sev, limit);
            Ok(serde_json::to_value(alerts).unwrap_or_default())
        }

        "alert_acknowledge" => {
            let alert_id = match req.data.get("alert_id").and_then(|v| v.as_str()) {
                Some(id) => id,
                None => return Response { id, success: false, data: serde_json::Value::Null,
                    error: Some("Missing alert_id".into()) },
            };
            let acked = state.alert_manager.acknowledge(alert_id);
            Ok(serde_json::json!({ "acknowledged": acked }))
        }

        "alert_counts" => {
            let (info, warn, crit, emrg) = state.alert_manager.unacknowledged_counts();
            Ok(serde_json::json!({
                "info": info, "warning": warn, "critical": crit, "emergency": emrg,
                "total": info + warn + crit + emrg,
            }))
        }

        "broker_init_session" => {
            use crate::broker_icici::IciciBreezeBroker;
            if let Some(icici) = state.broker_adapter.as_any().downcast_ref::<IciciBreezeBroker>() {
                match icici.init_session() {
                    Ok(()) => Ok(serde_json::json!({ "status": "session_initialized" })),
                    Err(e) => Err(format!("Session init failed: {}", e)),
                }
            } else {
                Err("broker_init_session is only supported for ICICI Breeze adapter".into())
            }
        }

        "broker_refresh_status" => {
            use crate::broker_icici::IciciBreezeBroker;
            if let Some(icici) = state.broker_adapter.as_any().downcast_ref::<IciciBreezeBroker>() {
                let active = icici.refresh_status();
                Ok(serde_json::json!({ "connected": active, "broker": "icici_breeze" }))
            } else {
                Ok(serde_json::json!({
                    "connected": state.broker_adapter.is_connected(),
                    "broker": state.broker_adapter.name(),
                }))
            }
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

    #[test]
    fn test_oms_submit_order() {
        let resp = req("oms_submit_order", json!({
            "symbol": "RELIANCE",
            "side": "buy",
            "quantity": 10,
            "price": 2500.0,
        }));
        assert!(resp.success, "OMS submit failed: {:?}", resp.error);
        assert_eq!(resp.data["symbol"], "RELIANCE");
        assert!(resp.data["internal_id"].as_str().unwrap().starts_with("OMS-"));
    }

    #[test]
    fn test_oms_submit_order_rejected_by_kill_switch() {
        let state = make_state();
        state.activate_kill_switch();
        let resp = handle_request(Request {
            id: None,
            command: "oms_submit_order".to_string(),
            data: json!({ "symbol": "TCS", "side": "buy", "quantity": 5, "price": 3000.0 }),
        }, &state);
        assert!(!resp.success);
        assert!(resp.error.as_ref().unwrap().contains("Kill switch"));
    }

    #[test]
    fn test_oms_orders() {
        let state = make_state();
        handle_request(Request {
            id: None, command: "oms_submit_order".to_string(),
            data: json!({ "symbol": "INFY", "side": "buy", "quantity": 5, "price": 1500.0, "strategy_id": "test_strat" }),
        }, &state);
        let resp = handle_request(Request {
            id: None, command: "oms_orders".to_string(), data: json!({}),
        }, &state);
        assert!(resp.success);
        let orders = resp.data.as_array().unwrap();
        assert_eq!(orders.len(), 1);
    }

    #[test]
    fn test_oms_reconcile() {
        let resp = req("oms_reconcile", json!({}));
        assert!(resp.success, "OMS reconcile failed: {:?}", resp.error);
        assert!(resp.data.get("matched").is_some());
    }

    #[test]
    fn test_alerts_empty() {
        let resp = req("alerts", json!({}));
        assert!(resp.success);
        let alerts = resp.data.as_array().unwrap();
        assert_eq!(alerts.len(), 0);
    }

    #[test]
    fn test_alert_counts() {
        let resp = req("alert_counts", json!({}));
        assert!(resp.success);
        assert_eq!(resp.data["total"], 0);
    }

    #[test]
    fn test_oms_fat_finger_rejection_fires_alert() {
        let state = make_state();
        let resp = handle_request(Request {
            id: None, command: "oms_submit_order".to_string(),
            data: json!({ "symbol": "BIG", "side": "buy", "quantity": 100000, "price": 100.0 }),
        }, &state);
        assert!(!resp.success);
        let counts_resp = handle_request(Request {
            id: None, command: "alert_counts".to_string(), data: json!({}),
        }, &state);
        assert!(counts_resp.data["warning"].as_u64().unwrap() >= 1);
    }

    #[test]
    fn test_oms_modify_order_rejected_by_kill_switch() {
        let state = make_state();
        let submit_resp = handle_request(Request {
            id: None, command: "oms_submit_order".to_string(),
            data: json!({ "symbol": "INFY", "side": "buy", "quantity": 10, "price": 1500.0 }),
        }, &state);
        assert!(submit_resp.success, "Setup: submit should succeed");
        let order_id = submit_resp.data["internal_id"].as_str().unwrap();
        state.activate_kill_switch();
        let modify_resp = handle_request(Request {
            id: None, command: "oms_modify_order".to_string(),
            data: json!({ "order_id": order_id, "quantity": 20 }),
        }, &state);
        assert!(!modify_resp.success);
        assert!(modify_resp.error.as_ref().unwrap().contains("Kill switch"));
    }
}
