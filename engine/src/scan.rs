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
    atr: f64,
    momentum_score: f64,
    volume_ratio: f64,
}

#[derive(Serialize)]
struct VoteBreakdown {
    ema_crossover: f64,
    rsi: f64,
    macd: f64,
    supertrend: f64,
    bollinger: f64,
    vwap: f64,
    momentum: f64,
    volume: f64,
}

struct Thresholds {
    min_confidence: f64,
    rsi_oversold: f64,
    rsi_overbought: f64,
    rsi_strong_oversold: f64,
    rsi_strong_overbought: f64,
    momentum_candles: usize,
    volume_surge_ratio: f64,
}

fn get_thresholds(aggressiveness: &str) -> Thresholds {
    match aggressiveness {
        "high" => Thresholds {
            min_confidence: 0.30,
            rsi_oversold: 40.0,
            rsi_overbought: 60.0,
            rsi_strong_oversold: 35.0,
            rsi_strong_overbought: 65.0,
            momentum_candles: 2,
            volume_surge_ratio: 1.2,
        },
        "low" => Thresholds {
            min_confidence: 0.60,
            rsi_oversold: 25.0,
            rsi_overbought: 75.0,
            rsi_strong_oversold: 20.0,
            rsi_strong_overbought: 80.0,
            momentum_candles: 4,
            volume_surge_ratio: 1.8,
        },
        _ => Thresholds {
            min_confidence: 0.40,
            rsi_oversold: 30.0,
            rsi_overbought: 70.0,
            rsi_strong_oversold: 25.0,
            rsi_strong_overbought: 75.0,
            momentum_candles: 3,
            volume_surge_ratio: 1.5,
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
        let bb_mid = (bb_upper + bb_lower) / 2.0;
        let vwap = get_f64(&indicators, "vwap", last);

        if ema21 == 0.0 || supertrend == 0.0 || bb_upper == 0.0 {
            continue;
        }

        let atr = calc_atr_last(&sym_data.candles, 14);

        // ======= MOMENTUM DETECTION (NEW - catches rallies) =======
        let momentum_score = calc_momentum(&sym_data.candles, thresholds.momentum_candles);
        let volume_ratio = calc_volume_ratio(&sym_data.candles, 5);
        let breakout_score = calc_breakout(&sym_data.candles, 10);

        // --- Vote: EMA Trend (weight: 0.15) ---
        let ema_vote = if ema9 > ema21 && ema9_prev <= ema21_prev {
            1.0  // fresh bullish crossover
        } else if ema9 < ema21 && ema9_prev >= ema21_prev {
            -1.0 // fresh bearish crossover
        } else if ema9 > ema21 {
            // Trending up — reward based on how far EMA9 is above EMA21
            let spread = (ema9 - ema21) / ema21 * 100.0;
            (0.5 + (spread * 0.3).min(0.5)).min(1.0)
        } else if ema9 < ema21 {
            let spread = (ema21 - ema9) / ema21 * 100.0;
            -(0.5 + (spread * 0.3).min(0.5)).min(1.0)
        } else {
            0.0
        };

        // --- Vote: RSI Momentum (weight: 0.10) ---
        // FIXED: RSI 50-70 is BULLISH momentum, not neutral!
        // RSI > 70 means strong trend, not "overbought" in a trending market
        let rsi_vote = if rsi < thresholds.rsi_strong_oversold {
            1.0   // deeply oversold — strong buy
        } else if rsi < thresholds.rsi_oversold {
            0.7   // oversold — buy
        } else if rsi > 80.0 {
            -0.3  // extreme — slight caution but don't fight the trend
        } else if rsi > 60.0 {
            0.5   // bullish momentum zone (50-80)
        } else if rsi > 50.0 {
            0.3   // mild bullish
        } else if rsi > 40.0 {
            -0.3  // mild bearish
        } else {
            -0.5  // bearish momentum
        };

        // --- Vote: MACD (weight: 0.10) ---
        let macd_vote = if macd > macd_sig && macd_prev <= macd_sig_prev {
            1.0
        } else if macd < macd_sig && macd_prev >= macd_sig_prev {
            -1.0
        } else if macd_hist > 0.0 {
            // Reward increasing histogram (accelerating momentum)
            let prev_hist = get_f64(&indicators, "macd_histogram", prev);
            if macd_hist > prev_hist { 0.7 } else { 0.3 }
        } else if macd_hist < 0.0 {
            let prev_hist = get_f64(&indicators, "macd_histogram", prev);
            if macd_hist < prev_hist { -0.7 } else { -0.3 }
        } else {
            0.0
        };

        // --- Vote: Supertrend (weight: 0.10) ---
        let st_vote = if close > supertrend {
            0.8
        } else {
            -0.8
        };

        // --- Vote: Bollinger Position (weight: 0.05) ---
        let bb_range = bb_upper - bb_lower;
        let bb_vote = if bb_range > 0.0 {
            let position = (close - bb_lower) / bb_range;
            if position > 0.9 && momentum_score > 0.5 {
                0.6  // riding upper band with momentum = bullish breakout
            } else if position > 0.8 {
                0.3  // near upper band
            } else if position < 0.1 && momentum_score < -0.5 {
                -0.6 // riding lower band with negative momentum
            } else if position < 0.2 {
                -0.3
            } else if close > bb_mid {
                0.2  // above midline
            } else {
                -0.2 // below midline
            }
        } else {
            0.0
        };

        // --- Vote: VWAP (weight: 0.05) ---
        let vwap_pct = if vwap > 0.0 { (close - vwap) / vwap * 100.0 } else { 0.0 };
        let vwap_vote = if vwap_pct > 0.5 {
            0.6  // clearly above VWAP
        } else if vwap_pct > 0.0 {
            0.3
        } else if vwap_pct < -0.5 {
            -0.6
        } else {
            -0.3
        };

        // --- Vote: MOMENTUM (NEW - weight: 0.25) ---
        // Consecutive green/red candles, rate of price change
        let momentum_vote = momentum_score;

        // --- Vote: VOLUME (NEW - weight: 0.20) ---
        // Volume surge confirms moves
        let volume_vote = if volume_ratio > thresholds.volume_surge_ratio * 1.5 {
            // Massive volume surge
            if momentum_score > 0.0 { 1.0 } else { -1.0 }
        } else if volume_ratio > thresholds.volume_surge_ratio {
            // Notable volume increase
            if momentum_score > 0.0 { 0.7 } else { -0.7 }
        } else if volume_ratio > 1.0 {
            // Above average volume
            if momentum_score > 0.0 { 0.3 } else { -0.3 }
        } else {
            0.0 // below average volume — no conviction
        };

        // Weighted composite — momentum and volume are now dominant
        let composite: f64 = ema_vote * 0.15
            + rsi_vote * 0.10
            + macd_vote * 0.10
            + st_vote * 0.10
            + bb_vote * 0.05
            + vwap_vote * 0.05
            + momentum_vote * 0.25
            + volume_vote * 0.20;

        // Breakout bonus: add extra confidence for price breakouts
        let composite = composite + breakout_score * 0.10;

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
                atr: round2(atr),
                momentum_score: round3(momentum_score),
                volume_ratio: round2(volume_ratio),
            },
            votes: VoteBreakdown {
                ema_crossover: round3(ema_vote),
                rsi: round3(rsi_vote),
                macd: round3(macd_vote),
                supertrend: round3(st_vote),
                bollinger: round3(bb_vote),
                vwap: round3(vwap_vote),
                momentum: round3(momentum_vote),
                volume: round3(volume_vote),
            },
        });
    }

    out_signals.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap());

    let output = ScanOutput { signals: out_signals };
    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

/// Momentum score based on consecutive candle direction and rate of change
fn calc_momentum(candles: &[Candle], lookback: usize) -> f64 {
    let n = candles.len();
    if n < lookback + 1 {
        return 0.0;
    }

    let start = n - lookback;
    let mut green_count = 0i32;
    let mut total_change = 0.0;
    let avg_close = candles[start..n].iter().map(|c| c.close).sum::<f64>() / lookback as f64;

    for i in start..n {
        let prev_idx = if i > 0 { i - 1 } else { 0 };
        let is_green = candles[i].close > candles[prev_idx].close;

        if is_green {
            green_count += 1;
        } else {
            green_count -= 1;
        }

        if avg_close > 0.0 {
            let pct_change = (candles[i].close - candles[prev_idx].close) / avg_close * 100.0;
            total_change += pct_change;
        }
    }

    // Score: combination of direction consistency and magnitude
    let direction_score = green_count as f64 / lookback as f64;  // -1.0 to +1.0
    let magnitude_score = (total_change / lookback as f64).min(2.0).max(-2.0) / 2.0;  // normalized

    // Combined: both direction and magnitude matter
    let raw = direction_score * 0.6 + magnitude_score * 0.4;
    raw.min(1.0).max(-1.0)
}

/// Volume ratio: current volume vs average of last N candles
fn calc_volume_ratio(candles: &[Candle], lookback: usize) -> f64 {
    let n = candles.len();
    if n < lookback + 1 {
        return 1.0;
    }

    let current_vol = candles[n - 1].volume;
    let avg_vol: f64 = candles[n - 1 - lookback..n - 1]
        .iter()
        .map(|c| c.volume)
        .sum::<f64>() / lookback as f64;

    if avg_vol > 0.0 {
        current_vol / avg_vol
    } else {
        1.0
    }
}

/// Breakout detection: is price making new highs/lows over recent period?
fn calc_breakout(candles: &[Candle], lookback: usize) -> f64 {
    let n = candles.len();
    if n < lookback + 1 {
        return 0.0;
    }

    let current_close = candles[n - 1].close;
    let current_high = candles[n - 1].high;
    let current_low = candles[n - 1].low;

    let period = &candles[n - 1 - lookback..n - 1];
    let period_high = period.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    let period_low = period.iter().map(|c| c.low).fold(f64::INFINITY, f64::min);

    if current_high > period_high {
        // Breakout above recent high
        let strength = (current_close - period_high) / period_high * 100.0;
        (strength * 2.0).min(1.0)
    } else if current_low < period_low {
        // Breakdown below recent low
        let strength = (period_low - current_close) / period_low * 100.0;
        -(strength * 2.0).min(1.0)
    } else {
        0.0
    }
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
