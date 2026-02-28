use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
struct SignalInput {
    candles: Vec<Candle>,
}

#[derive(Deserialize)]
struct Candle {
    close: f64,
    high: f64,
    low: f64,
    volume: f64,
}

#[derive(Serialize)]
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

    let output = SignalOutput {
        ema_9: calc_ema(&closes, 9),
        ema_21: calc_ema(&closes, 21),
        rsi_14: calc_rsi(&closes, 14),
        macd: calc_macd(&closes).0,
        macd_signal: calc_macd(&closes).1,
        macd_histogram: calc_macd(&closes).2,
        bollinger_upper: calc_bollinger(&closes, 20).0,
        bollinger_lower: calc_bollinger(&closes, 20).1,
        bollinger_middle: calc_bollinger(&closes, 20).2,
        vwap: calc_vwap(&closes, &volumes),
        supertrend: calc_supertrend(&highs, &lows, &closes, 10, 3.0),
    };

    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

fn calc_ema(data: &[f64], period: usize) -> Vec<f64> {
    if data.len() < period { return vec![0.0; data.len()]; }
    let mut result = vec![0.0; data.len()];
    let mult = 2.0 / (period as f64 + 1.0);
    result[period - 1] = data[..period].iter().sum::<f64>() / period as f64;
    for i in period..data.len() {
        result[i] = (data[i] - result[i - 1]) * mult + result[i - 1];
    }
    result
}

fn calc_rsi(data: &[f64], period: usize) -> Vec<f64> {
    if data.len() < period + 1 { return vec![50.0; data.len()]; }
    let mut result = vec![50.0; data.len()];
    let mut avg_gain = 0.0;
    let mut avg_loss = 0.0;

    for i in 1..=period {
        let diff = data[i] - data[i - 1];
        if diff > 0.0 { avg_gain += diff; } else { avg_loss -= diff; }
    }
    avg_gain /= period as f64;
    avg_loss /= period as f64;

    if avg_loss == 0.0 { result[period] = 100.0; }
    else { result[period] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss); }

    for i in period + 1..data.len() {
        let diff = data[i] - data[i - 1];
        let (gain, loss) = if diff > 0.0 { (diff, 0.0) } else { (0.0, -diff) };
        avg_gain = (avg_gain * (period as f64 - 1.0) + gain) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + loss) / period as f64;
        if avg_loss == 0.0 { result[i] = 100.0; }
        else { result[i] = 100.0 - 100.0 / (1.0 + avg_gain / avg_loss); }
    }
    result
}

fn calc_macd(data: &[f64]) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let ema12 = calc_ema(data, 12);
    let ema26 = calc_ema(data, 26);
    let mut macd_line = vec![0.0; data.len()];
    for i in 0..data.len() {
        macd_line[i] = ema12[i] - ema26[i];
    }
    let signal = calc_ema(&macd_line, 9);
    let mut histogram = vec![0.0; data.len()];
    for i in 0..data.len() {
        histogram[i] = macd_line[i] - signal[i];
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

fn calc_vwap(closes: &[f64], volumes: &[f64]) -> Vec<f64> {
    let mut result = vec![0.0; closes.len()];
    let mut cum_vol = 0.0;
    let mut cum_pv = 0.0;
    for i in 0..closes.len() {
        cum_pv += closes[i] * volumes[i];
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

fn calc_atr(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> Vec<f64> {
    let n = closes.len();
    let mut tr = vec![0.0; n];
    let mut atr = vec![0.0; n];

    tr[0] = highs[0] - lows[0];
    for i in 1..n {
        tr[i] = (highs[i] - lows[i])
            .max((highs[i] - closes[i - 1]).abs())
            .max((lows[i] - closes[i - 1]).abs());
    }

    if n >= period {
        atr[period - 1] = tr[..period].iter().sum::<f64>() / period as f64;
        for i in period..n {
            atr[i] = (atr[i - 1] * (period as f64 - 1.0) + tr[i]) / period as f64;
        }
    }
    atr
}
