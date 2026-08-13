use std::sync::Arc;
use std::sync::atomic::AtomicU64;
use std::collections::HashMap;
use tracing::{info, warn, error};

static TOTAL_LAGGED_TICKS: AtomicU64 = AtomicU64::new(0);

use crate::state::{AppState, CachedSignal};
use crate::strategy::{Indicators, Side, create_strategy};
use crate::utils::Candle;
use crate::broker::{OrderRequest, OrderSide, OrderType, ProductType};
use crate::alerts::{AlertSeverity, AlertType};
use crate::position_sizing::{SizingMethod, SizingContext, MarketRegime, compute_quantity};
use crate::exec_algo::{ExecAlgoType, plan_twap, plan_vwap, plan_iceberg, execute_plan_sync, TwapConfig, VwapConfig, IcebergConfig};
use crate::strategy_performance::GLOBAL_TRACKER;

const MAX_ROLLING_CANDLES: usize = 300;

/// Spawns the live executor background task.
/// Subscribes to live price ticks, aggregates them into candles,
/// runs configured strategies, and optionally auto-executes signals.
pub fn spawn(state: Arc<AppState>) {
    let config = state.config.clone();
    if !config.live_executor.enabled {
        info!("Live executor disabled in config");
        return;
    }

    let strategies_names = config.live_executor.strategies.clone();
    let min_confidence = config.live_executor.min_confidence;
    let auto_execute = config.live_executor.auto_execute;
    let max_positions = config.live_executor.max_positions;
    let default_qty = config.live_executor.default_qty;
    let exchange = config.live_executor.exchange.clone();
    let product_str = config.live_executor.product.clone();
    let candle_interval = config.live_executor.candle_interval_secs.max(1);
    let sizing_mode = config.live_executor.position_sizing_mode.clone();
    let max_position_pct = config.live_executor.max_position_pct;
    let exec_algo_str = config.live_executor.exec_algo.clone();
    let exec_slices = config.live_executor.exec_slices;
    let exec_duration = config.live_executor.exec_duration_secs;
    let iceberg_visible = config.live_executor.iceberg_visible_qty;
    let tick_exec_enabled = config.live_executor.tick_execution_enabled;
    let _tick_threshold_pct = config.live_executor.tick_threshold_pct;
    let trail_pct: f64 = config.live_executor.trail_pct.unwrap_or(0.0);

    info!(
        strategies = ?strategies_names,
        auto_execute = auto_execute,
        min_confidence = min_confidence,
        candle_interval_secs = candle_interval,
        position_sizing = %sizing_mode,
        "Starting live executor"
    );

    let mut rx = state.live_prices.subscribe();

    tokio::spawn(async move {
        let mut candle_windows_1m: HashMap<String, Vec<Candle>> = HashMap::new();
        let mut candle_windows_5m: HashMap<String, Vec<Candle>> = HashMap::new();
        let mut candle_windows_15m: HashMap<String, Vec<Candle>> = HashMap::new();
        let mut current_candles: HashMap<String, PartialCandle> = HashMap::new();
        let mut partial_5m: HashMap<String, PartialCandle> = HashMap::new();
        let mut partial_15m: HashMap<String, PartialCandle> = HashMap::new();
        let mut trailing_highs: HashMap<String, f64> = HashMap::new();
        let mut trailing_lows: HashMap<String, f64> = HashMap::new();

        loop {
            let tick = match rx.recv().await {
                Ok(t) => t,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    let total = TOTAL_LAGGED_TICKS.fetch_add(n, std::sync::atomic::Ordering::Relaxed) + n;
                    warn!(lagged = n, total_lagged = total, "Live executor lagged, skipping ticks");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    info!("Live executor: price channel closed, stopping");
                    break;
                }
            };

            // ─── Tick-Level Threshold Execution (sub-second path) ──────────
            // Risk-reducing SL/TP exits are allowed even when kill switch is active.
            // Collect position snapshots first to avoid holding DashMap read locks
            // while calling sync_oms_fill (which needs write locks) — prevents deadlock.
            if tick_exec_enabled {
                let exits_needed: Vec<(String, i64, bool, Option<f64>, Option<f64>)> = state.positions.iter()
                    .filter(|entry| entry.value().symbol == tick.symbol)
                    .map(|entry| {
                        let pos = entry.value();
                        (pos.symbol.clone(), pos.qty, pos.side.eq_ignore_ascii_case("buy"),
                         pos.stop_loss, pos.take_profit)
                    })
                    .collect();

                for (sym, qty, is_long, sl, tp) in exits_needed {
                    let mut exited = false;
                    if let Some(sl_price) = sl {
                        let hit = if is_long { tick.ltp <= sl_price } else { tick.ltp >= sl_price };
                        if hit {
                            let close_side = if is_long { OrderSide::Sell } else { OrderSide::Buy };
                            let order_req = OrderRequest {
                                symbol: sym.clone(),
                                exchange: exchange.clone(),
                                side: close_side,
                                order_type: OrderType::Market,
                                quantity: qty,
                                price: Some(tick.ltp),
                                product: ProductType::Intraday,
                                tag: Some("tick_sl".into()),
                                ..Default::default()
                            };
                            let ref_price = Some(tick.ltp);
                            if let Ok(order) = state.oms.submit_order(order_req, None, ref_price) {
                                if order.filled_qty > 0 {
                                    let side_str = if is_long { "sell" } else { "buy" };
                                    state.sync_oms_fill(&order.symbol, side_str, order.filled_qty,
                                        order.avg_fill_price, None, None);
                                    state.log_audit("TICK_SL_EXIT", Some(&sym),
                                        &format!("SL hit at {:.2}, closed {} qty", tick.ltp, order.filled_qty));
                                }
                            }
                            exited = true;
                        }
                    }
                    if !exited {
                        if let Some(tp_price) = tp {
                            let hit = if is_long { tick.ltp >= tp_price } else { tick.ltp <= tp_price };
                            if hit {
                                let close_side = if is_long { OrderSide::Sell } else { OrderSide::Buy };
                                let order_req = OrderRequest {
                                    symbol: sym.clone(),
                                    exchange: exchange.clone(),
                                    side: close_side,
                                    order_type: OrderType::Market,
                                    quantity: qty,
                                    price: Some(tick.ltp),
                                    product: ProductType::Intraday,
                                    tag: Some("tick_tp".into()),
                                    ..Default::default()
                                };
                                let ref_price = Some(tick.ltp);
                                if let Ok(order) = state.oms.submit_order(order_req, None, ref_price) {
                                    if order.filled_qty > 0 {
                                        let side_str = if is_long { "sell" } else { "buy" };
                                        state.sync_oms_fill(&order.symbol, side_str, order.filled_qty,
                                            order.avg_fill_price, None, None);
                                        state.log_audit("TICK_TP_EXIT", Some(&sym),
                                            &format!("TP hit at {:.2}, closed {} qty", tick.ltp, order.filled_qty));
                                    }
                                }
                                exited = true;
                            }
                        }
                    }

                    // Trailing stop-loss: track peak price and exit if retracement exceeds trail_pct
                    if !exited && trail_pct > 0.0 {
                        if is_long {
                            let high = trailing_highs.entry(sym.clone()).or_insert(tick.ltp);
                            if tick.ltp > *high { *high = tick.ltp; }
                            let trailing_sl = *high * (1.0 - trail_pct);
                            if tick.ltp <= trailing_sl {
                                let order_req = OrderRequest {
                                    symbol: sym.clone(),
                                    exchange: exchange.clone(),
                                    side: OrderSide::Sell,
                                    order_type: OrderType::Market,
                                    quantity: qty,
                                    price: Some(tick.ltp),
                                    product: ProductType::Intraday,
                                    tag: Some("tick_trailing_sl".into()),
                                    ..Default::default()
                                };
                                if let Ok(order) = state.oms.submit_order(order_req, None, Some(tick.ltp)) {
                                    if order.filled_qty > 0 {
                                        state.sync_oms_fill(&order.symbol, "sell", order.filled_qty,
                                            order.avg_fill_price, None, None);
                                        state.log_audit("TICK_TRAILING_SL", Some(&sym),
                                            &format!("Trailing SL hit at {:.2} (high {:.2}, trail {}%), closed {} qty",
                                                tick.ltp, *high, trail_pct * 100.0, order.filled_qty));
                                    }
                                }
                                trailing_highs.remove(&sym);
                            }
                        } else {
                            let low = trailing_lows.entry(sym.clone()).or_insert(tick.ltp);
                            if tick.ltp < *low { *low = tick.ltp; }
                            let trailing_sl = *low * (1.0 + trail_pct);
                            if tick.ltp >= trailing_sl {
                                let order_req = OrderRequest {
                                    symbol: sym.clone(),
                                    exchange: exchange.clone(),
                                    side: OrderSide::Buy,
                                    order_type: OrderType::Market,
                                    quantity: qty,
                                    price: Some(tick.ltp),
                                    product: ProductType::Intraday,
                                    tag: Some("tick_trailing_sl".into()),
                                    ..Default::default()
                                };
                                if let Ok(order) = state.oms.submit_order(order_req, None, Some(tick.ltp)) {
                                    if order.filled_qty > 0 {
                                        state.sync_oms_fill(&order.symbol, "buy", order.filled_qty,
                                            order.avg_fill_price, None, None);
                                        state.log_audit("TICK_TRAILING_SL", Some(&sym),
                                            &format!("Trailing SL hit at {:.2} (low {:.2}, trail {}%), closed {} qty",
                                                tick.ltp, *low, trail_pct * 100.0, order.filled_qty));
                                    }
                                }
                                trailing_lows.remove(&sym);
                            }
                        }
                    } else if exited {
                        // Clean up trailing state when position is closed by SL or TP
                        trailing_highs.remove(&sym);
                        trailing_lows.remove(&sym);
                    }
                }
            }

            if state.is_killed() {
                continue;
            }

            // Update 5m and 15m partial candles
            partial_5m.entry(tick.symbol.clone())
                .or_insert_with(|| PartialCandle::new(tick.ltp, tick.volume))
                .update(tick.ltp, tick.volume);
            partial_15m.entry(tick.symbol.clone())
                .or_insert_with(|| PartialCandle::new(tick.ltp, tick.volume))
                .update(tick.ltp, tick.volume);

            // Emit 5m candle
            if let Some(p5) = partial_5m.get(&tick.symbol) {
                if p5.started.elapsed().as_secs() >= 300 {
                    let candle = p5.to_candle(&tick.symbol);
                    let w5 = candle_windows_5m.entry(tick.symbol.clone()).or_default();
                    w5.push(candle);
                    if w5.len() > MAX_ROLLING_CANDLES { w5.drain(..w5.len() - MAX_ROLLING_CANDLES); }
                    partial_5m.insert(tick.symbol.clone(), PartialCandle::new(tick.ltp, tick.volume));
                }
            }
            // Emit 15m candle
            if let Some(p15) = partial_15m.get(&tick.symbol) {
                if p15.started.elapsed().as_secs() >= 900 {
                    let candle = p15.to_candle(&tick.symbol);
                    let w15 = candle_windows_15m.entry(tick.symbol.clone()).or_default();
                    w15.push(candle);
                    if w15.len() > MAX_ROLLING_CANDLES { w15.drain(..w15.len() - MAX_ROLLING_CANDLES); }
                    partial_15m.insert(tick.symbol.clone(), PartialCandle::new(tick.ltp, tick.volume));
                }
            }

            let partial = current_candles.entry(tick.symbol.clone()).or_insert_with(|| {
                PartialCandle::new(tick.ltp, tick.volume)
            });

            partial.update(tick.ltp, tick.volume);

            let elapsed = partial.started.elapsed().as_secs();
            if elapsed < candle_interval {
                continue;
            }

            let candle = partial.to_candle(&tick.symbol);
            *partial = PartialCandle::new(tick.ltp, tick.volume);

            let window = candle_windows_1m.entry(tick.symbol.clone()).or_default();
            window.push(candle);
            if window.len() > MAX_ROLLING_CANDLES {
                window.drain(..window.len() - MAX_ROLLING_CANDLES);
            }

            if window.len() < 30 {
                continue;
            }

            // Risk check: block if drawdown exceeds limit
            let nav = state.get_nav();
            let peak = state.get_peak_nav();
            let dd = if peak > 0.0 { (peak - nav) / peak * 100.0 } else { 0.0 };
            if dd > state.config.risk.max_drawdown_pct {
                continue;
            }

            let indicators = Indicators::from_candles(window, &config);

            for strat_name in &strategies_names {
                let mut strategy = match create_strategy(strat_name, &config) {
                    Ok(s) => s,
                    Err(e) => {
                        warn!(strategy = %strat_name, error = %e, "Failed to create strategy");
                        continue;
                    }
                };

                let last_idx = window.len() - 1;
                if let Some(signal) = strategy.on_candle(last_idx, &window[last_idx], &indicators) {
                    let side_str = match signal.side {
                        Side::Buy => "buy",
                        Side::Sell => "sell",
                    };

                    if GLOBAL_TRACKER.is_strategy_retired(&strat_name) {
                        tracing::debug!(strategy = %strat_name, symbol = %tick.symbol, "Skipping retired strategy in live executor");
                        continue;
                    }

                    let calibrated_confidence = GLOBAL_TRACKER.get_regime_weighted_confidence(
                        signal.confidence, &strat_name, "neutral",
                    );

                    if calibrated_confidence < min_confidence {
                        continue;
                    }

                    let sizing_method = SizingMethod::from_str_loose(&sizing_mode);

                    let health = GLOBAL_TRACKER.get_strategy_health(strat_name);
                    let live_win_rate = if health.total_signals >= 10 {
                        health.win_rate_recent
                    } else {
                        0.50
                    };
                    let (live_avg_win, live_avg_loss) = {
                        let outcomes = GLOBAL_TRACKER.get_all_outcomes();
                        let strat_outcomes: Vec<&crate::strategy_performance::SignalOutcome> = outcomes.iter()
                            .filter(|o| o.strategy == *strat_name)
                            .collect();
                        let wins: Vec<f64> = strat_outcomes.iter().filter(|o| o.won).map(|o| o.pnl_pct.abs()).collect();
                        let losses: Vec<f64> = strat_outcomes.iter().filter(|o| !o.won).map(|o| o.pnl_pct.abs()).collect();
                        let avg_w = if !wins.is_empty() { wins.iter().sum::<f64>() / wins.len() as f64 } else { 1.0 };
                        let avg_l = if !losses.is_empty() { losses.iter().sum::<f64>() / losses.len() as f64 } else { 1.0 };
                        (avg_w.max(0.01), avg_l.max(0.01))
                    };

                    let asset_vol = if window.len() >= 20 {
                        let returns: Vec<f64> = window.windows(2)
                            .map(|pair| (pair[1].close / pair[0].close.max(0.01)).ln())
                            .collect();
                        let mean = returns.iter().sum::<f64>() / returns.len() as f64;
                        let var = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / (returns.len() - 1) as f64;
                        var.sqrt().max(0.001)
                    } else {
                        0.02
                    };

                    let portfolio_vol = {
                        let pos_count = state.positions.len().max(1) as f64;
                        (asset_vol / pos_count.sqrt()).max(0.001)
                    };

                    let live_regime = if asset_vol > 0.03 {
                        if health.avg_pnl_pct > 0.0 { MarketRegime::BullHighVol } else { MarketRegime::BearHighVol }
                    } else if asset_vol < 0.01 {
                        if health.avg_pnl_pct > 0.0 { MarketRegime::BullLowVol } else { MarketRegime::BearLowVol }
                    } else {
                        MarketRegime::Normal
                    };

                    let sizing_ctx = SizingContext {
                        nav,
                        price: signal.price,
                        win_rate: live_win_rate,
                        avg_win: live_avg_win,
                        avg_loss: live_avg_loss,
                        asset_volatility: asset_vol,
                        target_volatility: 0.15,
                        portfolio_volatility: portfolio_vol,
                        regime: live_regime,
                        signal_confidence: calibrated_confidence,
                        max_position_pct,
                        default_qty,
                    };
                    let qty = compute_quantity(sizing_method, &sizing_ctx);

                    let cached = CachedSignal {
                        symbol: tick.symbol.clone(),
                        strategy: strat_name.clone(),
                        side: side_str.to_string(),
                        price: signal.price,
                        confidence: calibrated_confidence,
                        reason: signal.reason.clone(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        ttl_seconds: candle_interval * 2,
                        stop_loss: signal.stop_loss,
                        take_profit: signal.take_profit,
                        suggested_qty: Some(qty),
                    };

                    state.cache_signal(cached);
                    state.log_audit("LIVE_SIGNAL", Some(&tick.symbol),
                        &format!("strategy={} side={} conf={:.2} cal_conf={:.2} price={:.2} qty={}",
                            strat_name, side_str, signal.confidence, calibrated_confidence, signal.price, qty));

                    if auto_execute {
                        let position_count = state.positions.len();
                        if position_count >= max_positions {
                            warn!(symbol = %tick.symbol, "Max positions reached, skipping auto-execute");
                            continue;
                        }

                        let daily_count = state.daily_trade_count.load(std::sync::atomic::Ordering::Relaxed);
                        if daily_count >= state.config.risk.max_daily_trades {
                            warn!(symbol = %tick.symbol, "Daily trade limit reached");
                            continue;
                        }

                        let order_side = match signal.side {
                            Side::Buy => OrderSide::Buy,
                            Side::Sell => OrderSide::Sell,
                        };
                        let product = match product_str.to_lowercase().as_str() {
                            "delivery" | "cnc" => ProductType::Delivery,
                            _ => ProductType::Intraday,
                        };

                        let ref_price = state.live_prices.get_ltp(&tick.symbol);

                        let smart_plan = crate::smart_executor::compute(serde_json::json!({
                            "command": "plan",
                            "symbol": tick.symbol,
                            "side": side_str,
                            "quantity": qty,
                            "price": signal.price,
                            "signal_confidence": calibrated_confidence,
                        }));

                        let algo = match &smart_plan {
                            Ok(plan) => {
                                let recommended = plan.get("recommended_algo")
                                    .and_then(|v| v.as_str())
                                    .unwrap_or(&exec_algo_str);
                                ExecAlgoType::from_str_loose(recommended)
                            }
                            Err(_) => ExecAlgoType::from_str_loose(&exec_algo_str),
                        };

                        let smart_slices = smart_plan.as_ref().ok()
                            .and_then(|p| p.get("num_slices"))
                            .and_then(|v| v.as_u64())
                            .map(|v| v as u32)
                            .unwrap_or(exec_slices);
                        let smart_interval = smart_plan.as_ref().ok()
                            .and_then(|p| p.get("slice_interval_secs"))
                            .and_then(|v| v.as_u64())
                            .unwrap_or(exec_duration);

                        if let Ok(ref plan_data) = smart_plan {
                            let slippage = plan_data.get("estimated_slippage_bps").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            let impact = plan_data.get("estimated_market_impact_bps").and_then(|v| v.as_f64()).unwrap_or(0.0);
                            tracing::info!(
                                symbol = %tick.symbol, algo = ?algo, slices = smart_slices,
                                slippage_bps = slippage, impact_bps = impact,
                                "Smart execution plan applied"
                            );
                        }

                        let exec_state = state.clone();
                        let exec_symbol = tick.symbol.clone();
                        let exec_exchange = exchange.clone();
                        let exec_strat = strat_name.clone();
                        let exec_side_str = side_str.to_string();
                        let exec_sl = signal.stop_loss;
                        let exec_tp = signal.take_profit;
                        let exec_price = signal.price;

                        match algo {
                            ExecAlgoType::TWAP => {
                                let plan = plan_twap(&exec_symbol, order_side, qty, &TwapConfig {
                                    duration_secs: smart_interval, num_slices: smart_slices, randomize_pct: 15.0,
                                });
                                tokio::task::spawn_blocking(move || {
                                    let result = execute_plan_sync(&plan, &exec_state.oms, &exec_exchange, product,
                                        Some(exec_price), Some(exec_strat.clone()), ref_price);
                                    if result.total_filled > 0 {
                                        exec_state.sync_oms_fill(&exec_symbol, &exec_side_str, result.total_filled,
                                            result.avg_fill_price, exec_sl, exec_tp);
                                        exec_state.log_audit("LIVE_TWAP_EXEC", Some(&exec_symbol),
                                            &format!("filled={}/{} avg={:.2} slices={}/{}",
                                                result.total_filled, qty, result.avg_fill_price,
                                                result.num_slices_filled, result.num_slices_attempted));
                                    }
                                });
                            }
                            ExecAlgoType::VWAP => {
                                let plan = plan_vwap(&exec_symbol, order_side, qty, &VwapConfig {
                                    duration_secs: smart_interval, num_slices: smart_slices,
                                    volume_profile: Vec::new(), max_participation_rate: 0.25,
                                });
                                tokio::task::spawn_blocking(move || {
                                    let result = execute_plan_sync(&plan, &exec_state.oms, &exec_exchange, product,
                                        Some(exec_price), Some(exec_strat.clone()), ref_price);
                                    if result.total_filled > 0 {
                                        exec_state.sync_oms_fill(&exec_symbol, &exec_side_str, result.total_filled,
                                            result.avg_fill_price, exec_sl, exec_tp);
                                        exec_state.log_audit("LIVE_VWAP_EXEC", Some(&exec_symbol),
                                            &format!("filled={}/{} vwap={:.2}", result.total_filled, qty, result.vwap_achieved));
                                    }
                                });
                            }
                            ExecAlgoType::Iceberg => {
                                let plan = plan_iceberg(&exec_symbol, order_side, qty, &IcebergConfig {
                                    visible_qty: iceberg_visible, replenish_delay_ms: 500,
                                });
                                tokio::task::spawn_blocking(move || {
                                    let result = execute_plan_sync(&plan, &exec_state.oms, &exec_exchange, product,
                                        Some(exec_price), Some(exec_strat.clone()), ref_price);
                                    if result.total_filled > 0 {
                                        exec_state.sync_oms_fill(&exec_symbol, &exec_side_str, result.total_filled,
                                            result.avg_fill_price, exec_sl, exec_tp);
                                        exec_state.log_audit("LIVE_ICEBERG_EXEC", Some(&exec_symbol),
                                            &format!("filled={}/{} slices={}", result.total_filled, qty, result.num_slices_filled));
                                    }
                                });
                            }
                            ExecAlgoType::Direct => {
                                tokio::task::spawn_blocking(move || {
                                    let order_req = OrderRequest {
                                        symbol: exec_symbol.clone(),
                                        exchange: exec_exchange,
                                        side: order_side,
                                        order_type: OrderType::Limit,
                                        quantity: qty,
                                        price: Some(exec_price),
                                        trigger_price: exec_sl,
                                        product,
                                        tag: Some(format!("live:{}", exec_strat)),
                                        ..Default::default()
                                    };

                                    match exec_state.oms.submit_order(order_req, Some(exec_strat.clone()), ref_price) {
                                        Ok(order) => {
                                            if order.status == crate::broker::OrderStatus::Filled && order.filled_qty > 0 {
                                                exec_state.sync_oms_fill(
                                                    &order.symbol, &exec_side_str, order.filled_qty,
                                                    order.avg_fill_price, exec_sl, exec_tp,
                                                );
                                            }
                                            info!(symbol = %exec_symbol, order_id = %order.internal_id,
                                                "Live executor auto-submitted order");
                                            exec_state.log_audit("LIVE_AUTO_EXEC", Some(&exec_symbol),
                                                &format!("order_id={} qty={}", order.internal_id, qty));
                                        }
                                        Err(e) => {
                                            error!(symbol = %exec_symbol, error = %e,
                                                "Live executor order submission failed");
                                            exec_state.alert_manager.fire(
                                                AlertType::OrderRejected, AlertSeverity::Warning,
                                                "Live auto-execution rejected",
                                                &format!("Live exec rejected for {}: {}", exec_symbol, e),
                                                Some(&exec_symbol), None,
                                            );
                                        }
                                    }
                                });
                            }
                        }
                    }
                }
            }
        }
    });
}

struct PartialCandle {
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
    started: std::time::Instant,
}

impl PartialCandle {
    fn new(price: f64, vol: u64) -> Self {
        Self {
            open: price, high: price, low: price, close: price,
            volume: vol as f64,
            started: std::time::Instant::now(),
        }
    }

    fn update(&mut self, price: f64, vol: u64) {
        if price > self.high { self.high = price; }
        if price < self.low { self.low = price; }
        self.close = price;
        self.volume += vol as f64;
    }

    fn to_candle(&self, _symbol: &str) -> Candle {
        Candle {
            timestamp: chrono::Utc::now().to_rfc3339(),
            open: self.open,
            high: self.high,
            low: self.low,
            close: self.close,
            volume: self.volume,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_partial_candle() {
        let mut pc = PartialCandle::new(100.0, 50);
        pc.update(105.0, 30);
        pc.update(95.0, 20);
        pc.update(102.0, 10);

        assert_eq!(pc.open, 100.0);
        assert_eq!(pc.high, 105.0);
        assert_eq!(pc.low, 95.0);
        assert_eq!(pc.close, 102.0);
        assert_eq!(pc.volume, 110.0);

        let candle = pc.to_candle("TEST");
        assert_eq!(candle.open, 100.0);
        assert_eq!(candle.high, 105.0);
    }
}
