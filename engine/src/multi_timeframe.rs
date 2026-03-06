use serde::{Deserialize, Serialize};
use serde_json::Value;
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

#[derive(Deserialize, Serialize, Clone)]
struct Candle {
    close: f64,
    high: f64,
    low: f64,
    volume: f64,
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
    if candles.len() < 26 {
        return ("neutral".to_string(), 0.0);
    }

    let candles_json = serde_json::to_value(
        &serde_json::json!({ "candles": candles })
    ).unwrap();

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

fn get_f64(val: &Value, key: &str, idx: usize) -> f64 {
    val.get(key)
        .and_then(|arr| arr.as_array())
        .and_then(|arr| arr.get(idx))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
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
        let mut dominant_direction = "neutral";

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
            dominant_direction = "bullish";
        } else if bear_weighted > bull_weighted && confirmation_count <= -2 {
            direction = "SHORT";
            alignment_score = bear_weighted;
            dominant_direction = "bearish";
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

        let close = ref_candles.last().unwrap().close;
        let atr = calc_atr(ref_candles, 14);

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

fn calc_atr(candles: &[Candle], period: usize) -> f64 {
    if candles.len() < period + 1 {
        return 0.0;
    }
    let start = candles.len() - period;
    let mut sum = 0.0;
    for i in start..candles.len() {
        let tr = (candles[i].high - candles[i].low)
            .max((candles[i].high - candles[i - 1].close).abs())
            .max((candles[i].low - candles[i - 1].close).abs());
        sum += tr;
    }
    sum / period as f64
}
