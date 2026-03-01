use serde::{Deserialize, Serialize};
use serde_json::Value;
#[derive(Deserialize)]
struct IVSurfaceConfig {
    spot: f64,
    risk_free_rate: Option<f64>,
    strikes: Vec<StrikeData>,
}

#[derive(Deserialize, Clone)]
struct StrikeData {
    strike: f64,
    expiry_days: f64,
    call_price: Option<f64>,
    put_price: Option<f64>,
    call_iv: Option<f64>,
    put_iv: Option<f64>,
}

#[derive(Serialize)]
struct IVSurfaceResult {
    surface: Vec<SurfacePoint>,
    skew_analysis: SkewAnalysis,
    anomalies: Vec<Anomaly>,
    term_structure: Vec<TermPoint>,
    summary: SurfaceSummary,
}

#[derive(Serialize)]
struct SurfacePoint {
    strike: f64,
    expiry_days: f64,
    moneyness: f64,
    call_iv: f64,
    put_iv: f64,
    avg_iv: f64,
}

#[derive(Serialize)]
struct SkewAnalysis {
    current_skew: f64,
    skew_direction: String,
    put_call_iv_ratio: f64,
    atm_iv: f64,
    otm_put_iv: f64,
    otm_call_iv: f64,
    smile_curvature: f64,
}

#[derive(Serialize, Clone)]
struct Anomaly {
    strike: f64,
    expiry_days: f64,
    anomaly_type: String,
    severity: f64,
    description: String,
    expected_iv: f64,
    actual_iv: f64,
}

#[derive(Serialize)]
struct TermPoint {
    expiry_days: f64,
    atm_iv: f64,
}

#[derive(Serialize)]
struct SurfaceSummary {
    overall_iv_level: String,
    skew_regime: String,
    term_structure_shape: String,
    mispriced_options_count: usize,
    signal: String,
}

pub fn compute(data: Value) -> Result<Value, String> {
    let config: IVSurfaceConfig =
        serde_json::from_value(data).map_err(|e| format!("Invalid IV surface config: {}", e))?;

    if config.strikes.is_empty() {
        return Err("No strike data provided".to_string());
    }

    let r = config.risk_free_rate.unwrap_or(0.065);
    let spot = config.spot;

    let mut surface: Vec<SurfacePoint> = Vec::new();
    for s in &config.strikes {
        let moneyness = s.strike / spot;
        let call_iv = s.call_iv.unwrap_or_else(|| {
            s.call_price.map(|p| implied_vol(p, spot, s.strike, r, s.expiry_days / 365.0, true)).unwrap_or(0.0)
        });
        let put_iv = s.put_iv.unwrap_or_else(|| {
            s.put_price.map(|p| implied_vol(p, spot, s.strike, r, s.expiry_days / 365.0, false)).unwrap_or(0.0)
        });
        let avg_iv = if call_iv > 0.0 && put_iv > 0.0 { (call_iv + put_iv) / 2.0 }
            else if call_iv > 0.0 { call_iv } else { put_iv };

        surface.push(SurfacePoint {
            strike: s.strike,
            expiry_days: s.expiry_days,
            moneyness: round4(moneyness),
            call_iv: round4(call_iv),
            put_iv: round4(put_iv),
            avg_iv: round4(avg_iv),
        });
    }

    let skew = compute_skew(&surface, spot);
    let anomalies = detect_anomalies(&surface, spot);
    let term_structure = compute_term_structure(&surface, spot);

    let avg_iv: f64 = surface.iter().filter(|s| s.avg_iv > 0.0).map(|s| s.avg_iv).sum::<f64>()
        / surface.iter().filter(|s| s.avg_iv > 0.0).count().max(1) as f64;

    let iv_level = if avg_iv > 0.35 { "HIGH" } else if avg_iv > 0.20 { "MODERATE" } else { "LOW" };
    let skew_regime = if skew.current_skew.abs() < 0.02 { "FLAT" }
        else if skew.current_skew > 0.0 { "PUT_SKEW" } else { "CALL_SKEW" };

    let ts_shape = if term_structure.len() >= 2 {
        let first = term_structure.first().unwrap().atm_iv;
        let last = term_structure.last().unwrap().atm_iv;
        if last > first * 1.05 { "CONTANGO" }
        else if last < first * 0.95 { "BACKWARDATION" }
        else { "FLAT" }
    } else { "INSUFFICIENT_DATA" };

    let signal = if avg_iv > 0.30 && skew.put_call_iv_ratio > 1.2 { "SELL_PREMIUM" }
        else if avg_iv < 0.15 { "BUY_PREMIUM" }
        else if anomalies.len() > 3 { "ARBITRAGE_OPPORTUNITIES" }
        else { "NEUTRAL" };

    let result = IVSurfaceResult {
        surface,
        skew_analysis: skew,
        anomalies: anomalies.clone(),
        term_structure,
        summary: SurfaceSummary {
            overall_iv_level: iv_level.to_string(),
            skew_regime: skew_regime.to_string(),
            term_structure_shape: ts_shape.to_string(),
            mispriced_options_count: anomalies.len(),
            signal: signal.to_string(),
        },
    };

    serde_json::to_value(result).map_err(|e| format!("Serialization error: {}", e))
}

fn compute_skew(surface: &[SurfacePoint], _spot: f64) -> SkewAnalysis {
    let atm_points: Vec<&SurfacePoint> = surface.iter()
        .filter(|s| (s.moneyness - 1.0).abs() < 0.05 && s.avg_iv > 0.0).collect();
    let otm_puts: Vec<&SurfacePoint> = surface.iter()
        .filter(|s| s.moneyness < 0.95 && s.put_iv > 0.0).collect();
    let otm_calls: Vec<&SurfacePoint> = surface.iter()
        .filter(|s| s.moneyness > 1.05 && s.call_iv > 0.0).collect();

    let atm_iv = if atm_points.is_empty() { 0.2 }
        else { atm_points.iter().map(|s| s.avg_iv).sum::<f64>() / atm_points.len() as f64 };
    let otm_put_iv = if otm_puts.is_empty() { atm_iv }
        else { otm_puts.iter().map(|s| s.put_iv).sum::<f64>() / otm_puts.len() as f64 };
    let otm_call_iv = if otm_calls.is_empty() { atm_iv }
        else { otm_calls.iter().map(|s| s.call_iv).sum::<f64>() / otm_calls.len() as f64 };

    let skew = otm_put_iv - otm_call_iv;
    let pc_ratio = if otm_call_iv > 0.0 { otm_put_iv / otm_call_iv } else { 1.0 };
    let curvature = (otm_put_iv + otm_call_iv) / 2.0 - atm_iv;

    let direction = if skew > 0.03 { "PUT_HEAVY" }
        else if skew < -0.03 { "CALL_HEAVY" }
        else { "BALANCED" };

    SkewAnalysis {
        current_skew: round4(skew),
        skew_direction: direction.to_string(),
        put_call_iv_ratio: round4(pc_ratio),
        atm_iv: round4(atm_iv),
        otm_put_iv: round4(otm_put_iv),
        otm_call_iv: round4(otm_call_iv),
        smile_curvature: round4(curvature),
    }
}

fn detect_anomalies(surface: &[SurfacePoint], _spot: f64) -> Vec<Anomaly> {
    let mut anomalies = Vec::new();

    let by_expiry = group_by_expiry(surface);
    for (expiry, points) in &by_expiry {
        if points.len() < 3 { continue; }
        for i in 1..points.len() - 1 {
            let prev = points[i - 1].avg_iv;
            let curr = points[i].avg_iv;
            let next = points[i + 1].avg_iv;
            if prev > 0.0 && next > 0.0 && curr > 0.0 {
                let expected = (prev + next) / 2.0;
                let deviation = (curr - expected).abs() / expected;
                if deviation > 0.15 {
                    anomalies.push(Anomaly {
                        strike: points[i].strike,
                        expiry_days: *expiry as f64,
                        anomaly_type: if curr > expected { "IV_SPIKE".into() } else { "IV_DIP".into() },
                        severity: round4(deviation),
                        description: format!("IV deviates {:.1}% from interpolated value", deviation * 100.0),
                        expected_iv: round4(expected),
                        actual_iv: round4(curr),
                    });
                }
            }
        }

        for p in points {
            if p.call_iv > 0.0 && p.put_iv > 0.0 {
                let diff = (p.call_iv - p.put_iv).abs();
                let avg = (p.call_iv + p.put_iv) / 2.0;
                if avg > 0.0 && diff / avg > 0.2 {
                    anomalies.push(Anomaly {
                        strike: p.strike,
                        expiry_days: p.expiry_days,
                        anomaly_type: "PUT_CALL_IV_DIVERGENCE".into(),
                        severity: round4(diff / avg),
                        description: format!("Call IV ({:.1}%) vs Put IV ({:.1}%) divergence", p.call_iv * 100.0, p.put_iv * 100.0),
                        expected_iv: round4(avg),
                        actual_iv: round4(if p.call_iv > p.put_iv { p.call_iv } else { p.put_iv }),
                    });
                }
            }
        }
    }

    anomalies.sort_by(|a, b| b.severity.partial_cmp(&a.severity).unwrap_or(std::cmp::Ordering::Equal));
    anomalies.truncate(10);
    anomalies
}

fn compute_term_structure(surface: &[SurfacePoint], spot: f64) -> Vec<TermPoint> {
    let by_expiry = group_by_expiry(surface);
    let mut terms: Vec<TermPoint> = by_expiry.iter().map(|(expiry, points)| {
        let atm: Vec<&&SurfacePoint> = points.iter()
            .filter(|s| (s.strike / spot - 1.0).abs() < 0.05 && s.avg_iv > 0.0).collect();
        let iv = if atm.is_empty() {
            points.iter().filter(|s| s.avg_iv > 0.0).map(|s| s.avg_iv).sum::<f64>()
                / points.iter().filter(|s| s.avg_iv > 0.0).count().max(1) as f64
        } else {
            atm.iter().map(|s| s.avg_iv).sum::<f64>() / atm.len() as f64
        };
        TermPoint { expiry_days: *expiry as f64, atm_iv: round4(iv) }
    }).collect();
    terms.sort_by(|a, b| a.expiry_days.partial_cmp(&b.expiry_days).unwrap_or(std::cmp::Ordering::Equal));
    terms
}

fn group_by_expiry(surface: &[SurfacePoint]) -> std::collections::HashMap<i64, Vec<&SurfacePoint>> {
    let mut map: std::collections::HashMap<i64, Vec<&SurfacePoint>> = std::collections::HashMap::new();
    for s in surface {
        map.entry(s.expiry_days as i64).or_default().push(s);
    }
    map
}

fn implied_vol(option_price: f64, spot: f64, strike: f64, r: f64, t: f64, is_call: bool) -> f64 {
    if t <= 0.0 || option_price <= 0.0 { return 0.0; }
    let mut lo = 0.01;
    let mut hi = 3.0;
    for _ in 0..100 {
        let mid = (lo + hi) / 2.0;
        let bs = bs_price(spot, strike, r, t, mid, is_call);
        if (bs - option_price).abs() < 0.001 { return mid; }
        if bs > option_price { hi = mid; } else { lo = mid; }
    }
    (lo + hi) / 2.0
}

fn bs_price(s: f64, k: f64, r: f64, t: f64, sigma: f64, is_call: bool) -> f64 {
    let d1 = ((s / k).ln() + (r + sigma * sigma / 2.0) * t) / (sigma * t.sqrt());
    let d2 = d1 - sigma * t.sqrt();
    if is_call {
        s * norm_cdf(d1) - k * (-r * t).exp() * norm_cdf(d2)
    } else {
        k * (-r * t).exp() * norm_cdf(-d2) - s * norm_cdf(-d1)
    }
}

fn norm_cdf(x: f64) -> f64 {
    0.5 * (1.0 + erf(x / (2.0_f64).sqrt()))
}

fn erf(x: f64) -> f64 {
    let a1 = 0.254829592; let a2 = -0.284496736; let a3 = 1.421413741;
    let a4 = -1.453152027; let a5 = 1.061405429; let p = 0.3275911;
    let sign = if x < 0.0 { -1.0 } else { 1.0 };
    let x = x.abs();
    let t = 1.0 / (1.0 + p * x);
    let y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * (-x * x).exp();
    sign * y
}

fn round4(v: f64) -> f64 { (v * 10000.0).round() / 10000.0 }
