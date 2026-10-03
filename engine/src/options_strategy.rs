use serde::{Deserialize, Serialize};
use crate::utils::{norm_cdf, round2, round4, bs_greeks as utils_bs_greeks};

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
    #[serde(default)]
    unlimited_profit: bool,
    #[serde(default)]
    unlimited_loss: bool,
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

    // Positive = premium paid (debit), negative = premium received (credit).
    let net_premium: f64 = config.legs.iter().map(|l| l.premium * l.quantity as f64).sum();
    let pnl_at = |price: f64| -> f64 {
        config.legs.iter().map(|l| intrinsic(l, price) * l.quantity as f64).sum::<f64>() - net_premium
    };

    // Chart: an even grid plus every strike, so the peaks and corners are drawn exactly.
    let mut prices: Vec<f64> = (0..=n_points).map(|i| low + step * i as f64).collect();
    prices.extend(config.legs.iter().map(|l| l.strike).filter(|k| *k > low && *k < high));
    prices.sort_by(|a, b| a.partial_cmp(b).unwrap());
    prices.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let payoff_diagram: Vec<PayoffPoint> = prices.iter().map(|&p| {
        let pnl = pnl_at(p);
        PayoffPoint { price: round2(p), payoff: round2(pnl + net_premium), pnl: round2(pnl) }
    }).collect();

    // The P&L is a straight line between strikes, so its best and worst values sit
    // at a strike or at a price of 0. Above the highest strike it keeps moving by
    // the net number of calls per point: more calls bought than sold = unlimited
    // profit, more sold than bought = unlimited loss.
    let net_calls: f64 = config.legs.iter().filter(|l| l.option_type == "call").map(|l| l.quantity as f64).sum();
    let unlimited_profit = net_calls > 0.0;
    let unlimited_loss = net_calls < 0.0;
    let mut corners: Vec<f64> = vec![0.0];
    corners.extend(config.legs.iter().map(|l| l.strike));
    let top = corners.iter().cloned().fold(config.spot, f64::max) * 2.0;
    corners.push(top);
    corners.sort_by(|a, b| a.partial_cmp(b).unwrap());
    corners.dedup_by(|a, b| (*a - *b).abs() < 1e-9);
    let corner_pnl: Vec<f64> = corners.iter().map(|&p| pnl_at(p)).collect();
    let max_profit = corner_pnl.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
    let max_loss = corner_pnl.iter().cloned().fold(f64::INFINITY, f64::min);

    // Exact breakevens: where the straight pieces cross zero.
    let mut breakevens = Vec::new();
    for i in 1..corners.len() {
        let (a, b, pa, pb) = (corners[i - 1], corners[i], corner_pnl[i - 1], corner_pnl[i]);
        if (pa < 0.0) != (pb < 0.0) && (pb - pa).abs() > 1e-12 {
            breakevens.push(round2(a + (0.0 - pa) * (b - a) / (pb - pa)));
        }
    }
    let last = *corner_pnl.last().unwrap();
    if net_calls != 0.0 && (last < 0.0) != (net_calls < 0.0) {
        breakevens.push(round2(top - last / net_calls));
    }

    // Implied volatility may arrive in percent (the chain shows 14.6); the model needs 0.146.
    let sigma_of = |l: &Leg| l.iv.filter(|v| *v > 0.0).map(|v| if v > 3.0 { v / 100.0 } else { v });

    let mut net_delta = 0.0;
    let mut net_gamma = 0.0;
    let mut net_theta = 0.0;
    let mut net_vega = 0.0;

    for leg in &config.legs {
        let t = leg.expiry_days.unwrap_or(30.0) / 365.0;
        let sigma = sigma_of(leg).unwrap_or(0.2);
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
    } else if has_buys && !unlimited_loss && max_loss < 0.0 {
        // Hedged strategy (spreads, condors): SEBI spread benefit applies
        // Margin ≈ max loss of the strategy
        let spread_margin = max_loss.abs();
        (spread_margin, spread_margin)
    } else {
        // Naked short or unbounded risk: SPAN + exposure margin, ~15% of notional.
        // Short calls and short puts cannot both lose at once, so with nothing
        // bought (straddle, strangle) only the larger side is charged.
        let side = |kind: &str| -> f64 {
            config.legs.iter()
                .filter(|l| l.quantity < 0 && l.option_type == kind)
                .map(|l| config.spot * l.quantity.unsigned_abs() as f64 * 0.15)
                .sum()
        };
        let span_margin = if has_buys { side("call") + side("put") } else { side("call").max(side("put")) };
        let total = span_margin + buy_premium;
        (total, span_margin)
    };

    let rr = if !unlimited_loss && !unlimited_profit && max_loss.abs() > 0.01 {
        (max_profit / max_loss.abs()).min(99.0)
    } else { 0.0 };

    // Chance the strategy ends in profit at expiry, from a lognormal price at the
    // legs' average implied volatility over the nearest expiry.
    let ivs: Vec<f64> = config.legs.iter().filter_map(|l| sigma_of(l)).collect();
    let sigma = if ivs.is_empty() { 0.2 } else { ivs.iter().sum::<f64>() / ivs.len() as f64 };
    let t = config.legs.iter().filter_map(|l| l.expiry_days).fold(f64::INFINITY, f64::min);
    let t = if t.is_finite() { t.max(0.5) / 365.0 } else { 30.0 / 365.0 };
    let below = |x: f64| -> f64 {
        if x <= 0.0 { return 0.0; }
        norm_cdf(((x / config.spot).ln() - (rf - sigma * sigma / 2.0) * t) / (sigma * t.sqrt()))
    };
    let mut cuts = breakevens.clone();
    cuts.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let mut pop = 0.0;
    let mut lo = 0.0;
    for i in 0..=cuts.len() {
        let hi = if i < cuts.len() { cuts[i] } else { f64::INFINITY };
        let probe = if hi.is_finite() { (lo + hi) / 2.0 } else { lo.max(config.spot) * 1.5 + 1.0 };
        if pnl_at(probe) > 0.0 {
            pop += (if hi.is_finite() { below(hi) } else { 1.0 }) - below(lo);
        }
        lo = hi;
    }

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
        max_profit: round2(max_profit),
        max_loss: round2(max_loss),
        unlimited_profit,
        unlimited_loss,
        probability_of_profit: round4(pop.clamp(0.0, 1.0)),
    };

    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn intrinsic(leg: &Leg, price: f64) -> f64 {
    match leg.option_type.as_str() {
        "call" => (price - leg.strike).max(0.0),
        "put" => (leg.strike - price).max(0.0),
        _ => 0.0,
    }
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
    let is_call = opt_type == "call";
    let (delta, gamma, theta, vega, _rho) = utils_bs_greeks(s, k, t, r, sigma, is_call);
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
    fn test_short_straddle_numbers_from_the_screen() {
        // NIFTY 22,400 short straddle, 3 days left, chain IV in percent.
        let r = run_with(json!({ "spot": 22421.95, "legs": [
            {"option_type":"call","strike":22400.0,"premium":156.1,"quantity":-65,"expiry_days":3.0,"iv":14.6},
            {"option_type":"put","strike":22400.0,"premium":103.6,"quantity":-65,"expiry_days":3.0,"iv":14.6}
        ]}));
        assert!(r.unlimited_loss && !r.unlimited_profit);
        assert!((r.max_profit - 259.7 * 65.0).abs() < 1.0, "max profit is the full credit, got {}", r.max_profit);
        assert_eq!(r.breakeven_points, vec![22140.3, 22659.7]);
        assert!(r.probability_of_profit > 0.3 && r.probability_of_profit < 0.8, "pop {}", r.probability_of_profit);
        // Theta per day in rupees: a few thousand, not hundreds of thousands.
        assert!(r.greeks_summary.net_theta > 500.0 && r.greeks_summary.net_theta < 20000.0, "theta {}", r.greeks_summary.net_theta);
        // Only one side of a straddle can lose: ~15% of one side's notional.
        assert!((r.risk_metrics.margin_required - 22421.95 * 65.0 * 0.15).abs() < 1.0);
    }

    #[test]
    fn test_long_call_is_unlimited_profit_limited_loss() {
        let r = run(json!([{"option_type":"call","strike":100.0,"premium":5.0,"quantity":1,"expiry_days":30.0,"iv":0.2}]), 100.0);
        assert!(r.unlimited_profit && !r.unlimited_loss);
        assert_eq!(r.max_loss, -5.0);
        assert_eq!(r.breakeven_points, vec![105.0]);
    }

    #[test]
    fn test_iron_condor_is_bounded_both_ways() {
        let r = run(json!([
            {"option_type":"put","strike":90.0,"premium":1.0,"quantity":1},
            {"option_type":"put","strike":95.0,"premium":3.0,"quantity":-1},
            {"option_type":"call","strike":105.0,"premium":3.0,"quantity":-1},
            {"option_type":"call","strike":110.0,"premium":1.0,"quantity":1}
        ]), 100.0);
        assert!(!r.unlimited_profit && !r.unlimited_loss);
        assert_eq!(r.max_profit, 4.0);
        assert_eq!(r.max_loss, -1.0);
    }

    fn run_with(cfg: serde_json::Value) -> StrategyResult {
        serde_json::from_value(compute(cfg).unwrap()).unwrap()
    }

    #[test]
    fn test_empty_legs_error() {
        let result = compute(json!({ "legs": [], "spot": 100.0 }));
        assert!(result.is_err());
    }
}
