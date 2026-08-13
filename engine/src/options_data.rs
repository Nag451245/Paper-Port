use std::sync::Arc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tracing::{info, warn};

use crate::config::OptionsConfig;
use crate::state::AppState;

// ─── Data Structures ─────────────────────────────────────────────────

/// Per-strike summary carried inside an OptionsSnapshot.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrikeSummary {
    pub strike: f64,
    pub call_oi: i64,
    pub put_oi: i64,
    pub call_iv: f64,
    pub put_iv: f64,
    pub call_ltp: f64,
    pub put_ltp: f64,
}

/// Aggregated options data for a single symbol at a point in time.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptionsSnapshot {
    pub symbol: String,
    pub expiry: String,
    pub spot_price: f64,
    pub pcr: f64,
    pub max_pain: f64,
    pub total_call_oi: i64,
    pub total_put_oi: i64,
    pub atm_iv: f64,
    pub lot_size: i64,
    pub strikes: Vec<StrikeSummary>,
    pub timestamp: String,
}

/// Concurrent options data store — mirrors `LivePriceStore` pattern.
pub struct OptionsDataStore {
    snapshots: DashMap<String, OptionsSnapshot>,
    previous: DashMap<String, OptionsSnapshot>,
}

impl OptionsDataStore {
    pub fn new() -> Arc<Self> {
        Arc::new(Self {
            snapshots: DashMap::new(),
            previous: DashMap::new(),
        })
    }

    pub fn update(&self, snap: OptionsSnapshot) {
        if let Some(old) = self.snapshots.get(&snap.symbol) {
            self.previous.insert(snap.symbol.clone(), old.value().clone());
        }
        self.snapshots.insert(snap.symbol.clone(), snap);
    }

    pub fn get(&self, symbol: &str) -> Option<OptionsSnapshot> {
        self.snapshots.get(symbol).map(|s| s.value().clone())
    }

    pub fn get_previous(&self, symbol: &str) -> Option<OptionsSnapshot> {
        self.previous.get(symbol).map(|s| s.value().clone())
    }

    pub fn all_snapshots(&self) -> Vec<OptionsSnapshot> {
        self.snapshots.iter().map(|e| e.value().clone()).collect()
    }

    pub fn symbol_count(&self) -> usize {
        self.snapshots.len()
    }
}

// ─── Bridge Polling ──────────────────────────────────────────────────

/// Parse the bridge `/option-chain/{symbol}` JSON into an `OptionsSnapshot`.
fn parse_option_chain(symbol: &str, data: &serde_json::Value) -> Result<OptionsSnapshot, String> {
    let spot = data.get("spotPrice")
        .or_else(|| data.get("underlyingValue"))
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    let pcr = data.get("pcr").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let max_pain = data.get("maxPain").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let total_call_oi = data.get("totalCallOI").and_then(|v| v.as_i64()).unwrap_or(0);
    let total_put_oi = data.get("totalPutOI").and_then(|v| v.as_i64()).unwrap_or(0);
    let lot_size = data.get("lotSize").and_then(|v| v.as_i64()).unwrap_or(1);

    let expiry = data.get("expiry")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let strikes_arr = data.get("strikes")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    let mut strikes = Vec::with_capacity(strikes_arr.len());
    let mut atm_iv = 0.0_f64;
    let mut atm_dist = f64::MAX;

    for s in &strikes_arr {
        let strike = s.get("strike").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let call_oi = s.get("callOI").and_then(|v| v.as_i64()).unwrap_or(0);
        let put_oi = s.get("putOI").and_then(|v| v.as_i64()).unwrap_or(0);
        let call_iv = s.get("callIV").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let put_iv = s.get("putIV").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let call_ltp = s.get("callLTP").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let put_ltp = s.get("putLTP").and_then(|v| v.as_f64()).unwrap_or(0.0);

        let dist = (strike - spot).abs();
        if dist < atm_dist {
            atm_dist = dist;
            atm_iv = (call_iv + put_iv) / 2.0;
        }

        strikes.push(StrikeSummary {
            strike, call_oi, put_oi, call_iv, put_iv, call_ltp, put_ltp,
        });
    }

    if spot <= 0.0 && strikes.is_empty() {
        return Err(format!("Empty option chain for {}", symbol));
    }

    Ok(OptionsSnapshot {
        symbol: symbol.to_string(),
        expiry,
        spot_price: spot,
        pcr,
        max_pain,
        total_call_oi,
        total_put_oi,
        atm_iv,
        lot_size,
        strikes,
        timestamp: chrono::Utc::now().to_rfc3339(),
    })
}

/// Fetch and parse a single option chain from the bridge.
fn poll_option_chain(bridge_url: &str, symbol: &str) -> Result<OptionsSnapshot, String> {
    let data = crate::broker_icici::bridge_get_option_chain(bridge_url, symbol, None)?;

    if let Some(err) = data.get("error").and_then(|v| v.as_str()) {
        return Err(format!("{}: {}", symbol, err));
    }

    parse_option_chain(symbol, &data)
}

/// Rate-limited polling loop for option chains.
async fn options_polling_loop(
    store: &Arc<OptionsDataStore>,
    state: &Arc<AppState>,
    bridge_url: &str,
    symbols: &[String],
    config: &OptionsConfig,
) {
    let inter_call_delay = std::time::Duration::from_millis(config.poll_delay_ms.max(100));
    let cycle_pause = std::time::Duration::from_secs(config.poll_cycle_pause_secs.max(10));

    loop {
        for symbol in symbols {
            let url = bridge_url.to_string();
            let sym = symbol.clone();
            let result = tokio::task::spawn_blocking(move || {
                poll_option_chain(&url, &sym)
            }).await;

            match result {
                Ok(Ok(snap)) => {
                    store.update(snap);
                }
                Ok(Err(e)) => {
                    warn!(symbol = %symbol, error = %e, "Option chain poll failed");
                }
                Err(e) => {
                    warn!(symbol = %symbol, error = %e, "Option chain poll task panicked");
                }
            }

            tokio::time::sleep(inter_call_delay).await;
        }

        run_options_strategies(store, state, config);

        tokio::time::sleep(cycle_pause).await;
    }
}

/// Public entry point — call from `main.rs` to start the options data feed.
pub async fn start_options_feed(
    store: Arc<OptionsDataStore>,
    state: Arc<AppState>,
    bridge_url: &str,
    symbols: &[String],
    config: &OptionsConfig,
) {
    if symbols.is_empty() {
        info!("Options feed: no symbols configured, skipping");
        return;
    }
    info!(count = symbols.len(), "Starting options chain feed");
    options_polling_loop(&store, &state, bridge_url, symbols, config).await;
}

// ─── Options Strategies ──────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OptionsSignal {
    pub symbol: String,
    pub strategy: String,
    pub side: String,
    pub confidence: f64,
    pub reason: String,
}

/// Evaluate all four options strategies for every symbol that has data.
fn run_options_strategies(
    store: &Arc<OptionsDataStore>,
    state: &Arc<AppState>,
    config: &OptionsConfig,
) {
    for snap in store.all_snapshots() {
        let prev = store.get_previous(&snap.symbol);
        let spot = state.live_prices.get_ltp(&snap.symbol).unwrap_or(snap.spot_price);

        let signals = [
            eval_oi_buildup(&snap, prev.as_ref(), spot, config),
            eval_pcr_extremes(&snap, prev.as_ref(), config),
            eval_iv_crush(&snap, prev.as_ref(), config),
            eval_max_pain_convergence(&snap, spot, config),
        ];

        for sig in signals.into_iter().flatten() {
            state.cache_signal(crate::state::CachedSignal {
                symbol: sig.symbol.clone(),
                strategy: sig.strategy.clone(),
                side: sig.side.clone(),
                price: spot,
                confidence: sig.confidence,
                reason: sig.reason.clone(),
                timestamp: chrono::Utc::now().to_rfc3339(),
                ttl_seconds: config.poll_cycle_pause_secs + 30,
                stop_loss: None,
                take_profit: None,
                suggested_qty: None,
            });
        }
    }
}

// ── 1. OI Buildup Detection ─────────────────────────────────────────

fn eval_oi_buildup(
    snap: &OptionsSnapshot,
    prev: Option<&OptionsSnapshot>,
    spot: f64,
    config: &OptionsConfig,
) -> Option<OptionsSignal> {
    let prev = prev?;
    if prev.total_call_oi == 0 && prev.total_put_oi == 0 {
        return None;
    }

    let prev_total_oi = prev.total_call_oi + prev.total_put_oi;
    let curr_total_oi = snap.total_call_oi + snap.total_put_oi;
    if prev_total_oi == 0 {
        return None;
    }

    let oi_change_pct = (curr_total_oi - prev_total_oi) as f64 / prev_total_oi as f64 * 100.0;
    let price_change = spot - prev.spot_price;
    let threshold = config.oi_change_threshold_pct;

    let (side, label, confidence) = if oi_change_pct > threshold && price_change > 0.0 {
        ("buy", "Long buildup", 0.75)
    } else if oi_change_pct > threshold && price_change < 0.0 {
        ("sell", "Short buildup", 0.75)
    } else if oi_change_pct < -threshold && price_change < 0.0 {
        ("sell", "Long unwinding", 0.60)
    } else if oi_change_pct < -threshold && price_change > 0.0 {
        ("buy", "Short covering", 0.60)
    } else {
        return None;
    };

    Some(OptionsSignal {
        symbol: snap.symbol.clone(),
        strategy: "oi_buildup".into(),
        side: side.into(),
        confidence,
        reason: format!(
            "{}: OI {}{:.1}%, price {}{:.2}",
            label,
            if oi_change_pct >= 0.0 { "+" } else { "" },
            oi_change_pct,
            if price_change >= 0.0 { "+" } else { "" },
            price_change,
        ),
    })
}

// ── 2. PCR Extremes (Contrarian) ────────────────────────────────────

fn eval_pcr_extremes(
    snap: &OptionsSnapshot,
    prev: Option<&OptionsSnapshot>,
    config: &OptionsConfig,
) -> Option<OptionsSignal> {
    if snap.pcr <= 0.0 {
        return None;
    }

    let pcr_roc = prev
        .filter(|p| p.pcr > 0.0)
        .map(|p| (snap.pcr - p.pcr) / p.pcr * 100.0)
        .unwrap_or(0.0);

    let roc_boost = (pcr_roc.abs() / 50.0).min(0.15);

    let (side, label, base_conf) = if snap.pcr >= config.pcr_high_threshold {
        ("buy", "PCR high (contrarian bullish)", 0.70)
    } else if snap.pcr <= config.pcr_low_threshold {
        ("sell", "PCR low (contrarian bearish)", 0.70)
    } else {
        return None;
    };

    Some(OptionsSignal {
        symbol: snap.symbol.clone(),
        strategy: "pcr_extremes".into(),
        side: side.into(),
        confidence: (base_conf + roc_boost).min(0.95),
        reason: format!(
            "{}: PCR={:.2}, RoC={:+.1}%",
            label, snap.pcr, pcr_roc,
        ),
    })
}

// ── 3. IV Crush / Expansion Detection ───────────────────────────────

fn eval_iv_crush(
    snap: &OptionsSnapshot,
    prev: Option<&OptionsSnapshot>,
    config: &OptionsConfig,
) -> Option<OptionsSignal> {
    let prev = prev?;
    if prev.atm_iv <= 0.0 || snap.atm_iv <= 0.0 {
        return None;
    }

    let iv_change_pct = (snap.atm_iv - prev.atm_iv) / prev.atm_iv * 100.0;
    let threshold = config.iv_crush_threshold_pct;

    let (side, label, confidence) = if iv_change_pct < -threshold {
        ("sell", "IV Crush", 0.70)
    } else if iv_change_pct > threshold {
        ("buy", "IV Expansion", 0.65)
    } else {
        return None;
    };

    Some(OptionsSignal {
        symbol: snap.symbol.clone(),
        strategy: "iv_crush".into(),
        side: side.into(),
        confidence,
        reason: format!(
            "{}: ATM IV {:.1}% -> {:.1}% ({:+.1}%)",
            label, prev.atm_iv * 100.0, snap.atm_iv * 100.0, iv_change_pct,
        ),
    })
}

// ── 4. Max Pain Convergence ─────────────────────────────────────────

fn eval_max_pain_convergence(
    snap: &OptionsSnapshot,
    spot: f64,
    config: &OptionsConfig,
) -> Option<OptionsSignal> {
    if snap.max_pain <= 0.0 || spot <= 0.0 {
        return None;
    }

    let distance_pct = (spot - snap.max_pain) / snap.max_pain * 100.0;

    if distance_pct.abs() > config.max_pain_proximity_pct {
        return None;
    }

    let (side, label) = if distance_pct > 0.0 {
        ("sell", "Spot above max pain — expect pull down")
    } else {
        ("buy", "Spot below max pain — expect pull up")
    };

    let proximity_factor = 1.0 - (distance_pct.abs() / config.max_pain_proximity_pct);
    let confidence = 0.55 + 0.25 * proximity_factor;

    Some(OptionsSignal {
        symbol: snap.symbol.clone(),
        strategy: "max_pain_convergence".into(),
        side: side.into(),
        confidence: confidence.min(0.80),
        reason: format!(
            "{}: spot={:.0}, maxPain={:.0}, dist={:+.2}%",
            label, spot, snap.max_pain, distance_pct,
        ),
    })
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn default_config() -> OptionsConfig {
        OptionsConfig::default()
    }

    fn sample_snapshot(symbol: &str) -> OptionsSnapshot {
        OptionsSnapshot {
            symbol: symbol.into(),
            expiry: "2026-03-26".into(),
            spot_price: 22000.0,
            pcr: 1.0,
            max_pain: 22000.0,
            total_call_oi: 500_000,
            total_put_oi: 500_000,
            atm_iv: 0.15,
            lot_size: 50,
            strikes: vec![],
            timestamp: "2026-03-11T10:00:00Z".into(),
        }
    }

    #[test]
    fn test_options_data_store_update_and_get() {
        let store = OptionsDataStore::new();
        let snap = sample_snapshot("NIFTY");
        store.update(snap.clone());
        let got = store.get("NIFTY").unwrap();
        assert_eq!(got.symbol, "NIFTY");
        assert_eq!(got.pcr, 1.0);
        assert!(store.get_previous("NIFTY").is_none());

        let mut snap2 = sample_snapshot("NIFTY");
        snap2.pcr = 1.3;
        store.update(snap2);
        let prev = store.get_previous("NIFTY").unwrap();
        assert_eq!(prev.pcr, 1.0);
        assert_eq!(store.get("NIFTY").unwrap().pcr, 1.3);
    }

    #[test]
    fn test_parse_option_chain_valid() {
        let data = json!({
            "symbol": "NIFTY",
            "spotPrice": 22500.0,
            "pcr": 1.2,
            "maxPain": 22400.0,
            "totalCallOI": 1000000,
            "totalPutOI": 1200000,
            "lotSize": 50,
            "expiry": "2026-03-26",
            "strikes": [
                { "strike": 22400.0, "callOI": 50000, "putOI": 60000,
                  "callIV": 0.14, "putIV": 0.15, "callLTP": 180.0, "putLTP": 80.0 },
                { "strike": 22500.0, "callOI": 70000, "putOI": 55000,
                  "callIV": 0.13, "putIV": 0.14, "callLTP": 120.0, "putLTP": 120.0 },
            ]
        });
        let snap = parse_option_chain("NIFTY", &data).unwrap();
        assert_eq!(snap.symbol, "NIFTY");
        assert_eq!(snap.pcr, 1.2);
        assert_eq!(snap.total_call_oi, 1_000_000);
        assert_eq!(snap.strikes.len(), 2);
        assert!(snap.atm_iv > 0.0);
    }

    #[test]
    fn test_oi_buildup_long() {
        let cfg = default_config();
        let mut prev = sample_snapshot("NIFTY");
        prev.total_call_oi = 400_000;
        prev.total_put_oi = 400_000;
        prev.spot_price = 21800.0;

        let mut curr = sample_snapshot("NIFTY");
        curr.total_call_oi = 500_000;
        curr.total_put_oi = 500_000;

        let sig = eval_oi_buildup(&curr, Some(&prev), 22200.0, &cfg).unwrap();
        assert_eq!(sig.side, "buy");
        assert!(sig.reason.contains("Long buildup"));
    }

    #[test]
    fn test_oi_buildup_short() {
        let cfg = default_config();
        let mut prev = sample_snapshot("NIFTY");
        prev.total_call_oi = 400_000;
        prev.total_put_oi = 400_000;
        prev.spot_price = 22200.0;

        let mut curr = sample_snapshot("NIFTY");
        curr.total_call_oi = 500_000;
        curr.total_put_oi = 500_000;

        let sig = eval_oi_buildup(&curr, Some(&prev), 21800.0, &cfg).unwrap();
        assert_eq!(sig.side, "sell");
        assert!(sig.reason.contains("Short buildup"));
    }

    #[test]
    fn test_oi_buildup_no_signal_within_threshold() {
        let cfg = default_config();
        let prev = sample_snapshot("NIFTY");
        let mut curr = sample_snapshot("NIFTY");
        curr.total_call_oi = prev.total_call_oi + 1000;
        curr.total_put_oi = prev.total_put_oi + 1000;

        assert!(eval_oi_buildup(&curr, Some(&prev), 22050.0, &cfg).is_none());
    }

    #[test]
    fn test_pcr_high_contrarian_bullish() {
        let cfg = default_config();
        let mut snap = sample_snapshot("BANKNIFTY");
        snap.pcr = 1.8;

        let sig = eval_pcr_extremes(&snap, None, &cfg).unwrap();
        assert_eq!(sig.side, "buy");
        assert!(sig.reason.contains("contrarian bullish"));
    }

    #[test]
    fn test_pcr_low_contrarian_bearish() {
        let cfg = default_config();
        let mut snap = sample_snapshot("BANKNIFTY");
        snap.pcr = 0.3;

        let sig = eval_pcr_extremes(&snap, None, &cfg).unwrap();
        assert_eq!(sig.side, "sell");
        assert!(sig.reason.contains("contrarian bearish"));
    }

    #[test]
    fn test_pcr_neutral_no_signal() {
        let cfg = default_config();
        let snap = sample_snapshot("NIFTY"); // pcr=1.0
        assert!(eval_pcr_extremes(&snap, None, &cfg).is_none());
    }

    #[test]
    fn test_iv_crush() {
        let cfg = default_config();
        let mut prev = sample_snapshot("RELIANCE");
        prev.atm_iv = 0.40;

        let mut curr = sample_snapshot("RELIANCE");
        curr.atm_iv = 0.28; // -30% drop

        let sig = eval_iv_crush(&curr, Some(&prev), &cfg).unwrap();
        assert_eq!(sig.side, "sell");
        assert!(sig.reason.contains("IV Crush"));
    }

    #[test]
    fn test_iv_expansion() {
        let cfg = default_config();
        let mut prev = sample_snapshot("RELIANCE");
        prev.atm_iv = 0.15;

        let mut curr = sample_snapshot("RELIANCE");
        curr.atm_iv = 0.20; // +33% rise

        let sig = eval_iv_crush(&curr, Some(&prev), &cfg).unwrap();
        assert_eq!(sig.side, "buy");
        assert!(sig.reason.contains("IV Expansion"));
    }

    #[test]
    fn test_iv_no_signal_within_threshold() {
        let cfg = default_config();
        let mut prev = sample_snapshot("NIFTY");
        prev.atm_iv = 0.15;

        let mut curr = sample_snapshot("NIFTY");
        curr.atm_iv = 0.14; // only ~6.7%

        assert!(eval_iv_crush(&curr, Some(&prev), &cfg).is_none());
    }

    #[test]
    fn test_max_pain_convergence_above() {
        let cfg = default_config();
        let mut snap = sample_snapshot("NIFTY");
        snap.max_pain = 22000.0;
        let spot = 22300.0; // ~1.36% above — within 2%

        let sig = eval_max_pain_convergence(&snap, spot, &cfg).unwrap();
        assert_eq!(sig.side, "sell");
        assert!(sig.reason.contains("above max pain"));
    }

    #[test]
    fn test_max_pain_convergence_below() {
        let cfg = default_config();
        let mut snap = sample_snapshot("NIFTY");
        snap.max_pain = 22000.0;
        let spot = 21700.0; // ~1.36% below

        let sig = eval_max_pain_convergence(&snap, spot, &cfg).unwrap();
        assert_eq!(sig.side, "buy");
        assert!(sig.reason.contains("below max pain"));
    }

    #[test]
    fn test_max_pain_no_signal_far() {
        let cfg = default_config();
        let mut snap = sample_snapshot("NIFTY");
        snap.max_pain = 22000.0;
        let spot = 23000.0; // ~4.5% away

        assert!(eval_max_pain_convergence(&snap, spot, &cfg).is_none());
    }

    #[test]
    fn test_store_all_snapshots() {
        let store = OptionsDataStore::new();
        store.update(sample_snapshot("NIFTY"));
        store.update(sample_snapshot("BANKNIFTY"));
        assert_eq!(store.symbol_count(), 2);
        assert_eq!(store.all_snapshots().len(), 2);
    }
}
