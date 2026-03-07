use std::f64::consts::{PI, SQRT_2};

#[derive(serde::Deserialize, serde::Serialize, Clone, Debug)]
pub struct Candle {
    #[serde(default)]
    pub timestamp: String,
    #[serde(default)]
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: f64,
}

pub fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}

pub fn round3(v: f64) -> f64 {
    (v * 1000.0).round() / 1000.0
}

pub fn round4(v: f64) -> f64 {
    (v * 10000.0).round() / 10000.0
}

pub fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / SQRT_2))
}

pub fn norm_pdf(x: f64) -> f64 {
    (-x * x / 2.0).exp() / (2.0 * PI).sqrt()
}

/// Abramowitz & Stegun approximation (max error ~1.5e-7)
pub fn erf(x: f64) -> f64 {
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + 0.3275911 * x);
    let poly = t
        * (0.254829592
            + t * (-0.284496736
                + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    sign * (1.0 - poly * (-x * x).exp())
}

pub fn bs_price(s: f64, k: f64, r: f64, t: f64, sigma: f64, is_call: bool) -> f64 {
    if t <= 0.0 || sigma <= 0.0 {
        return if is_call {
            (s - k).max(0.0)
        } else {
            (k - s).max(0.0)
        };
    }
    let d1 = ((s / k).ln() + (r + sigma * sigma / 2.0) * t) / (sigma * t.sqrt());
    let d2 = d1 - sigma * t.sqrt();
    if is_call {
        s * norm_cdf(d1) - k * (-r * t).exp() * norm_cdf(d2)
    } else {
        k * (-r * t).exp() * norm_cdf(-d2) - s * norm_cdf(-d1)
    }
}

pub fn bs_greeks(
    s: f64,
    k: f64,
    t: f64,
    r: f64,
    sigma: f64,
    is_call: bool,
) -> (f64, f64, f64, f64, f64) {
    if t <= 0.0 || sigma <= 0.0 {
        let delta = if is_call {
            if s > k { 1.0 } else { 0.0 }
        } else {
            if s < k { -1.0 } else { 0.0 }
        };
        return (delta, 0.0, 0.0, 0.0, 0.0);
    }
    let d1 = ((s / k).ln() + (r + sigma * sigma / 2.0) * t) / (sigma * t.sqrt());
    let d2 = d1 - sigma * t.sqrt();
    let pdf_d1 = norm_pdf(d1);
    let nd1 = norm_cdf(d1);

    let delta = if is_call { nd1 } else { nd1 - 1.0 };
    let gamma = pdf_d1 / (s * sigma * t.sqrt());
    let theta = if is_call {
        (-(s * pdf_d1 * sigma) / (2.0 * t.sqrt()) - r * k * (-r * t).exp() * norm_cdf(d2))
            / 365.0
    } else {
        (-(s * pdf_d1 * sigma) / (2.0 * t.sqrt()) + r * k * (-r * t).exp() * norm_cdf(-d2))
            / 365.0
    };
    let vega = s * pdf_d1 * t.sqrt() / 100.0;
    let rho = if is_call {
        k * t * (-r * t).exp() * norm_cdf(d2) / 100.0
    } else {
        -k * t * (-r * t).exp() * norm_cdf(-d2) / 100.0
    };

    (delta, gamma, theta, vega, rho)
}

/// Xorshift64 PRNG - fast, statistically sound, deterministic for reproducibility
pub struct Xorshift64 {
    state: u64,
}

impl Xorshift64 {
    pub fn new(seed: u64) -> Self {
        Self {
            state: if seed == 0 { 0xDEADBEEFCAFE } else { seed },
        }
    }

    pub fn next_u64(&mut self) -> u64 {
        let mut x = self.state;
        x ^= x << 13;
        x ^= x >> 7;
        x ^= x << 17;
        self.state = x;
        x
    }

    /// Returns a uniform f64 in [0, 1)
    pub fn next_f64(&mut self) -> f64 {
        (self.next_u64() >> 11) as f64 / (1u64 << 53) as f64
    }

    /// Returns a random index in [0, max)
    pub fn next_usize(&mut self, max: usize) -> usize {
        (self.next_u64() % max as u64) as usize
    }

    /// Box-Muller transform for normal distribution
    pub fn next_normal(&mut self, mean: f64, std_dev: f64) -> f64 {
        let u1 = self.next_f64().max(1e-10);
        let u2 = self.next_f64();
        let z = (-2.0 * u1.ln()).sqrt() * (2.0 * PI * u2).cos();
        mean + std_dev * z
    }
}

pub fn rolling_std(data: &[f64]) -> f64 {
    let n = data.len() as f64;
    if n < 2.0 {
        return 0.0;
    }
    let mean = data.iter().sum::<f64>() / n;
    (data.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
}

pub fn calc_ema_series(data: &[f64], period: usize) -> Vec<f64> {
    if data.len() < period {
        return vec![0.0; data.len()];
    }
    let mut result = vec![0.0; data.len()];
    let mult = 2.0 / (period as f64 + 1.0);
    result[period - 1] = data[..period].iter().sum::<f64>() / period as f64;
    for i in period..data.len() {
        result[i] = (data[i] - result[i - 1]) * mult + result[i - 1];
    }
    result
}

pub fn calc_ema_last(data: &[f64], period: usize) -> f64 {
    if data.is_empty() {
        return 0.0;
    }
    let period = period.min(data.len());
    let mul = 2.0 / (period as f64 + 1.0);
    let mut e = data[0];
    for &v in &data[1..] {
        e = (v - e) * mul + e;
    }
    e
}

pub fn calc_rsi_series(data: &[f64], period: usize) -> Vec<f64> {
    if data.len() < period + 1 {
        return vec![50.0; data.len()];
    }
    let mut result = vec![50.0; data.len()];
    let mut avg_gain = 0.0;
    let mut avg_loss = 0.0;

    for i in 1..=period {
        let diff = data[i] - data[i - 1];
        if diff > 0.0 {
            avg_gain += diff;
        } else {
            avg_loss -= diff;
        }
    }
    avg_gain /= period as f64;
    avg_loss /= period as f64;

    result[period] = if avg_loss == 0.0 {
        100.0
    } else {
        100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
    };

    for i in period + 1..data.len() {
        let diff = data[i] - data[i - 1];
        let (gain, loss) = if diff > 0.0 {
            (diff, 0.0)
        } else {
            (0.0, -diff)
        };
        avg_gain = (avg_gain * (period as f64 - 1.0) + gain) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + loss) / period as f64;
        result[i] = if avg_loss == 0.0 {
            100.0
        } else {
            100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
        };
    }
    result
}

pub fn calc_sma(data: &[f64], period: usize) -> Vec<f64> {
    let mut result = vec![0.0; data.len()];
    for i in 0..data.len() {
        if i < period - 1 {
            continue;
        }
        let sum: f64 = data[i + 1 - period..=i].iter().sum();
        result[i] = sum / period as f64;
    }
    result
}

pub fn calc_atr_series(
    highs: &[f64],
    lows: &[f64],
    closes: &[f64],
    period: usize,
) -> Vec<f64> {
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

pub fn pearson_correlation(a: &[f64], b: &[f64]) -> f64 {
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
    if denom > 0.0 {
        num / denom
    } else {
        0.0
    }
}

pub fn ols_slope(x: &[f64], y: &[f64]) -> f64 {
    let n = x.len() as f64;
    let mx = x.iter().sum::<f64>() / n;
    let my = y.iter().sum::<f64>() / n;
    let mut num = 0.0;
    let mut den = 0.0;
    for i in 0..x.len() {
        num += (x[i] - mx) * (y[i] - my);
        den += (x[i] - mx).powi(2);
    }
    if den > 0.0 {
        num / den
    } else {
        1.0
    }
}

/// Generate Cartesian product of parameter ranges for optimization
pub fn generate_combinations(params: &[Vec<serde_json::Value>]) -> Vec<Vec<serde_json::Value>> {
    if params.is_empty() {
        return vec![vec![]];
    }
    let mut result = vec![vec![]];
    for param_values in params {
        let mut new_result = Vec::new();
        for existing in &result {
            for val in param_values {
                let mut combo = existing.clone();
                combo.push(val.clone());
                new_result.push(combo);
            }
        }
        result = new_result;
    }
    result
}

/// Extract f64 from a JSON indicator object at a given array index
pub fn get_f64(indicators: &serde_json::Value, key: &str, idx: usize) -> f64 {
    indicators
        .get(key)
        .and_then(|arr| arr.get(idx))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0)
}

/// Transaction cost model for realistic backtesting
#[derive(Clone, Debug)]
pub struct TransactionCosts {
    pub commission_per_trade: f64,
    pub slippage_bps: f64,
    pub stamp_duty_pct: f64,
    pub stt_pct: f64,
    pub exchange_fee_pct: f64,
    pub gst_pct: f64,
}

impl Default for TransactionCosts {
    fn default() -> Self {
        Self {
            commission_per_trade: 20.0,
            slippage_bps: 5.0,
            stamp_duty_pct: 0.003,
            stt_pct: 0.025,
            exchange_fee_pct: 0.00345,
            gst_pct: 18.0,
        }
    }
}

impl TransactionCosts {
    pub fn total_cost(&self, trade_value: f64, is_sell: bool) -> f64 {
        let slippage = trade_value * self.slippage_bps / 10_000.0;
        let stt = if is_sell {
            trade_value * self.stt_pct / 100.0
        } else {
            0.0
        };
        let exchange_fee = trade_value * self.exchange_fee_pct / 100.0;
        let stamp_duty = trade_value * self.stamp_duty_pct / 100.0;
        let brokerage = self.commission_per_trade;
        let gst = (brokerage + exchange_fee) * self.gst_pct / 100.0;

        slippage + stt + exchange_fee + stamp_duty + brokerage + gst
    }

    pub fn slippage_adjusted_price(&self, price: f64, is_buy: bool) -> f64 {
        let slip = price * self.slippage_bps / 10_000.0;
        if is_buy {
            price + slip
        } else {
            price - slip
        }
    }
}

/// Pre-trade risk validation
#[derive(Clone, Debug)]
pub struct RiskLimits {
    pub max_position_size_pct: f64,
    pub max_single_loss_pct: f64,
    pub max_drawdown_pct: f64,
    pub max_daily_trades: usize,
    pub max_open_positions: usize,
    pub max_portfolio_heat_pct: f64,
}

impl Default for RiskLimits {
    fn default() -> Self {
        Self {
            max_position_size_pct: 20.0,
            max_single_loss_pct: 2.0,
            max_drawdown_pct: 25.0,
            max_daily_trades: 20,
            max_open_positions: 10,
            max_portfolio_heat_pct: 6.0,
        }
    }
}

#[derive(Debug, Clone)]
pub struct RiskCheckResult {
    pub approved: bool,
    pub reason: Option<String>,
    pub adjusted_qty: Option<i64>,
}

impl RiskLimits {
    pub fn check_position_size(
        &self,
        nav: f64,
        price: f64,
        qty: i64,
        stop_loss: Option<f64>,
    ) -> RiskCheckResult {
        let trade_value = price * qty.unsigned_abs() as f64;
        let position_pct = trade_value / nav * 100.0;

        if position_pct > self.max_position_size_pct {
            let max_qty = (nav * self.max_position_size_pct / 100.0 / price) as i64;
            return RiskCheckResult {
                approved: false,
                reason: Some(format!(
                    "Position size {:.1}% exceeds limit {:.1}%",
                    position_pct, self.max_position_size_pct
                )),
                adjusted_qty: Some(max_qty),
            };
        }

        if let Some(sl) = stop_loss {
            let risk_per_share = (price - sl).abs();
            let total_risk = risk_per_share * qty.unsigned_abs() as f64;
            let risk_pct = total_risk / nav * 100.0;
            if risk_pct > self.max_single_loss_pct {
                let max_qty = (nav * self.max_single_loss_pct / 100.0 / risk_per_share) as i64;
                return RiskCheckResult {
                    approved: false,
                    reason: Some(format!(
                        "Risk per trade {:.1}% exceeds limit {:.1}%",
                        risk_pct, self.max_single_loss_pct
                    )),
                    adjusted_qty: Some(max_qty),
                };
            }
        }

        RiskCheckResult {
            approved: true,
            reason: None,
            adjusted_qty: None,
        }
    }

    pub fn check_drawdown(&self, nav: f64, peak: f64) -> RiskCheckResult {
        let dd_pct = (peak - nav) / peak * 100.0;
        if dd_pct > self.max_drawdown_pct {
            return RiskCheckResult {
                approved: false,
                reason: Some(format!(
                    "Drawdown {:.1}% exceeds circuit breaker {:.1}%",
                    dd_pct, self.max_drawdown_pct
                )),
                adjusted_qty: None,
            };
        }
        RiskCheckResult {
            approved: true,
            reason: None,
            adjusted_qty: None,
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_norm_cdf_known_values() {
        assert!((norm_cdf(0.0) - 0.5).abs() < 0.001);
        assert!((norm_cdf(1.96) - 0.975).abs() < 0.002);
        assert!((norm_cdf(-1.96) - 0.025).abs() < 0.002);
    }

    #[test]
    fn test_xorshift64_uniform_distribution() {
        let mut rng = Xorshift64::new(42);
        let n = 10_000;
        let mut count_below_half = 0;
        for _ in 0..n {
            let v = rng.next_f64();
            assert!(v >= 0.0 && v < 1.0);
            if v < 0.5 {
                count_below_half += 1;
            }
        }
        let ratio = count_below_half as f64 / n as f64;
        assert!(
            (ratio - 0.5).abs() < 0.03,
            "uniform distribution should be ~50/50, got {:.1}%",
            ratio * 100.0
        );
    }

    #[test]
    fn test_xorshift64_normal_distribution() {
        let mut rng = Xorshift64::new(42);
        let n = 10_000;
        let vals: Vec<f64> = (0..n).map(|_| rng.next_normal(0.0, 1.0)).collect();
        let mean = vals.iter().sum::<f64>() / n as f64;
        let var = vals.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / n as f64;
        assert!(
            mean.abs() < 0.05,
            "mean should be ~0, got {}",
            mean
        );
        assert!(
            (var - 1.0).abs() < 0.1,
            "variance should be ~1.0, got {}",
            var
        );
    }

    #[test]
    fn test_transaction_costs() {
        let costs = TransactionCosts::default();
        let buy_cost = costs.total_cost(100_000.0, false);
        let sell_cost = costs.total_cost(100_000.0, true);
        assert!(buy_cost > 0.0);
        assert!(sell_cost > buy_cost, "sell should cost more due to STT");
    }

    #[test]
    fn test_slippage_adjusted_price() {
        let costs = TransactionCosts::default();
        let buy_price = costs.slippage_adjusted_price(100.0, true);
        let sell_price = costs.slippage_adjusted_price(100.0, false);
        assert!(buy_price > 100.0, "buy slippage should increase price");
        assert!(sell_price < 100.0, "sell slippage should decrease price");
    }

    #[test]
    fn test_risk_limits_position_size() {
        let limits = RiskLimits::default();
        let result_ok = limits.check_position_size(100_000.0, 100.0, 100, None);
        assert!(result_ok.approved, "10% of NAV (100 * 100 = 10k) should be approved");
        let result_big = limits.check_position_size(100_000.0, 100.0, 300, None);
        assert!(!result_big.approved || result_big.adjusted_qty.is_some(),
            "30% of NAV should be rejected or adjusted down");
    }

    #[test]
    fn test_risk_limits_drawdown_circuit_breaker() {
        let limits = RiskLimits::default();
        let result = limits.check_drawdown(70_000.0, 100_000.0);
        assert!(
            !result.approved,
            "30% drawdown should trip circuit breaker"
        );
    }

    #[test]
    fn test_bs_price_put_call_parity() {
        let call = bs_price(100.0, 100.0, 0.05, 1.0, 0.2, true);
        let put = bs_price(100.0, 100.0, 0.05, 1.0, 0.2, false);
        let parity = call - put - (100.0 - 100.0 * (-0.05_f64).exp());
        assert!(parity.abs() < 0.05, "put-call parity violated: {}", parity);
    }

    #[test]
    fn test_rolling_std() {
        let data = vec![1.0, 2.0, 3.0, 4.0, 5.0];
        let std = rolling_std(&data);
        assert!((std - 1.5811).abs() < 0.01);
    }

    #[test]
    fn test_generate_combinations() {
        use serde_json::json;
        let params = vec![
            vec![json!(1), json!(2)],
            vec![json!("a"), json!("b")],
        ];
        let combos = generate_combinations(&params);
        assert_eq!(combos.len(), 4);
    }

    #[test]
    fn test_ema_single_value() {
        let data = vec![42.0];
        let series = calc_ema_series(&data, 9);
        assert_eq!(series.len(), 1);
        assert!((series[0] - 0.0).abs() < f64::EPSILON, "single value with period>len returns 0-padded");

        let last = calc_ema_last(&data, 9);
        assert!((last - 42.0).abs() < f64::EPSILON, "calc_ema_last of single element should return that element");
    }

    #[test]
    fn test_sma_single_value() {
        let data = vec![77.5];
        let sma = calc_sma(&data, 1);
        assert_eq!(sma.len(), 1);
        assert!((sma[0] - 77.5).abs() < f64::EPSILON, "SMA(1) of single element should be that element");
    }

    #[test]
    fn test_atr_flat_candles() {
        let n = 20;
        let price = 100.0;
        let highs = vec![price; n];
        let lows = vec![price; n];
        let closes = vec![price; n];
        let atr = calc_atr_series(&highs, &lows, &closes, 14);
        assert!((atr[n - 1]).abs() < f64::EPSILON, "ATR of flat candles (no range) should be 0, got {}", atr[n - 1]);
    }

    #[test]
    fn test_rsi_all_up() {
        let data: Vec<f64> = (0..30).map(|i| 100.0 + i as f64 * 2.0).collect();
        let rsi = calc_rsi_series(&data, 14);
        assert!(rsi[29] > 95.0, "RSI of consistently rising prices should be near 100, got {}", rsi[29]);
    }

    #[test]
    fn test_rsi_all_down() {
        let data: Vec<f64> = (0..30).map(|i| 200.0 - i as f64 * 2.0).collect();
        let rsi = calc_rsi_series(&data, 14);
        assert!(rsi[29] < 5.0, "RSI of consistently falling prices should be near 0, got {}", rsi[29]);
    }

    #[test]
    fn test_supertrend_basic() {
        let closes: Vec<f64> = (0..40).map(|i| 100.0 + i as f64 * 0.5).collect();
        let candles: Vec<serde_json::Value> = closes.iter().map(|&c| {
            serde_json::json!({
                "close": c,
                "high": c + 1.0,
                "low": c - 1.0,
                "volume": 10000.0
            })
        }).collect();

        let result = crate::signals::compute(serde_json::json!({ "candles": candles }));
        assert!(result.is_ok(), "supertrend computation should not panic");
        let out = result.unwrap();
        let st = out.get("supertrend").expect("missing supertrend field");
        let arr = st.as_array().unwrap();
        assert_eq!(arr.len(), 40);
    }

    #[test]
    fn test_transaction_costs_zero_qty() {
        let costs = TransactionCosts::default();
        let cost = costs.total_cost(0.0, false);
        let brokerage = costs.commission_per_trade;
        let gst = brokerage * costs.gst_pct / 100.0;
        let expected_fixed = brokerage + gst;
        assert!(
            (cost - expected_fixed).abs() < 0.01,
            "zero trade value should only incur fixed brokerage+GST, got {} vs expected {}",
            cost, expected_fixed
        );
    }

    #[test]
    fn test_norm_cdf_extremes() {
        let big = norm_cdf(10.0);
        assert!((big - 1.0).abs() < 1e-6, "norm_cdf(10) should be ~1.0, got {}", big);

        let small = norm_cdf(-10.0);
        assert!(small.abs() < 1e-6, "norm_cdf(-10) should be ~0.0, got {}", small);

        let huge = norm_cdf(100.0);
        assert!(huge.is_finite(), "norm_cdf(100) should be finite");
        assert!((huge - 1.0).abs() < 1e-10, "norm_cdf(100) should be ~1.0");

        let neg_huge = norm_cdf(-100.0);
        assert!(neg_huge.is_finite(), "norm_cdf(-100) should be finite");
        assert!(neg_huge.abs() < 1e-10, "norm_cdf(-100) should be ~0.0");
    }
}
