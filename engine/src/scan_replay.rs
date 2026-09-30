//! Replay the live scanner over history.
//!
//! WHY THIS EXISTS
//! `scan::compute` produces the signals that actually trade, but nothing could
//! evaluate it historically: `backtest::run` only executes the named strategies
//! in `strategy.rs`, and `walk_forward` calls `backtest::run`. So the code that
//! decides what to buy had never been compared against what happened next.
//!
//! WHAT IT DOES
//! Walks forward through time and, at every timestamp, calls the REAL
//! `scan::compute` exactly as the live bot does: one batch containing every
//! symbol that has a bar at that timestamp, each with its trailing `window`
//! bars (production feeds 50 completed bars). Cross-symbol strategies such as
//! sector rotation therefore see the same batch they would see live.
//!
//! It deliberately does NOT reimplement or modify any scan logic. Fidelity is
//! the point: this is the engine judging itself, not a port of it. Forward
//! returns and statistics are left to the caller, which already holds the
//! candles; see server/scripts/replay-scan-engine.mjs.
//!
//! EVALUATION RULE (the caller reconstructs the same grid from it):
//! a (symbol, timestamp) pair is scanned iff the symbol has a bar at that
//! timestamp, at least `window` bars end there, and `from <= timestamp < to`.

use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::{BTreeSet, HashMap};

use crate::scan;
use crate::utils::Candle;

/// Bars the live bot hands the scanner (bot-engine.ts: completedBars(bars).slice(-50)).
const PRODUCTION_WINDOW: usize = 50;
/// scan.rs skips any symbol with fewer candles than this.
const MIN_SCAN_CANDLES: usize = 15;
/// Keep the error list bounded; the count is reported separately.
const MAX_REPORTED_ERRORS: usize = 20;

#[derive(Deserialize)]
struct ReplaySymbol {
    symbol: String,
    candles: Vec<Candle>,
}

#[derive(Deserialize)]
struct ReplayInput {
    symbols: Vec<ReplaySymbol>,
    #[serde(default = "default_window")]
    window: usize,
    /// "high" is what bot-engine.ts passes in live operation.
    #[serde(default = "default_aggressiveness")]
    aggressiveness: String,
    /// Passed straight through. Note: live regime strings are uppercase
    /// ("TRENDING_UP") and scan.rs matches lowercase ("trending"), so in
    /// production regime weighting never applies. Omit to reproduce that.
    #[serde(default)]
    regime: Option<String>,
    /// Only scan timestamps >= from (string compare; ISO-8601 sorts correctly).
    #[serde(default)]
    from: Option<String>,
    /// Only scan timestamps < to.
    #[serde(default)]
    to: Option<String>,
}

fn default_window() -> usize { PRODUCTION_WINDOW }
fn default_aggressiveness() -> String { "high".to_string() }

pub fn compute(data: Value) -> Result<Value, String> {
    let input: ReplayInput = serde_json::from_value(data)
        .map_err(|e| format!("Invalid scan_replay input: {}", e))?;

    if input.window < MIN_SCAN_CANDLES {
        return Err(format!(
            "window {} is below {}, the minimum scan.rs will evaluate",
            input.window, MIN_SCAN_CANDLES
        ));
    }

    // Symbols are aligned by timestamp, so timestamps must be present and
    // strictly increasing. A duplicate or out-of-order bar would silently shift
    // every window after it — refuse rather than replay a misaligned history.
    for s in &input.symbols {
        for (i, c) in s.candles.iter().enumerate() {
            if c.timestamp.is_empty() {
                return Err(format!("{}: candle {} has no timestamp; symbols cannot be aligned by time", s.symbol, i));
            }
            if i > 0 && c.timestamp.as_str() <= s.candles[i - 1].timestamp.as_str() {
                return Err(format!(
                    "{}: timestamps must be strictly increasing (candle {} '{}' follows '{}')",
                    s.symbol, i, c.timestamp, s.candles[i - 1].timestamp
                ));
            }
        }
    }

    let index: Vec<HashMap<&str, usize>> = input
        .symbols
        .iter()
        .map(|s| s.candles.iter().enumerate().map(|(i, c)| (c.timestamp.as_str(), i)).collect())
        .collect();

    let mut timestamps: BTreeSet<&str> = BTreeSet::new();
    for s in &input.symbols {
        for c in &s.candles {
            timestamps.insert(c.timestamp.as_str());
        }
    }

    let mut signals: Vec<Value> = Vec::new();
    let mut errors: Vec<String> = Vec::new();
    let mut error_count = 0usize;
    let mut calls = 0usize;
    let mut evaluated = 0usize;

    for ts in timestamps.iter() {
        let ts: &str = ts;
        if let Some(f) = &input.from {
            if ts < f.as_str() { continue; }
        }
        if let Some(t) = &input.to {
            if ts >= t.as_str() { continue; }
        }

        let mut batch: Vec<Value> = Vec::new();
        for (si, s) in input.symbols.iter().enumerate() {
            let i = match index[si].get(ts) {
                Some(&i) => i,
                None => continue,
            };
            if i + 1 < input.window {
                continue;
            }
            let slice = &s.candles[i + 1 - input.window..=i];
            let candles = serde_json::to_value(slice)
                .map_err(|e| format!("{}: could not serialise candles: {}", s.symbol, e))?;
            batch.push(json!({ "symbol": s.symbol, "candles": candles }));
        }
        if batch.is_empty() {
            continue;
        }
        evaluated += batch.len();

        let date = ts.get(..10).unwrap_or(ts); // str::get never panics on a char boundary
        let mut request = json!({
            "symbols": batch,
            "aggressiveness": input.aggressiveness,
            "current_date": date,
        });
        if let Some(r) = &input.regime {
            request["regime"] = json!(r);
        }

        calls += 1;
        match scan::compute(request) {
            Ok(result) => {
                if let Some(list) = result.get("signals").and_then(|v| v.as_array()) {
                    for sig in list {
                        signals.push(json!({
                            "timestamp": ts,
                            "symbol": sig.get("symbol").cloned().unwrap_or(Value::Null),
                            // scan.rs tags every family; fall back defensively.
                            "strategy": sig.get("strategy").cloned().unwrap_or_else(|| json!("composite")),
                            "direction": sig.get("direction").cloned().unwrap_or(Value::Null),
                            "confidence": sig.get("confidence").cloned().unwrap_or(Value::Null),
                            "votes": sig.get("votes").cloned().unwrap_or(Value::Null),
                        }));
                    }
                }
            }
            Err(e) => {
                error_count += 1;
                if errors.len() < MAX_REPORTED_ERRORS {
                    errors.push(format!("{}: {}", ts, e));
                }
            }
        }
    }

    Ok(json!({
        "window": input.window,
        "aggressiveness": input.aggressiveness,
        "calls": calls,
        "evaluated": evaluated,
        "signals": signals,
        "error_count": error_count,
        "errors": errors,
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A valid calendar date per index (28-day months keep every date legal),
    /// so scan.rs's current_date parsing sees real YYYY-MM-DD values.
    fn day(i: usize) -> String {
        format!("2026-{:02}-{:02}", 1 + i / 28, 1 + i % 28)
    }

    /// Steadily rising closes on rising volume — the series scan.rs's own
    /// tests use to guarantee a BUY, so equality checks are not vacuous.
    fn rising(n: usize, offset: usize) -> Vec<Candle> {
        (0..n).map(|k| {
            let i = k + offset;
            let c = 100.0 + i as f64 * 2.0;
            Candle { timestamp: day(i), open: c - 1.0, high: c + 1.0, low: c - 2.0, close: c, volume: 1000.0 + i as f64 * 200.0 }
        }).collect()
    }

    fn signal_key(v: &Value) -> String {
        format!("{}|{}|{}",
            v.get("strategy").and_then(|x| x.as_str()).unwrap_or("composite"),
            v.get("direction").and_then(|x| x.as_str()).unwrap_or(""),
            v.get("confidence").map(|x| x.to_string()).unwrap_or_default())
    }

    #[test]
    fn replay_matches_direct_scan_on_the_same_window() {
        // THE fidelity property: at any timestamp, replay must return exactly
        // what scan::compute returns when handed that window directly.
        let candles = rising(80, 0);
        let replay = compute(json!({ "symbols": [{ "symbol": "X", "candles": candles }] })).unwrap();
        let last_ts = candles[79].timestamp.clone();

        let mut from_replay: Vec<String> = replay["signals"].as_array().unwrap().iter()
            .filter(|s| s["timestamp"] == json!(last_ts))
            .map(signal_key).collect();

        let direct = scan::compute(json!({
            "symbols": [{ "symbol": "X", "candles": serde_json::to_value(&candles[30..80]).unwrap() }],
            "aggressiveness": "high",
            "current_date": &last_ts[..10],
        })).unwrap();
        let mut from_direct: Vec<String> = direct["signals"].as_array().unwrap().iter().map(signal_key).collect();

        from_replay.sort();
        from_direct.sort();
        assert!(!from_direct.is_empty(), "a rising series should produce at least one signal, or this test proves nothing");
        assert_eq!(from_replay, from_direct, "replay diverged from a direct scan of the same 50-bar window");
    }

    #[test]
    fn only_bars_with_a_full_window_are_evaluated() {
        let replay = compute(json!({ "symbols": [{ "symbol": "X", "candles": rising(80, 0) }] })).unwrap();
        // 80 bars, window 50 → bars 49..=79 are scannable
        assert_eq!(replay["evaluated"], json!(31));
        assert_eq!(replay["calls"], json!(31));
    }

    #[test]
    fn symbols_align_by_timestamp_not_by_position() {
        // B starts 20 bars after A. B must not be scanned until IT has a full
        // window, and when both are scanned they must be in the same batch.
        let a = rising(90, 0);
        let b = rising(70, 20);
        let replay = compute(json!({ "symbols": [
            { "symbol": "A", "candles": a },
            { "symbol": "B", "candles": b },
        ] })).unwrap();
        // A scannable at its bars 49..=89 → 41; B at its bars 49..=69 → 21
        assert_eq!(replay["evaluated"], json!(41 + 21));
        // one scan call per distinct timestamp with at least one scannable symbol
        assert_eq!(replay["calls"], json!(41));
        let b_first = replay["signals"].as_array().unwrap().iter()
            .filter(|s| s["symbol"] == json!("B"))
            .filter_map(|s| s["timestamp"].as_str().map(|t| t.to_string()))
            .min();
        if let Some(t) = b_first {
            assert!(t.as_str() >= day(20 + 49).as_str(), "B was scanned before it had a full window: {}", t);
        }
    }

    #[test]
    fn from_and_to_bound_the_replay() {
        let candles = rising(80, 0);
        let replay = compute(json!({
            "symbols": [{ "symbol": "X", "candles": candles }],
            "from": day(60), "to": day(70),
        })).unwrap();
        assert_eq!(replay["evaluated"], json!(10));
    }

    #[test]
    fn rejects_a_window_scan_would_never_evaluate() {
        let err = compute(json!({ "symbols": [{ "symbol": "X", "candles": rising(60, 0) }], "window": 10 })).unwrap_err();
        assert!(err.contains("window"), "unexpected error: {}", err);
    }

    #[test]
    fn rejects_candles_without_timestamps() {
        let mut candles = rising(60, 0);
        candles[5].timestamp = String::new();
        let err = compute(json!({ "symbols": [{ "symbol": "X", "candles": candles }] })).unwrap_err();
        assert!(err.contains("no timestamp"), "unexpected error: {}", err);
    }

    #[test]
    fn rejects_out_of_order_or_duplicate_bars() {
        let mut candles = rising(60, 0);
        candles[10].timestamp = candles[9].timestamp.clone();
        let err = compute(json!({ "symbols": [{ "symbol": "X", "candles": candles }] })).unwrap_err();
        assert!(err.contains("strictly increasing"), "unexpected error: {}", err);
    }
}
