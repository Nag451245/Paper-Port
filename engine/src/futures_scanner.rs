use serde::Serialize;
use tracing::{info, warn};

use crate::rate_limiter::RateLimiter;
use crate::universe::Universe;

// ─── Data Structures ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct FuturesAnalysis {
    pub symbol: String,
    pub spot_price: f64,
    pub futures_price: f64,
    pub basis_pct: f64,
    pub oi_change_pct: f64,
    pub oi_interpretation: String,
    pub signal: f64,
}

/// OI interpretation categories
fn interpret_oi(price_change_pct: f64, oi_rising: bool) -> &'static str {
    match (price_change_pct > 0.0, oi_rising) {
        (true, true)   => "long_buildup",
        (false, true)  => "short_buildup",
        (false, false) => "long_unwinding",
        (true, false)  => "short_covering",
    }
}

/// Convert OI interpretation to a directional signal [-1.0, 1.0]
fn interpretation_signal(interp: &str) -> f64 {
    match interp {
        "long_buildup"    =>  0.8,
        "short_covering"  =>  0.4,
        "long_unwinding"  => -0.4,
        "short_buildup"   => -0.8,
        _                 =>  0.0,
    }
}

// ─── Analysis Functions ──────────────────────────────────────────────

/// Analyze a single F&O symbol by fetching spot and futures data.
pub fn analyze_futures(
    limiter: &RateLimiter,
    bridge_url: &str,
    symbol: &str,
) -> Option<FuturesAnalysis> {
    let spot = match crate::rate_limiter::rate_limited_quote(limiter, bridge_url, symbol) {
        Ok((price, _)) => price,
        Err(e) => {
            warn!(symbol = symbol, error = %e, "Failed to fetch spot price for futures analysis");
            return None;
        }
    };

    let fut_symbol = format!("{}-FUT", symbol);
    let (futures_price, _fut_vol) = match crate::rate_limiter::rate_limited_quote(limiter, bridge_url, &fut_symbol) {
        Ok(q) => q,
        Err(_) => {
            let fut_symbol2 = format!("{}FUT", symbol);
            match crate::rate_limiter::rate_limited_quote(limiter, bridge_url, &fut_symbol2) {
                Ok(q) => q,
                Err(e) => {
                    warn!(symbol = symbol, error = %e, "Failed to fetch futures price");
                    return None;
                }
            }
        }
    };

    if spot <= 0.0 || futures_price <= 0.0 {
        return None;
    }

    let basis_pct = (futures_price - spot) / spot * 100.0;

    // Approximate OI change using price change as proxy when real OI data unavailable
    let price_change_pct = (futures_price - spot) / spot * 100.0;
    let oi_change_pct = price_change_pct.abs() * 0.5; // conservative estimate
    let oi_signed = if price_change_pct > 0.0 { oi_change_pct } else { -oi_change_pct };

    let interpretation = interpret_oi(price_change_pct, oi_signed > 0.0);
    let signal = interpretation_signal(interpretation);

    // Adjust signal by basis magnitude — high premium is bullish, discount is bearish
    let basis_adj = (basis_pct / 2.0).clamp(-0.2, 0.2);
    let final_signal = (signal + basis_adj).clamp(-1.0, 1.0);

    Some(FuturesAnalysis {
        symbol: symbol.to_string(),
        spot_price: spot,
        futures_price,
        basis_pct,
        oi_change_pct: oi_signed,
        oi_interpretation: interpretation.to_string(),
        signal: final_signal,
    })
}

/// Scan all F&O stocks in the universe for futures signals.
pub fn scan_futures(
    limiter: &RateLimiter,
    bridge_url: &str,
    universe: &Universe,
) -> Vec<FuturesAnalysis> {
    let fno = universe.fno_stocks();
    info!(fno_count = fno.len(), "Starting futures scan");

    let results: Vec<FuturesAnalysis> = fno.iter()
        .filter_map(|stock| analyze_futures(limiter, bridge_url, &stock.symbol))
        .collect();

    info!(
        scanned = results.len(),
        bullish = results.iter().filter(|r| r.signal > 0.3).count(),
        bearish = results.iter().filter(|r| r.signal < -0.3).count(),
        "Futures scan complete"
    );

    results
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_interpret_oi() {
        assert_eq!(interpret_oi(2.0, true), "long_buildup");
        assert_eq!(interpret_oi(-2.0, true), "short_buildup");
        assert_eq!(interpret_oi(-2.0, false), "long_unwinding");
        assert_eq!(interpret_oi(2.0, false), "short_covering");
    }

    #[test]
    fn test_interpretation_signal() {
        assert!(interpretation_signal("long_buildup") > 0.0);
        assert!(interpretation_signal("short_buildup") < 0.0);
        assert!(interpretation_signal("short_covering") > 0.0);
        assert!(interpretation_signal("long_unwinding") < 0.0);
    }

    #[test]
    fn test_signal_clamped() {
        let signal = interpretation_signal("long_buildup");
        assert!(signal >= -1.0 && signal <= 1.0);
    }
}
