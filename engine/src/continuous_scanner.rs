use std::sync::Arc;
use std::sync::atomic::{AtomicUsize, Ordering};
use dashmap::DashMap;
use serde::Serialize;
use tracing::{info, warn};

use crate::state::{AppState, CachedSignal};
use crate::universe::Universe;
use crate::rate_limiter::RateLimiter;
use crate::news_sentiment::NewsSentimentStore;
use crate::futures_scanner;
use crate::strategy_performance::GLOBAL_TRACKER;

// ─── Enriched Signal ─────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize)]
pub struct EnrichedSignal {
    pub symbol: String,
    pub direction: String,
    pub confidence: f64,
    pub entry: f64,
    pub stop_loss: Option<f64>,
    pub target: Option<f64>,
    pub strategy: String,
    pub sector: String,
    pub cap_category: String,
    pub news_sentiment: f64,
    pub options_pcr: Option<f64>,
    pub options_iv_rank: Option<f64>,
    pub futures_basis: Option<f64>,
    pub futures_signal: Option<f64>,
    pub ml_score: Option<f64>,
    pub timeframe_alignment: Option<f64>,
    pub last_updated: String,
    pub scan_count: u32,
    pub volume_ratio: f64,
}

#[derive(Debug, Clone, Serialize)]
pub struct SectorScore {
    pub sector: String,
    pub avg_signal: f64,
    pub bullish_count: usize,
    pub bearish_count: usize,
    pub news_sentiment: f64,
    pub top_symbol: String,
}

/// Global scan ledger that persists across scan cycles.
pub struct ScanLedger {
    pub signals: DashMap<String, EnrichedSignal>,
    pub sector_scores: DashMap<String, SectorScore>,
    sector_index: AtomicUsize,
}

impl ScanLedger {
    pub fn new() -> Self {
        Self {
            signals: DashMap::new(),
            sector_scores: DashMap::new(),
            sector_index: AtomicUsize::new(0),
        }
    }

    pub fn next_sector_index(&self) -> usize {
        self.sector_index.fetch_add(1, Ordering::Relaxed)
    }

    pub fn upsert_signal(&self, key: &str, sig: EnrichedSignal) {
        if let Some(mut existing) = self.signals.get_mut(key) {
            existing.confidence = sig.confidence;
            existing.news_sentiment = sig.news_sentiment;
            existing.options_pcr = sig.options_pcr.or(existing.options_pcr);
            existing.options_iv_rank = sig.options_iv_rank.or(existing.options_iv_rank);
            existing.futures_basis = sig.futures_basis.or(existing.futures_basis);
            existing.futures_signal = sig.futures_signal.or(existing.futures_signal);
            existing.ml_score = sig.ml_score.or(existing.ml_score);
            existing.last_updated = sig.last_updated;
            existing.scan_count += 1;
        } else {
            self.signals.insert(key.to_string(), sig);
        }
    }

    /// Remove signals older than `max_age_secs`.
    pub fn prune_stale(&self, max_age_secs: i64) {
        let now = chrono::Utc::now();
        let mut stale_keys: Vec<String> = Vec::new();

        for entry in self.signals.iter() {
            if let Ok(ts) = chrono::DateTime::parse_from_rfc3339(&entry.last_updated) {
                let age = (now - ts.with_timezone(&chrono::Utc)).num_seconds();
                if age > max_age_secs {
                    stale_keys.push(entry.key().clone());
                }
            }
        }

        for key in stale_keys {
            self.signals.remove(&key);
        }
    }

    pub fn top_signals(&self, limit: usize) -> Vec<EnrichedSignal> {
        let mut all: Vec<EnrichedSignal> = self.signals.iter()
            .map(|e| e.value().clone())
            .collect();
        all.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));
        all.truncate(limit);
        all
    }

    pub fn update_sector_score(&self, sector: &str, signals: &[EnrichedSignal], news_sentiment: f64) {
        let sector_sigs: Vec<&EnrichedSignal> = signals.iter()
            .filter(|s| s.sector.to_lowercase() == sector.to_lowercase())
            .collect();

        if sector_sigs.is_empty() {
            return;
        }

        let avg_signal: f64 = sector_sigs.iter().map(|s| s.confidence).sum::<f64>() / sector_sigs.len() as f64;
        let bullish = sector_sigs.iter().filter(|s| s.direction == "buy").count();
        let bearish = sector_sigs.iter().filter(|s| s.direction == "sell").count();
        let top = sector_sigs.iter()
            .max_by(|a, b| a.confidence.partial_cmp(&b.confidence).unwrap_or(std::cmp::Ordering::Equal))
            .map(|s| s.symbol.clone())
            .unwrap_or_default();

        self.sector_scores.insert(sector.to_string(), SectorScore {
            sector: sector.to_string(),
            avg_signal,
            bullish_count: bullish,
            bearish_count: bearish,
            news_sentiment,
            top_symbol: top,
        });
    }
}

// ─── Volume/Breakout Quick Filter ────────────────────────────────────

/// Quick-filter a large universe to find stocks with unusual volume or
/// significant price moves (breakouts/breakdowns). Fetches only 5 days
/// of daily data per stock — fast enough for 3000+ stocks with rate limiting.
/// Returns the symbols worth deep-scanning.
pub fn quick_volume_filter(
    limiter: &RateLimiter,
    bridge_url: &str,
    stocks: &[crate::universe::StockInfo],
    min_volume: f64,
    min_change_pct: f64,
) -> Vec<crate::universe::StockInfo> {
    let from = chrono::Utc::now() - chrono::Duration::days(5);
    let to = chrono::Utc::now();
    let from_str = from.format("%Y-%m-%d").to_string();
    let to_str = to.format("%Y-%m-%d").to_string();
    let mut survivors = Vec::new();

    for stock in stocks {
        let candles_result = crate::rate_limiter::rate_limited_historical(
            limiter, bridge_url, &stock.symbol, "1day", &from_str, &to_str,
        );

        let candle_data = match candles_result {
            Ok(data) => data,
            Err(_) => continue,
        };

        let bars = candle_data.get("data")
            .and_then(|d| d.as_array())
            .or_else(|| candle_data.as_array());

        let bars = match bars {
            Some(b) if b.len() >= 2 => b,
            _ => continue,
        };

        let last = &bars[bars.len() - 1];
        let prev = &bars[bars.len() - 2];

        let last_close = last.get("close")
            .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0.0);
        let prev_close = prev.get("close")
            .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0.0);
        let last_volume = last.get("volume")
            .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
            .unwrap_or(0.0);

        let avg_volume: f64 = bars.iter()
            .filter_map(|c| c.get("volume")
                .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))))
            .sum::<f64>() / bars.len() as f64;

        if last_close <= 0.0 || prev_close <= 0.0 { continue; }

        let change_pct = ((last_close - prev_close) / prev_close * 100.0).abs();
        let volume_ratio = if avg_volume > 0.0 { last_volume / avg_volume } else { 0.0 };

        let passes = (avg_volume >= min_volume && change_pct >= min_change_pct)
            || volume_ratio >= 1.5
            || change_pct >= 3.0;

        if passes {
            survivors.push(stock.clone());
        }
    }

    info!(
        universe_size = stocks.len(),
        survivors = survivors.len(),
        "Quick volume/breakout filter complete"
    );
    survivors
}

// ─── Scan Runner ─────────────────────────────────────────────────────

/// Run a sector rotation scan for the given sector slice.
pub fn run_sector_scan(
    state: &Arc<AppState>,
    universe: &Universe,
    limiter: &RateLimiter,
    news_store: &NewsSentimentStore,
    ledger: &ScanLedger,
    sector: &str,
    stocks: &[crate::universe::StockInfo],
) -> usize {
    let bridge_url = &state.config.broker.icici.bridge_url;
    let now_str = chrono::Utc::now().to_rfc3339();
    let mut signal_count = 0;

    for stock in stocks {
        let from = chrono::Utc::now() - chrono::Duration::days(60);
        let to = chrono::Utc::now();
        let from_str = from.format("%Y-%m-%d").to_string();
        let to_str = to.format("%Y-%m-%d").to_string();

        let candles_result = crate::rate_limiter::rate_limited_historical(
            limiter, bridge_url, &stock.symbol, "1day", &from_str, &to_str,
        );

        let candle_data = match candles_result {
            Ok(data) => data,
            Err(e) => {
                warn!(symbol = %stock.symbol, error = %e, "Failed to fetch candles for sector scan");
                continue;
            }
        };

        let scan_input = serde_json::json!({
            "command": "scan",
            "candles": candle_data,
            "aggressiveness": "medium",
        });

        let scan_result = match crate::scan::compute(scan_input) {
            Ok(r) => r,
            Err(_) => continue,
        };

        let signals = scan_result.get("signals").and_then(|v| v.as_array());
        if let Some(sigs) = signals {
            for sig in sigs {
                let direction = sig.get("direction").and_then(|v| v.as_str()).unwrap_or("hold");
                if direction == "hold" { continue; }

                let confidence = sig.get("confidence").and_then(|v| v.as_f64()).unwrap_or(0.0);
                if confidence < 0.5 { continue; }

                let entry = sig.get("entry").and_then(|v| v.as_f64()).unwrap_or(0.0);
                let sl = sig.get("stop_loss").and_then(|v| v.as_f64());
                let tp = sig.get("target").and_then(|v| v.as_f64());
                let strategy = sig.get("strategy").and_then(|v| v.as_str()).unwrap_or("composite");
                let volume_ratio = sig.get("volume_ratio").and_then(|v| v.as_f64()).unwrap_or(1.0);

                let news = news_store.get_sentiment(&stock.symbol);

                let options_pcr = state.options_data.get(&stock.symbol)
                    .map(|snap| snap.pcr);
                let options_iv = state.options_data.get(&stock.symbol)
                    .map(|snap| snap.atm_iv);

                let key = format!("{}:{}", stock.symbol, strategy);

                let enriched = EnrichedSignal {
                    symbol: stock.symbol.clone(),
                    direction: direction.to_string(),
                    confidence,
                    entry,
                    stop_loss: sl,
                    target: tp,
                    strategy: strategy.to_string(),
                    sector: stock.sector.clone(),
                    cap_category: stock.cap_category().as_str().to_string(),
                    news_sentiment: news,
                    options_pcr,
                    options_iv_rank: options_iv,
                    futures_basis: None,
                    futures_signal: None,
                    ml_score: None,
                    timeframe_alignment: None,
                    last_updated: now_str.clone(),
                    scan_count: 1,
                    volume_ratio,
                };

                if GLOBAL_TRACKER.is_strategy_retired(strategy) {
                    tracing::debug!(strategy = strategy, symbol = %stock.symbol, "Skipping retired strategy");
                    continue;
                }

                let calibrated_confidence = GLOBAL_TRACKER.get_regime_weighted_confidence(
                    confidence, strategy, "neutral",
                );

                let mut enriched = enriched;
                enriched.confidence = calibrated_confidence;

                ledger.upsert_signal(&key, enriched);

                let cached = CachedSignal {
                    symbol: stock.symbol.clone(),
                    strategy: strategy.to_string(),
                    side: direction.to_string(),
                    price: entry,
                    confidence: calibrated_confidence,
                    reason: format!("continuous:{}:{}", sector, strategy),
                    timestamp: now_str.clone(),
                    ttl_seconds: 1800,
                    stop_loss: sl,
                    take_profit: tp,
                    suggested_qty: None,
                };
                state.signal_cache.insert(format!("cont:{}:{}", stock.symbol, strategy), cached);
                signal_count += 1;
            }
        }
    }

    let sector_news = news_store.get_sector_sentiment(sector, universe);
    let sector_sigs: Vec<EnrichedSignal> = ledger.signals.iter()
        .filter(|e| e.value().sector.to_lowercase() == sector.to_lowercase())
        .map(|e| e.value().clone())
        .collect();
    ledger.update_sector_score(sector, &sector_sigs, sector_news);

    info!(sector = sector, signals = signal_count, "Sector scan complete");
    signal_count
}

/// Run futures scan on all F&O stocks and merge results into ledger.
pub fn run_futures_scan(
    limiter: &RateLimiter,
    bridge_url: &str,
    universe: &Universe,
    ledger: &ScanLedger,
) {
    let results = futures_scanner::scan_futures(limiter, bridge_url, universe);
    let now_str = chrono::Utc::now().to_rfc3339();

    for fa in &results {
        let key = format!("{}:futures", fa.symbol);
        if let Some(mut sig) = ledger.signals.get_mut(&key) {
            sig.futures_basis = Some(fa.basis_pct);
            sig.futures_signal = Some(fa.signal);
            sig.last_updated = now_str.clone();
        }
        // Also update any existing signals for this symbol across strategies
        for mut entry in ledger.signals.iter_mut() {
            if entry.symbol == fa.symbol {
                entry.futures_basis = Some(fa.basis_pct);
                entry.futures_signal = Some(fa.signal);
            }
        }
    }

    info!(analyzed = results.len(), "Futures scan results merged into ledger");
}

/// Run EOD analysis: tag signal outcomes for ML training.
pub fn run_eod_analysis(
    state: &Arc<AppState>,
    ledger: &ScanLedger,
    limiter: &RateLimiter,
) -> Vec<serde_json::Value> {
    let bridge_url = &state.config.broker.icici.bridge_url;
    let mut outcomes: Vec<serde_json::Value> = Vec::new();

    for entry in ledger.signals.iter() {
        let sig = entry.value();
        let current_price = match crate::rate_limiter::rate_limited_quote(limiter, bridge_url, &sig.symbol) {
            Ok((p, _)) => p,
            Err(_) => continue,
        };

        let pnl_pct = if sig.direction == "buy" {
            (current_price - sig.entry) / sig.entry * 100.0
        } else {
            (sig.entry - current_price) / sig.entry * 100.0
        };

        let outcome = if pnl_pct > 0.5 { "WIN" } else if pnl_pct < -0.5 { "LOSS" } else { "FLAT" };

        outcomes.push(serde_json::json!({
            "symbol": sig.symbol,
            "strategy": sig.strategy,
            "direction": sig.direction,
            "entry": sig.entry,
            "current_price": current_price,
            "pnl_pct": pnl_pct,
            "outcome": outcome,
            "sector": sig.sector,
            "cap_category": sig.cap_category,
            "news_sentiment": sig.news_sentiment,
            "options_pcr": sig.options_pcr,
            "futures_basis": sig.futures_basis,
            "ml_score": sig.ml_score,
            "scan_count": sig.scan_count,
            "confidence": sig.confidence,
            "timestamp": chrono::Utc::now().to_rfc3339(),
        }));
    }

    // Persist outcomes for ML training
    if !outcomes.is_empty() {
        let path = "data/ml_training_log.json";
        let mut existing: Vec<serde_json::Value> = std::fs::read_to_string(path)
            .ok()
            .and_then(|s| serde_json::from_str(&s).ok())
            .unwrap_or_default();
        existing.extend(outcomes.clone());

        // Keep last 10,000 entries
        if existing.len() > 10_000 {
            existing = existing[existing.len() - 10_000..].to_vec();
        }

        if let Ok(json) = serde_json::to_string_pretty(&existing) {
            let _ = std::fs::write(path, json);
        }
    }

    info!(outcomes = outcomes.len(), "EOD analysis complete");
    outcomes
}

// ─── Scheduler ───────────────────────────────────────────────────────

/// Spawn the continuous scanner background task.
/// Runs sector rotation scans, options flow scans, futures scans,
/// news fetches, and EOD analysis on schedule.
pub fn spawn(
    state: Arc<AppState>,
    universe: Arc<Universe>,
    limiter: Arc<RateLimiter>,
    news_store: Arc<NewsSentimentStore>,
    ledger: Arc<ScanLedger>,
) {
    let config = state.config.continuous_scan.clone();
    if !config.enabled {
        info!("Continuous scanner disabled");
        return;
    }

    tokio::spawn(async move {
        info!("Continuous scanner started");
        let mut last_news_fetch = std::time::Instant::now() - std::time::Duration::from_secs(1000);
        let mut last_futures_scan = std::time::Instant::now() - std::time::Duration::from_secs(1000);
        let mut last_broad_scan = std::time::Instant::now() - std::time::Duration::from_secs(1000);
        let mut last_eod = String::new();
        let mut last_weekly = String::new();
        let sectors_per_iteration: usize = 3;
        let broad_scan_interval_secs: u64 = 1800; // Full universe volume scan every 30 min

        loop {
            tokio::time::sleep(std::time::Duration::from_secs(15)).await;

            let now_utc = chrono::Utc::now();
            let ist = now_utc + chrono::Duration::hours(5) + chrono::Duration::minutes(30);
            let ist_time = ist.format("%H:%M").to_string();
            let ist_day = ist.format("%A").to_string();
            let ist_date = ist.format("%Y-%m-%d").to_string();

            let is_weekday = !matches!(ist_day.as_str(), "Saturday" | "Sunday");
            let is_market_hours = ist_time.as_str() >= "09:15" && ist_time.as_str() <= "15:30";

            // Fetch news periodically
            let news_interval_secs = config.news_fetch_interval_secs;
            if last_news_fetch.elapsed().as_secs() >= news_interval_secs {
                let ns = news_store.clone();
                let rl = limiter.clone();
                let uv = universe.clone();
                tokio::task::spawn_blocking(move || {
                    ns.fetch_and_update(&rl, &uv);
                }).await.ok();
                last_news_fetch = std::time::Instant::now();
            }

            if !is_weekday { 
                // Weekly scan on Saturday
                if ist_day == "Saturday" && ist_time.as_str() >= "10:00" && ist_time.as_str() < "10:05" && last_weekly != ist_date {
                    info!("Running weekly sector review");
                    let st = state.clone();
                    let uv = universe.clone();
                    let rl = limiter.clone();
                    let ns = news_store.clone();
                    let lg = ledger.clone();
                    tokio::task::spawn_blocking(move || {
                        let sectors = uv.sector_list();
                        for sector in &sectors {
                            let stocks = uv.by_sector(sector);
                            run_sector_scan(&st, &uv, &rl, &ns, &lg, sector, &stocks);
                        }
                    }).await.ok();
                    last_weekly = ist_date.clone();
                }
                continue; 
            }

            // Intraday sector rotation: scan multiple sectors per iteration
            if is_market_hours {
                let sectors = universe.sector_list();
                if !sectors.is_empty() {
                    for _ in 0..sectors_per_iteration {
                        let idx = ledger.next_sector_index();
                        let sector_name = sectors[idx % sectors.len()].clone();
                        let st = state.clone();
                        let uv = universe.clone();
                        let rl = limiter.clone();
                        let ns = news_store.clone();
                        let lg = ledger.clone();
                        let sn = sector_name.clone();
                        tokio::task::spawn_blocking(move || {
                            let stocks = uv.by_sector(&sn);
                            run_sector_scan(&st, &uv, &rl, &ns, &lg, &sn, &stocks);
                        }).await.ok();
                    }
                }

                // Broad universe scan: quick-filter all 3000+ stocks by volume/breakout,
                // then deep-scan survivors. Runs every 30 minutes.
                if last_broad_scan.elapsed().as_secs() >= broad_scan_interval_secs {
                    info!("Starting broad universe volume/breakout scan");
                    let st = state.clone();
                    let uv = universe.clone();
                    let rl = limiter.clone();
                    let ns = news_store.clone();
                    let lg = ledger.clone();
                    tokio::task::spawn_blocking(move || {
                        let all_stocks = uv.symbols().iter()
                            .filter_map(|s| uv.get(s))
                            .collect::<Vec<_>>();
                        let bridge_url = &st.config.broker.icici.bridge_url;

                        let movers = quick_volume_filter(
                            &rl, bridge_url, &all_stocks,
                            50_000.0,  // min avg volume
                            1.5,       // min % change
                        );

                        if !movers.is_empty() {
                            info!(movers = movers.len(), "Broad scan: deep-scanning volume movers");
                            let sectors_seen: std::collections::HashSet<String> = movers.iter()
                                .map(|s| s.sector.clone())
                                .collect();
                            for sector in &sectors_seen {
                                let sector_movers: Vec<_> = movers.iter()
                                    .filter(|s| &s.sector == sector)
                                    .cloned()
                                    .collect();
                                run_sector_scan(&st, &uv, &rl, &ns, &lg, sector, &sector_movers);
                            }
                        }
                    }).await.ok();
                    last_broad_scan = std::time::Instant::now();
                }

                // Futures scan every 15 minutes
                let futures_interval = config.futures_scan_interval_secs;
                if last_futures_scan.elapsed().as_secs() >= futures_interval {
                    let rl = limiter.clone();
                    let bridge = state.config.broker.icici.bridge_url.clone();
                    let uv = universe.clone();
                    let lg = ledger.clone();
                    tokio::task::spawn_blocking(move || {
                        run_futures_scan(&rl, &bridge, &uv, &lg);
                    }).await.ok();
                    last_futures_scan = std::time::Instant::now();
                }

                // Prune stale signals
                ledger.prune_stale(config.signal_ttl_secs);
            }

            // EOD analysis at 15:30
            if ist_time.as_str() >= "15:30" && ist_time.as_str() < "15:35" && last_eod != ist_date {
                info!("Running EOD analysis");
                let st = state.clone();
                let lg = ledger.clone();
                let rl = limiter.clone();
                tokio::task::spawn_blocking(move || {
                    run_eod_analysis(&st, &lg, &rl);
                }).await.ok();
                last_eod = ist_date.clone();
            }
        }
    });
}

// ─── Status Report ───────────────────────────────────────────────────

#[derive(Serialize)]
pub struct ScanStatus {
    pub total_signals: usize,
    pub sector_count: usize,
    pub top_signals: Vec<EnrichedSignal>,
    pub sector_scores: Vec<SectorScore>,
}

pub fn get_status(ledger: &ScanLedger, limit: usize) -> ScanStatus {
    let top = ledger.top_signals(limit);
    let sectors: Vec<SectorScore> = ledger.sector_scores.iter()
        .map(|e| e.value().clone())
        .collect();

    ScanStatus {
        total_signals: ledger.signals.len(),
        sector_count: sectors.len(),
        top_signals: top,
        sector_scores: sectors,
    }
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_scan_ledger_upsert() {
        let ledger = ScanLedger::new();
        let sig = EnrichedSignal {
            symbol: "TCS".into(), direction: "buy".into(), confidence: 0.8,
            entry: 3500.0, stop_loss: Some(3400.0), target: Some(3700.0),
            strategy: "ema_crossover".into(), sector: "IT".into(),
            cap_category: "LargeCap".into(), news_sentiment: 0.3,
            options_pcr: None, options_iv_rank: None,
            futures_basis: None, futures_signal: None,
            ml_score: None, timeframe_alignment: None,
            last_updated: "2024-01-01T00:00:00Z".into(), scan_count: 1,
            volume_ratio: 1.5,
        };
        ledger.upsert_signal("TCS:ema_crossover", sig.clone());
        assert_eq!(ledger.signals.len(), 1);

        // Second upsert should increment scan_count
        ledger.upsert_signal("TCS:ema_crossover", sig);
        let entry = ledger.signals.get("TCS:ema_crossover").unwrap();
        assert_eq!(entry.scan_count, 2);
    }

    #[test]
    fn test_top_signals() {
        let ledger = ScanLedger::new();
        for i in 0..5 {
            let sig = EnrichedSignal {
                symbol: format!("SYM{}", i), direction: "buy".into(),
                confidence: i as f64 * 0.2, entry: 100.0,
                stop_loss: None, target: None,
                strategy: "test".into(), sector: "IT".into(),
                cap_category: "LargeCap".into(), news_sentiment: 0.0,
                options_pcr: None, options_iv_rank: None,
                futures_basis: None, futures_signal: None,
                ml_score: None, timeframe_alignment: None,
                last_updated: "2024-01-01T00:00:00Z".into(), scan_count: 1,
                volume_ratio: 1.0,
            };
            ledger.upsert_signal(&format!("SYM{}:test", i), sig);
        }
        let top = ledger.top_signals(3);
        assert_eq!(top.len(), 3);
        assert!(top[0].confidence >= top[1].confidence);
    }

    #[test]
    fn test_sector_score_update() {
        let ledger = ScanLedger::new();
        let sigs = vec![
            EnrichedSignal {
                symbol: "TCS".into(), direction: "buy".into(), confidence: 0.8,
                entry: 3500.0, stop_loss: None, target: None,
                strategy: "test".into(), sector: "IT".into(),
                cap_category: "LargeCap".into(), news_sentiment: 0.0,
                options_pcr: None, options_iv_rank: None,
                futures_basis: None, futures_signal: None,
                ml_score: None, timeframe_alignment: None,
                last_updated: "2024-01-01T00:00:00Z".into(), scan_count: 1,
                volume_ratio: 1.0,
            },
        ];
        ledger.update_sector_score("IT", &sigs, 0.5);
        assert!(ledger.sector_scores.get("IT").is_some());
        assert_eq!(ledger.sector_scores.get("IT").unwrap().bullish_count, 1);
    }

    #[test]
    fn test_next_sector_index() {
        let ledger = ScanLedger::new();
        assert_eq!(ledger.next_sector_index(), 0);
        assert_eq!(ledger.next_sector_index(), 1);
        assert_eq!(ledger.next_sector_index(), 2);
    }

    #[test]
    fn test_prune_stale() {
        let ledger = ScanLedger::new();
        let old_time = (chrono::Utc::now() - chrono::Duration::hours(2)).to_rfc3339();
        let sig = EnrichedSignal {
            symbol: "OLD".into(), direction: "buy".into(), confidence: 0.5,
            entry: 100.0, stop_loss: None, target: None,
            strategy: "test".into(), sector: "IT".into(),
            cap_category: "LargeCap".into(), news_sentiment: 0.0,
            options_pcr: None, options_iv_rank: None,
            futures_basis: None, futures_signal: None,
            ml_score: None, timeframe_alignment: None,
            last_updated: old_time, scan_count: 1,
            volume_ratio: 1.0,
        };
        ledger.upsert_signal("OLD:test", sig);
        assert_eq!(ledger.signals.len(), 1);
        ledger.prune_stale(3600); // 1 hour max age
        assert_eq!(ledger.signals.len(), 0);
    }

    #[test]
    fn test_get_status() {
        let ledger = ScanLedger::new();
        let status = get_status(&ledger, 10);
        assert_eq!(status.total_signals, 0);
        assert_eq!(status.sector_count, 0);
    }

    #[test]
    fn test_get_status_top_50() {
        let ledger = ScanLedger::new();
        for i in 0..60 {
            let sig = EnrichedSignal {
                symbol: format!("SYM{}", i), direction: "buy".into(),
                confidence: i as f64 * 0.01, entry: 100.0,
                stop_loss: None, target: None,
                strategy: "test".into(), sector: "IT".into(),
                cap_category: "LargeCap".into(), news_sentiment: 0.0,
                options_pcr: None, options_iv_rank: None,
                futures_basis: None, futures_signal: None,
                ml_score: None, timeframe_alignment: None,
                last_updated: chrono::Utc::now().to_rfc3339(), scan_count: 1,
                volume_ratio: 1.0,
            };
            ledger.upsert_signal(&format!("SYM{}:test", i), sig);
        }
        let status = get_status(&ledger, 50);
        assert_eq!(status.total_signals, 60);
        assert_eq!(status.top_signals.len(), 50);
        assert!(status.top_signals[0].confidence >= status.top_signals[49].confidence);
    }

    #[test]
    fn test_prune_stale_keeps_recent() {
        let ledger = ScanLedger::new();
        let recent = chrono::Utc::now().to_rfc3339();
        let old = (chrono::Utc::now() - chrono::Duration::hours(5)).to_rfc3339();

        for (key, ts) in [("RECENT:test", recent), ("OLD:test", old)] {
            let sig = EnrichedSignal {
                symbol: key.split(':').next().unwrap().into(), direction: "buy".into(),
                confidence: 0.7, entry: 100.0,
                stop_loss: None, target: None,
                strategy: "test".into(), sector: "IT".into(),
                cap_category: "LargeCap".into(), news_sentiment: 0.0,
                options_pcr: None, options_iv_rank: None,
                futures_basis: None, futures_signal: None,
                ml_score: None, timeframe_alignment: None,
                last_updated: ts, scan_count: 1,
                volume_ratio: 1.0,
            };
            ledger.upsert_signal(key, sig);
        }
        assert_eq!(ledger.signals.len(), 2);
        ledger.prune_stale(14400); // 4 hours
        assert_eq!(ledger.signals.len(), 1);
        assert!(ledger.signals.get("RECENT:test").is_some());
    }

    #[test]
    fn test_multiple_sectors_score_tracking() {
        let ledger = ScanLedger::new();
        let sectors = ["IT", "Banking", "Pharma", "Auto", "Energy"];
        for sector in &sectors {
            let sigs = vec![EnrichedSignal {
                symbol: format!("{}_STOCK", sector), direction: "buy".into(),
                confidence: 0.75, entry: 500.0,
                stop_loss: None, target: None,
                strategy: "composite".into(), sector: sector.to_string(),
                cap_category: "LargeCap".into(), news_sentiment: 0.1,
                options_pcr: None, options_iv_rank: None,
                futures_basis: None, futures_signal: None,
                ml_score: None, timeframe_alignment: None,
                last_updated: chrono::Utc::now().to_rfc3339(), scan_count: 1,
                volume_ratio: 1.2,
            }];
            ledger.update_sector_score(sector, &sigs, 0.3);
        }
        assert_eq!(ledger.sector_scores.len(), 5);
        for sector in &sectors {
            assert!(ledger.sector_scores.get(*sector).is_some());
        }
    }

    #[test]
    fn test_enriched_signal_serialization() {
        let sig = EnrichedSignal {
            symbol: "RELIANCE".into(), direction: "buy".into(), confidence: 0.85,
            entry: 2500.0, stop_loss: Some(2450.0), target: Some(2600.0),
            strategy: "composite".into(), sector: "Energy".into(),
            cap_category: "LargeCap".into(), news_sentiment: 0.5,
            options_pcr: Some(1.2), options_iv_rank: Some(0.45),
            futures_basis: Some(0.15), futures_signal: Some(0.8),
            ml_score: Some(0.72), timeframe_alignment: Some(0.9),
            last_updated: "2026-03-18T10:00:00Z".into(), scan_count: 3,
            volume_ratio: 2.1,
        };
        let json = serde_json::to_string(&sig).unwrap();
        assert!(json.contains("RELIANCE"));
        assert!(json.contains("0.85"));
        assert!(json.contains("Energy"));
        assert!(json.contains("2.1"));
    }
}
