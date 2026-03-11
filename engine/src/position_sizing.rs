use serde::{Deserialize, Serialize};

/// Position sizing algorithm
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum SizingMethod {
    /// Fixed quantity (legacy)
    Fixed,
    /// Fixed percentage of NAV
    NavPct,
    /// Kelly criterion: f* = (p*b - q) / b where p=win_rate, b=avg_win/avg_loss, q=1-p
    Kelly,
    /// Half-Kelly: more conservative variant (f*/2)
    HalfKelly,
    /// Risk-parity: size inversely proportional to asset volatility
    RiskParity,
    /// Volatility-targeting: scale position to target a specific portfolio volatility
    VolTarget,
    /// Regime-adaptive: adjusts sizing based on current market regime
    RegimeAdaptive,
}

impl Default for SizingMethod {
    fn default() -> Self { Self::Fixed }
}

impl SizingMethod {
    pub fn from_str_loose(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "nav_pct" | "navpct" | "pct" => Self::NavPct,
            "kelly" => Self::Kelly,
            "half_kelly" | "halfkelly" => Self::HalfKelly,
            "risk_parity" | "riskparity" => Self::RiskParity,
            "vol_target" | "voltarget" | "volatility" => Self::VolTarget,
            "regime" | "regime_adaptive" | "regimeadaptive" => Self::RegimeAdaptive,
            _ => Self::Fixed,
        }
    }
}

/// Input context for sizing calculation
pub struct SizingContext {
    pub nav: f64,
    pub price: f64,
    pub win_rate: f64,
    pub avg_win: f64,
    pub avg_loss: f64,
    pub asset_volatility: f64,
    pub target_volatility: f64,
    pub portfolio_volatility: f64,
    pub regime: MarketRegime,
    pub signal_confidence: f64,
    pub max_position_pct: f64,
    pub default_qty: i64,
}

impl Default for SizingContext {
    fn default() -> Self {
        Self {
            nav: 1_000_000.0,
            price: 100.0,
            win_rate: 0.5,
            avg_win: 1.0,
            avg_loss: 1.0,
            asset_volatility: 0.02,
            target_volatility: 0.15,
            portfolio_volatility: 0.12,
            regime: MarketRegime::Normal,
            signal_confidence: 0.7,
            max_position_pct: 20.0,
            default_qty: 1,
        }
    }
}

/// Simplified market regime for sizing
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MarketRegime {
    /// Low volatility bull market — can size larger
    BullLowVol,
    /// High volatility bull market — moderate sizing
    BullHighVol,
    /// Low volatility bear — cautious sizing
    BearLowVol,
    /// High volatility bear / crisis — minimal sizing
    BearHighVol,
    /// Sideways / range-bound
    Sideways,
    /// Unknown / default
    Normal,
}

impl MarketRegime {
    pub fn from_str_loose(s: &str) -> Self {
        match s.to_uppercase().as_str() {
            "BULL_LOW_VOL" => Self::BullLowVol,
            "BULL_HIGH_VOL" => Self::BullHighVol,
            "BEAR_LOW_VOL" => Self::BearLowVol,
            "BEAR_HIGH_VOL" => Self::BearHighVol,
            "SIDEWAYS" => Self::Sideways,
            _ => Self::Normal,
        }
    }

    fn sizing_multiplier(&self) -> f64 {
        match self {
            Self::BullLowVol => 1.2,
            Self::BullHighVol => 0.8,
            Self::BearLowVol => 0.6,
            Self::BearHighVol => 0.3,
            Self::Sideways => 0.7,
            Self::Normal => 1.0,
        }
    }
}

/// Compute the optimal quantity for a position given the sizing method and context
pub fn compute_quantity(method: SizingMethod, ctx: &SizingContext) -> i64 {
    let raw_qty = match method {
        SizingMethod::Fixed => {
            return ctx.default_qty;
        }
        SizingMethod::NavPct => {
            nav_pct_sizing(ctx)
        }
        SizingMethod::Kelly => {
            kelly_sizing(ctx, 1.0)
        }
        SizingMethod::HalfKelly => {
            kelly_sizing(ctx, 0.5)
        }
        SizingMethod::RiskParity => {
            risk_parity_sizing(ctx)
        }
        SizingMethod::VolTarget => {
            vol_target_sizing(ctx)
        }
        SizingMethod::RegimeAdaptive => {
            regime_adaptive_sizing(ctx)
        }
    };

    let max_qty = (ctx.nav * ctx.max_position_pct / 100.0 / ctx.price).max(1.0) as i64;
    raw_qty.max(1).min(max_qty)
}

/// Simple NAV percentage sizing
fn nav_pct_sizing(ctx: &SizingContext) -> i64 {
    let max_value = ctx.nav * ctx.max_position_pct / 100.0;
    (max_value / ctx.price).max(1.0) as i64
}

/// Kelly criterion sizing: f* = (p*b - q) / b
/// scaled by a fraction (1.0 = full Kelly, 0.5 = half Kelly)
fn kelly_sizing(ctx: &SizingContext, fraction: f64) -> i64 {
    let p = ctx.win_rate.max(0.01).min(0.99);
    let q = 1.0 - p;
    let b = if ctx.avg_loss > 0.0 { ctx.avg_win / ctx.avg_loss } else { 1.0 };

    let kelly_f = (p * b - q) / b.max(0.01);
    let clamped = kelly_f.max(0.0).min(0.5) * fraction;

    let position_value = ctx.nav * clamped;
    (position_value / ctx.price).max(1.0) as i64
}

/// Risk-parity: size inversely proportional to asset volatility.
/// Target: each position contributes equally to portfolio risk.
/// quantity = (target_risk_budget / asset_vol) * (nav / price)
fn risk_parity_sizing(ctx: &SizingContext) -> i64 {
    let risk_budget = ctx.target_volatility / 100.0;
    let vol = ctx.asset_volatility.max(0.001);

    let weight = (risk_budget / vol).min(ctx.max_position_pct / 100.0);
    let position_value = ctx.nav * weight;
    (position_value / ctx.price).max(1.0) as i64
}

/// Volatility-targeting: scale position so that position vol ≈ target vol
/// quantity = (target_vol / asset_vol) * (nav / price) * (1/num_positions_assumed)
fn vol_target_sizing(ctx: &SizingContext) -> i64 {
    let asset_vol = ctx.asset_volatility.max(0.001);
    let target = ctx.target_volatility;

    let vol_scalar = (target / asset_vol).min(5.0);
    let assumed_positions = 5.0;
    let weight = (vol_scalar / assumed_positions).min(ctx.max_position_pct / 100.0);
    let position_value = ctx.nav * weight;
    (position_value / ctx.price).max(1.0) as i64
}

/// Regime-adaptive: base sizing on Kelly/vol-target, then scale by regime multiplier
/// and signal confidence
fn regime_adaptive_sizing(ctx: &SizingContext) -> i64 {
    let base_qty = vol_target_sizing(ctx) as f64;

    let regime_mult = ctx.regime.sizing_multiplier();
    let conf_mult = 0.5 + 0.5 * ctx.signal_confidence;

    (base_qty * regime_mult * conf_mult).max(1.0) as i64
}

/// Convenience: compute sizing and return a breakdown for logging/analytics
pub fn compute_with_breakdown(method: SizingMethod, ctx: &SizingContext) -> SizingResult {
    let qty = compute_quantity(method, ctx);
    let position_value = ctx.price * qty as f64;
    let nav_pct = if ctx.nav > 0.0 { position_value / ctx.nav * 100.0 } else { 0.0 };

    SizingResult {
        method,
        quantity: qty,
        position_value,
        nav_pct,
        regime: format!("{:?}", ctx.regime),
        regime_multiplier: ctx.regime.sizing_multiplier(),
    }
}

#[derive(Debug, Clone, Serialize)]
pub struct SizingResult {
    pub method: SizingMethod,
    pub quantity: i64,
    pub position_value: f64,
    pub nav_pct: f64,
    pub regime: String,
    pub regime_multiplier: f64,
}

#[cfg(test)]
mod tests {
    use super::*;

    fn default_ctx() -> SizingContext {
        SizingContext {
            nav: 1_000_000.0,
            price: 2500.0,
            win_rate: 0.55,
            avg_win: 5000.0,
            avg_loss: 3000.0,
            asset_volatility: 0.02,
            target_volatility: 0.15,
            portfolio_volatility: 0.12,
            regime: MarketRegime::Normal,
            signal_confidence: 0.8,
            max_position_pct: 20.0,
            default_qty: 10,
        }
    }

    #[test]
    fn test_fixed_returns_default() {
        let ctx = default_ctx();
        let qty = compute_quantity(SizingMethod::Fixed, &ctx);
        assert_eq!(qty, 10);
    }

    #[test]
    fn test_nav_pct() {
        let ctx = default_ctx();
        let qty = compute_quantity(SizingMethod::NavPct, &ctx);
        let value = qty as f64 * 2500.0;
        let pct = value / 1_000_000.0 * 100.0;
        assert!(pct <= 20.0 + 0.1, "should not exceed max_position_pct, got {}%", pct);
        assert!(qty > 0);
    }

    #[test]
    fn test_kelly_positive_edge() {
        let ctx = SizingContext {
            win_rate: 0.6,
            avg_win: 4000.0,
            avg_loss: 3000.0,
            ..default_ctx()
        };
        let qty = compute_quantity(SizingMethod::Kelly, &ctx);
        assert!(qty > 0, "positive edge should give positive sizing");
        let qty_half = compute_quantity(SizingMethod::HalfKelly, &ctx);
        assert!(qty_half <= qty, "half kelly should be <= full kelly");
    }

    #[test]
    fn test_kelly_no_edge_minimal() {
        let ctx = SizingContext {
            win_rate: 0.3,
            avg_win: 1000.0,
            avg_loss: 2000.0,
            ..default_ctx()
        };
        let qty = compute_quantity(SizingMethod::Kelly, &ctx);
        assert_eq!(qty, 1, "negative edge should give minimum sizing");
    }

    #[test]
    fn test_risk_parity_low_vol_more_shares() {
        let ctx_low_vol = SizingContext {
            asset_volatility: 0.01,
            ..default_ctx()
        };
        let ctx_high_vol = SizingContext {
            asset_volatility: 0.05,
            ..default_ctx()
        };
        let qty_low = compute_quantity(SizingMethod::RiskParity, &ctx_low_vol);
        let qty_high = compute_quantity(SizingMethod::RiskParity, &ctx_high_vol);
        assert!(qty_low > qty_high,
            "lower vol asset should get more shares: {} vs {}", qty_low, qty_high);
    }

    #[test]
    fn test_vol_target_scales_inversely() {
        let ctx_low = SizingContext {
            asset_volatility: 0.01,
            max_position_pct: 50.0,
            target_volatility: 0.05,
            ..default_ctx()
        };
        let ctx_high = SizingContext {
            asset_volatility: 0.10,
            max_position_pct: 50.0,
            target_volatility: 0.05,
            ..default_ctx()
        };
        let qty_low = compute_quantity(SizingMethod::VolTarget, &ctx_low);
        let qty_high = compute_quantity(SizingMethod::VolTarget, &ctx_high);
        assert!(qty_low > qty_high, "lower vol should get more: {} vs {}", qty_low, qty_high);
    }

    #[test]
    fn test_regime_adaptive_bear_reduces() {
        let ctx_bull = SizingContext { regime: MarketRegime::BullLowVol, ..default_ctx() };
        let ctx_bear = SizingContext { regime: MarketRegime::BearHighVol, ..default_ctx() };
        let qty_bull = compute_quantity(SizingMethod::RegimeAdaptive, &ctx_bull);
        let qty_bear = compute_quantity(SizingMethod::RegimeAdaptive, &ctx_bear);
        assert!(qty_bull > qty_bear,
            "bull should size larger than bear crisis: {} vs {}", qty_bull, qty_bear);
    }

    #[test]
    fn test_never_exceeds_max_position_pct() {
        let ctx = SizingContext {
            nav: 100_000.0,
            price: 100.0,
            max_position_pct: 10.0,
            target_volatility: 0.50,
            asset_volatility: 0.001,
            ..default_ctx()
        };
        for method in &[SizingMethod::NavPct, SizingMethod::Kelly, SizingMethod::RiskParity,
                        SizingMethod::VolTarget, SizingMethod::RegimeAdaptive] {
            let qty = compute_quantity(*method, &ctx);
            let value = qty as f64 * 100.0;
            let pct = value / 100_000.0 * 100.0;
            assert!(pct <= 10.0 + 0.1, "{:?}: position {}% exceeds max 10%", method, pct);
        }
    }

    #[test]
    fn test_breakdown_structure() {
        let ctx = default_ctx();
        let result = compute_with_breakdown(SizingMethod::Kelly, &ctx);
        assert!(result.quantity > 0);
        assert!(result.position_value > 0.0);
        assert!(result.nav_pct > 0.0);
        assert_eq!(result.regime_multiplier, 1.0);
    }

    #[test]
    fn test_method_parsing() {
        assert_eq!(SizingMethod::from_str_loose("kelly"), SizingMethod::Kelly);
        assert_eq!(SizingMethod::from_str_loose("half_kelly"), SizingMethod::HalfKelly);
        assert_eq!(SizingMethod::from_str_loose("risk_parity"), SizingMethod::RiskParity);
        assert_eq!(SizingMethod::from_str_loose("vol_target"), SizingMethod::VolTarget);
        assert_eq!(SizingMethod::from_str_loose("regime_adaptive"), SizingMethod::RegimeAdaptive);
        assert_eq!(SizingMethod::from_str_loose("unknown"), SizingMethod::Fixed);
    }
}
