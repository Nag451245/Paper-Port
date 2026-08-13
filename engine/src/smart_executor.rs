use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionPlan {
    pub symbol: String,
    pub side: String,
    pub total_qty: i64,
    pub recommended_algo: String,
    pub num_slices: u32,
    pub slice_interval_secs: u64,
    pub urgency: f64,
    pub estimated_slippage_bps: f64,
    pub estimated_market_impact_bps: f64,
    pub estimated_total_cost_bps: f64,
    pub optimal_execution_window: ExecutionWindow,
    pub risk_warnings: Vec<String>,
    pub confidence: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionWindow {
    pub avoid_open_minutes: u32,
    pub avoid_close_minutes: u32,
    pub preferred_start_ist: String,
    pub preferred_end_ist: String,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExecutionQuality {
    pub symbol: String,
    pub side: String,
    pub qty: i64,
    pub avg_fill_price: f64,
    pub vwap: f64,
    pub arrival_price: f64,
    pub implementation_shortfall_bps: f64,
    pub vwap_slippage_bps: f64,
    pub market_impact_bps: f64,
    pub timing_cost_bps: f64,
    pub total_cost_bps: f64,
    pub grade: String,
}

#[derive(Debug, Clone, Deserialize)]
struct PlanInput {
    symbol: String,
    side: String,
    quantity: i64,
    price: f64,
    #[serde(default = "default_adv")]
    avg_daily_volume: f64,
    #[serde(default = "default_volatility")]
    daily_volatility: f64,
    #[serde(default = "default_spread")]
    bid_ask_spread_bps: f64,
    #[serde(default)]
    urgency: Option<String>,
    #[serde(default)]
    signal_confidence: Option<f64>,
    #[serde(default)]
    time_ist: Option<String>,
}

fn default_adv() -> f64 { 500_000.0 }
fn default_volatility() -> f64 { 0.02 }
fn default_spread() -> f64 { 3.0 }

#[derive(Debug, Clone, Deserialize)]
struct QualityInput {
    symbol: String,
    side: String,
    qty: i64,
    avg_fill_price: f64,
    arrival_price: f64,
    #[serde(default)]
    vwap: Option<f64>,
    #[serde(default = "default_adv")]
    avg_daily_volume: f64,
    #[serde(default = "default_volatility")]
    daily_volatility: f64,
}

fn participation_rate(qty: i64, adv: f64) -> f64 {
    if adv <= 0.0 { return 1.0; }
    (qty as f64 / adv).clamp(0.0, 1.0)
}

fn almgren_chriss_impact(qty: i64, price: f64, adv: f64, volatility: f64, spread_bps: f64) -> (f64, f64) {
    let part = participation_rate(qty, adv);
    let sigma = volatility * price;

    let temporary_bps = spread_bps / 2.0 + 50.0 * part.sqrt() * volatility * 10000.0;
    let permanent_bps = 30.0 * part * volatility * 10000.0;

    let _ = sigma;
    (temporary_bps, permanent_bps)
}

fn estimate_slippage(qty: i64, adv: f64, volatility: f64, spread_bps: f64) -> f64 {
    let part = participation_rate(qty, adv);

    let base = spread_bps / 2.0;
    let volume_impact = 20.0 * part.powf(0.6);
    let vol_impact = volatility * 5000.0 * part.powf(0.3);

    base + volume_impact + vol_impact
}

fn recommend_algo(qty: i64, adv: f64, urgency_str: &str, confidence: f64) -> (String, u32, u64) {
    let part = participation_rate(qty, adv);

    let urgency = match urgency_str {
        "high" | "urgent" => 0.9,
        "low" | "patient" => 0.2,
        _ => 0.5,
    };

    if part < 0.001 {
        return ("direct".to_string(), 1, 0);
    }

    if urgency > 0.7 || confidence > 0.85 {
        if part > 0.05 {
            let slices = ((part * 200.0).ceil() as u32).clamp(3, 20);
            return ("twap".to_string(), slices, 15);
        }
        return ("direct".to_string(), 1, 0);
    }

    if part > 0.1 {
        let slices = ((part * 500.0).ceil() as u32).clamp(5, 50);
        return ("iceberg".to_string(), slices, 10);
    }

    if part > 0.02 {
        let slices = ((part * 300.0).ceil() as u32).clamp(3, 30);
        return ("vwap".to_string(), slices, 20);
    }

    if part > 0.005 {
        let slices = ((part * 200.0).ceil() as u32).clamp(2, 15);
        return ("twap".to_string(), slices, 30);
    }

    ("direct".to_string(), 1, 0)
}

fn optimal_window(time_ist: &str) -> ExecutionWindow {
    let hour: u32 = time_ist.split(':').next()
        .and_then(|h| h.parse().ok())
        .unwrap_or(10);

    if hour < 9 || hour >= 15 {
        return ExecutionWindow {
            avoid_open_minutes: 15,
            avoid_close_minutes: 15,
            preferred_start_ist: "09:30".to_string(),
            preferred_end_ist: "15:00".to_string(),
            reason: "Market closed — queue for next session".to_string(),
        };
    }

    if hour == 9 {
        return ExecutionWindow {
            avoid_open_minutes: 15,
            avoid_close_minutes: 15,
            preferred_start_ist: "09:30".to_string(),
            preferred_end_ist: "11:30".to_string(),
            reason: "First 15 min has high volatility and wide spreads; wait for stability".to_string(),
        };
    }

    if hour >= 14 {
        return ExecutionWindow {
            avoid_open_minutes: 15,
            avoid_close_minutes: 15,
            preferred_start_ist: format!("{}:00", hour),
            preferred_end_ist: "15:15".to_string(),
            reason: "Near close — execute quickly before last-minute volatility".to_string(),
        };
    }

    ExecutionWindow {
        avoid_open_minutes: 15,
        avoid_close_minutes: 15,
        preferred_start_ist: format!("{}:00", hour),
        preferred_end_ist: format!("{}:00", (hour + 2).min(15)),
        reason: "Mid-session — optimal liquidity window".to_string(),
    }
}

fn grade_execution(is_bps: f64) -> String {
    if is_bps < 5.0 { "A+".to_string() }
    else if is_bps < 10.0 { "A".to_string() }
    else if is_bps < 20.0 { "B".to_string() }
    else if is_bps < 40.0 { "C".to_string() }
    else { "D".to_string() }
}

pub fn compute(data: Value) -> Result<Value, String> {
    let command = data.get("command").and_then(|v| v.as_str()).unwrap_or("plan");

    match command {
        "plan" => {
            let input: PlanInput = serde_json::from_value(data.clone())
                .map_err(|e| format!("Invalid plan input: {}", e))?;

            let urgency_str = input.urgency.as_deref().unwrap_or("medium");
            let confidence = input.signal_confidence.unwrap_or(0.6);
            let time_ist = input.time_ist.as_deref().unwrap_or("10:00");

            let (algo, slices, interval) = recommend_algo(
                input.quantity, input.avg_daily_volume, urgency_str, confidence,
            );

            let slippage = estimate_slippage(
                input.quantity, input.avg_daily_volume,
                input.daily_volatility, input.bid_ask_spread_bps,
            );

            let (temp_impact, perm_impact) = almgren_chriss_impact(
                input.quantity, input.price, input.avg_daily_volume,
                input.daily_volatility, input.bid_ask_spread_bps,
            );

            let total_cost = slippage + perm_impact;

            let window = optimal_window(time_ist);

            let mut warnings = Vec::new();
            let part = participation_rate(input.quantity, input.avg_daily_volume);
            if part > 0.2 {
                warnings.push(format!(
                    "High participation rate ({:.1}% of ADV) — significant market impact expected",
                    part * 100.0
                ));
            }
            if part > 0.05 && algo == "direct" {
                warnings.push("Consider using TWAP/VWAP for better execution".to_string());
            }
            if input.daily_volatility > 0.04 {
                warnings.push("High volatility — widen stop loss and reduce position size".to_string());
            }
            if total_cost > 50.0 {
                warnings.push(format!("Estimated total cost {:.1} bps — may erode edge", total_cost));
            }

            let plan = ExecutionPlan {
                symbol: input.symbol,
                side: input.side,
                total_qty: input.quantity,
                recommended_algo: algo,
                num_slices: slices,
                slice_interval_secs: interval,
                urgency: match urgency_str { "high" | "urgent" => 0.9, "low" => 0.2, _ => 0.5 },
                estimated_slippage_bps: (slippage * 100.0).round() / 100.0,
                estimated_market_impact_bps: (temp_impact * 100.0).round() / 100.0,
                estimated_total_cost_bps: (total_cost * 100.0).round() / 100.0,
                optimal_execution_window: window,
                risk_warnings: warnings,
                confidence,
            };

            serde_json::to_value(plan).map_err(|e| e.to_string())
        }

        "quality" | "analyze" => {
            let input: QualityInput = serde_json::from_value(data.clone())
                .map_err(|e| format!("Invalid quality input: {}", e))?;

            let is_buy = input.side.to_lowercase() == "buy";
            let vwap = input.vwap.unwrap_or(input.arrival_price);

            let is_bps = if is_buy {
                (input.avg_fill_price - input.arrival_price) / input.arrival_price * 10000.0
            } else {
                (input.arrival_price - input.avg_fill_price) / input.arrival_price * 10000.0
            };

            let vwap_slip = if is_buy {
                (input.avg_fill_price - vwap) / vwap * 10000.0
            } else {
                (vwap - input.avg_fill_price) / vwap * 10000.0
            };

            let part = participation_rate(input.qty, input.avg_daily_volume);
            let expected_impact = 30.0 * part * input.daily_volatility * 10000.0;
            let timing = (is_bps - expected_impact).max(0.0);

            let quality = ExecutionQuality {
                symbol: input.symbol,
                side: input.side,
                qty: input.qty,
                avg_fill_price: input.avg_fill_price,
                vwap,
                arrival_price: input.arrival_price,
                implementation_shortfall_bps: (is_bps * 100.0).round() / 100.0,
                vwap_slippage_bps: (vwap_slip * 100.0).round() / 100.0,
                market_impact_bps: (expected_impact * 100.0).round() / 100.0,
                timing_cost_bps: (timing * 100.0).round() / 100.0,
                total_cost_bps: (is_bps * 100.0).round() / 100.0,
                grade: grade_execution(is_bps.abs()),
            };

            serde_json::to_value(quality).map_err(|e| e.to_string())
        }

        "optimal_size" => {
            let price = data.get("price").and_then(|v| v.as_f64()).unwrap_or(100.0);
            let capital = data.get("capital").and_then(|v| v.as_f64()).unwrap_or(1_000_000.0);
            let risk_pct = data.get("risk_pct").and_then(|v| v.as_f64()).unwrap_or(1.0);
            let stop_loss_pct = data.get("stop_loss_pct").and_then(|v| v.as_f64()).unwrap_or(2.0);
            let adv = data.get("avg_daily_volume").and_then(|v| v.as_f64()).unwrap_or(500_000.0);
            let volatility = data.get("daily_volatility").and_then(|v| v.as_f64()).unwrap_or(0.02);
            let confidence = data.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.6);

            let risk_amount = capital * risk_pct / 100.0;
            let risk_per_share = price * stop_loss_pct / 100.0;
            let risk_based_qty = (risk_amount / risk_per_share).floor() as i64;

            let max_participation = 0.05;
            let volume_based_qty = (adv * max_participation).floor() as i64;

            let kelly_fraction = if confidence > 0.5 {
                let win_rate = confidence;
                let avg_win = stop_loss_pct * 1.5;
                let avg_loss = stop_loss_pct;
                let b = avg_win / avg_loss;
                (win_rate - (1.0 - win_rate) / b).max(0.0)
            } else { 0.0 };
            let kelly_capital = capital * kelly_fraction * 0.5;
            let kelly_qty = (kelly_capital / price).floor() as i64;

            let vol_adjusted = ((1.0 - volatility * 10.0).max(0.3) * risk_based_qty as f64).floor() as i64;

            let recommended = risk_based_qty
                .min(volume_based_qty)
                .min(kelly_qty.max(1))
                .min(vol_adjusted)
                .max(1);

            let slippage = estimate_slippage(recommended, adv, volatility, 3.0);

            Ok(serde_json::json!({
                "recommended_qty": recommended,
                "risk_based_qty": risk_based_qty,
                "volume_based_qty": volume_based_qty,
                "kelly_qty": kelly_qty,
                "vol_adjusted_qty": vol_adjusted,
                "kelly_fraction": (kelly_fraction * 1000.0).round() / 1000.0,
                "estimated_slippage_bps": (slippage * 100.0).round() / 100.0,
                "estimated_value": recommended as f64 * price,
                "participation_rate_pct": (recommended as f64 / adv * 100.0 * 100.0).round() / 100.0,
            }))
        }

        _ => Err(format!("Unknown smart_executor command: {}", command)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_plan_small_order() {
        let result = compute(json!({
            "command": "plan",
            "symbol": "RELIANCE",
            "side": "buy",
            "quantity": 10,
            "price": 2500.0,
            "avg_daily_volume": 5000000.0,
        }));
        assert!(result.is_ok());
        let plan = result.unwrap();
        assert_eq!(plan["recommended_algo"], "direct");
        assert_eq!(plan["num_slices"], 1);
    }

    #[test]
    fn test_plan_large_order() {
        let result = compute(json!({
            "command": "plan",
            "symbol": "SMALLCAP",
            "side": "buy",
            "quantity": 50000,
            "price": 100.0,
            "avg_daily_volume": 200000.0,
        }));
        assert!(result.is_ok());
        let plan = result.unwrap();
        assert_ne!(plan["recommended_algo"], "direct");
        assert!(plan["num_slices"].as_u64().unwrap() > 1);
        assert!(plan["risk_warnings"].as_array().unwrap().len() > 0);
    }

    #[test]
    fn test_quality_good_execution() {
        let result = compute(json!({
            "command": "quality",
            "symbol": "TCS",
            "side": "buy",
            "qty": 100,
            "avg_fill_price": 3500.10,
            "arrival_price": 3500.00,
            "avg_daily_volume": 2000000.0,
        }));
        assert!(result.is_ok());
        let q = result.unwrap();
        assert!(q["implementation_shortfall_bps"].as_f64().unwrap() < 10.0);
        let grade = q["grade"].as_str().unwrap();
        assert!(grade == "A+" || grade == "A");
    }

    #[test]
    fn test_quality_bad_execution() {
        let result = compute(json!({
            "command": "quality",
            "symbol": "PENNY",
            "side": "buy",
            "qty": 10000,
            "avg_fill_price": 105.0,
            "arrival_price": 100.0,
            "avg_daily_volume": 50000.0,
        }));
        assert!(result.is_ok());
        let q = result.unwrap();
        assert!(q["implementation_shortfall_bps"].as_f64().unwrap() > 100.0);
        assert_eq!(q["grade"], "D");
    }

    #[test]
    fn test_optimal_size() {
        let result = compute(json!({
            "command": "optimal_size",
            "price": 2500.0,
            "capital": 1000000.0,
            "risk_pct": 1.0,
            "stop_loss_pct": 2.0,
            "avg_daily_volume": 3000000.0,
            "confidence": 0.7,
        }));
        assert!(result.is_ok());
        let s = result.unwrap();
        assert!(s["recommended_qty"].as_i64().unwrap() > 0);
        assert!(s["kelly_fraction"].as_f64().unwrap() > 0.0);
    }

    #[test]
    fn test_almgren_chriss() {
        let (temp, perm) = almgren_chriss_impact(1000, 100.0, 1_000_000.0, 0.02, 3.0);
        assert!(temp > 0.0);
        assert!(perm > 0.0);
        assert!(temp > perm);
    }

    #[test]
    fn test_algo_recommendation_scales() {
        let (algo1, _, _) = recommend_algo(10, 5_000_000.0, "medium", 0.6);
        assert_eq!(algo1, "direct");

        let (algo2, slices2, _) = recommend_algo(500_000, 1_000_000.0, "medium", 0.6);
        assert_ne!(algo2, "direct");
        assert!(slices2 > 1);
    }
}
