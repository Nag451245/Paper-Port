//! Latency monitoring and execution quality analytics.
//! Records execution events, computes slippage/latency/market impact,
//! and aggregates stats by symbol, broker, and time-of-day bucket.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

static ANALYTICS_STORE: once_cell::sync::Lazy<Mutex<ExecutionAnalyticsStore>> =
    once_cell::sync::Lazy::new(|| Mutex::new(ExecutionAnalyticsStore::new()));

/// Single execution event record.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionEvent {
    pub order_sent_ts: i64,
    pub ack_ts: Option<i64>,
    pub fill_ts: i64,
    pub price_at_send: f64,
    pub fill_price: f64,
    pub fill_qty: i64,
    pub symbol: String,
    pub broker: String,
    #[serde(default)]
    pub side: Option<String>,
}

/// Per-execution computed metrics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionMetrics {
    pub slippage_bps: f64,
    pub latency_ms: f64,
    pub market_impact_bps: f64,
}

/// Time-of-day bucket (IST).
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TimeBucketStats {
    pub bucket: String,
    pub count: usize,
    pub avg_slippage_bps: f64,
    pub avg_latency_ms: f64,
    pub avg_market_impact_bps: f64,
    pub fill_rate: f64,
}

/// Aggregate execution statistics.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionStats {
    pub total_executions: usize,
    pub total_orders: usize,
    pub avg_slippage_bps: f64,
    pub avg_latency_ms: f64,
    pub fill_rate: f64,
    pub avg_market_impact_bps: f64,
    pub worst_slippage_bps: f64,
    pub best_slippage_bps: f64,
    pub by_time_bucket: Vec<TimeBucketStats>,
}

struct ExecutionAnalyticsStore {
    events: Vec<(ExecutionEvent, ExecutionMetrics)>,
    orders_total: usize, // includes unfilled
}

impl ExecutionAnalyticsStore {
    fn new() -> Self {
        Self {
            events: Vec::new(),
            orders_total: 0,
        }
    }

    fn record(&mut self, evt: ExecutionEvent) {
        let metrics = compute_metrics(&evt);
        self.events.push((evt, metrics));
    }

    fn record_order_sent(&mut self) {
        self.orders_total += 1;
    }

    fn stats(&self) -> ExecutionStats {
        let filled = self.events.len();
        let total_orders = self.orders_total.max(filled);
        let fill_rate = if total_orders > 0 {
            filled as f64 / total_orders as f64
        } else {
            0.0
        };

        let (avg_slippage, avg_latency, avg_impact, worst, best) = if self.events.is_empty() {
            (0.0, 0.0, 0.0, 0.0, 0.0)
        } else {
            let n = self.events.len() as f64;
            let sum_slip: f64 = self.events.iter().map(|(_, m)| m.slippage_bps).sum();
            let sum_lat: f64 = self.events.iter().map(|(_, m)| m.latency_ms).sum();
            let sum_imp: f64 = self.events.iter().map(|(_, m)| m.market_impact_bps).sum();
            let slips: Vec<f64> = self.events.iter().map(|(_, m)| m.slippage_bps).collect();
            let worst = slips.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let best = slips.iter().cloned().fold(f64::INFINITY, f64::min);
            (
                sum_slip / n,
                sum_lat / n,
                sum_imp / n,
                if worst == f64::NEG_INFINITY { 0.0 } else { worst },
                if best == f64::INFINITY { 0.0 } else { best },
            )
        };

        let by_time_bucket = self.aggregate_by_time_bucket();

        ExecutionStats {
            total_executions: filled,
            total_orders,
            avg_slippage_bps: round2(avg_slippage),
            avg_latency_ms: round2(avg_latency),
            fill_rate: round4(fill_rate),
            avg_market_impact_bps: round2(avg_impact),
            worst_slippage_bps: round2(worst),
            best_slippage_bps: round2(best),
            by_time_bucket,
        }
    }

    fn by_symbol(&self) -> HashMap<String, SymbolBrokerStats> {
        let mut by_sym: HashMap<String, Vec<&(ExecutionEvent, ExecutionMetrics)>> = HashMap::new();
        for e in &self.events {
            by_sym.entry(e.0.symbol.clone()).or_default().push(e);
        }
        by_sym
            .into_iter()
            .map(|(k, v)| {
                let n = v.len() as f64;
                let avg_slip = v.iter().map(|(_, m)| m.slippage_bps).sum::<f64>() / n;
                let avg_lat = v.iter().map(|(_, m)| m.latency_ms).sum::<f64>() / n;
                let avg_imp = v.iter().map(|(_, m)| m.market_impact_bps).sum::<f64>() / n;
                (
                    k,
                    SymbolBrokerStats {
                        count: v.len(),
                        avg_slippage_bps: round2(avg_slip),
                        avg_latency_ms: round2(avg_lat),
                        avg_market_impact_bps: round2(avg_imp),
                    },
                )
            })
            .collect()
    }

    fn by_broker(&self) -> HashMap<String, SymbolBrokerStats> {
        let mut by_broker: HashMap<String, Vec<&(ExecutionEvent, ExecutionMetrics)>> = HashMap::new();
        for e in &self.events {
            by_broker.entry(e.0.broker.clone()).or_default().push(e);
        }
        by_broker
            .into_iter()
            .map(|(k, v)| {
                let n = v.len() as f64;
                let avg_slip = v.iter().map(|(_, m)| m.slippage_bps).sum::<f64>() / n;
                let avg_lat = v.iter().map(|(_, m)| m.latency_ms).sum::<f64>() / n;
                let avg_imp = v.iter().map(|(_, m)| m.market_impact_bps).sum::<f64>() / n;
                (
                    k,
                    SymbolBrokerStats {
                        count: v.len(),
                        avg_slippage_bps: round2(avg_slip),
                        avg_latency_ms: round2(avg_lat),
                        avg_market_impact_bps: round2(avg_imp),
                    },
                )
            })
            .collect()
    }

    fn by_time_bucket(&self) -> Vec<TimeBucketStats> {
        self.aggregate_by_time_bucket()
    }

    fn aggregate_by_time_bucket(&self) -> Vec<TimeBucketStats> {
        let buckets = ["09:15-10:00", "10:00-12:00", "12:00-14:00", "14:00-15:30", "other"];
        let mut by_bucket: HashMap<String, Vec<&(ExecutionEvent, ExecutionMetrics)>> = HashMap::new();
        for b in &buckets {
            by_bucket.insert((*b).to_string(), Vec::new());
        }
        for e in &self.events {
            let bucket = time_to_bucket(e.0.order_sent_ts);
            by_bucket.entry(bucket).or_default().push(e);
        }
        buckets
            .iter()
            .map(|b| {
                let v = by_bucket.get(*b).cloned().unwrap_or_default();
                let n = v.len() as f64;
                let (avg_slip, avg_lat, avg_imp) = if v.is_empty() {
                    (0.0, 0.0, 0.0)
                } else {
                    (
                        v.iter().map(|(_, m)| m.slippage_bps).sum::<f64>() / n,
                        v.iter().map(|(_, m)| m.latency_ms).sum::<f64>() / n,
                        v.iter().map(|(_, m)| m.market_impact_bps).sum::<f64>() / n,
                    )
                };
                TimeBucketStats {
                    bucket: (*b).to_string(),
                    count: v.len(),
                    avg_slippage_bps: round2(avg_slip),
                    avg_latency_ms: round2(avg_lat),
                    avg_market_impact_bps: round2(avg_imp),
                    fill_rate: if self.orders_total > 0 {
                        round4(v.len() as f64 / self.orders_total as f64)
                    } else {
                        0.0
                    },
                }
            })
            .collect()
    }

    fn reset(&mut self) {
        self.events.clear();
        self.orders_total = 0;
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct SymbolBrokerStats {
    pub count: usize,
    pub avg_slippage_bps: f64,
    pub avg_latency_ms: f64,
    pub avg_market_impact_bps: f64,
}

fn compute_metrics(evt: &ExecutionEvent) -> ExecutionMetrics {
    let slippage_bps = if evt.price_at_send > 0.0 {
        ((evt.fill_price - evt.price_at_send) / evt.price_at_send * 10_000.0).abs()
    } else {
        0.0
    };
    let latency_ms = (evt.fill_ts - evt.order_sent_ts) as f64;
    let market_impact_bps = slippage_bps; // simplified: use slippage as proxy
    ExecutionMetrics {
        slippage_bps,
        latency_ms,
        market_impact_bps,
    }
}

fn time_to_bucket(ts_ms: i64) -> String {
    use chrono::{TimeZone, Timelike};
    let utc = match chrono::Utc.timestamp_millis_opt(ts_ms) {
        chrono::LocalResult::Single(dt) => dt,
        _ => chrono::DateTime::UNIX_EPOCH,
    };
    let ist = utc + chrono::Duration::hours(5) + chrono::Duration::minutes(30);
    let h = ist.hour() as i32;
    let m = ist.minute() as i32;
    let minutes = h * 60 + m;
    let bucket = if ((9 * 60 + 15)..(10 * 60)).contains(&minutes) {
        "09:15-10:00"
    } else if ((10 * 60)..(12 * 60)).contains(&minutes) {
        "10:00-12:00"
    } else if ((12 * 60)..(14 * 60)).contains(&minutes) {
        "12:00-14:00"
    } else if ((14 * 60)..(15 * 60 + 30)).contains(&minutes) {
        "14:00-15:30"
    } else {
        "other"
    };
    bucket.to_string()
}

fn round2(x: f64) -> f64 {
    (x * 100.0).round() / 100.0
}
fn round4(x: f64) -> f64 {
    (x * 10_000.0).round() / 10_000.0
}

/// JSON API entry point. Commands: "record", "stats", "by_symbol", "by_broker", "by_time_bucket", "reset", "record_order_sent"
pub fn compute(data: Value) -> Result<Value, String> {
    let command = data
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("stats");

    match command {
        "record" => {
            let evt_value = data.get("event").or(data.get("data")).cloned().unwrap_or(Value::Null);
            let evt: ExecutionEvent =
                serde_json::from_value(evt_value)
                    .map_err(|e| format!("Invalid execution event: {}", e))?;
            let mut store = ANALYTICS_STORE.lock().map_err(|_| "Lock poisoned".to_string())?;
            store.record(evt);
            Ok(serde_json::json!({ "recorded": true }))
        }
        "record_order_sent" => {
            let mut store = ANALYTICS_STORE.lock().map_err(|_| "Lock poisoned".to_string())?;
            store.record_order_sent();
            Ok(serde_json::json!({ "recorded": true }))
        }
        "stats" => {
            let store = ANALYTICS_STORE.lock().map_err(|_| "Lock poisoned".to_string())?;
            let stats = store.stats();
            serde_json::to_value(stats).map_err(|e| format!("Serialization error: {}", e))
        }
        "by_symbol" => {
            let store = ANALYTICS_STORE.lock().map_err(|_| "Lock poisoned".to_string())?;
            let by_sym = store.by_symbol();
            let out: HashMap<String, SymbolBrokerStats> = by_sym;
            serde_json::to_value(out).map_err(|e| format!("Serialization error: {}", e))
        }
        "by_broker" => {
            let store = ANALYTICS_STORE.lock().map_err(|_| "Lock poisoned".to_string())?;
            let by_broker = store.by_broker();
            let out: HashMap<String, SymbolBrokerStats> = by_broker;
            serde_json::to_value(out).map_err(|e| format!("Serialization error: {}", e))
        }
        "by_time_bucket" => {
            let store = ANALYTICS_STORE.lock().map_err(|_| "Lock poisoned".to_string())?;
            let buckets = store.by_time_bucket();
            serde_json::to_value(buckets).map_err(|e| format!("Serialization error: {}", e))
        }
        "reset" => {
            let mut store = ANALYTICS_STORE.lock().map_err(|_| "Lock poisoned".to_string())?;
            store.reset();
            Ok(serde_json::json!({ "reset": true }))
        }
        _ => Err(format!("Unknown command: {}", command)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn ts_ist(h: u32, m: u32) -> i64 {
        use chrono::TimeZone;
        let ist_naive = chrono::NaiveDate::from_ymd_opt(2024, 1, 15)
            .unwrap()
            .and_hms_opt(h, m, 0)
            .unwrap();
        let utc_naive = ist_naive - chrono::Duration::hours(5) - chrono::Duration::minutes(30);
        chrono::Utc.from_utc_datetime(&utc_naive).timestamp_millis()
    }

    #[test]
    fn test_record_and_stats() {
        compute(json!({ "command": "reset" })).unwrap();
        compute(json!({ "command": "record_order_sent" })).unwrap();
        compute(json!({
            "command": "record",
            "data": {
                "order_sent_ts": ts_ist(10, 30),
                "ack_ts": Some(ts_ist(10, 30) + 5),
                "fill_ts": ts_ist(10, 30) + 50,
                "price_at_send": 100.0,
                "fill_price": 100.5,
                "fill_qty": 10,
                "symbol": "RELIANCE",
                "broker": "icici"
            }
        }))
        .unwrap();
        let result = compute(json!({ "command": "stats" })).unwrap();
        let stats: ExecutionStats = serde_json::from_value(result).unwrap();
        assert_eq!(stats.total_executions, 1);
        assert!(stats.avg_slippage_bps > 0.0);
        assert_eq!(stats.avg_latency_ms, 50.0);
        assert!(stats.fill_rate > 0.0);
    }

    #[test]
    fn test_slippage_calculation() {
        compute(json!({ "command": "reset" })).unwrap();
        compute(json!({
            "command": "record",
            "data": {
                "order_sent_ts": 1000,
                "fill_ts": 1100,
                "price_at_send": 100.0,
                "fill_price": 101.0,
                "fill_qty": 5,
                "symbol": "TCS",
                "broker": "zerodha"
            }
        }))
        .unwrap();
        let result = compute(json!({ "command": "stats" })).unwrap();
        let stats: ExecutionStats = serde_json::from_value(result).unwrap();
        assert!((stats.avg_slippage_bps - 100.0).abs() < 1.0);
    }

    #[test]
    fn test_by_symbol_aggregation() {
        compute(json!({ "command": "reset" })).unwrap();
        for _ in 0..3 {
            compute(json!({
                "command": "record",
                "data": {
                    "order_sent_ts": 1000,
                    "fill_ts": 1050,
                    "price_at_send": 200.0,
                    "fill_price": 200.2,
                    "fill_qty": 1,
                    "symbol": "SYM_AGG_A",
                    "broker": "icici"
                }
            }))
            .unwrap();
        }
        compute(json!({
            "command": "record",
            "data": {
                "order_sent_ts": 1000,
                "fill_ts": 1050,
                "price_at_send": 150.0,
                "fill_price": 150.1,
                "fill_qty": 1,
                "symbol": "SYM_AGG_B",
                "broker": "icici"
            }
        }))
        .unwrap();
        let result = compute(json!({ "command": "by_symbol" })).unwrap();
        let by_sym: HashMap<String, SymbolBrokerStats> = serde_json::from_value(result).unwrap();
        assert!(by_sym.get("SYM_AGG_A").map(|s| s.count).unwrap_or(0) >= 3);
        assert!(by_sym.get("SYM_AGG_B").map(|s| s.count).unwrap_or(0) >= 1);
    }

    #[test]
    fn test_fill_rate() {
        compute(json!({ "command": "reset" })).unwrap();
        for _ in 0..2 {
            compute(json!({ "command": "record_order_sent" })).unwrap();
        }
        compute(json!({
            "command": "record",
            "data": {
                "order_sent_ts": 1000,
                "fill_ts": 1050,
                "price_at_send": 100.0,
                "fill_price": 100.0,
                "fill_qty": 1,
                "symbol": "FILL_TEST",
                "broker": "icici"
            }
        }))
        .unwrap();
        let result = compute(json!({ "command": "stats" })).unwrap();
        let stats: ExecutionStats = serde_json::from_value(result).unwrap();
        assert!(stats.total_orders >= 2, "should have at least 2 orders");
        assert!(stats.total_executions >= 1, "should have at least 1 execution");
        assert!(stats.fill_rate > 0.0 && stats.fill_rate <= 1.0, "fill rate should be between 0 and 1");
    }

    #[test]
    fn test_by_time_bucket() {
        compute(json!({ "command": "reset" })).unwrap();
        compute(json!({
            "command": "record",
            "data": {
                "order_sent_ts": ts_ist(11, 0),
                "fill_ts": ts_ist(11, 0) + 30,
                "price_at_send": 100.0,
                "fill_price": 100.0,
                "fill_qty": 1,
                "symbol": "X",
                "broker": "b"
            }
        }))
        .unwrap();
        let result = compute(json!({ "command": "by_time_bucket" })).unwrap();
        let buckets: Vec<TimeBucketStats> = serde_json::from_value(result).unwrap();
        assert_eq!(buckets.len(), 5);
        let ten_twelve = buckets.iter().find(|b| b.bucket == "10:00-12:00").unwrap();
        assert_eq!(ten_twelve.count, 1);
    }
}
