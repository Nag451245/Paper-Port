use std::sync::Arc;
use std::collections::HashMap;
use serde::{Deserialize, Serialize};
use tracing::{info, warn, error};

use crate::state::{AppState, CachedSignal};
use crate::broker_icici;
use crate::scan;
use crate::broker::{OrderRequest, OrderSide, OrderType, ProductType, OrderStatus};
use crate::position_sizing::{SizingMethod, SizingContext, MarketRegime, compute_quantity};
use crate::config::PremarketConfig;

// ─── Universe Source ──────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct UniverseSymbol {
    pub symbol: String,
    #[serde(default)]
    pub name: String,
    #[serde(default)]
    pub sector: String,
    #[serde(default)]
    pub market_cap: f64,
    #[serde(default)]
    pub avg_volume: u64,
}

/// Load the symbol universe from a JSON file.
/// Expected format: array of objects with at least a "symbol" field.
/// Optional fields: "name", "sector", "market_cap", "avg_volume"
pub fn load_universe_from_file(path: &str) -> Result<Vec<UniverseSymbol>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read universe file {}: {}", path, e))?;
    let symbols: Vec<UniverseSymbol> = serde_json::from_str(&contents)
        .map_err(|e| format!("Failed to parse universe file: {}", e))?;
    if symbols.is_empty() {
        return Err("Universe file is empty".into());
    }
    info!(count = symbols.len(), path = path, "Loaded symbol universe from file");
    Ok(symbols)
}

/// Load universe from a simple text file (one symbol per line, # comments)
pub fn load_universe_from_text(path: &str) -> Result<Vec<UniverseSymbol>, String> {
    let contents = std::fs::read_to_string(path)
        .map_err(|e| format!("Failed to read universe file {}: {}", path, e))?;
    let symbols: Vec<UniverseSymbol> = contents.lines()
        .map(|l| l.trim())
        .filter(|l| !l.is_empty() && !l.starts_with('#'))
        .map(|l| {
            let parts: Vec<&str> = l.splitn(2, ',').collect();
            UniverseSymbol {
                symbol: parts[0].trim().to_uppercase(),
                name: parts.get(1).map(|s| s.trim().to_string()).unwrap_or_default(),
                sector: String::new(),
                market_cap: 0.0,
                avg_volume: 0,
            }
        })
        .collect();
    if symbols.is_empty() {
        return Err("Universe file is empty".into());
    }
    info!(count = symbols.len(), path = path, "Loaded symbol universe from text file");
    Ok(symbols)
}

/// Load from the configured source (file, or fallback to config symbols)
pub fn load_universe(config: &PremarketConfig, fallback_symbols: &[String]) -> Vec<UniverseSymbol> {
    if !config.universe_file.is_empty() {
        let path = &config.universe_file;
        let result = if path.ends_with(".json") {
            load_universe_from_file(path)
        } else {
            load_universe_from_text(path)
        };
        match result {
            Ok(u) => return u,
            Err(e) => warn!(error = %e, "Failed to load universe file, using fallback symbols"),
        }
    }

    if !config.symbols.is_empty() {
        return config.symbols.iter()
            .map(|s| UniverseSymbol {
                symbol: s.clone(),
                name: String::new(),
                sector: String::new(),
                market_cap: 0.0,
                avg_volume: 0,
            })
            .collect();
    }

    fallback_symbols.iter()
        .map(|s| UniverseSymbol {
            symbol: s.clone(),
            name: String::new(),
            sector: String::new(),
            market_cap: 0.0,
            avg_volume: 0,
        })
        .collect()
}

// ─── Tier-1 Quick Volume Filter ───────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct Tier1Result {
    pub symbol: String,
    pub last_close: f64,
    pub avg_volume: f64,
    pub last_volume: u64,
    pub volume_ratio: f64,
    pub passed: bool,
}

/// Quick volume/price filter: fetch last few candles for each symbol,
/// check if volume and price meet minimum thresholds.
pub fn tier1_filter(
    bridge_url: &str,
    symbols: &[UniverseSymbol],
    config: &PremarketConfig,
    concurrency: usize,
) -> Vec<Tier1Result> {
    use rayon::prelude::*;

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(concurrency.clamp(1, 80))
        .build()
        .unwrap_or_else(|_| rayon::ThreadPoolBuilder::new().build().unwrap());

    let to_date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let from_date = (chrono::Utc::now() - chrono::Duration::days(10))
        .format("%Y-%m-%d").to_string();
    let min_vol = config.min_avg_volume;
    let min_price = config.min_price;
    let max_price = config.max_price;
    let min_vol_ratio = config.min_volume_ratio;

    pool.install(|| {
        symbols.par_iter().filter_map(|us| {
            let result = broker_icici::bridge_get_historical(
                bridge_url, &us.symbol, "1day", &from_date, &to_date,
            );
            let candles = match result {
                Ok(val) => {
                    val.get("data").and_then(|d| d.as_array()).cloned()
                        .or_else(|| val.as_array().cloned())
                        .unwrap_or_default()
                }
                Err(_) => return None,
            };

            if candles.len() < 3 { return None; }

            let last = candles.last()?;
            let last_close = last.get("close")
                .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0.0);
            let last_volume = last.get("volume")
                .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                .unwrap_or(0);

            let avg_volume: f64 = candles.iter()
                .filter_map(|c| c.get("volume")
                    .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))))
                .sum::<f64>() / candles.len() as f64;

            let volume_ratio = if avg_volume > 0.0 { last_volume as f64 / avg_volume } else { 0.0 };

            let passed = last_close >= min_price
                && (max_price <= 0.0 || last_close <= max_price)
                && avg_volume >= min_vol as f64
                && volume_ratio >= min_vol_ratio;

            Some(Tier1Result {
                symbol: us.symbol.clone(),
                last_close,
                avg_volume,
                last_volume,
                volume_ratio,
                passed,
            })
        }).collect()
    })
}

// ─── Tier-2 Deep Technical Scan ───────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PremarketSignal {
    pub symbol: String,
    pub direction: String,
    pub confidence: f64,
    pub entry: f64,
    pub stop_loss: Option<f64>,
    pub target: Option<f64>,
    pub strategy: String,
    pub volume_ratio: f64,
    pub suggested_qty: i64,
}

/// Fetch full historical data and run deep scan on Tier-1 survivors.
/// Uses rayon for parallel data fetching.
pub fn tier2_deep_scan(
    bridge_url: &str,
    tier1_passed: &[Tier1Result],
    config: &PremarketConfig,
    concurrency: usize,
) -> Vec<PremarketSignal> {
    use rayon::prelude::*;

    let pool = rayon::ThreadPoolBuilder::new()
        .num_threads(concurrency.clamp(1, 80))
        .build()
        .unwrap_or_else(|_| rayon::ThreadPoolBuilder::new().build().unwrap());

    let to_date = chrono::Utc::now().format("%Y-%m-%d").to_string();
    let from_date = (chrono::Utc::now() - chrono::Duration::days(config.lookback_days))
        .format("%Y-%m-%d").to_string();
    let interval = config.scan_interval.clone();
    let aggressiveness = config.aggressiveness.clone();
    let min_confidence = config.min_signal_confidence;

    let sym_data_list: Vec<serde_json::Value> = pool.install(|| {
        tier1_passed.par_iter().filter_map(|t1| {
            let hist = broker_icici::bridge_get_historical(
                bridge_url, &t1.symbol, &interval, &from_date, &to_date,
            );
            let candles = match hist {
                Ok(val) => {
                    val.get("data").and_then(|d| d.as_array()).cloned()
                        .or_else(|| val.as_array().cloned())
                        .unwrap_or_default()
                }
                Err(e) => {
                    warn!(symbol = %t1.symbol, error = %e, "Tier-2 historical fetch failed");
                    return None;
                }
            };
            if candles.len() < 15 { return None; }
            Some(serde_json::json!({
                "symbol": t1.symbol,
                "candles": candles,
            }))
        }).collect()
    });

    if sym_data_list.is_empty() {
        info!("Tier-2 scan: no symbols with sufficient data");
        return Vec::new();
    }

    let scan_input = serde_json::json!({
        "symbols": sym_data_list,
        "aggressiveness": aggressiveness,
    });

    let scan_result = match scan::compute(scan_input) {
        Ok(v) => v,
        Err(e) => {
            error!(error = %e, "Tier-2 scan::compute failed");
            return Vec::new();
        }
    };

    let volume_map: HashMap<String, f64> = tier1_passed.iter()
        .map(|t| (t.symbol.clone(), t.volume_ratio))
        .collect();

    let signals = scan_result.get("signals")
        .and_then(|v| v.as_array())
        .cloned()
        .unwrap_or_default();

    signals.iter().filter_map(|sig| {
        let confidence = sig.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0);
        if confidence < min_confidence { return None; }

        let symbol = sig.get("symbol").and_then(|v| v.as_str())?.to_string();
        let direction = sig.get("direction").and_then(|v| v.as_str())?.to_string();
        let entry = sig.get("entry").and_then(|v| v.as_f64()).unwrap_or(0.0);
        let stop_loss = sig.get("stop_loss").and_then(|v| v.as_f64());
        let target = sig.get("target").and_then(|v| v.as_f64());
        let strategy = sig.get("strategy").and_then(|v| v.as_str()).unwrap_or("composite").to_string();
        let vol_ratio = volume_map.get(&symbol).copied().unwrap_or(1.0);

        Some(PremarketSignal {
            symbol,
            direction,
            confidence,
            entry,
            stop_loss,
            target,
            strategy,
            volume_ratio: vol_ratio,
            suggested_qty: 0,
        })
    })
    .collect()
}

// ─── Full Pipeline ────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct PremarketReport {
    pub timestamp: String,
    pub universe_size: usize,
    pub tier1_passed: usize,
    pub tier1_failed: usize,
    pub tier1_fetch_errors: usize,
    pub signals_generated: usize,
    pub signals_queued: usize,
    pub top_signals: Vec<PremarketSignal>,
    pub elapsed_secs: f64,
}

/// Run the full pre-market pipeline:
/// 1. Load universe
/// 2. Tier-1 quick volume/price filter (parallel)
/// 3. Tier-2 deep technical scan (parallel)
/// 4. Rank by confidence, apply position sizing
/// 5. Cache top signals + push to dynamic watchlist
/// 6. Optionally auto-queue for market-open execution
pub fn run_premarket_pipeline(state: &Arc<AppState>) -> PremarketReport {
    let start = std::time::Instant::now();
    let config = &state.config.premarket;
    let bridge_url = state.config.broker.icici.bridge_url.clone();

    if bridge_url.is_empty() {
        error!("Pre-market pipeline: bridge URL not configured");
        return PremarketReport {
            timestamp: chrono::Utc::now().to_rfc3339(),
            universe_size: 0, tier1_passed: 0, tier1_failed: 0,
            tier1_fetch_errors: 0, signals_generated: 0, signals_queued: 0,
            top_signals: Vec::new(), elapsed_secs: 0.0,
        };
    }

    // Step 1: Load universe
    let universe = load_universe(config, &state.config.market_data.symbols);
    let universe_size = universe.len();
    info!(universe_size = universe_size, "Pre-market: loaded symbol universe");

    if universe_size == 0 {
        warn!("Pre-market pipeline: empty universe, nothing to scan");
        return PremarketReport {
            timestamp: chrono::Utc::now().to_rfc3339(),
            universe_size: 0, tier1_passed: 0, tier1_failed: 0,
            tier1_fetch_errors: 0, signals_generated: 0, signals_queued: 0,
            top_signals: Vec::new(), elapsed_secs: start.elapsed().as_secs_f64(),
        };
    }

    // Step 2: Tier-1 quick filter (parallel)
    info!("Pre-market: starting Tier-1 volume/price filter on {} symbols", universe_size);
    let t1_results = tier1_filter(&bridge_url, &universe, config, config.concurrency);
    let t1_passed: Vec<Tier1Result> = t1_results.iter().filter(|r| r.passed).cloned().collect();
    let t1_failed = t1_results.iter().filter(|r| !r.passed).count();
    let t1_errors = universe_size.saturating_sub(t1_results.len());

    info!(
        passed = t1_passed.len(),
        failed = t1_failed,
        fetch_errors = t1_errors,
        "Pre-market: Tier-1 filter complete"
    );

    if t1_passed.is_empty() {
        info!("Pre-market: no symbols passed Tier-1 filter");
        return PremarketReport {
            timestamp: chrono::Utc::now().to_rfc3339(),
            universe_size, tier1_passed: 0, tier1_failed: t1_failed,
            tier1_fetch_errors: t1_errors, signals_generated: 0, signals_queued: 0,
            top_signals: Vec::new(), elapsed_secs: start.elapsed().as_secs_f64(),
        };
    }

    // Step 3: Tier-2 deep scan (parallel)
    info!("Pre-market: starting Tier-2 deep scan on {} symbols", t1_passed.len());
    let mut signals = tier2_deep_scan(&bridge_url, &t1_passed, config, config.concurrency);
    let total_signals = signals.len();
    info!(signals = total_signals, "Pre-market: Tier-2 scan complete");

    // Step 4: Rank by confidence (descending), take top N
    signals.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    let max_signals = config.max_signals;
    signals.truncate(max_signals);

    // Apply position sizing
    let sizing_mode = SizingMethod::from_str_loose(&config.position_sizing_mode);
    let nav = state.get_nav();

    for sig in &mut signals {
        let ctx = SizingContext {
            nav,
            price: sig.entry,
            win_rate: 0.5,
            avg_win: 1.0,
            avg_loss: 1.0,
            asset_volatility: 0.02,
            target_volatility: 0.15,
            portfolio_volatility: 0.12,
            regime: MarketRegime::Normal,
            signal_confidence: sig.confidence,
            max_position_pct: state.config.live_executor.max_position_pct,
            default_qty: state.config.live_executor.default_qty,
        };
        sig.suggested_qty = compute_quantity(sizing_mode, &ctx);
    }

    // Step 5: Cache signals + update dynamic watchlist
    let mut queued = 0;
    let watchlist_symbols: Vec<String> = signals.iter().map(|s| s.symbol.clone()).collect();

    for sig in &signals {
        let cached = CachedSignal {
            symbol: sig.symbol.clone(),
            strategy: sig.strategy.clone(),
            side: sig.direction.clone(),
            price: sig.entry,
            confidence: sig.confidence,
            reason: format!("premarket:{}", sig.strategy),
            timestamp: chrono::Utc::now().to_rfc3339(),
            ttl_seconds: 3600,
            stop_loss: sig.stop_loss,
            take_profit: sig.target,
            suggested_qty: Some(sig.suggested_qty),
        };
        let key = format!("{}:{}", sig.symbol, sig.strategy);
        state.signal_cache.insert(key, cached);
        queued += 1;
    }

    // Push watchlist symbols into LivePriceStore awareness
    // (so the live executor can subscribe to their ticks once market opens)
    if !watchlist_symbols.is_empty() {
        state.set_dynamic_watchlist(watchlist_symbols.clone());
        info!(count = watchlist_symbols.len(), "Pre-market: dynamic watchlist updated");
    }

    state.log_audit("PREMARKET_SCAN", None,
        &format!("universe={} t1_pass={} signals={} queued={} elapsed={:.1}s",
            universe_size, t1_passed.len(), total_signals, queued, start.elapsed().as_secs_f64()));

    let report = PremarketReport {
        timestamp: chrono::Utc::now().to_rfc3339(),
        universe_size,
        tier1_passed: t1_passed.len(),
        tier1_failed: t1_failed,
        tier1_fetch_errors: t1_errors,
        signals_generated: total_signals,
        signals_queued: queued,
        top_signals: signals,
        elapsed_secs: start.elapsed().as_secs_f64(),
    };

    info!(
        elapsed = format!("{:.1}s", report.elapsed_secs),
        universe = universe_size,
        tier1 = report.tier1_passed,
        signals = report.signals_queued,
        "Pre-market pipeline complete"
    );

    report
}

// ─── Auto-Execute Queued Signals ──────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct ExecutionResult {
    pub symbol: String,
    pub side: String,
    pub quantity: i64,
    pub price: f64,
    pub status: String,
    pub order_id: Option<String>,
    pub reason: Option<String>,
}

/// Execute all queued pre-market signals through the OMS.
/// Called at market open or manually.
pub fn execute_queued_signals(state: &Arc<AppState>, config: &PremarketConfig) -> Vec<ExecutionResult> {
    if state.is_killed() {
        warn!("Pre-market execution blocked: kill switch active");
        return Vec::new();
    }

    let min_confidence = config.min_signal_confidence;
    let exchange = config.execution_exchange.clone();
    let product = match config.execution_product.to_lowercase().as_str() {
        "delivery" | "cnc" => ProductType::Delivery,
        _ => ProductType::Intraday,
    };
    let max_orders = config.max_auto_orders;

    let all_signals: Vec<CachedSignal> = state.signal_cache.iter()
        .map(|entry| entry.value().clone())
        .filter(|s| s.confidence >= min_confidence)
        .collect();

    let mut qualifying: Vec<CachedSignal> = all_signals;
    qualifying.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
    qualifying.truncate(max_orders);

    let mut results = Vec::new();

    for sig in &qualifying {
        if state.positions.len() >= state.config.live_executor.max_positions {
            info!("Pre-market execution: max positions reached, stopping");
            break;
        }

        let side = match sig.side.to_lowercase().as_str() {
            "sell" | "short" => OrderSide::Sell,
            _ => OrderSide::Buy,
        };
        let qty = sig.suggested_qty.unwrap_or(state.config.live_executor.default_qty);

        let order_req = OrderRequest {
            symbol: sig.symbol.clone(),
            exchange: exchange.clone(),
            side,
            order_type: OrderType::Limit,
            quantity: qty,
            price: Some(sig.price),
            trigger_price: sig.stop_loss,
            product,
            tag: Some(format!("premarket:{}", sig.strategy)),
            ..Default::default()
        };

        let ref_price = state.live_prices.get_ltp(&sig.symbol).or(Some(sig.price));
        match state.oms.submit_order(order_req, Some(sig.strategy.clone()), ref_price) {
            Ok(order) => {
                if order.status == OrderStatus::Filled && order.filled_qty > 0 {
                    state.sync_oms_fill(
                        &order.symbol, &sig.side, order.filled_qty,
                        order.avg_fill_price, sig.stop_loss, sig.take_profit,
                    );
                }
                state.log_audit("PREMARKET_EXEC", Some(&sig.symbol),
                    &format!("strategy={} side={} qty={} price={:.2} conf={:.2}",
                        sig.strategy, sig.side, qty, sig.price, sig.confidence));
                results.push(ExecutionResult {
                    symbol: sig.symbol.clone(),
                    side: sig.side.clone(),
                    quantity: qty,
                    price: sig.price,
                    status: "submitted".into(),
                    order_id: Some(order.internal_id),
                    reason: None,
                });
            }
            Err(e) => {
                state.log_audit("PREMARKET_EXEC_FAIL", Some(&sig.symbol),
                    &format!("strategy={} error={}", sig.strategy, e));
                results.push(ExecutionResult {
                    symbol: sig.symbol.clone(),
                    side: sig.side.clone(),
                    quantity: qty,
                    price: sig.price,
                    status: "rejected".into(),
                    order_id: None,
                    reason: Some(e),
                });
            }
        }
    }

    state.log_audit("PREMARKET_EXEC_BATCH", None,
        &format!("attempted={} submitted={} rejected={}",
            results.len(),
            results.iter().filter(|r| r.status == "submitted").count(),
            results.iter().filter(|r| r.status == "rejected").count()));

    results
}

// ─── Scheduler ────────────────────────────────────────────────────────

/// Start the pre-market scheduler as a background task.
/// Runs at `scan_time_ist` (e.g., "08:50") on weekdays.
/// After scanning, optionally auto-executes at `execute_time_ist`.
pub fn spawn_scheduler(state: Arc<AppState>) {
    let config = state.config.premarket.clone();
    if !config.enabled {
        info!("Pre-market scheduler disabled in config");
        return;
    }

    let scan_time = config.scan_time_ist.clone();
    let exec_time = config.execute_time_ist.clone();
    let auto_execute = config.auto_execute_at_open;

    info!(
        scan_time = %scan_time,
        exec_time = %exec_time,
        auto_execute = auto_execute,
        "Starting pre-market scheduler"
    );

    tokio::spawn(async move {
        loop {
            let now_ist = chrono::Utc::now() + chrono::Duration::hours(5) + chrono::Duration::minutes(30);
            let weekday = now_ist.format("%u").to_string().parse::<u32>().unwrap_or(6);

            // Only run Mon-Fri (1-5)
            if weekday > 5 {
                tokio::time::sleep(std::time::Duration::from_secs(3600)).await;
                continue;
            }

            let current_hhmm = now_ist.format("%H:%M").to_string();

            // Check if it's scan time (within a 60-second window)
            if time_matches(&current_hhmm, &scan_time) {
                info!("Pre-market scheduler: scan triggered at IST {}", current_hhmm);

                let scan_state = state.clone();
                let report = tokio::task::spawn_blocking(move || {
                    run_premarket_pipeline(&scan_state)
                }).await.unwrap_or_else(|e| {
                    error!("Pre-market scan panicked: {}", e);
                    PremarketReport {
                        timestamp: chrono::Utc::now().to_rfc3339(),
                        universe_size: 0, tier1_passed: 0, tier1_failed: 0,
                        tier1_fetch_errors: 0, signals_generated: 0, signals_queued: 0,
                        top_signals: Vec::new(), elapsed_secs: 0.0,
                    }
                });

                info!(
                    signals = report.signals_queued,
                    elapsed = format!("{:.1}s", report.elapsed_secs),
                    "Pre-market scan complete"
                );

                // Sleep until scan window passes to avoid re-triggering
                tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                continue;
            }

            // Check if it's execution time
            if auto_execute && time_matches(&current_hhmm, &exec_time) {
                info!("Pre-market scheduler: auto-execution triggered at IST {}", current_hhmm);

                let exec_state = state.clone();
                let exec_config = state.config.premarket.clone();
                let results = tokio::task::spawn_blocking(move || {
                    execute_queued_signals(&exec_state, &exec_config)
                }).await.unwrap_or_else(|e| {
                    error!("Pre-market execution panicked: {}", e);
                    Vec::new()
                });

                let submitted = results.iter().filter(|r| r.status == "submitted").count();
                let rejected = results.iter().filter(|r| r.status == "rejected").count();
                info!(submitted = submitted, rejected = rejected, "Pre-market auto-execution complete");

                // Sleep to avoid re-triggering
                tokio::time::sleep(std::time::Duration::from_secs(120)).await;
                continue;
            }

            // Poll every 30 seconds
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
        }
    });
}

/// Check if current HH:MM matches target HH:MM within a 1-minute window
fn time_matches(current: &str, target: &str) -> bool {
    current == target
}

// ─── Dynamic Watchlist Feed ───────────────────────────────────────────

/// Start a bridge feed for dynamically discovered symbols.
/// Called after pre-market scan to subscribe to ticks for top signal symbols.
pub async fn start_dynamic_feed(state: Arc<AppState>) {
    let bridge_url = state.config.broker.icici.bridge_url.clone();
    if bridge_url.is_empty() { return; }

    let poll_interval = state.config.market_data.reconnect_delay_secs.max(2);

    loop {
        let watchlist = state.get_dynamic_watchlist();
        if watchlist.is_empty() {
            tokio::time::sleep(std::time::Duration::from_secs(30)).await;
            continue;
        }

        // Poll each dynamic symbol
        for symbol in &watchlist {
            if state.live_prices.get_ltp(symbol).is_some() {
                continue; // Already has recent data from main feed
            }

            let url = bridge_url.clone();
            let sym = symbol.clone();
            let result = tokio::task::spawn_blocking(move || {
                let quote_url = format!("{}/quote/{}", url, sym);
                let resp = ureq::get(&quote_url)
                    .timeout(std::time::Duration::from_secs(5))
                    .call();
                match resp {
                    Ok(r) => {
                        let data: serde_json::Value = r.into_json().unwrap_or_default();
                        let ltp = data.get("ltp").and_then(|v| v.as_f64()).unwrap_or(0.0);
                        if ltp > 0.0 {
                            Some(crate::market_data::Tick {
                                symbol: sym,
                                ltp,
                                open: ltp,
                                high: ltp,
                                low: ltp,
                                close: ltp,
                                volume: data.get("volume").and_then(|v| v.as_u64()).unwrap_or(0),
                                timestamp: data.get("timestamp").and_then(|v| v.as_str()).unwrap_or("").to_string(),
                            })
                        } else {
                            None
                        }
                    }
                    Err(_) => None,
                }
            }).await;

            if let Ok(Some(tick)) = result {
                state.live_prices.update(tick);
            }
        }

        tokio::time::sleep(std::time::Duration::from_secs(poll_interval)).await;
    }
}

// ─── Tests ────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_load_universe_from_text_format() {
        let dir = std::env::temp_dir();
        let path = dir.join("test_universe.txt");
        std::fs::write(&path, "RELIANCE\nINFY\nTCS\n# comment\nHDFCBANK\n").unwrap();
        let result = load_universe_from_text(path.to_str().unwrap());
        assert!(result.is_ok());
        let symbols = result.unwrap();
        assert_eq!(symbols.len(), 4);
        assert_eq!(symbols[0].symbol, "RELIANCE");
        assert_eq!(symbols[3].symbol, "HDFCBANK");
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_load_universe_from_json_format() {
        let dir = std::env::temp_dir();
        let path = dir.join("test_universe.json");
        let data = serde_json::json!([
            {"symbol": "RELIANCE", "name": "Reliance Industries", "avg_volume": 5000000},
            {"symbol": "TCS", "name": "Tata Consultancy", "avg_volume": 3000000},
        ]);
        std::fs::write(&path, serde_json::to_string(&data).unwrap()).unwrap();
        let result = load_universe_from_file(path.to_str().unwrap());
        assert!(result.is_ok());
        let symbols = result.unwrap();
        assert_eq!(symbols.len(), 2);
        assert_eq!(symbols[0].symbol, "RELIANCE");
        assert_eq!(symbols[1].avg_volume, 3000000);
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_load_universe_fallback() {
        let config = PremarketConfig {
            symbols: vec!["NIFTY".into(), "BANKNIFTY".into()],
            ..Default::default()
        };
        let universe = load_universe(&config, &[]);
        assert_eq!(universe.len(), 2);
        assert_eq!(universe[0].symbol, "NIFTY");
    }

    #[test]
    fn test_load_universe_empty_fallback() {
        let config = PremarketConfig::default();
        let fallback = vec!["A".to_string(), "B".to_string()];
        let universe = load_universe(&config, &fallback);
        assert_eq!(universe.len(), 2);
    }

    #[test]
    fn test_time_matches() {
        assert!(time_matches("08:50", "08:50"));
        assert!(!time_matches("08:51", "08:50"));
    }

    #[test]
    fn test_premarket_signal_serialization() {
        let sig = PremarketSignal {
            symbol: "RELIANCE".into(),
            direction: "BUY".into(),
            confidence: 0.85,
            entry: 2500.0,
            stop_loss: Some(2450.0),
            target: Some(2600.0),
            strategy: "composite".into(),
            volume_ratio: 1.5,
            suggested_qty: 10,
        };
        let json = serde_json::to_string(&sig).unwrap();
        assert!(json.contains("RELIANCE"));
        assert!(json.contains("0.85"));
    }

    #[test]
    fn test_premarket_report_serialization() {
        let report = PremarketReport {
            timestamp: "2026-03-06T03:20:00Z".into(),
            universe_size: 1000,
            tier1_passed: 300,
            tier1_failed: 650,
            tier1_fetch_errors: 50,
            signals_generated: 25,
            signals_queued: 10,
            top_signals: Vec::new(),
            elapsed_secs: 45.2,
        };
        let json = serde_json::to_string(&report).unwrap();
        assert!(json.contains("1000"));
        assert!(json.contains("45.2"));
    }

    #[test]
    fn test_execution_result_serialization() {
        let result = ExecutionResult {
            symbol: "TCS".into(),
            side: "buy".into(),
            quantity: 5,
            price: 3500.0,
            status: "submitted".into(),
            order_id: Some("OMS-001".into()),
            reason: None,
        };
        let json = serde_json::to_string(&result).unwrap();
        assert!(json.contains("submitted"));
    }

    #[test]
    fn test_empty_universe_file() {
        let dir = std::env::temp_dir();
        let path = dir.join("test_empty_universe.txt");
        std::fs::write(&path, "# only comments\n").unwrap();
        let result = load_universe_from_text(path.to_str().unwrap());
        assert!(result.is_err());
        std::fs::remove_file(&path).ok();
    }

    #[test]
    fn test_csv_format_universe() {
        let dir = std::env::temp_dir();
        let path = dir.join("test_csv_universe.txt");
        std::fs::write(&path, "RELIANCE, Reliance Industries\nTCS, Tata Consultancy\n").unwrap();
        let result = load_universe_from_text(path.to_str().unwrap());
        assert!(result.is_ok());
        let symbols = result.unwrap();
        assert_eq!(symbols[0].symbol, "RELIANCE");
        assert_eq!(symbols[0].name, "Reliance Industries");
        std::fs::remove_file(&path).ok();
    }
}
