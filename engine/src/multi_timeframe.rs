use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::utils::{Candle, get_f64, calc_atr_candles};
use crate::signals;

#[derive(Deserialize)]
struct MTFInput {
    symbols: Vec<MTFSymbolData>,
    #[serde(default = "default_aggressiveness")]
    aggressiveness: String,
}

#[derive(Deserialize)]
struct MTFSymbolData {
    symbol: String,
    #[serde(default)]
    candles_1m: Vec<Candle>,
    #[serde(default)]
    candles_5m: Vec<Candle>,
    #[serde(default)]
    candles_15m: Vec<Candle>,
    #[serde(default)]
    candles_1h: Vec<Candle>,
    #[serde(default)]
    candles_daily: Vec<Candle>,
}

fn default_aggressiveness() -> String {
    "medium".to_string()
}

#[derive(Serialize)]
struct MTFOutput {
    signals: Vec<MTFSignal>,
}

#[derive(Serialize)]
struct MTFSignal {
    symbol: String,
    direction: String,
    confidence: f64,
    entry: f64,
    stop_loss: f64,
    target: f64,
    timeframe_alignment: TimeframeAlignment,
    dominant_timeframe: String,
}

#[derive(Serialize)]
struct TimeframeAlignment {
    trend_1m: String,
    trend_5m: String,
    trend_15m: String,
    trend_1h: String,
    trend_daily: String,
    alignment_score: f64,
    confirmation_count: i32,
}

fn analyze_trend(candles: &[Candle]) -> (String, f64) {
    if candles.len() < 15 {
        return ("neutral".to_string(), 0.0);
    }

    let candles_json = match serde_json::to_value(
        &serde_json::json!({ "candles": candles })
    ) {
        Ok(v) => v,
        Err(_) => return ("neutral".to_string(), 0.0),
    };

    let indicators = match signals::compute(candles_json) {
        Ok(v) => v,
        Err(_) => return ("neutral".to_string(), 0.0),
    };

    let n = candles.len();
    let last = n - 1;

    let ema9 = get_f64(&indicators, "ema_9", last);
    let ema21 = get_f64(&indicators, "ema_21", last);
    let rsi = get_f64(&indicators, "rsi_14", last);
    let supertrend = get_f64(&indicators, "supertrend", last);
    let close = candles[last].close;

    if ema21 == 0.0 {
        return ("neutral".to_string(), 0.0);
    }

    let mut bull_score = 0.0;
    let mut bear_score = 0.0;

    if ema9 > ema21 { bull_score += 1.0; } else { bear_score += 1.0; }
    if rsi > 50.0 { bull_score += 0.5; } else { bear_score += 0.5; }
    if supertrend > 0.0 && close > supertrend { bull_score += 1.0; } else if supertrend > 0.0 { bear_score += 1.0; }

    // Momentum check
    if n >= 5 {
        let recent_change = (close - candles[n - 5].close) / candles[n - 5].close;
        if recent_change > 0.005 { bull_score += 0.5; }
        else if recent_change < -0.005 { bear_score += 0.5; }
    }

    let total = bull_score + bear_score;
    if total == 0.0 {
        return ("neutral".to_string(), 0.0);
    }

    if bull_score > bear_score {
        ("bullish".to_string(), bull_score / total)
    } else if bear_score > bull_score {
        ("bearish".to_string(), bear_score / total)
    } else {
        ("neutral".to_string(), 0.0)
    }
}

pub fn compute(data: Value) -> Result<Value, String> {
    let input: MTFInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid MTF scan input: {}", e))?;

    let min_confidence = match input.aggressiveness.as_str() {
        "high" => 0.30,
        "low" => 0.60,
        _ => 0.40,
    };

    let mut out_signals = Vec::new();

    for sym_data in &input.symbols {
        let (trend_1m, conf_1m) = analyze_trend(&sym_data.candles_1m);
        let (trend_5m, conf_5m) = analyze_trend(&sym_data.candles_5m);
        let (trend_15m, conf_15m) = analyze_trend(&sym_data.candles_15m);
        let (trend_1h, conf_1h) = analyze_trend(&sym_data.candles_1h);
        let (trend_daily, conf_daily) = analyze_trend(&sym_data.candles_daily);

        let trends = vec![
            (&trend_1m, conf_1m, 0.05),
            (&trend_5m, conf_5m, 0.15),
            (&trend_15m, conf_15m, 0.25),
            (&trend_1h, conf_1h, 0.30),
            (&trend_daily, conf_daily, 0.25),
        ];

        let mut bull_weighted = 0.0;
        let mut bear_weighted = 0.0;
        let mut confirmation_count = 0i32;
        for (trend, conf, weight) in &trends {
            match trend.as_str() {
                "bullish" => {
                    bull_weighted += conf * weight;
                    confirmation_count += 1;
                }
                "bearish" => {
                    bear_weighted += conf * weight;
                    confirmation_count -= 1;
                }
                _ => {}
            }
        }

        let alignment_score;
        let direction;

        if bull_weighted > bear_weighted && confirmation_count >= 2 {
            direction = "LONG";
            alignment_score = bull_weighted;
        } else if bear_weighted > bull_weighted && confirmation_count <= -2 {
            direction = "SHORT";
            alignment_score = bear_weighted;
        } else {
            continue;
        }

        if alignment_score < min_confidence {
            continue;
        }

        // Use the most granular available candles for entry/SL/target
        let ref_candles = if !sym_data.candles_5m.is_empty() {
            &sym_data.candles_5m
        } else if !sym_data.candles_15m.is_empty() {
            &sym_data.candles_15m
        } else if !sym_data.candles_1h.is_empty() {
            &sym_data.candles_1h
        } else {
            &sym_data.candles_daily
        };

        if ref_candles.is_empty() { continue; }

        let close = match ref_candles.last() {
            Some(c) => c.close,
            None => continue,
        };
        let atr = calc_atr_candles(ref_candles, 14);

        let (entry, stop_loss, target) = if direction == "LONG" {
            (close, close - 2.0 * atr, close + 3.0 * atr)
        } else {
            (close, close + 2.0 * atr, close - 3.0 * atr)
        };

        let dominant_timeframe = if conf_daily > conf_1h && conf_daily > conf_15m {
            "daily"
        } else if conf_1h > conf_15m {
            "1h"
        } else if conf_15m > conf_5m {
            "15m"
        } else {
            "5m"
        };

        out_signals.push(MTFSignal {
            symbol: sym_data.symbol.clone(),
            direction: direction.to_string(),
            confidence: (alignment_score * 100.0).round() / 100.0,
            entry: (entry * 100.0).round() / 100.0,
            stop_loss: (stop_loss * 100.0).round() / 100.0,
            target: (target * 100.0).round() / 100.0,
            timeframe_alignment: TimeframeAlignment {
                trend_1m: trend_1m.clone(),
                trend_5m: trend_5m.clone(),
                trend_15m: trend_15m.clone(),
                trend_1h: trend_1h.clone(),
                trend_daily: trend_daily.clone(),
                alignment_score: (alignment_score * 100.0).round() / 100.0,
                confirmation_count: confirmation_count.abs(),
            },
            dominant_timeframe: dominant_timeframe.to_string(),
        });
    }

    out_signals.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));

    serde_json::to_value(MTFOutput { signals: out_signals })
        .map_err(|e| format!("Serialization error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_trending_candles(n: usize, base: f64, step: f64) -> Vec<serde_json::Value> {
        (0..n)
            .map(|i| {
                let close = base + step * i as f64;
                json!({
                    "timestamp": format!("2024-01-{:02}T09:{:02}:00", (i % 28) + 1, i % 60),
                    "open": close - step.abs() * 0.3,
                    "high": close + step.abs() * 0.5 + 0.5,
                    "low": close - step.abs() * 0.5 - 0.5,
                    "close": close,
                    "volume": 50000.0 + (i as f64 * 200.0)
                })
            })
            .collect()
    }

    #[test]
    fn test_multi_timeframe_basic() {
        let candles_1m = make_trending_candles(40, 2400.0, 1.0);
        let candles_5m = make_trending_candles(40, 2400.0, 2.0);

        let input = json!({
            "symbols": [{
                "symbol": "RELIANCE",
                "candles_1m": candles_1m,
                "candles_5m": candles_5m
            }]
        });

        let result = compute(input).expect("basic MTF compute should not fail");
        let signals = result.get("signals").expect("missing signals key");
        assert!(signals.is_array(), "signals should be an array");
    }

    #[test]
    fn test_multi_timeframe_empty_symbols() {
        let input = json!({ "symbols": [] });
        let result = compute(input).expect("empty symbols should succeed");
        let signals = result.get("signals").unwrap().as_array().unwrap();
        assert!(signals.is_empty(), "no symbols means no signals");
    }

    #[test]
    fn test_multi_timeframe_insufficient_data() {
        let short_candles = make_trending_candles(5, 100.0, 0.5);
        let input = json!({
            "symbols": [{
                "symbol": "INFY",
                "candles_1m": short_candles.clone(),
                "candles_5m": short_candles
            }]
        });

        let result = compute(input).expect("insufficient data should not error, just produce neutral");
        let signals = result.get("signals").unwrap().as_array().unwrap();
        assert!(
            signals.is_empty(),
            "too few candles should yield neutral trends and no signals"
        );
    }

    #[test]
    fn test_multi_timeframe_single_timeframe() {
        let candles_5m = make_trending_candles(40, 1800.0, 1.5);
        let input = json!({
            "symbols": [{
                "symbol": "TCS",
                "candles_5m": candles_5m
            }]
        });

        let result = compute(input).expect("single timeframe should not fail");
        let signals = result.get("signals").expect("missing signals");
        assert!(signals.is_array());
    }
}
