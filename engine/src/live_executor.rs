use std::sync::Arc;
use std::collections::HashMap;
use tracing::{info, warn, error};

use crate::state::{AppState, CachedSignal};
use crate::strategy::{Indicators, Side, create_strategy};
use crate::utils::Candle;
use crate::broker::{OrderRequest, OrderSide, OrderType, ProductType};
use crate::alerts::{AlertSeverity, AlertType};

const MAX_ROLLING_CANDLES: usize = 300;
const CANDLE_INTERVAL_SECS: u64 = 60;

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

    info!(
        strategies = ?strategies_names,
        auto_execute = auto_execute,
        min_confidence = min_confidence,
        "Starting live executor"
    );

    let mut rx = state.live_prices.subscribe();

    tokio::spawn(async move {
        let mut candle_windows: HashMap<String, Vec<Candle>> = HashMap::new();
        let mut current_candles: HashMap<String, PartialCandle> = HashMap::new();

        loop {
            let tick = match rx.recv().await {
                Ok(t) => t,
                Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                    warn!(lagged = n, "Live executor lagged, skipping ticks");
                    continue;
                }
                Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                    info!("Live executor: price channel closed, stopping");
                    break;
                }
            };

            if state.is_killed() {
                continue;
            }

            let partial = current_candles.entry(tick.symbol.clone()).or_insert_with(|| {
                PartialCandle::new(tick.ltp, tick.volume)
            });

            partial.update(tick.ltp, tick.volume);

            let elapsed = partial.started.elapsed().as_secs();
            if elapsed < CANDLE_INTERVAL_SECS {
                continue;
            }

            let candle = partial.to_candle(&tick.symbol);
            *partial = PartialCandle::new(tick.ltp, tick.volume);

            let window = candle_windows.entry(tick.symbol.clone()).or_default();
            window.push(candle);
            if window.len() > MAX_ROLLING_CANDLES {
                window.drain(..window.len() - MAX_ROLLING_CANDLES);
            }

            if window.len() < 30 {
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

                    if signal.confidence < min_confidence {
                        continue;
                    }

                    let cached = CachedSignal {
                        symbol: tick.symbol.clone(),
                        strategy: strat_name.clone(),
                        side: side_str.to_string(),
                        price: signal.price,
                        confidence: signal.confidence,
                        reason: signal.reason.clone(),
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        ttl_seconds: CANDLE_INTERVAL_SECS * 2,
                        stop_loss: signal.stop_loss,
                        take_profit: signal.take_profit,
                        suggested_qty: Some(default_qty),
                    };

                    state.cache_signal(cached);
                    state.log_audit("LIVE_SIGNAL", Some(&tick.symbol),
                        &format!("strategy={} side={} conf={:.2} price={:.2}",
                            strat_name, side_str, signal.confidence, signal.price));

                    if auto_execute {
                        let position_count = state.positions.len();
                        if position_count >= max_positions {
                            warn!(symbol = %tick.symbol, "Max positions reached, skipping auto-execute");
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

                        let order_req = OrderRequest {
                            symbol: tick.symbol.clone(),
                            exchange: exchange.clone(),
                            side: order_side,
                            order_type: OrderType::Limit,
                            quantity: default_qty,
                            price: Some(signal.price),
                            trigger_price: signal.stop_loss,
                            product,
                            tag: Some(format!("live:{}", strat_name)),
                        };

                        let ref_price = state.live_prices.get_ltp(&tick.symbol);
                        match state.oms.submit_order(order_req, Some(strat_name.clone()), ref_price) {
                            Ok(order) => {
                                info!(symbol = %tick.symbol, order_id = %order.internal_id,
                                    "Live executor auto-submitted order");
                                state.log_audit("LIVE_AUTO_EXEC", Some(&tick.symbol),
                                    &format!("order_id={}", order.internal_id));
                            }
                            Err(e) => {
                                error!(symbol = %tick.symbol, error = %e,
                                    "Live executor order submission failed");
                                state.alert_manager.fire(
                                    AlertType::OrderRejected, AlertSeverity::Warning,
                                    "Live auto-execution rejected",
                                    &format!("Live exec rejected for {}: {}", tick.symbol, e),
                                    Some(&tick.symbol), None,
                                );
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
