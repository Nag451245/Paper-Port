use serde::{Deserialize, Serialize};
use crate::utils::{norm_cdf, round2, round4};

#[derive(Deserialize)]
struct Config {
    legs: Vec<Leg>,
    spot: f64,
    risk_free_rate: Option<f64>,
    price_range: Option<(f64, f64)>,
    num_points: Option<usize>,
}

#[derive(Deserialize, Clone)]
struct Leg {
    option_type: String, // "call" or "put"
    strike: f64,
    premium: f64,
    quantity: i64, // positive = buy, negative = sell/write
    expiry_days: Option<f64>,
    iv: Option<f64>,
}

#[derive(Serialize, Deserialize)]
struct StrategyResult {
    strategy_name: String,
    payoff_diagram: Vec<PayoffPoint>,
    greeks_summary: GreeksSummary,
    risk_metrics: RiskMetrics,
    breakeven_points: Vec<f64>,
    max_profit: f64,
    max_loss: f64,
    probability_of_profit: f64,
}

#[derive(Serialize, Deserialize)]
struct PayoffPoint {
    price: f64,
    payoff: f64,
    pnl: f64,
}

#[derive(Serialize, Deserialize)]
struct GreeksSummary {
    net_delta: f64,
    net_gamma: f64,
    net_theta: f64,
    net_vega: f64,
}

#[derive(Serialize, Deserialize)]
struct RiskMetrics {
    risk_reward_ratio: f64,
    capital_required: f64,
    margin_required: f64,
    net_premium: f64,
}

pub fn compute(data: serde_json::Value) -> Result<serde_json::Value, String> {
    let config: Config = serde_json::from_value(data).map_err(|e| format!("Invalid input: {}", e))?;

    if config.legs.is_empty() { return Err("At least one leg required".into()); }

    let rf = config.risk_free_rate.unwrap_or(0.065);
    let n_points = config.num_points.unwrap_or(100);
    let low = config.price_range.map(|r| r.0).unwrap_or(config.spot * 0.8);
    let high = config.price_range.map(|r| r.1).unwrap_or(config.spot * 1.2);
    let step = (high - low) / n_points as f64;

    let strategy_name = detect_strategy(&config.legs);

    let net_premium: f64 = config.legs.iter().map(|l| l.premium * l.quantity as f64).sum();

    let mut payoff_diagram = Vec::with_capacity(n_points + 1);
    let mut max_profit = f64::NEG_INFINITY;
    let mut max_loss = f64::INFINITY;
    let mut breakevens = Vec::new();

    let mut prev_pnl: Option<f64> = None;
    let mut prev_price: Option<f64> = None;

    for i in 0..=n_points {
        let price = low + step * i as f64;
        let mut payoff = 0.0;
        for leg in &config.legs {
            let intrinsic = match leg.option_type.as_str() {
                "call" => (price - leg.strike).max(0.0),
                "put" => (leg.strike - price).max(0.0),
                _ => 0.0,
            };
            payoff += intrinsic * leg.quantity as f64;
        }
        let adj_pnl = payoff - net_premium;

        if adj_pnl > max_profit { max_profit = adj_pnl; }
        if adj_pnl < max_loss { max_loss = adj_pnl; }

        if let (Some(pp), Some(pprice)) = (prev_pnl, prev_price) {
            if (pp < 0.0 && adj_pnl >= 0.0) || (pp >= 0.0 && adj_pnl < 0.0) {
                let ratio = pp.abs() / (pp.abs() + adj_pnl.abs());
                breakevens.push(round2(pprice + ratio * step));
            }
        }
        prev_pnl = Some(adj_pnl);
        prev_price = Some(price);

        payoff_diagram.push(PayoffPoint { price: round2(price), payoff: round2(payoff), pnl: round2(adj_pnl) });
    }

    if max_profit == f64::NEG_INFINITY { max_profit = 0.0; }
    if max_loss == f64::INFINITY { max_loss = 0.0; }
    if max_profit > config.spot * 10.0 { max_profit = f64::INFINITY; }
    if max_loss < -config.spot * 10.0 { max_loss = f64::NEG_INFINITY; }

    let mut net_delta = 0.0;
    let mut net_gamma = 0.0;
    let mut net_theta = 0.0;
    let mut net_vega = 0.0;

    for leg in &config.legs {
        let t = leg.expiry_days.unwrap_or(30.0) / 365.0;
        let sigma = leg.iv.unwrap_or(0.2);
        if t > 0.0 && sigma > 0.0 {
            let (d, g, th, v) = bs_greeks(config.spot, leg.strike, t, rf, sigma, &leg.option_type);
            net_delta += d * leg.quantity as f64;
            net_gamma += g * leg.quantity as f64;
            net_theta += th * leg.quantity as f64;
            net_vega += v * leg.quantity as f64;
        }
    }

    let buy_premium: f64 = config.legs.iter()
        .filter(|l| l.quantity > 0)
        .map(|l| l.premium * l.quantity as f64)
        .sum();

    let has_sells = config.legs.iter().any(|l| l.quantity < 0);
    let has_buys = config.legs.iter().any(|l| l.quantity > 0);

    let (capital_required, margin_required) = if !has_sells {
        // Buy-only: just the premium paid
        (buy_premium, 0.0)
    } else if has_buys && max_loss.is_finite() && max_loss < 0.0 {
        // Hedged strategy (spreads, condors): SEBI spread benefit applies
        // Margin ≈ max loss of the strategy
        let spread_margin = max_loss.abs();
        (spread_margin, spread_margin)
    } else {
        // Naked short or unbounded risk: SPAN + exposure margin
        // Index: ~15% of notional, Stock: ~20% (use 15% as default)
        let span_margin: f64 = config.legs.iter()
            .filter(|l| l.quantity < 0)
            .map(|l| {
                let notional = config.spot * l.quantity.unsigned_abs() as f64;
                notional * 0.15
            })
            .sum();
        let total = span_margin + buy_premium;
        (total, span_margin)
    };

    let rr = if max_loss.abs() > 0.01 && max_loss.is_finite() {
        (max_profit / max_loss.abs()).min(99.0)
    } else { 0.0 };

    let profitable_points = payoff_diagram.iter().filter(|p| p.pnl > 0.0).count();
    let pop = profitable_points as f64 / payoff_diagram.len().max(1) as f64;

    let result = StrategyResult {
        strategy_name,
        payoff_diagram,
        greeks_summary: GreeksSummary {
            net_delta: round4(net_delta),
            net_gamma: round4(net_gamma),
            net_theta: round4(net_theta),
            net_vega: round4(net_vega),
        },
        risk_metrics: RiskMetrics {
            risk_reward_ratio: round2(rr),
            capital_required: round2(capital_required),
            margin_required: round2(margin_required),
            net_premium: round2(net_premium),
        },
        breakeven_points: breakevens,
        max_profit: if max_profit.is_finite() { round2(max_profit) } else { f64::INFINITY },
        max_loss: if max_loss.is_finite() { round2(max_loss) } else { f64::NEG_INFINITY },
        probability_of_profit: round4(pop),
    };

    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn detect_strategy(legs: &[Leg]) -> String {
    let n = legs.len();
    if n == 1 {
        let l = &legs[0];
        return if l.quantity > 0 {
            format!("Long {}", l.option_type.to_uppercase())
        } else {
            format!("Short {}", l.option_type.to_uppercase())
        };
    }
    if n == 2 {
        let (a, b) = (&legs[0], &legs[1]);
        if a.option_type == b.option_type && a.quantity.signum() != b.quantity.signum() {
            if a.option_type == "call" { return "Bull Call Spread / Bear Call Spread".into(); }
            return "Bull Put Spread / Bear Put Spread".into();
        }
        if a.option_type != b.option_type && a.strike == b.strike && a.quantity > 0 && b.quantity > 0 {
            return "Long Straddle".into();
        }
        if a.option_type != b.option_type && a.strike == b.strike && a.quantity < 0 && b.quantity < 0 {
            return "Short Straddle".into();
        }
        if a.option_type != b.option_type && a.strike != b.strike && a.quantity > 0 && b.quantity > 0 {
            return "Long Strangle".into();
        }
    }
    if n == 4 {
        return "Iron Condor / Iron Butterfly".into();
    }
    format!("Custom {}-Leg Strategy", n)
}

fn bs_greeks(s: f64, k: f64, t: f64, r: f64, sigma: f64, opt_type: &str) -> (f64, f64, f64, f64) {
    let d1 = ((s / k).ln() + (r + sigma * sigma / 2.0) * t) / (sigma * t.sqrt());
    let _d2 = d1 - sigma * t.sqrt();
    let pdf_d1 = (-d1 * d1 / 2.0).exp() / (2.0 * std::f64::consts::PI).sqrt();
    let nd1 = norm_cdf(d1);

    let delta = if opt_type == "call" { nd1 } else { nd1 - 1.0 };
    let gamma = pdf_d1 / (s * sigma * t.sqrt());
    let theta = -(s * pdf_d1 * sigma) / (2.0 * t.sqrt()) / 365.0;
    let vega = s * pdf_d1 * t.sqrt() / 100.0;

    (delta, gamma, theta, vega)
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run(legs: serde_json::Value, spot: f64) -> StrategyResult {
        let result = compute(json!({ "legs": legs, "spot": spot })).unwrap();
        serde_json::from_value(result).unwrap()
    }

    #[test]
    fn test_long_call_basic() {
        let r = run(json!([{"option_type":"call","strike":100.0,"premium":5.0,"quantity":1}]), 100.0);
        assert_eq!(r.strategy_name, "Long CALL");
        assert!(r.risk_metrics.capital_required > 0.0);
        assert_eq!(r.risk_metrics.margin_required, 0.0);
    }

    #[test]
    fn test_long_put_basic() {
        let r = run(json!([{"option_type":"put","strike":100.0,"premium":4.0,"quantity":1}]), 100.0);
        assert_eq!(r.strategy_name, "Long PUT");
        assert!(r.risk_metrics.net_premium > 0.0, "long put is debit: net_premium should be positive");
    }

    #[test]
    fn test_short_call_basic() {
        let r = run(json!([{"option_type":"call","strike":100.0,"premium":5.0,"quantity":-1}]), 100.0);
        assert_eq!(r.strategy_name, "Short CALL");
        assert!(r.risk_metrics.capital_required > 0.0);
        assert!(r.risk_metrics.margin_required > 0.0);
    }

    #[test]
    fn test_buy_only_capital_is_premium() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":10.0,"quantity":2}
        ]), 100.0);
        assert_eq!(r.risk_metrics.capital_required, 20.0);
        assert_eq!(r.risk_metrics.margin_required, 0.0);
    }

    #[test]
    fn test_naked_short_margin_uses_span() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":5.0,"quantity":-10}
        ]), 100.0);
        let expected_span = 100.0 * 10.0 * 0.15;
        assert!((r.risk_metrics.margin_required - expected_span).abs() < 1.0,
            "naked margin should be ~{}, got {}", expected_span, r.risk_metrics.margin_required);
    }

    #[test]
    fn test_bull_call_spread_margin_is_max_loss() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":10.0,"quantity":1},
            {"option_type":"call","strike":110.0,"premium":5.0,"quantity":-1}
        ]), 105.0);
        assert!(r.risk_metrics.capital_required > 0.0);
        assert!(r.risk_metrics.capital_required < 100.0,
            "spread margin should be bounded, got {}", r.risk_metrics.capital_required);
    }

    #[test]
    fn test_iron_condor_detection() {
        let r = run(json!([
            {"option_type":"put","strike":90.0,"premium":1.0,"quantity":1},
            {"option_type":"put","strike":95.0,"premium":3.0,"quantity":-1},
            {"option_type":"call","strike":105.0,"premium":3.0,"quantity":-1},
            {"option_type":"call","strike":110.0,"premium":1.0,"quantity":1}
        ]), 100.0);
        assert_eq!(r.strategy_name, "Iron Condor / Iron Butterfly");
    }

    #[test]
    fn test_iron_condor_margin_is_max_loss() {
        let r = run(json!([
            {"option_type":"put","strike":90.0,"premium":1.0,"quantity":1},
            {"option_type":"put","strike":95.0,"premium":3.0,"quantity":-1},
            {"option_type":"call","strike":105.0,"premium":3.0,"quantity":-1},
            {"option_type":"call","strike":110.0,"premium":1.0,"quantity":1}
        ]), 100.0);
        assert!(r.max_loss.is_finite() && r.max_loss < 0.0);
        assert!((r.risk_metrics.capital_required - r.max_loss.abs()).abs() < 0.5,
            "condor margin should equal |maxLoss|={}, got capital={}",
            r.max_loss.abs(), r.risk_metrics.capital_required);
    }

    #[test]
    fn test_iron_condor_limited_profit_and_loss() {
        let r = run(json!([
            {"option_type":"put","strike":90.0,"premium":1.0,"quantity":1},
            {"option_type":"put","strike":95.0,"premium":3.0,"quantity":-1},
            {"option_type":"call","strike":105.0,"premium":3.0,"quantity":-1},
            {"option_type":"call","strike":110.0,"premium":1.0,"quantity":1}
        ]), 100.0);
        assert!(r.max_profit.is_finite(), "iron condor max profit should be finite");
        assert!(r.max_loss.is_finite(), "iron condor max loss should be finite");
        assert!(r.max_profit > 0.0);
        assert!(r.max_loss < 0.0);
    }

    #[test]
    fn test_breakeven_points_exist_for_spread() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":10.0,"quantity":1},
            {"option_type":"call","strike":110.0,"premium":5.0,"quantity":-1}
        ]), 105.0);
        assert!(!r.breakeven_points.is_empty(), "spread should have breakeven(s)");
    }

    #[test]
    fn test_straddle_detection() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":5.0,"quantity":1},
            {"option_type":"put","strike":100.0,"premium":5.0,"quantity":1}
        ]), 100.0);
        assert_eq!(r.strategy_name, "Long Straddle");
    }

    #[test]
    fn test_short_straddle_detection() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":5.0,"quantity":-1},
            {"option_type":"put","strike":100.0,"premium":5.0,"quantity":-1}
        ]), 100.0);
        assert_eq!(r.strategy_name, "Short Straddle");
    }

    #[test]
    fn test_long_strangle_detection() {
        let r = run(json!([
            {"option_type":"call","strike":110.0,"premium":3.0,"quantity":1},
            {"option_type":"put","strike":90.0,"premium":3.0,"quantity":1}
        ]), 100.0);
        assert_eq!(r.strategy_name, "Long Strangle");
    }

    #[test]
    fn test_net_premium_credit_strategy() {
        let r = run(json!([
            {"option_type":"put","strike":95.0,"premium":3.0,"quantity":-1},
            {"option_type":"put","strike":90.0,"premium":1.0,"quantity":1}
        ]), 100.0);
        assert!(r.risk_metrics.net_premium < 0.0,
            "credit spread net premium should be negative (received), got {}", r.risk_metrics.net_premium);
    }

    #[test]
    fn test_net_premium_debit_strategy() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":10.0,"quantity":1},
            {"option_type":"call","strike":110.0,"premium":5.0,"quantity":-1}
        ]), 100.0);
        assert!(r.risk_metrics.net_premium > 0.0,
            "debit spread net premium should be positive (paid), got {}", r.risk_metrics.net_premium);
    }

    #[test]
    fn test_probability_of_profit_in_range() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":5.0,"quantity":1}
        ]), 100.0);
        assert!(r.probability_of_profit >= 0.0 && r.probability_of_profit <= 1.0);
    }

    #[test]
    fn test_payoff_diagram_has_points() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":5.0,"quantity":1}
        ]), 100.0);
        assert!(r.payoff_diagram.len() > 50, "should have many payoff points");
    }

    #[test]
    fn test_greeks_computed() {
        let r = run(json!([
            {"option_type":"call","strike":100.0,"premium":5.0,"quantity":1,"expiry_days":30.0,"iv":0.2}
        ]), 100.0);
        assert!(r.greeks_summary.net_delta != 0.0, "delta should be non-zero");
        assert!(r.greeks_summary.net_gamma != 0.0, "gamma should be non-zero");
    }

    #[test]
    fn test_nifty_iron_condor_realistic_margin() {
        let lot = 75;
        let r = run(json!([
            {"option_type":"put","strike":24450.0,"premium":8.0,"quantity":lot},
            {"option_type":"put","strike":24550.0,"premium":18.0,"quantity":-lot},
            {"option_type":"call","strike":24650.0,"premium":18.0,"quantity":-lot},
            {"option_type":"call","strike":24750.0,"premium":8.0,"quantity":lot}
        ]), 24600.0);
        // net credit = (18+18-8-8)*75 = 20*75 = 1500
        // max loss per side = (100 - 20)*75 = 6000
        assert!(r.risk_metrics.capital_required > 5000.0,
            "NIFTY condor margin should be >> 5K, got {}", r.risk_metrics.capital_required);
    }

    #[test]
    fn test_empty_legs_error() {
        let result = compute(json!({ "legs": [], "spot": 100.0 }));
        assert!(result.is_err());
    }
}
