use serde::{Deserialize, Serialize};

/// Slippage model type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SlippageModel {
    /// Fixed basis points (legacy behavior)
    FixedBps,
    /// Volume-dependent: larger orders relative to ADV get more slippage
    VolumeDep,
    /// Almgren-Chriss market impact model
    AlmgrenChriss,
}

impl Default for SlippageModel {
    fn default() -> Self { Self::FixedBps }
}

impl SlippageModel {
    pub fn from_str_loose(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "volume" | "volume_dep" | "volumedep" => Self::VolumeDep,
            "almgren" | "almgren_chriss" | "market_impact" => Self::AlmgrenChriss,
            _ => Self::FixedBps,
        }
    }
}

/// Configuration for slippage models
#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct SlippageConfig {
    pub model: SlippageModel,
    /// Fixed slippage in basis points (used by FixedBps)
    pub fixed_bps: f64,
    /// Average daily volume of the instrument (used by VolumeDep and AlmgrenChriss)
    pub avg_daily_volume: f64,
    /// Bid-ask spread in basis points (used by VolumeDep and AlmgrenChriss)
    pub bid_ask_spread_bps: f64,
    /// Temporary impact coefficient (Almgren-Chriss eta parameter)
    pub temporary_impact_coeff: f64,
    /// Permanent impact coefficient (Almgren-Chriss gamma parameter)
    pub permanent_impact_coeff: f64,
    /// Daily volatility of the instrument (decimal, e.g., 0.02 = 2%)
    pub daily_volatility: f64,
}

impl Default for SlippageConfig {
    fn default() -> Self {
        Self {
            model: SlippageModel::FixedBps,
            fixed_bps: 5.0,
            avg_daily_volume: 1_000_000.0,
            bid_ask_spread_bps: 2.0,
            temporary_impact_coeff: 0.1,
            permanent_impact_coeff: 0.05,
            daily_volatility: 0.02,
        }
    }
}

/// Compute slippage in price units for a given order
///
/// Returns the absolute price impact (always positive).
/// Caller should add this to buy price or subtract from sell price.
pub fn compute_slippage(
    price: f64,
    quantity: i64,
    config: &SlippageConfig,
) -> f64 {
    match config.model {
        SlippageModel::FixedBps => {
            price * config.fixed_bps / 10_000.0
        }
        SlippageModel::VolumeDep => {
            compute_volume_dependent_slippage(price, quantity, config)
        }
        SlippageModel::AlmgrenChriss => {
            compute_almgren_chriss(price, quantity, config)
        }
    }
}

/// Apply slippage to a price
pub fn slippage_adjusted_price(price: f64, quantity: i64, is_buy: bool, config: &SlippageConfig) -> f64 {
    let impact = compute_slippage(price, quantity, config);
    if is_buy {
        price + impact
    } else {
        price - impact
    }
}

/// Volume-dependent slippage model:
/// Base = half the bid-ask spread
/// + Market impact proportional to (order_size / ADV)^0.5 * daily_vol * price
///
/// The square-root law is widely observed empirically (Bouchaud et al.)
fn compute_volume_dependent_slippage(price: f64, quantity: i64, config: &SlippageConfig) -> f64 {
    let qty = quantity.unsigned_abs() as f64;
    let adv = config.avg_daily_volume.max(1.0);

    let half_spread = price * config.bid_ask_spread_bps / 20_000.0;

    let participation = (qty / adv).min(1.0);
    let market_impact = config.daily_volatility * price * participation.sqrt();

    half_spread + market_impact
}

/// Almgren-Chriss market impact model:
///
/// Total cost = Temporary impact + Permanent impact
/// Temporary impact = eta * sigma * (n / V)^0.6
/// Permanent impact = gamma * sigma * (n / V)
///
/// Where:
///   eta = temporary impact coefficient
///   gamma = permanent impact coefficient
///   sigma = daily volatility
///   n = order quantity
///   V = average daily volume
fn compute_almgren_chriss(price: f64, quantity: i64, config: &SlippageConfig) -> f64 {
    let qty = quantity.unsigned_abs() as f64;
    let adv = config.avg_daily_volume.max(1.0);
    let sigma = config.daily_volatility;
    let eta = config.temporary_impact_coeff;
    let gamma = config.permanent_impact_coeff;

    let participation = qty / adv;

    let temporary = eta * sigma * price * participation.powf(0.6);
    let permanent = gamma * sigma * price * participation;

    let half_spread = price * config.bid_ask_spread_bps / 20_000.0;

    half_spread + temporary + permanent
}

/// Estimate expected slippage cost for a trade (for pre-trade analytics / TCA)
pub fn estimate_trade_cost(
    price: f64,
    quantity: i64,
    config: &SlippageConfig,
) -> SlippageCostEstimate {
    let qty = quantity.unsigned_abs() as f64;
    let adv = config.avg_daily_volume.max(1.0);

    let slippage_per_share = compute_slippage(price, quantity, config);
    let total_slippage_cost = slippage_per_share * qty;
    let slippage_bps = if price > 0.0 { slippage_per_share / price * 10_000.0 } else { 0.0 };
    let participation_rate = qty / adv;

    let half_spread = price * config.bid_ask_spread_bps / 20_000.0;
    let spread_cost = half_spread * qty;

    let market_impact_cost = total_slippage_cost - spread_cost;

    SlippageCostEstimate {
        slippage_bps,
        slippage_per_share,
        total_slippage_cost,
        spread_cost,
        market_impact_cost,
        participation_rate,
        model: config.model,
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SlippageCostEstimate {
    pub slippage_bps: f64,
    pub slippage_per_share: f64,
    pub total_slippage_cost: f64,
    pub spread_cost: f64,
    pub market_impact_cost: f64,
    pub participation_rate: f64,
    pub model: SlippageModel,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_fixed_bps_slippage() {
        let config = SlippageConfig {
            model: SlippageModel::FixedBps,
            fixed_bps: 5.0,
            ..Default::default()
        };
        let slip = compute_slippage(1000.0, 100, &config);
        assert!((slip - 0.50).abs() < 0.01, "5 bps of 1000 = 0.50, got {}", slip);
    }

    #[test]
    fn test_fixed_bps_adjusted_price() {
        let config = SlippageConfig::default();
        let buy = slippage_adjusted_price(1000.0, 100, true, &config);
        let sell = slippage_adjusted_price(1000.0, 100, false, &config);
        assert!(buy > 1000.0, "buy price should be higher");
        assert!(sell < 1000.0, "sell price should be lower");
    }

    #[test]
    fn test_volume_dep_small_order_low_slippage() {
        let config = SlippageConfig {
            model: SlippageModel::VolumeDep,
            avg_daily_volume: 1_000_000.0,
            bid_ask_spread_bps: 2.0,
            daily_volatility: 0.02,
            ..Default::default()
        };
        let slip_small = compute_slippage(1000.0, 100, &config);
        let slip_large = compute_slippage(1000.0, 100_000, &config);
        assert!(slip_large > slip_small, "larger orders should have more slippage");
    }

    #[test]
    fn test_volume_dep_scales_with_sqrt() {
        let config = SlippageConfig {
            model: SlippageModel::VolumeDep,
            avg_daily_volume: 1_000_000.0,
            bid_ask_spread_bps: 0.0,
            daily_volatility: 0.02,
            ..Default::default()
        };
        let slip_1k = compute_slippage(1000.0, 1000, &config);
        let slip_4k = compute_slippage(1000.0, 4000, &config);
        let ratio = slip_4k / slip_1k;
        assert!((ratio - 2.0).abs() < 0.1, "4x quantity should give ~2x slippage (sqrt), got ratio {}", ratio);
    }

    #[test]
    fn test_almgren_chriss_basic() {
        let config = SlippageConfig {
            model: SlippageModel::AlmgrenChriss,
            avg_daily_volume: 500_000.0,
            daily_volatility: 0.025,
            temporary_impact_coeff: 0.1,
            permanent_impact_coeff: 0.05,
            bid_ask_spread_bps: 3.0,
            ..Default::default()
        };
        let slip = compute_slippage(2500.0, 5000, &config);
        assert!(slip > 0.0, "slippage must be positive");
        assert!(slip < 2500.0 * 0.01, "slippage should be < 1% for 1% participation");
    }

    #[test]
    fn test_almgren_chriss_larger_order_more_impact() {
        let config = SlippageConfig {
            model: SlippageModel::AlmgrenChriss,
            avg_daily_volume: 1_000_000.0,
            daily_volatility: 0.02,
            temporary_impact_coeff: 0.1,
            permanent_impact_coeff: 0.05,
            bid_ask_spread_bps: 2.0,
            ..Default::default()
        };
        let slip_small = compute_slippage(1000.0, 1000, &config);
        let slip_large = compute_slippage(1000.0, 50_000, &config);
        assert!(slip_large > slip_small * 3.0,
            "50x qty should have significantly more impact: {} vs {}", slip_large, slip_small);
    }

    #[test]
    fn test_cost_estimate_structure() {
        let config = SlippageConfig {
            model: SlippageModel::AlmgrenChriss,
            avg_daily_volume: 1_000_000.0,
            daily_volatility: 0.02,
            bid_ask_spread_bps: 3.0,
            ..Default::default()
        };
        let est = estimate_trade_cost(2000.0, 10_000, &config);
        assert!(est.slippage_bps > 0.0);
        assert!(est.spread_cost > 0.0);
        assert!(est.market_impact_cost > 0.0);
        assert!((est.participation_rate - 0.01).abs() < 0.001);
        assert_eq!(est.model, SlippageModel::AlmgrenChriss);
    }

    #[test]
    fn test_model_parsing() {
        assert_eq!(SlippageModel::from_str_loose("volume_dep"), SlippageModel::VolumeDep);
        assert_eq!(SlippageModel::from_str_loose("almgren_chriss"), SlippageModel::AlmgrenChriss);
        assert_eq!(SlippageModel::from_str_loose("fixed"), SlippageModel::FixedBps);
    }
}
