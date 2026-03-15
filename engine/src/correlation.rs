use serde::{Deserialize, Serialize};
use crate::utils::{round2, round4, pearson_correlation, ols_slope, ols_regression};

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

#[derive(Serialize, Deserialize)]
struct CorrelationResult {
    pairs: Vec<PairAnalysis>,
    best_pairs: Vec<String>,
}

#[derive(Serialize, Deserialize)]
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
    kalman_confidence: f64,
}

struct KalmanState {
    beta: f64,
    p: f64,
    q: f64,
    r: f64,
}

impl KalmanState {
    fn new() -> Self {
        KalmanState {
            beta: 1.0,
            p: 1.0,
            q: 0.0001,
            r: 0.01,
        }
    }

    fn update(&mut self, x: f64, y: f64) -> f64 {
        self.p += self.q;

        let k = self.p * x / (x * self.p * x + self.r);
        let innovation = y - self.beta * x;
        self.beta += k * innovation;
        self.p = (1.0 - k * x) * self.p;

        self.beta
    }
}

fn kalman_hedge_ratio(prices_a: &[f64], prices_b: &[f64]) -> (f64, Vec<f64>, f64) {
    let mut kf = KalmanState::new();
    let mut hedge_ratios = Vec::with_capacity(prices_a.len());

    for i in 0..prices_a.len() {
        let ratio = kf.update(prices_b[i], prices_a[i]);
        hedge_ratios.push(ratio);
    }

    (kf.beta, hedge_ratios, kf.p)
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

        let (hedge, hedge_history, hedge_uncertainty) = kalman_hedge_ratio(&log_a, &log_b);
        let spread: Vec<f64> = (0..n).map(|i| log_a[i] - hedge_history[i] * log_b[i]).collect();

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
            kalman_confidence: round4(1.0 / (1.0 + hedge_uncertainty)),
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

/// ADF test with constant term (intercept) for valid unit root testing
fn adf_score(spread: &[f64]) -> f64 {
    if spread.len() < 5 { return 0.0; }
    let mut dy = Vec::new();
    let mut lag = Vec::new();
    for i in 1..spread.len() {
        dy.push(spread[i] - spread[i - 1]);
        lag.push(spread[i - 1]);
    }
    let (beta, _intercept) = ols_regression(&lag, &dy);
    let n = dy.len() as f64;
    let residuals: Vec<f64> = (0..dy.len()).map(|i| {
        dy[i] - (_intercept + beta * lag[i])
    }).collect();
    let sse = residuals.iter().map(|r| r * r).sum::<f64>();
    let se = (sse / (n - 2.0).max(1.0)).sqrt();
    let lag_mean = lag.iter().sum::<f64>() / n;
    let var_lag = lag.iter().map(|l| (l - lag_mean).powi(2)).sum::<f64>();
    let se_beta = if var_lag > 0.0 { se / var_lag.sqrt() } else { 1.0 };
    if se_beta > 0.0 { beta / se_beta } else { 0.0 }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn linear_prices(start: f64, step: f64, n: usize) -> Vec<f64> {
        (0..n).map(|i| start + step * i as f64).collect()
    }

    #[test]
    fn test_perfect_positive_correlation() {
        let a: Vec<f64> = (1..=50).map(|i| i as f64).collect();
        let b: Vec<f64> = (1..=50).map(|i| i as f64 * 2.0).collect();
        let corr = pearson_correlation(&a, &b);
        assert!((corr - 1.0).abs() < 0.001, "perfectly correlated should be ~1.0, got {}", corr);
    }

    #[test]
    fn test_perfect_negative_correlation() {
        let a: Vec<f64> = (1..=50).map(|i| i as f64).collect();
        let b: Vec<f64> = (1..=50).map(|i| 100.0 - i as f64).collect();
        let corr = pearson_correlation(&a, &b);
        assert!((corr - (-1.0)).abs() < 0.001, "inversely correlated should be ~-1.0, got {}", corr);
    }

    #[test]
    fn test_correlation_in_range() {
        let a = vec![1.0, 2.0, 3.0, 4.0, 5.0, 6.0, 7.0, 8.0, 9.0, 10.0,
                     11.0, 12.0, 13.0, 14.0, 15.0, 16.0, 17.0, 18.0, 19.0, 20.0];
        let b = vec![2.0, 1.0, 4.0, 3.0, 6.0, 5.0, 8.0, 7.0, 10.0, 9.0,
                     12.0, 11.0, 14.0, 13.0, 16.0, 15.0, 18.0, 17.0, 20.0, 19.0];
        let corr = pearson_correlation(&a, &b);
        assert!(corr >= -1.0 && corr <= 1.0);
    }

    #[test]
    fn test_ols_slope_known() {
        let x = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let y = vec![2.0, 4.0, 6.0, 8.0, 10.0];
        let slope = ols_slope(&x, &y);
        assert!((slope - 2.0).abs() < 0.01, "slope should be ~2.0, got {}", slope);
    }

    #[test]
    fn test_half_life_mean_reverting() {
        let mut spread = Vec::new();
        let mut val = 0.0;
        for i in 0..100 {
            val = val * 0.9 + if i % 2 == 0 { 0.5 } else { -0.5 };
            spread.push(val);
        }
        let hl = compute_half_life(&spread);
        assert!(hl > 0.0 && hl < 100.0, "mean-reverting spread should have finite half-life, got {}", hl);
    }

    #[test]
    fn test_hurst_exponent_range() {
        let data: Vec<f64> = (0..100).map(|i| (i as f64 * 0.1).sin()).collect();
        let h = compute_hurst(&data);
        assert!(h > 0.0 && h < 1.5, "Hurst should be in (0, 1.5), got {}", h);
    }

    #[test]
    fn test_full_pair_analysis() {
        let n = 60;
        let a = linear_prices(100.0, 0.5, n);
        let b = linear_prices(200.0, 1.0, n);
        let result = compute(json!({
            "pairs": [{"symbol_a": "A", "symbol_b": "B", "prices_a": a, "prices_b": b}]
        })).unwrap();
        let out: CorrelationResult = serde_json::from_value(result).unwrap();
        assert_eq!(out.pairs.len(), 1);
        assert!(out.pairs[0].correlation > 0.9, "trending pair should be highly correlated");
    }

    #[test]
    fn test_adf_score_returns_number() {
        let spread: Vec<f64> = (0..50).map(|i| (i as f64 * 0.2).sin()).collect();
        let score = adf_score(&spread);
        assert!(score.is_finite());
    }

    #[test]
    fn test_empty_pairs_error() {
        let result = compute(json!({ "pairs": [] }));
        assert!(result.is_err());
    }

    #[test]
    fn test_too_few_prices_skipped() {
        let result = compute(json!({
            "pairs": [{"symbol_a":"A","symbol_b":"B","prices_a":[1.0,2.0],"prices_b":[3.0,4.0]}]
        })).unwrap();
        let out: CorrelationResult = serde_json::from_value(result).unwrap();
        assert_eq!(out.pairs.len(), 0, "pairs with <20 prices should be skipped");
    }

    #[test]
    fn test_kalman_hedge_ratio_adapts() {
        let a: Vec<f64> = (1..=100).map(|i| (100.0 + i as f64 * 0.5).ln()).collect();
        let b: Vec<f64> = (1..=100).map(|i| (200.0 + i as f64 * 1.0).ln()).collect();
        let (hedge, history, uncertainty) = kalman_hedge_ratio(&a, &b);
        assert!(hedge > 0.0, "hedge ratio should be positive");
        assert!(history.len() == 100, "should have 100 hedge ratio estimates");
        assert!(uncertainty < 1.0, "uncertainty should decrease over time");
        let early_var: f64 = history[..10].windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>();
        let late_var: f64 = history[90..].windows(2).map(|w| (w[1] - w[0]).abs()).sum::<f64>();
        assert!(late_var <= early_var + 0.01, "later estimates should be more stable");
    }
}
