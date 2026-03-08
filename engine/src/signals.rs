use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::utils::{Candle, calc_ema_series as calc_ema, calc_rsi_series as calc_rsi, calc_atr_series as calc_atr};

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
    let input: SignalInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid signal input: {}", e))?;

    let closes: Vec<f64> = input.candles.iter().map(|c| c.close).collect();
    let highs: Vec<f64> = input.candles.iter().map(|c| c.high).collect();
    let lows: Vec<f64> = input.candles.iter().map(|c| c.low).collect();
    let volumes: Vec<f64> = input.candles.iter().map(|c| c.volume).collect();

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
        vwap: calc_vwap(&highs, &lows, &closes, &volumes),
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
fn calc_vwap(highs: &[f64], lows: &[f64], closes: &[f64], volumes: &[f64]) -> Vec<f64> {
    let mut result = vec![0.0; closes.len()];
    let mut cum_vol = 0.0;
    let mut cum_pv = 0.0;
    for i in 0..closes.len() {
        let typical = (highs[i] + lows[i] + closes[i]) / 3.0;
        cum_pv += typical * volumes[i];
        cum_vol += volumes[i];
        result[i] = if cum_vol > 0.0 { cum_pv / cum_vol } else { closes[i] };
    }
    result
}

fn calc_supertrend(highs: &[f64], lows: &[f64], closes: &[f64], period: usize, multiplier: f64) -> Vec<f64> {
    let n = closes.len();
    let mut result = vec![0.0; n];
    if n < period { return result; }

    let atr = calc_atr(highs, lows, closes, period);

    for i in period..n {
        let hl2 = (highs[i] + lows[i]) / 2.0;
        let upper = hl2 + multiplier * atr[i];
        let lower = hl2 - multiplier * atr[i];
        result[i] = if closes[i] > upper { lower } else if closes[i] < lower { upper } else { result[i - 1] };
        if result[i] == 0.0 { result[i] = lower; }
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

    #[test]
    fn test_vwap_typical_price_with_equal_volume() {
        let highs = vec![101.0, 103.0, 102.0, 104.0, 105.0];
        let lows = vec![99.0, 101.0, 100.0, 102.0, 103.0];
        let closes = vec![100.0, 102.0, 101.0, 103.0, 104.0];
        let volumes = vec![1000.0; 5];
        let vwap = calc_vwap(&highs, &lows, &closes, &volumes);
        let tp: Vec<f64> = (0..5).map(|i| (highs[i] + lows[i] + closes[i]) / 3.0).collect();
        let expected_last = tp.iter().sum::<f64>() / 5.0;
        assert!((vwap[4] - expected_last).abs() < 0.01, "VWAP should use typical price (H+L+C)/3");
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
