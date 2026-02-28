use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::f64::consts::{E, PI};

#[derive(Deserialize)]
struct GreeksInput {
    spot: f64,
    strike: f64,
    time_to_expiry: f64,
    risk_free_rate: f64,
    volatility: f64,
    option_type: String,
}

#[derive(Serialize)]
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
        return Ok(serde_json::to_value(GreeksOutput {
            price: round4(intrinsic),
            delta: if is_call { if s > k { 1.0 } else { 0.0 } } else { if s < k { -1.0 } else { 0.0 } },
            gamma: 0.0, theta: 0.0, vega: 0.0, rho: 0.0,
            implied_volatility: sigma,
        }).unwrap());
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

fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / 2.0_f64.sqrt()))
}

fn norm_pdf(x: f64) -> f64 {
    E.powf(-x * x / 2.0) / (2.0 * PI).sqrt()
}

fn erf(x: f64) -> f64 {
    let t = 1.0 / (1.0 + 0.3275911 * x.abs());
    let poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    let result = 1.0 - poly * E.powf(-x * x);
    if x >= 0.0 { result } else { -result }
}

fn round4(v: f64) -> f64 { (v * 10000.0).round() / 10000.0 }
