use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::utils::{Candle, calc_ema_series as calc_ema, calc_rsi_series as calc_rsi, calc_atr_series as calc_atr, sanitize_candles};

#[derive(Deserialize)]
struct SignalInput {
    candles: Vec<Candle>,
}

#[derive(Serialize, Deserialize)]
struct SignalOutput {
    ema_9: Vec<f64>,
    ema_21: Vec<f64>,
    rsi_14: Vec<f64>,
    macd: Vec<f64>,
    macd_signal: Vec<f64>,
    macd_histogram: Vec<f64>,
    bollinger_upper: Vec<f64>,
    bollinger_lower: Vec<f64>,
    bollinger_middle: Vec<f64>,
    vwap: Vec<f64>,
    supertrend: Vec<f64>,
}

pub fn compute(data: Value) -> Result<Value, String> {
    let mut input: SignalInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid signal input: {}", e))?;

    sanitize_candles(&mut input.candles);

    let closes: Vec<f64> = input.candles.iter().map(|c| c.close).collect();
    let highs: Vec<f64> = input.candles.iter().map(|c| c.high).collect();
    let lows: Vec<f64> = input.candles.iter().map(|c| c.low).collect();

    let macd_result = calc_macd(&closes);
    let bb_result = calc_bollinger(&closes, 20);
    let output = SignalOutput {
        ema_9: nan_to_zero(&calc_ema(&closes, 9)),
        ema_21: nan_to_zero(&calc_ema(&closes, 21)),
        rsi_14: calc_rsi(&closes, 14),
        macd: nan_to_zero(&macd_result.0),
        macd_signal: nan_to_zero(&macd_result.1),
        macd_histogram: nan_to_zero(&macd_result.2),
        bollinger_upper: bb_result.0,
        bollinger_lower: bb_result.1,
        bollinger_middle: bb_result.2,
        vwap: calc_vwap(&input.candles),
        supertrend: calc_supertrend(&highs, &lows, &closes, 10, 3.0),
    };

    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

/// Replace NaN with 0.0 for JSON serialization (NaN is not valid JSON)
fn nan_to_zero(data: &[f64]) -> Vec<f64> {
    data.iter().map(|&v| if v.is_nan() { 0.0 } else { v }).collect()
}

fn calc_macd(data: &[f64]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let ema12 = calc_ema(data, 12);
    let ema26 = calc_ema(data, 26);
    let mut macd_line = vec![f64::NAN; data.len()];
    for i in 0..data.len() {
        let a = ema12[i];
        let b = ema26[i];
        macd_line[i] = if a.is_nan() || b.is_nan() { f64::NAN } else { a - b };
    }
    let clean_macd: Vec<f64> = macd_line.iter().map(|&v| if v.is_nan() { 0.0 } else { v }).collect();
    let signal = calc_ema(&clean_macd, 9);
    let mut histogram = vec![f64::NAN; data.len()];
    for i in 0..data.len() {
        let m = macd_line[i];
        let s = signal[i];
        histogram[i] = if m.is_nan() || s.is_nan() { f64::NAN } else { m - s };
    }
    (macd_line, signal, histogram)
}

fn calc_bollinger(data: &[f64], period: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let mut upper = vec![0.0; data.len()];
    let mut lower = vec![0.0; data.len()];
    let mut middle = vec![0.0; data.len()];

    for i in period - 1..data.len() {
        let window = &data[i + 1 - period..=i];
        let mean = window.iter().sum::<f64>() / period as f64;
        let variance = window.iter().map(|x| (x - mean).powi(2)).sum::<f64>() / period as f64;
        let std_dev = variance.sqrt();
        middle[i] = mean;
        upper[i] = mean + 2.0 * std_dev;
        lower[i] = mean - 2.0 * std_dev;
    }
    (upper, lower, middle)
}

/// VWAP using typical price = (high + low + close) / 3
/// Session-anchored VWAP.
///
/// VWAP is only meaningful relative to a session open. The previous version
/// accumulated price*volume from the first bar of the series and never reset,
/// so on a multi-day window it drifted into a slow average of the whole
/// history — in a rising series price sat permanently above it and the VWAP
/// vote was pinned at maximum bullish, a constant bias rather than a signal.
///
/// The session key is the date prefix of the candle timestamp. If timestamps
/// are absent (all empty) the key never changes and this degrades to the old
/// cumulative behaviour rather than failing.
fn calc_vwap(candles: &[Candle]) -> Vec<f64> {
    let mut result = vec![0.0; candles.len()];
    let mut cum_vol = 0.0;
    let mut cum_pv = 0.0;
    let mut session: Option<&str> = None;

    for (i, c) in candles.iter().enumerate() {
        // str::get, not [..10]: byte-slicing a String panics on a non-ASCII timestamp.
        let key = c.timestamp.get(..10).unwrap_or("");
        if session != Some(key) {
            session = Some(key);
            cum_vol = 0.0;
            cum_pv = 0.0;
        }

        let typical = (c.high + c.low + c.close) / 3.0;
        cum_pv += typical * c.volume;
        cum_vol += c.volume;
        result[i] = if cum_vol > 0.0 { cum_pv / cum_vol } else { c.close };
    }
    result
}

/// SuperTrend with ratcheted final bands and a persistent trend state.
///
/// The previous implementation compared the close against the *basic* bands of
/// the same bar: `close > hl2 + 3*ATR`. Because `close <= high`, that needs a bar
/// whose range exceeds roughly six times its own ATR, which essentially never
/// happens — so the flip never fired and the series stayed pinned at its first
/// value. Verified on 300 synthetic bars spanning a full up-then-down trend:
/// one distinct value, zero band crossings.
///
/// This is the standard algorithm, matching `strategy.rs::SuperTrend`:
/// the upper band may only ratchet down and the lower band only up while the
/// trend holds, and the trend flips only when the close breaches the active
/// final band.
fn calc_supertrend(highs: &[f64], lows: &[f64], closes: &[f64], period: usize, multiplier: f64) -> Vec<f64> {
    let n = closes.len();
    let mut result = vec![0.0; n];
    if n < period || period == 0 { return result; }

    let atr = calc_atr(highs, lows, closes, period);

    let mut final_upper = 0.0_f64;
    let mut final_lower = 0.0_f64;
    let mut in_uptrend: Option<bool> = None;

    for i in period..n {
        let a = atr[i];
        if !a.is_finite() || a <= 0.0 {
            result[i] = if i > 0 { result[i - 1] } else { 0.0 };
            continue;
        }

        let hl2 = (highs[i] + lows[i]) / 2.0;
        let basic_upper = hl2 + multiplier * a;
        let basic_lower = hl2 - multiplier * a;

        let prev_upper = final_upper;
        let prev_lower = final_lower;
        let prev_close = closes[i - 1];

        final_lower = if basic_lower > prev_lower || prev_close < prev_lower {
            basic_lower
        } else {
            basic_lower.max(prev_lower)
        };

        final_upper = if basic_upper < prev_upper || prev_close > prev_upper {
            basic_upper
        } else {
            basic_upper.min(prev_upper)
        };

        let now_uptrend = match in_uptrend {
            Some(true) => closes[i] >= final_lower,
            Some(false) => closes[i] > final_upper,
            None => closes[i] > final_upper,
        };
        in_uptrend = Some(now_uptrend);

        result[i] = if now_uptrend { final_lower } else { final_upper };
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_candles(closes: &[f64]) -> Vec<serde_json::Value> {
        closes.iter().map(|&c| json!({
            "close": c, "high": c * 1.01, "low": c * 0.99, "volume": 10000.0
        })).collect()
    }

    fn compute_signals(closes: &[f64]) -> SignalOutput {
        let candles = make_candles(closes);
        let result = compute(json!({ "candles": candles })).unwrap();
        serde_json::from_value(result).unwrap()
    }

    #[test]
    fn test_ema_convergence_to_constant() {
        let data = vec![100.0; 30];
        let ema9 = calc_ema(&data, 9);
        assert!((ema9[29] - 100.0).abs() < 0.01, "EMA of constant series should equal the constant");
    }

    #[test]
    fn test_ema_weights_recent_more() {
        let mut data = vec![100.0; 20];
        data.push(110.0);
        let ema9 = calc_ema(&data, 9);
        let ema21 = calc_ema(&data, 21);
        assert!(ema9[20] > ema21[20], "shorter EMA should react faster to price jump");
    }

    #[test]
    fn test_rsi_overbought_on_rising() {
        let data: Vec<f64> = (0..30).map(|i| 100.0 + i as f64 * 2.0).collect();
        let rsi = calc_rsi(&data, 14);
        assert!(rsi[29] > 90.0, "RSI should be overbought (>90) on steadily rising prices, got {}", rsi[29]);
    }

    #[test]
    fn test_rsi_oversold_on_falling() {
        let data: Vec<f64> = (0..30).map(|i| 200.0 - i as f64 * 2.0).collect();
        let rsi = calc_rsi(&data, 14);
        assert!(rsi[29] < 10.0, "RSI should be oversold (<10) on steadily falling prices, got {}", rsi[29]);
    }

    #[test]
    fn test_rsi_midpoint_on_flat() {
        let data = vec![100.0; 30];
        let rsi = calc_rsi(&data, 14);
        assert!((rsi[29] - 50.0).abs() < 1.0 || rsi[29] == 100.0,
            "RSI of flat series should be ~50 or 100 (no losses), got {}", rsi[29]);
    }

    #[test]
    fn test_macd_zero_on_flat() {
        let data = vec![100.0; 60];
        let (macd, signal, hist) = calc_macd(&data);
        let last = data.len() - 1;
        assert!((macd[last]).abs() < 0.1, "MACD should be ~0 on flat series, got {}", macd[last]);
        assert!((signal[last]).abs() < 0.1, "MACD signal should be ~0 on flat series, got {}", signal[last]);
        assert!((hist[last]).abs() < 0.1, "MACD histogram should be ~0 on flat series, got {}", hist[last]);
    }

    #[test]
    fn test_bollinger_contains_data() {
        let data: Vec<f64> = (0..30).map(|i| 100.0 + (i as f64 * 0.1).sin() * 5.0).collect();
        let (upper, lower, middle) = calc_bollinger(&data, 20);
        for i in 19..30 {
            assert!(upper[i] > middle[i], "upper band should be above middle at {}", i);
            assert!(lower[i] < middle[i], "lower band should be below middle at {}", i);
            assert!(upper[i] > lower[i], "upper should be above lower at {}", i);
        }
    }

    fn bar(ts: &str, h: f64, l: f64, c: f64, v: f64) -> Candle {
        Candle { timestamp: ts.to_string(), open: c, high: h, low: l, close: c, volume: v }
    }

    #[test]
    fn test_vwap_typical_price_with_equal_volume() {
        let day = "2026-01-02";
        let candles = vec![
            bar(day, 101.0, 99.0, 100.0, 1000.0),
            bar(day, 103.0, 101.0, 102.0, 1000.0),
            bar(day, 102.0, 100.0, 101.0, 1000.0),
            bar(day, 104.0, 102.0, 103.0, 1000.0),
            bar(day, 105.0, 103.0, 104.0, 1000.0),
        ];
        let vwap = calc_vwap(&candles);
        let expected: f64 = candles.iter().map(|c| (c.high + c.low + c.close) / 3.0).sum::<f64>() / 5.0;
        assert!((vwap[4] - expected).abs() < 0.01, "VWAP should use typical price (H+L+C)/3");
    }

    #[test]
    fn test_vwap_resets_on_new_session() {
        // Two identical sessions. If VWAP is session-anchored, the last bar of
        // each day must produce the same value; if it accumulates across days
        // the second day is dragged toward the first and they differ.
        let candles = vec![
            bar("2026-01-02", 101.0, 99.0, 100.0, 1000.0),
            bar("2026-01-02", 103.0, 101.0, 102.0, 1000.0),
            bar("2026-01-05", 101.0, 99.0, 100.0, 1000.0),
            bar("2026-01-05", 103.0, 101.0, 102.0, 1000.0),
        ];
        let vwap = calc_vwap(&candles);
        assert!((vwap[1] - vwap[3]).abs() < 1e-9,
            "VWAP must reset at the session boundary (day1 end {} vs day2 end {})", vwap[1], vwap[3]);
    }

    #[test]
    fn test_vwap_without_timestamps_stays_cumulative() {
        let candles = vec![
            bar("", 101.0, 99.0, 100.0, 1000.0),
            bar("", 103.0, 101.0, 102.0, 1000.0),
        ];
        let vwap = calc_vwap(&candles);
        assert!(vwap[1] > 0.0, "missing timestamps must degrade gracefully, not panic");
    }

    #[test]
    fn test_supertrend_is_not_constant_over_a_trend() {
        // Regression: the old implementation compared close against the BASIC
        // bands of the same bar, which needs a range of ~6x ATR to fire. It
        // never fired, so the series was a flat line.
        let mut highs = vec![]; let mut lows = vec![]; let mut closes = vec![];
        let mut px = 100.0_f64;
        for i in 0..120 {
            px += if i < 60 { 1.0 } else { -1.0 };
            highs.push(px + 1.0);
            lows.push(px - 1.0);
            closes.push(px);
        }
        let st = calc_supertrend(&highs, &lows, &closes, 10, 3.0);
        let tail = &st[20..];
        let distinct = tail.iter().map(|v| format!("{:.4}", v)).collect::<std::collections::HashSet<_>>().len();
        assert!(distinct > 5, "SuperTrend must track price, got {} distinct values", distinct);
    }

    #[test]
    fn test_supertrend_flips_side_when_trend_reverses() {
        let mut highs = vec![]; let mut lows = vec![]; let mut closes = vec![];
        let mut px = 100.0_f64;
        for i in 0..160 {
            px += if i < 80 { 1.0 } else { -1.0 };
            highs.push(px + 1.0);
            lows.push(px - 1.0);
            closes.push(px);
        }
        let st = calc_supertrend(&highs, &lows, &closes, 10, 3.0);
        // In the rally the band sits BELOW price; after the reversal, ABOVE it.
        assert!(st[70] < closes[70], "during an uptrend the band should trail below price");
        assert!(st[150] > closes[150], "after the reversal the band should sit above price");
    }

    #[test]
    fn test_output_lengths_match_input() {
        let closes: Vec<f64> = (0..50).map(|i| 100.0 + i as f64).collect();
        let s = compute_signals(&closes);
        assert_eq!(s.ema_9.len(), 50);
        assert_eq!(s.ema_21.len(), 50);
        assert_eq!(s.rsi_14.len(), 50);
        assert_eq!(s.macd.len(), 50);
        assert_eq!(s.bollinger_upper.len(), 50);
        assert_eq!(s.vwap.len(), 50);
        assert_eq!(s.supertrend.len(), 50);
    }

    #[test]
    fn test_insufficient_data_returns_nan() {
        let data = vec![100.0; 5];
        let ema = calc_ema(&data, 9);
        assert_eq!(ema.len(), 5);
        assert!(ema.iter().all(|v| v.is_nan()),
            "EMA with insufficient data should be NaN");
    }
}
