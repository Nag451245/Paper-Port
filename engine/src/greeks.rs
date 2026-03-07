use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f64::consts::E;

use crate::utils::{norm_cdf, norm_pdf, round4};

#[derive(Deserialize)]
struct GreeksInput {
    spot: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    volatility: f64,
    option_type: String,
}

#[derive(Serialize, Deserialize)]
struct GreeksOutput {
    price: f64,
    delta: f64,
    gamma: f64,
    theta: f64,
    vega: f64,
    rho: f64,
    implied_volatility: f64,
}

pub fn compute(data: Value) -> Result<Value, String> {
    let input: GreeksInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid greeks input: {}", e))?;

    let is_call = input.option_type.to_lowercase() == "call" || input.option_type.to_lowercase() == "ce";

    let s = input.spot;
    let k = input.strike;
    let t = input.time_to_expiry;
    let r = input.risk_free_rate;
    let sigma = input.volatility;

    if t <= 0.0 {
        let intrinsic = if is_call { (s - k).max(0.0) } else { (k - s).max(0.0) };
        return serde_json::to_value(GreeksOutput {
            price: round4(intrinsic),
            delta: if is_call { if s > k { 1.0 } else { 0.0 } } else { if s < k { -1.0 } else { 0.0 } },
            gamma: 0.0, theta: 0.0, vega: 0.0, rho: 0.0,
            implied_volatility: sigma,
        }).map_err(|e| e.to_string());
    }

    let d1 = ((s / k).ln() + (r + sigma * sigma / 2.0) * t) / (sigma * t.sqrt());
    let d2 = d1 - sigma * t.sqrt();

    let nd1 = norm_cdf(d1);
    let nd2 = norm_cdf(d2);
    let nd1_neg = norm_cdf(-d1);
    let nd2_neg = norm_cdf(-d2);
    let pdf_d1 = norm_pdf(d1);

    let (price, delta, rho_val) = if is_call {
        let p = s * nd1 - k * E.powf(-r * t) * nd2;
        let d = nd1;
        let rho = k * t * E.powf(-r * t) * nd2 / 100.0;
        (p, d, rho)
    } else {
        let p = k * E.powf(-r * t) * nd2_neg - s * nd1_neg;
        let d = nd1 - 1.0;
        let rho = -k * t * E.powf(-r * t) * nd2_neg / 100.0;
        (p, d, rho)
    };

    let gamma = pdf_d1 / (s * sigma * t.sqrt());
    let theta = if is_call {
        (-(s * pdf_d1 * sigma) / (2.0 * t.sqrt()) - r * k * E.powf(-r * t) * nd2) / 365.0
    } else {
        (-(s * pdf_d1 * sigma) / (2.0 * t.sqrt()) + r * k * E.powf(-r * t) * nd2_neg) / 365.0
    };
    let vega = s * pdf_d1 * t.sqrt() / 100.0;

    let output = GreeksOutput {
        price: round4(price),
        delta: round4(delta),
        gamma: round4(gamma),
        theta: round4(theta),
        vega: round4(vega),
        rho: round4(rho_val),
        implied_volatility: round4(sigma),
    };

    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn assert_near(actual: f64, expected: f64, tolerance: f64, label: &str) {
        assert!(
            (actual - expected).abs() < tolerance,
            "{}: expected {:.6}, got {:.6} (tol {:.6})",
            label, expected, actual, tolerance
        );
    }

    fn compute_greeks(spot: f64, strike: f64, t: f64, r: f64, vol: f64, opt: &str) -> GreeksOutput {
        let result = compute(json!({
            "spot": spot, "strike": strike, "time_to_expiry": t,
            "risk_free_rate": r, "volatility": vol, "option_type": opt,
        })).unwrap();
        serde_json::from_value(result).unwrap()
    }

    #[test]
    fn test_atm_call_delta_near_half() {
        let g = compute_greeks(100.0, 100.0, 1.0, 0.05, 0.20, "call");
        assert_near(g.delta, 0.6368, 0.02, "ATM call delta");
    }

    #[test]
    fn test_atm_put_delta_near_neg_half() {
        let g = compute_greeks(100.0, 100.0, 1.0, 0.05, 0.20, "put");
        assert!(g.delta < 0.0 && g.delta > -1.0, "ATM put delta should be in (-1, 0), got {}", g.delta);
    }

    #[test]
    fn test_put_call_parity() {
        let call = compute_greeks(100.0, 100.0, 1.0, 0.05, 0.20, "call");
        let put = compute_greeks(100.0, 100.0, 1.0, 0.05, 0.20, "put");
        let parity = call.price - put.price - (100.0 - 100.0 * (-0.05_f64).exp());
        assert_near(parity, 0.0, 0.05, "put-call parity");
    }

    #[test]
    fn test_deep_itm_call_price_near_intrinsic() {
        let g = compute_greeks(150.0, 100.0, 0.01, 0.05, 0.20, "call");
        assert_near(g.price, 50.0, 1.0, "deep ITM call ≈ intrinsic");
        assert_near(g.delta, 1.0, 0.05, "deep ITM call delta ≈ 1");
    }

    #[test]
    fn test_deep_otm_call_near_zero() {
        let g = compute_greeks(50.0, 100.0, 0.01, 0.05, 0.20, "call");
        assert_near(g.price, 0.0, 0.5, "deep OTM call ≈ 0");
        assert_near(g.delta, 0.0, 0.05, "deep OTM call delta ≈ 0");
    }

    #[test]
    fn test_gamma_always_positive() {
        for opt in &["call", "put"] {
            let g = compute_greeks(100.0, 100.0, 0.5, 0.05, 0.30, opt);
            assert!(g.gamma > 0.0, "gamma should be positive for {}", opt);
        }
    }

    #[test]
    fn test_vega_positive_and_equal_for_call_put() {
        let call = compute_greeks(100.0, 100.0, 0.5, 0.05, 0.30, "call");
        let put = compute_greeks(100.0, 100.0, 0.5, 0.05, 0.30, "put");
        assert!(call.vega > 0.0, "call vega should be positive");
        assert_near(call.vega, put.vega, 0.001, "call and put vega should be equal");
    }

    #[test]
    fn test_theta_negative_for_long_options() {
        let call = compute_greeks(100.0, 100.0, 0.5, 0.05, 0.30, "call");
        assert!(call.theta < 0.0, "ATM call theta should be negative, got {}", call.theta);
    }

    #[test]
    fn test_expiry_returns_intrinsic() {
        let itm_call = compute_greeks(110.0, 100.0, 0.0, 0.05, 0.20, "call");
        assert_near(itm_call.price, 10.0, 0.01, "expired ITM call = intrinsic");
        assert_near(itm_call.delta, 1.0, 0.01, "expired ITM call delta = 1");

        let otm_call = compute_greeks(90.0, 100.0, 0.0, 0.05, 0.20, "call");
        assert_near(otm_call.price, 0.0, 0.01, "expired OTM call = 0");
        assert_near(otm_call.delta, 0.0, 0.01, "expired OTM call delta = 0");

        let itm_put = compute_greeks(90.0, 100.0, 0.0, 0.05, 0.20, "put");
        assert_near(itm_put.price, 10.0, 0.01, "expired ITM put = intrinsic");
    }

    #[test]
    fn test_norm_cdf_known_values() {
        assert_near(norm_cdf(0.0), 0.5, 0.001, "N(0) = 0.5");
        assert_near(norm_cdf(1.96), 0.975, 0.002, "N(1.96) ≈ 0.975");
        assert_near(norm_cdf(-1.96), 0.025, 0.002, "N(-1.96) ≈ 0.025");
    }

    #[test]
    fn test_bs_call_reference_value() {
        // S=100, K=100, T=1, r=5%, σ=20% → BS call ≈ 10.45
        let g = compute_greeks(100.0, 100.0, 1.0, 0.05, 0.20, "call");
        assert_near(g.price, 10.45, 0.15, "BS call reference price");
    }

    #[test]
    fn test_option_type_aliases() {
        let ce = compute_greeks(100.0, 100.0, 0.5, 0.05, 0.25, "CE");
        let call = compute_greeks(100.0, 100.0, 0.5, 0.05, 0.25, "call");
        assert_near(ce.price, call.price, 0.001, "CE and call should produce same price");
    }
}
