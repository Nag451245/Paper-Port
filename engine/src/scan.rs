use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::signals;

#[derive(Deserialize)]
struct ScanInput {
    symbols: Vec<SymbolData>,
    #[serde(default = "default_aggressiveness")]
    aggressiveness: String,
}

#[derive(Deserialize)]
struct SymbolData {
    symbol: String,
    candles: Vec<Candle>,
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
struct ScanOutput {
    signals: Vec<ScanSignal>,
}

#[derive(Serialize)]
struct ScanSignal {
    symbol: String,
    direction: String,
    confidence: f64,
    entry: f64,
    stop_loss: f64,
    target: f64,
    indicators: IndicatorSnapshot,
    votes: VoteBreakdown,
}

#[derive(Serialize)]
struct IndicatorSnapshot {
    ema_9: f64,
    ema_21: f64,
    rsi_14: f64,
    macd: f64,
    macd_signal: f64,
    macd_histogram: f64,
    supertrend: f64,
    bollinger_upper: f64,
    bollinger_lower: f64,
    vwap: f64,
    close: f64,
}

#[derive(Serialize)]
struct VoteBreakdown {
    ema_crossover: f64,
    rsi: f64,
    macd: f64,
    supertrend: f64,
    bollinger: f64,
    vwap: f64,
}

struct Thresholds {
    min_confidence: f64,
    rsi_oversold: f64,
    rsi_overbought: f64,
    rsi_strong_oversold: f64,
    rsi_strong_overbought: f64,
}

fn get_thresholds(aggressiveness: &str) -> Thresholds {
    match aggressiveness {
        "high" => Thresholds {
            min_confidence: 0.45,
            rsi_oversold: 40.0,
            rsi_overbought: 60.0,
            rsi_strong_oversold: 35.0,
            rsi_strong_overbought: 65.0,
        },
        "low" => Thresholds {
            min_confidence: 0.75,
            rsi_oversold: 25.0,
            rsi_overbought: 75.0,
            rsi_strong_oversold: 20.0,
            rsi_strong_overbought: 80.0,
        },
        _ => Thresholds {
            min_confidence: 0.60,
            rsi_oversold: 30.0,
            rsi_overbought: 70.0,
            rsi_strong_oversold: 25.0,
            rsi_strong_overbought: 75.0,
        },
    }
}

pub fn compute(data: Value) -> Result<Value, String> {
    let input: ScanInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid scan input: {}", e))?;

    let thresholds = get_thresholds(&input.aggressiveness);
    let mut out_signals = Vec::new();

    for sym_data in &input.symbols {
        if sym_data.candles.len() < 26 {
            continue;
        }

        let candles_json = serde_json::to_value(
            &serde_json::json!({ "candles": sym_data.candles })
        ).unwrap();
        let indicators = match signals::compute(candles_json) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let n = sym_data.candles.len();
        let last = n - 1;
        let prev = n - 2;

        let close = sym_data.candles[last].close;

        let ema9 = get_f64(&indicators, "ema_9", last);
        let ema21 = get_f64(&indicators, "ema_21", last);
        let ema9_prev = get_f64(&indicators, "ema_9", prev);
        let ema21_prev = get_f64(&indicators, "ema_21", prev);
        let rsi = get_f64(&indicators, "rsi_14", last);
        let macd = get_f64(&indicators, "macd", last);
        let macd_sig = get_f64(&indicators, "macd_signal", last);
        let macd_prev = get_f64(&indicators, "macd", prev);
        let macd_sig_prev = get_f64(&indicators, "macd_signal", prev);
        let macd_hist = get_f64(&indicators, "macd_histogram", last);
        let supertrend = get_f64(&indicators, "supertrend", last);
        let bb_upper = get_f64(&indicators, "bollinger_upper", last);
        let bb_lower = get_f64(&indicators, "bollinger_lower", last);
        let vwap = get_f64(&indicators, "vwap", last);

        if ema21 == 0.0 || supertrend == 0.0 || bb_upper == 0.0 {
            continue;
        }

        // --- Vote: EMA Crossover (weight: 0.25) ---
        let ema_vote = if ema9 > ema21 && ema9_prev <= ema21_prev {
            1.0  // bullish crossover just happened
        } else if ema9 < ema21 && ema9_prev >= ema21_prev {
            -1.0 // bearish crossover just happened
        } else if ema9 > ema21 {
            0.5  // bullish trend
        } else if ema9 < ema21 {
            -0.5 // bearish trend
        } else {
            0.0
        };

        // --- Vote: RSI (weight: 0.20) ---
        let rsi_vote = if rsi < thresholds.rsi_strong_oversold {
            1.0
        } else if rsi < thresholds.rsi_oversold {
            0.7
        } else if rsi > thresholds.rsi_strong_overbought {
            -1.0
        } else if rsi > thresholds.rsi_overbought {
            -0.7
        } else {
            0.0
        };

        // --- Vote: MACD (weight: 0.20) ---
        let macd_vote = if macd > macd_sig && macd_prev <= macd_sig_prev {
            1.0  // bullish cross
        } else if macd < macd_sig && macd_prev >= macd_sig_prev {
            -1.0 // bearish cross
        } else if macd_hist > 0.0 {
            0.3
        } else if macd_hist < 0.0 {
            -0.3
        } else {
            0.0
        };

        // --- Vote: Supertrend (weight: 0.20) ---
        let st_vote = if close > supertrend {
            0.7
        } else {
            -0.7
        };

        // --- Vote: Bollinger (weight: 0.10) ---
        let bb_vote = if close <= bb_lower && rsi < thresholds.rsi_oversold + 5.0 {
            0.8
        } else if close >= bb_upper && rsi > thresholds.rsi_overbought - 5.0 {
            -0.8
        } else {
            0.0
        };

        // --- Vote: VWAP (weight: 0.05) ---
        let vwap_vote = if close > vwap {
            0.3
        } else {
            -0.3
        };

        let composite: f64 = ema_vote * 0.25
            + rsi_vote * 0.20
            + macd_vote * 0.20
            + st_vote * 0.20
            + bb_vote * 0.10
            + vwap_vote * 0.05;

        let (direction, confidence) = if composite > 0.0 {
            ("BUY".to_string(), composite.min(1.0))
        } else if composite < 0.0 {
            ("SELL".to_string(), composite.abs().min(1.0))
        } else {
            continue;
        };

        if confidence < thresholds.min_confidence {
            continue;
        }

        let atr = calc_atr_last(&sym_data.candles, 14);
        let (stop_loss, target) = if direction == "BUY" {
            (close - 1.5 * atr, close + 2.5 * atr)
        } else {
            (close + 1.5 * atr, close - 2.5 * atr)
        };

        out_signals.push(ScanSignal {
            symbol: sym_data.symbol.clone(),
            direction,
            confidence: round3(confidence),
            entry: round2(close),
            stop_loss: round2(stop_loss),
            target: round2(target),
            indicators: IndicatorSnapshot {
                ema_9: round2(ema9),
                ema_21: round2(ema21),
                rsi_14: round2(rsi),
                macd: round4(macd),
                macd_signal: round4(macd_sig),
                macd_histogram: round4(macd_hist),
                supertrend: round2(supertrend),
                bollinger_upper: round2(bb_upper),
                bollinger_lower: round2(bb_lower),
                vwap: round2(vwap),
                close: round2(close),
            },
            votes: VoteBreakdown {
                ema_crossover: round3(ema_vote),
                rsi: round3(rsi_vote),
                macd: round3(macd_vote),
                supertrend: round3(st_vote),
                bollinger: round3(bb_vote),
                vwap: round3(vwap_vote),
            },
        });
    }

    out_signals.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());

    let output = ScanOutput { signals: out_signals };
    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

fn get_f64(indicators: &Value, key: &str, idx: usize) -> f64 {
    indicators
        .get(key)
        .and_then(|arr| arr.get(idx))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}

fn calc_atr_last(candles: &[Candle], period: usize) -> f64 {
    let n = candles.len();
    if n < period + 1 {
        return candles.last().map(|c| c.high - c.low).unwrap_or(1.0);
    }

    let mut atr = 0.0;
    let start = n - period;
    for i in start..n {
        let tr = if i == 0 {
            candles[i].high - candles[i].low
        } else {
            (candles[i].high - candles[i].low)
                .max((candles[i].high - candles[i - 1].close).abs())
                .max((candles[i].low - candles[i - 1].close).abs())
        };
        atr += tr;
    }
    atr / period as f64
}

fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
fn round3(v: f64) -> f64 { (v * 1000.0).round() / 1000.0 }
fn round4(v: f64) -> f64 { (v * 10000.0).round() / 10000.0 }
