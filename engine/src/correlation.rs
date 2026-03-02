use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Config {
    pairs: Vec<PairData>,
    lookback: Option<usize>,
    zscore_threshold: Option<f64>,
}

#[derive(Deserialize)]
struct PairData {
    symbol_a: String,
    symbol_b: String,
    prices_a: Vec<f64>,
    prices_b: Vec<f64>,
}

#[derive(Serialize)]
struct CorrelationResult {
    pairs: Vec<PairAnalysis>,
    best_pairs: Vec<String>,
}

#[derive(Serialize)]
struct PairAnalysis {
    symbol_a: String,
    symbol_b: String,
    correlation: f64,
    cointegration_score: f64,
    half_life: f64,
    current_zscore: f64,
    spread_mean: f64,
    spread_std: f64,
    signal: String,
    hedge_ratio: f64,
    hurst_exponent: f64,
    is_mean_reverting: bool,
}

pub fn compute(data: serde_json::Value) -> Result<serde_json::Value, String> {
    let config: Config = serde_json::from_value(data).map_err(|e| format!("Invalid input: {}", e))?;

    if config.pairs.is_empty() { return Err("At least one pair required".into()); }

    let lookback = config.lookback.unwrap_or(60);
    let z_thresh = config.zscore_threshold.unwrap_or(2.0);

    let mut results: Vec<PairAnalysis> = Vec::new();

    for pair in &config.pairs {
        let n = pair.prices_a.len().min(pair.prices_b.len());
        if n < 20 { continue; }

        let a = &pair.prices_a[..n];
        let b = &pair.prices_b[..n];

        let log_a: Vec<f64> = a.iter().map(|p| p.ln()).collect();
        let log_b: Vec<f64> = b.iter().map(|p| p.ln()).collect();

        let corr = pearson_correlation(a, b);

        let hedge = ols_slope(&log_b, &log_a);
        let spread: Vec<f64> = (0..n).map(|i| log_a[i] - hedge * log_b[i]).collect();

        let spread_mean = spread.iter().sum::<f64>() / n as f64;
        let spread_var = spread.iter().map(|s| (s - spread_mean).powi(2)).sum::<f64>() / n as f64;
        let spread_std = spread_var.sqrt();

        let lb = lookback.min(n);
        let recent = &spread[n - lb..];
        let recent_mean = recent.iter().sum::<f64>() / lb as f64;
        let recent_var = recent.iter().map(|s| (s - recent_mean).powi(2)).sum::<f64>() / lb as f64;
        let recent_std = recent_var.sqrt();
        let current_z = if recent_std > 0.0 { (spread[n - 1] - recent_mean) / recent_std } else { 0.0 };

        let half_life = compute_half_life(&spread);
        let hurst = compute_hurst(&spread);
        let coint_score = adf_score(&spread);
        let is_mr = hurst < 0.5 && coint_score.abs() > 2.0;

        let signal = if !is_mr {
            "NO_TRADE"
        } else if current_z > z_thresh {
            "SHORT_A_LONG_B"
        } else if current_z < -z_thresh {
            "LONG_A_SHORT_B"
        } else {
            "NEUTRAL"
        };

        results.push(PairAnalysis {
            symbol_a: pair.symbol_a.clone(),
            symbol_b: pair.symbol_b.clone(),
            correlation: round4(corr),
            cointegration_score: round4(coint_score),
            half_life: round2(half_life),
            current_zscore: round4(current_z),
            spread_mean: round4(spread_mean),
            spread_std: round4(spread_std),
            signal: signal.to_string(),
            hedge_ratio: round4(hedge),
            hurst_exponent: round4(hurst),
            is_mean_reverting: is_mr,
        });
    }

    let mut best: Vec<String> = results.iter()
        .filter(|r| r.is_mean_reverting)
        .map(|r| format!("{}/{}", r.symbol_a, r.symbol_b))
        .collect();
    best.sort();

    let out = CorrelationResult { pairs: results, best_pairs: best };
    serde_json::to_value(out).map_err(|e| e.to_string())
}

fn pearson_correlation(a: &[f64], b: &[f64]) -> f64 {
    let n = a.len() as f64;
    let mean_a = a.iter().sum::<f64>() / n;
    let mean_b = b.iter().sum::<f64>() / n;
    let mut num = 0.0;
    let mut da = 0.0;
    let mut db = 0.0;
    for i in 0..a.len() {
        let xa = a[i] - mean_a;
        let xb = b[i] - mean_b;
        num += xa * xb;
        da += xa * xa;
        db += xb * xb;
    }
    let denom = (da * db).sqrt();
    if denom > 0.0 { num / denom } else { 0.0 }
}

fn ols_slope(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len() as f64;
    let mx = x.iter().sum::<f64>() / n;
    let my = y.iter().sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for i in 0..x.len() {
        num += (x[i] - mx) * (y[i] - my);
        den += (x[i] - mx).powi(2);
    }
    if den > 0.0 { num / den } else { 1.0 }
}

fn compute_half_life(spread: &[f64]) -> f64 {
    if spread.len() < 3 { return 999.0; }
    let mut y = Vec::new();
    let mut x = Vec::new();
    for i in 1..spread.len() {
        y.push(spread[i] - spread[i - 1]);
        x.push(spread[i - 1]);
    }
    let beta = ols_slope(&x, &y);
    if beta >= 0.0 { return 999.0; }
    -0.693 / beta
}

fn compute_hurst(data: &[f64]) -> f64 {
    let n = data.len();
    if n < 20 { return 0.5; }
    let lags = [2usize, 4, 8, 16, 32].iter().filter(|&&l| l < n / 2).copied().collect::<Vec<_>>();
    if lags.len() < 2 { return 0.5; }

    let mut log_lags = Vec::new();
    let mut log_rs = Vec::new();

    for lag in &lags {
        let mut rs_vals = Vec::new();
        let chunks = n / lag;
        for c in 0..chunks {
            let start = c * lag;
            let end = start + lag;
            let slice = &data[start..end];
            let mean = slice.iter().sum::<f64>() / *lag as f64;
            let mut cumdev = Vec::new();
            let mut s = 0.0;
            for v in slice { s += v - mean; cumdev.push(s); }
            let r = cumdev.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
                  - cumdev.iter().cloned().fold(f64::INFINITY, f64::min);
            let std = (slice.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / *lag as f64).sqrt();
            if std > 0.0 { rs_vals.push(r / std); }
        }
        if !rs_vals.is_empty() {
            let avg_rs = rs_vals.iter().sum::<f64>() / rs_vals.len() as f64;
            log_lags.push((*lag as f64).ln());
            log_rs.push(avg_rs.ln());
        }
    }

    if log_lags.len() < 2 { return 0.5; }
    ols_slope(&log_lags, &log_rs)
}

fn adf_score(spread: &[f64]) -> f64 {
    if spread.len() < 5 { return 0.0; }
    let mut dy = Vec::new();
    let mut lag = Vec::new();
    for i in 1..spread.len() {
        dy.push(spread[i] - spread[i - 1]);
        lag.push(spread[i - 1]);
    }
    let beta = ols_slope(&lag, &dy);
    let n = dy.len() as f64;
    let mean_dy = dy.iter().sum::<f64>() / n;
    let residuals: Vec<f64> = (0..dy.len()).map(|i| dy[i] - beta * lag[i]).collect();
    let sse = residuals.iter().map(|r| r * r).sum::<f64>();
    let se = (sse / (n - 1.0)).sqrt();
    let var_lag = lag.iter().map(|l| (l - lag.iter().sum::<f64>() / n).powi(2)).sum::<f64>();
    let se_beta = if var_lag > 0.0 { se / var_lag.sqrt() } else { 1.0 };
    if se_beta > 0.0 { beta / se_beta } else { 0.0 }
}

fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
fn round4(v: f64) -> f64 { (v * 10000.0).round() / 10000.0 }
