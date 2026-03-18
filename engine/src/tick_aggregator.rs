use std::collections::HashMap;
use std::sync::Arc;
use std::time::{Duration, Instant};

use dashmap::DashMap;
use serde::{Deserialize, Serialize};

use crate::market_data::{LivePriceStore, Tick};

const MAX_MICRO_CANDLES: usize = 200;
const FEATURE_WINDOW: usize = 20;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MicroCandle {
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
    pub tick_count: u32,
    pub vwap: f64,
    pub buy_volume: u64,
    pub sell_volume: u64,
    pub timestamp: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, Default)]
pub struct MicroFeatures {
    pub tick_momentum: f64,
    pub volume_acceleration: f64,
    pub vwap_deviation: f64,
    pub trade_imbalance: f64,
    pub spread_proxy: f64,
    pub tick_volatility: f64,
    pub micro_trend: f64,
    pub volume_zscore: f64,
}

struct PartialMicroCandle {
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: u64,
    tick_count: u32,
    price_volume_sum: f64,
    buy_volume: u64,
    sell_volume: u64,
    started_at: Instant,
    timestamp: String,
}

impl PartialMicroCandle {
    fn from_tick(tick: &Tick) -> Self {
        let (buy, sell) = if tick.close > tick.open {
            (tick.volume, 0)
        } else {
            (0, tick.volume)
        };
        Self {
            open: tick.ltp,
            high: tick.ltp,
            low: tick.ltp,
            close: tick.ltp,
            volume: tick.volume,
            tick_count: 1,
            price_volume_sum: tick.ltp * tick.volume as f64,
            buy_volume: buy,
            sell_volume: sell,
            started_at: Instant::now(),
            timestamp: tick.timestamp.clone(),
        }
    }

    fn update(&mut self, tick: &Tick) {
        if tick.ltp > self.high {
            self.high = tick.ltp;
        }
        if tick.ltp < self.low {
            self.low = tick.ltp;
        }
        self.close = tick.ltp;
        self.volume += tick.volume;
        self.tick_count += 1;
        self.price_volume_sum += tick.ltp * tick.volume as f64;
        if tick.close > tick.open {
            self.buy_volume += tick.volume;
        } else {
            self.sell_volume += tick.volume;
        }
    }

    fn finalize(&self) -> MicroCandle {
        let vwap = if self.volume > 0 {
            self.price_volume_sum / self.volume as f64
        } else {
            self.close
        };
        MicroCandle {
            open: self.open,
            high: self.high,
            low: self.low,
            close: self.close,
            volume: self.volume,
            tick_count: self.tick_count,
            vwap,
            buy_volume: self.buy_volume,
            sell_volume: self.sell_volume,
            timestamp: self.timestamp.clone(),
        }
    }
}

pub struct TickAggregator {
    candles: Arc<DashMap<String, Vec<MicroCandle>>>,
    features: Arc<DashMap<String, MicroFeatures>>,
}

impl TickAggregator {
    pub fn new(store: &Arc<LivePriceStore>, interval_secs: u64) -> Arc<Self> {
        let candles: Arc<DashMap<String, Vec<MicroCandle>>> = Arc::new(DashMap::new());
        let features: Arc<DashMap<String, MicroFeatures>> = Arc::new(DashMap::new());

        let agg = Arc::new(Self {
            candles: candles.clone(),
            features: features.clone(),
        });

        let mut rx = store.subscribe();
        let interval = Duration::from_secs(interval_secs);

        tokio::spawn(async move {
            let mut partial: HashMap<String, PartialMicroCandle> = HashMap::new();
            tracing::info!(interval_secs, "TickAggregator started");

            loop {
                match rx.recv().await {
                    Ok(tick) => {
                        let symbol = tick.symbol.clone();

                        let should_finalize = partial
                            .get(&symbol)
                            .map_or(false, |p| p.started_at.elapsed() >= interval);

                        if should_finalize {
                            if let Some(p) = partial.remove(&symbol) {
                                let micro = p.finalize();
                                tracing::debug!(
                                    symbol = %symbol,
                                    close = micro.close,
                                    ticks = micro.tick_count,
                                    "Finalized micro-candle"
                                );

                                let mut entry = candles.entry(symbol.clone()).or_default();
                                entry.push(micro);
                                if entry.len() > MAX_MICRO_CANDLES {
                                    let excess = entry.len() - MAX_MICRO_CANDLES;
                                    entry.drain(..excess);
                                }

                                let new_features = compute_features(&entry);
                                drop(entry);
                                features.insert(symbol.clone(), new_features);
                            }
                        }

                        match partial.get_mut(&symbol) {
                            Some(p) => p.update(&tick),
                            None => {
                                partial.insert(symbol, PartialMicroCandle::from_tick(&tick));
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(missed = n, "TickAggregator lagged, skipped ticks");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::info!("TickAggregator channel closed, shutting down");
                        break;
                    }
                }
            }
        });

        agg
    }

    pub fn get_micro_features(&self, symbol: &str) -> MicroFeatures {
        self.features
            .get(symbol)
            .map(|f| f.clone())
            .unwrap_or_default()
    }

    pub fn get_micro_candles(&self, symbol: &str, limit: usize) -> Vec<MicroCandle> {
        match self.candles.get(symbol) {
            Some(v) => {
                let start = v.len().saturating_sub(limit);
                v[start..].to_vec()
            }
            None => Vec::new(),
        }
    }

    pub fn compute(data: serde_json::Value) -> Result<serde_json::Value, String> {
        let cmd = data
            .get("command")
            .and_then(|v| v.as_str())
            .unwrap_or("");

        match cmd {
            "features" => {
                let candles_val = data.get("candles").ok_or("Missing 'candles' field")?;
                let candles: Vec<MicroCandle> = serde_json::from_value(candles_val.clone())
                    .map_err(|e| format!("Invalid candles: {}", e))?;
                let features = compute_features(&candles);
                serde_json::to_value(features).map_err(|e| e.to_string())
            }
            "candles" => {
                let candles_val = data.get("candles").ok_or("Missing 'candles' field")?;
                let candles: Vec<MicroCandle> = serde_json::from_value(candles_val.clone())
                    .map_err(|e| format!("Invalid candles: {}", e))?;
                let limit = data
                    .get("limit")
                    .and_then(|v| v.as_u64())
                    .unwrap_or(candles.len() as u64) as usize;
                let start = candles.len().saturating_sub(limit);
                serde_json::to_value(&candles[start..]).map_err(|e| e.to_string())
            }
            _ => Err(format!("Unknown tick_aggregator command: {}", cmd)),
        }
    }
}

fn compute_features(candles: &[MicroCandle]) -> MicroFeatures {
    if candles.is_empty() {
        return MicroFeatures::default();
    }

    let window = if candles.len() > FEATURE_WINDOW {
        &candles[candles.len() - FEATURE_WINDOW..]
    } else {
        candles
    };

    let n = window.len() as f64;
    let last = window.last().unwrap();

    let tick_momentum = if window.len() >= 2 {
        (last.close - window[0].open) / n
    } else {
        0.0
    };

    let volume_acceleration = if window.len() >= 2 {
        let prev_vol = window[window.len() - 2].volume as f64;
        let cur_vol = last.volume as f64;
        if prev_vol > 0.0 {
            (cur_vol - prev_vol) / prev_vol
        } else {
            0.0
        }
    } else {
        0.0
    };

    let total_vol: f64 = window.iter().map(|c| c.volume as f64).sum();
    let weighted_price: f64 = window.iter().map(|c| c.vwap * c.volume as f64).sum();
    let running_vwap = if total_vol > 0.0 {
        weighted_price / total_vol
    } else {
        last.close
    };
    let vwap_deviation = if running_vwap.abs() > 1e-12 {
        (last.close - running_vwap) / running_vwap
    } else {
        0.0
    };

    let total_buy: u64 = window.iter().map(|c| c.buy_volume).sum();
    let total_sell: u64 = window.iter().map(|c| c.sell_volume).sum();
    let total_trade = (total_buy + total_sell) as f64;
    let trade_imbalance = if total_trade > 0.0 {
        (total_buy as f64 - total_sell as f64) / total_trade
    } else {
        0.0
    };

    let spread_proxy = {
        let sum: f64 = window
            .iter()
            .map(|c| {
                let mid = (c.high + c.low) / 2.0;
                if mid > 1e-12 {
                    (c.high - c.low) / mid
                } else {
                    0.0
                }
            })
            .sum();
        sum / n
    };

    let mean_close: f64 = window.iter().map(|c| c.close).sum::<f64>() / n;
    let tick_volatility = if n > 1.0 {
        let var =
            window.iter().map(|c| (c.close - mean_close).powi(2)).sum::<f64>() / (n - 1.0);
        var.sqrt()
    } else {
        0.0
    };

    let trend_slice = if window.len() > 10 {
        &window[window.len() - 10..]
    } else {
        window
    };
    let closes: Vec<f64> = trend_slice.iter().map(|c| c.close).collect();
    let micro_trend = linear_slope(&closes);

    let mean_vol = total_vol / n;
    let vol_var = window
        .iter()
        .map(|c| (c.volume as f64 - mean_vol).powi(2))
        .sum::<f64>()
        / n.max(1.0);
    let vol_std = vol_var.sqrt();
    let volume_zscore = if vol_std > 1e-12 {
        (last.volume as f64 - mean_vol) / vol_std
    } else {
        0.0
    };

    MicroFeatures {
        tick_momentum,
        volume_acceleration,
        vwap_deviation,
        trade_imbalance,
        spread_proxy,
        tick_volatility,
        micro_trend,
        volume_zscore,
    }
}

fn linear_slope(values: &[f64]) -> f64 {
    let n = values.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let x_mean = (n - 1.0) / 2.0;
    let y_mean: f64 = values.iter().sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for (i, &y) in values.iter().enumerate() {
        let x = i as f64;
        num += (x - x_mean) * (y - y_mean);
        den += (x - x_mean).powi(2);
    }
    if den.abs() < 1e-15 {
        0.0
    } else {
        num / den
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sample_candles_json() -> Vec<serde_json::Value> {
        (0..10)
            .map(|i| {
                let base = 100.0 + i as f64;
                json!({
                    "open": base,
                    "high": base + 1.0,
                    "low": base - 0.5,
                    "close": base + 0.5,
                    "volume": 1000 + i * 100,
                    "tick_count": 5,
                    "vwap": base + 0.25,
                    "buy_volume": 600 + i * 50,
                    "sell_volume": 400 + i * 50,
                    "timestamp": format!("2025-01-01T09:15:{:02}", i * 5),
                })
            })
            .collect()
    }

    #[test]
    fn test_micro_features_default() {
        let f = MicroFeatures::default();
        assert_eq!(f.tick_momentum, 0.0);
        assert_eq!(f.volume_acceleration, 0.0);
        assert_eq!(f.vwap_deviation, 0.0);
        assert_eq!(f.trade_imbalance, 0.0);
        assert_eq!(f.spread_proxy, 0.0);
        assert_eq!(f.tick_volatility, 0.0);
        assert_eq!(f.micro_trend, 0.0);
        assert_eq!(f.volume_zscore, 0.0);
    }

    #[test]
    fn test_compute_api() {
        let candles = sample_candles_json();

        let result = TickAggregator::compute(json!({
            "command": "features",
            "candles": candles,
        }));
        assert!(result.is_ok(), "features failed: {:?}", result.err());
        let features = result.unwrap();
        assert!(features.get("tick_momentum").is_some());
        assert!(features.get("volume_zscore").is_some());

        let result = TickAggregator::compute(json!({
            "command": "candles",
            "candles": candles,
            "limit": 5,
        }));
        assert!(result.is_ok(), "candles failed: {:?}", result.err());
        let arr = result.unwrap();
        assert_eq!(arr.as_array().unwrap().len(), 5);

        let result = TickAggregator::compute(json!({ "command": "bogus" }));
        assert!(result.is_err());
    }
}
