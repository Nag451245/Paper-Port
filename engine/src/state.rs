use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, AtomicU32, AtomicU64, AtomicUsize, Ordering};
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use crate::config::EngineConfig;
use crate::broker::{BrokerAdapter, PaperBroker};
use crate::broker_icici::IciciBreezeBroker;
use crate::broker_zerodha::ZerodhaBroker;
use crate::broker_upstox::UpstoxBroker;
use crate::oms::{OMS, FatFingerLimits};
use crate::alerts::{AlertManager, NotificationConfig};
use crate::market_data::LivePriceStore;
use crate::options_data::OptionsDataStore;

// ─── Position Tracking ────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Position {
    pub symbol: String,
    pub side: String,
    pub qty: i64,
    pub entry_price: f64,
    pub current_price: f64,
    pub unrealized_pnl: f64,
    pub realized_pnl: f64,
    pub entry_time: String,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    #[serde(default)]
    pub asset_class: crate::broker::AssetClass,
    #[serde(default)]
    pub expiry: Option<String>,
    #[serde(default)]
    pub strike: Option<f64>,
    #[serde(default)]
    pub option_type: Option<String>,
}

/// Build a position key that differentiates the same underlying across asset classes.
/// Equity: "RELIANCE", Futures: "RELIANCE:FUT:2026-03", Options: "RELIANCE:OPT:2026-03:22000:CE",
/// FX: "USDINR:FX", Crypto: "BTCUSDT:CRYPTO"
pub fn position_key(symbol: &str, ac: crate::broker::AssetClass,
                    expiry: Option<&str>, strike: Option<f64>, opt_type: Option<&str>) -> String {
    match ac {
        crate::broker::AssetClass::Equity => symbol.to_string(),
        crate::broker::AssetClass::Futures => {
            format!("{}:FUT:{}", symbol, expiry.unwrap_or(""))
        }
        crate::broker::AssetClass::Options => {
            format!("{}:OPT:{}:{}:{}", symbol,
                expiry.unwrap_or(""),
                strike.map(|s| format!("{:.0}", s)).unwrap_or_default(),
                opt_type.unwrap_or(""))
        }
        crate::broker::AssetClass::FX => {
            format!("{}:FX", symbol)
        }
        crate::broker::AssetClass::Crypto => {
            format!("{}:CRYPTO", symbol)
        }
    }
}

impl Position {
    /// Unique position key that differentiates across asset classes.
    /// Equity: "RELIANCE", Futures: "RELIANCE:FUT:2026-03", Options: "RELIANCE:OPT:2026-03:22000:CE"
    pub fn key(&self) -> String {
        position_key(
            &self.symbol,
            self.asset_class,
            self.expiry.as_deref(),
            self.strike,
            self.option_type.as_deref(),
        )
    }

    pub fn update_price(&mut self, price: f64) {
        self.current_price = price;
        self.unrealized_pnl = if self.side == "buy" {
            (price - self.entry_price) * self.qty as f64
        } else {
            (self.entry_price - price) * self.qty as f64
        };
    }

    pub fn market_value(&self) -> f64 {
        self.current_price * self.qty.unsigned_abs() as f64
    }
}

// ─── Signal Cache ─────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CachedSignal {
    pub symbol: String,
    pub strategy: String,
    pub side: String,
    pub price: f64,
    pub confidence: f64,
    pub reason: String,
    pub timestamp: String,
    pub ttl_seconds: u64,
    #[serde(default)]
    pub stop_loss: Option<f64>,
    #[serde(default)]
    pub take_profit: Option<f64>,
    #[serde(default)]
    pub suggested_qty: Option<i64>,
}

// ─── Portfolio Snapshot ───────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PortfolioSnapshot {
    pub nav: f64,
    pub cash: f64,
    pub total_unrealized_pnl: f64,
    pub total_realized_pnl: f64,
    pub position_count: usize,
    pub peak_nav: f64,
    pub drawdown_pct: f64,
    pub daily_trades: usize,
    pub killed: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct PersistenceSnapshot {
    pub nav: f64,
    pub cash: f64,
    pub realized_pnl: f64,
    pub peak_nav: f64,
    pub positions: Vec<Position>,
    pub timestamp: String,
}

// ─── Audit Log ────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct AuditEntry {
    pub timestamp: String,
    pub action: String,
    pub symbol: Option<String>,
    pub details: String,
}

// ─── AppState ─────────────────────────────────────────────────────────

/// Shared application state, accessible from every handler via Arc.
/// Uses DashMap for lock-free concurrent reads/writes.
pub struct AppState {
    pub config: EngineConfig,
    pub positions: DashMap<String, Position>,
    pub signal_cache: DashMap<String, CachedSignal>,
    pub nav: AtomicU64,
    pub peak_nav: AtomicU64,
    pub cash: AtomicU64,
    pub realized_pnl: AtomicU64,
    pub daily_trade_count: AtomicUsize,
    last_reset_day: AtomicU32,
    pub started_at: std::time::Instant,
    /// Guards open_position/close_position/recalculate_nav to prevent TOCTOU races
    position_lock: Mutex<()>,
    /// Emergency kill switch — when true, all new orders are rejected
    pub killed: AtomicBool,
    /// Audit log entries
    pub audit_log: Mutex<Vec<AuditEntry>>,
    /// Order Management System
    pub oms: OMS,
    /// Alert manager
    pub alert_manager: AlertManager,
    /// The active broker adapter (paper, ICICI, Zerodha, Upstox)
    pub broker_adapter: Arc<dyn BrokerAdapter>,
    /// Live market price store (populated by market data feed)
    pub live_prices: Arc<LivePriceStore>,
    /// Options chain data store (populated by options feed)
    pub options_data: Arc<OptionsDataStore>,
}

impl AppState {
    pub fn new(config: EngineConfig, initial_capital: f64) -> Arc<Self> {
        let broker: Arc<dyn BrokerAdapter> = create_broker(&config, initial_capital);
        let fat_finger = FatFingerLimits::default();
        let oms = OMS::new(broker.clone(), fat_finger)
            .with_retry(
                config.oms_retry.enabled,
                config.oms_retry.max_retries,
                config.oms_retry.initial_backoff_ms,
            );
        let alert_manager = AlertManager::new(NotificationConfig::default());
        let (live_prices, _price_rx) = LivePriceStore::new();
        let options_data = OptionsDataStore::new();

        Arc::new(Self {
            config,
            positions: DashMap::new(),
            signal_cache: DashMap::new(),
            nav: f64_to_atomic(initial_capital),
            peak_nav: f64_to_atomic(initial_capital),
            cash: f64_to_atomic(initial_capital),
            realized_pnl: f64_to_atomic(0.0),
            daily_trade_count: AtomicUsize::new(0),
            last_reset_day: AtomicU32::new(current_day_key()),
            started_at: std::time::Instant::now(),
            position_lock: Mutex::new(()),
            killed: AtomicBool::new(false),
            audit_log: Mutex::new(Vec::new()),
            oms,
            alert_manager,
            broker_adapter: broker,
            live_prices,
            options_data,
        })
    }

    /// Spawn a background task that reads live price updates and updates position P&L.
    /// Must be called from an async (Tokio) context.
    pub fn start_price_update_loop(state: Arc<Self>) {
        let mut rx = state.live_prices.subscribe();
        tokio::spawn(async move {
            loop {
                match rx.recv().await {
                    Ok(tick) => {
                        for mut entry in state.positions.iter_mut() {
                            if entry.value().symbol == tick.symbol {
                                entry.value_mut().update_price(tick.ltp);
                            }
                        }
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Lagged(n)) => {
                        tracing::warn!(lagged = n, "Price update loop lagged, skipping ticks");
                    }
                    Err(tokio::sync::broadcast::error::RecvError::Closed) => {
                        tracing::info!("Price broadcast channel closed, stopping update loop");
                        break;
                    }
                }
            }
        });
    }

    pub fn get_nav(&self) -> f64 {
        f64::from_bits(self.nav.load(Ordering::Acquire))
    }

    pub fn set_nav(&self, val: f64) {
        self.nav.store(val.to_bits(), Ordering::Release);
        loop {
            let old_peak_bits = self.peak_nav.load(Ordering::Acquire);
            let old_peak = f64::from_bits(old_peak_bits);
            if val <= old_peak { break; }
            if self.peak_nav.compare_exchange_weak(
                old_peak_bits, val.to_bits(),
                Ordering::AcqRel, Ordering::Relaxed,
            ).is_ok() {
                break;
            }
        }
    }

    pub fn get_peak_nav(&self) -> f64 {
        f64::from_bits(self.peak_nav.load(Ordering::Acquire))
    }

    pub fn get_cash(&self) -> f64 {
        f64::from_bits(self.cash.load(Ordering::Acquire))
    }

    pub fn set_cash(&self, val: f64) {
        self.cash.store(val.to_bits(), Ordering::Release);
    }

    fn adjust_cash(&self, delta: f64) {
        loop {
            let old_bits = self.cash.load(Ordering::Acquire);
            let old_val = f64::from_bits(old_bits);
            let new_bits = (old_val + delta).to_bits();
            if self.cash.compare_exchange_weak(
                old_bits, new_bits,
                Ordering::AcqRel, Ordering::Relaxed,
            ).is_ok() {
                break;
            }
        }
    }

    pub fn get_realized_pnl(&self) -> f64 {
        f64::from_bits(self.realized_pnl.load(Ordering::Acquire))
    }

    pub fn add_realized_pnl(&self, pnl: f64) {
        loop {
            let old_bits = self.realized_pnl.load(Ordering::Acquire);
            let old_val = f64::from_bits(old_bits);
            let new_bits = (old_val + pnl).to_bits();
            if self.realized_pnl.compare_exchange_weak(
                old_bits, new_bits,
                Ordering::AcqRel, Ordering::Relaxed,
            ).is_ok() {
                break;
            }
        }
    }

    pub fn increment_trades(&self) -> usize {
        self.check_daily_reset();
        self.daily_trade_count.fetch_add(1, Ordering::AcqRel) + 1
    }

    pub fn reset_daily_trades(&self) {
        self.daily_trade_count.store(0, Ordering::Release);
        self.last_reset_day.store(current_day_key(), Ordering::Release);
    }

    /// Auto-reset trade count if the day has changed (CAS to avoid TOCTOU race)
    fn check_daily_reset(&self) {
        let today = current_day_key();
        let last = self.last_reset_day.load(Ordering::Acquire);
        if today != last {
            if self.last_reset_day.compare_exchange(
                last, today,
                Ordering::AcqRel, Ordering::Relaxed,
            ).is_ok() {
                self.daily_trade_count.store(0, Ordering::Release);
            }
        }
    }

    // ─── Kill Switch ──────────────────────────────────────────────────

    pub fn activate_kill_switch(&self) {
        self.killed.store(true, Ordering::Release);
        self.log_audit("KILL_SWITCH", None, "Emergency kill switch activated");
    }

    pub fn deactivate_kill_switch(&self) {
        self.killed.store(false, Ordering::Release);
        self.log_audit("KILL_SWITCH_OFF", None, "Kill switch deactivated");
    }

    pub fn is_killed(&self) -> bool {
        self.killed.load(Ordering::Acquire)
    }

    // ─── Audit Log ────────────────────────────────────────────────────

    pub fn log_audit(&self, action: &str, symbol: Option<&str>, details: &str) {
        if let Ok(mut log) = self.audit_log.lock().or_else(|e| Ok::<_, ()>(e.into_inner())) {
            log.push(AuditEntry {
                timestamp: chrono::Utc::now().to_rfc3339(),
                action: action.to_string(),
                symbol: symbol.map(|s| s.to_string()),
                details: details.to_string(),
            });
            const MAX_AUDIT_ENTRIES: usize = 10_000;
            if log.len() > MAX_AUDIT_ENTRIES {
                let drain_count = log.len() - MAX_AUDIT_ENTRIES;
                log.drain(..drain_count);
            }
        }
    }

    pub fn get_audit_log(&self) -> Vec<AuditEntry> {
        self.audit_log.lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }

    // ─── State Persistence ────────────────────────────────────────────

    pub fn save_snapshot(&self, path: &str) -> Result<(), String> {
        let snapshot = self.persistence_snapshot();
        let json = serde_json::to_string_pretty(&snapshot).map_err(|e| e.to_string())?;
        std::fs::write(path, json).map_err(|e| e.to_string())
    }

    pub fn load_snapshot(config: EngineConfig, path: &str) -> Result<Arc<Self>, String> {
        let json = std::fs::read_to_string(path).map_err(|e| e.to_string())?;
        let snap: PersistenceSnapshot = serde_json::from_str(&json).map_err(|e| e.to_string())?;
        let state = Self::new(config, snap.nav);
        state.set_cash(snap.cash);
        // Restore peak_nav BEFORE set_nav, so the CAS in set_nav preserves whichever is higher
        state.peak_nav.store(snap.peak_nav.to_bits(), Ordering::Release);
        state.set_nav(snap.nav);
        for pos in snap.positions {
            let key = pos.key();
            state.positions.insert(key, pos);
        }
        if snap.realized_pnl != 0.0 {
            state.add_realized_pnl(snap.realized_pnl);
        }
        Ok(state)
    }

    fn persistence_snapshot(&self) -> PersistenceSnapshot {
        let positions: Vec<Position> = self.positions.iter()
            .map(|e| e.value().clone())
            .collect();
        PersistenceSnapshot {
            nav: self.get_nav(),
            cash: self.get_cash(),
            realized_pnl: self.get_realized_pnl(),
            peak_nav: self.get_peak_nav(),
            positions,
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }

    pub fn snapshot(&self) -> PortfolioSnapshot {
        let killed = self.is_killed();
        let mut total_unrealized = 0.0;
        let mut position_count = 0;
        for entry in self.positions.iter() {
            total_unrealized += entry.value().unrealized_pnl;
            position_count += 1;
        }

        let nav = self.get_nav();
        let peak = self.get_peak_nav();
        let dd = if peak > 0.0 { (peak - nav) / peak * 100.0 } else { 0.0 };

        PortfolioSnapshot {
            nav,
            cash: self.get_cash(),
            total_unrealized_pnl: total_unrealized,
            total_realized_pnl: self.get_realized_pnl(),
            position_count,
            peak_nav: peak,
            drawdown_pct: dd,
            daily_trades: self.daily_trade_count.load(Ordering::Acquire),
            killed,
        }
    }

    /// Open a new position. Returns Err if risk limits are exceeded or kill switch is active.
    /// Holds position_lock to prevent TOCTOU between len check and insert.
    pub fn open_position(&self, pos: Position) -> Result<(), String> {
        if self.is_killed() {
            return Err("Kill switch is active — all new orders rejected".into());
        }

        let _guard = self.position_lock.lock().unwrap_or_else(|e| e.into_inner());

        let nav = self.get_nav();

        if self.positions.len() >= self.config.risk.max_open_positions {
            return Err(format!("Max open positions ({}) reached", self.config.risk.max_open_positions));
        }

        let position_value = pos.entry_price * pos.qty.unsigned_abs() as f64;
        let pct = position_value / nav * 100.0;
        if pct > self.config.risk.max_position_size_pct {
            return Err(format!(
                "Position {:.1}% exceeds max {:.1}%", pct, self.config.risk.max_position_size_pct
            ));
        }

        self.check_daily_reset();
        let current_count = self.daily_trade_count.load(std::sync::atomic::Ordering::Relaxed);
        if current_count >= self.config.risk.max_daily_trades {
            return Err(format!("Max daily trades ({}) reached", self.config.risk.max_daily_trades));
        }

        let peak = self.get_peak_nav();
        let dd = if peak > 0.0 { (peak - nav) / peak * 100.0 } else { 0.0 };
        if dd > self.config.risk.max_drawdown_pct {
            return Err(format!(
                "Drawdown {:.1}% exceeds circuit breaker {:.1}%", dd, self.config.risk.max_drawdown_pct
            ));
        }

        self.increment_trades();

        let cost = position_value * self.config.costs.slippage_bps / 10_000.0
            + self.config.costs.commission_per_trade;
        self.adjust_cash(-(position_value + cost));

        let key = pos.key();
        let detail = format!("side={} qty={} price={:.2} key={}", pos.side, pos.qty, pos.entry_price, key);
        self.positions.insert(key.clone(), pos);
        self.recalculate_nav_locked();
        self.log_audit("OPEN_POSITION", Some(&key), &detail);
        Ok(())
    }

    /// Close a position by key (or symbol for backward compat). Returns the realized PnL.
    /// Holds position_lock so cash + positions are read atomically in recalculate_nav.
    pub fn close_position(&self, symbol: &str, exit_price: f64) -> Result<f64, String> {
        let _guard = self.position_lock.lock().unwrap_or_else(|e| e.into_inner());

        match self.positions.remove(symbol).or_else(|| {
            let matching_key = self.positions.iter()
                .find(|entry| entry.value().symbol == symbol)
                .map(|entry| entry.key().clone());
            matching_key.and_then(|k| self.positions.remove(&k))
        }) {
            Some((_, mut pos)) => {
                pos.update_price(exit_price);
                let pnl = pos.unrealized_pnl;
                let value = exit_price * pos.qty.unsigned_abs() as f64;
                let is_sell_txn = pos.side == "buy";
                let cost = value * self.config.costs.slippage_bps / 10_000.0
                    + self.config.costs.commission_per_trade
                    + if is_sell_txn { value * self.config.costs.stt_pct / 100.0 } else { 0.0 };

                let net_pnl = pnl - cost;
                self.add_realized_pnl(net_pnl);
                self.adjust_cash(value - cost);
                self.recalculate_nav_locked();
                self.log_audit(
                    "CLOSE_POSITION", Some(symbol),
                    &format!("exit_price={:.2} pnl={:.2}", exit_price, net_pnl),
                );
                Ok(net_pnl)
            }
            None => Err(format!("No open position for {}", symbol)),
        }
    }

    /// Must be called while position_lock is held (open_position / close_position).
    /// Reads cash + all position values as a consistent snapshot.
    fn recalculate_nav_locked(&self) {
        let mut total = self.get_cash();
        for entry in self.positions.iter() {
            total += entry.value().market_value();
        }
        self.set_nav(total);
    }

    /// Public recalculate_nav that acquires the lock itself (for external callers).
    pub fn recalculate_nav(&self) {
        let _guard = self.position_lock.lock().unwrap_or_else(|e| e.into_inner());
        self.recalculate_nav_locked();
    }

    /// Sync a filled OMS order into AppState.positions.
    /// Call after submit_order when the order is filled.
    /// Holds position_lock for the entire operation to prevent TOCTOU races.
    /// For equity positions, `symbol` alone is sufficient. For derivatives, the
    /// key is derived from the Position's asset_class fields via `position_key()`.
    pub fn sync_oms_fill(&self, symbol: &str, side: &str, qty: i64, fill_price: f64,
                         stop_loss: Option<f64>, take_profit: Option<f64>) {
        let _guard = self.position_lock.lock().unwrap_or_else(|e| e.into_inner());

        let key = {
            if let Some(entry) = self.positions.iter().find(|e| e.value().symbol == symbol) {
                entry.key().clone()
            } else {
                symbol.to_string()
            }
        };

        if let Some(mut existing) = self.positions.get_mut(&key) {
            let same_side = existing.side.eq_ignore_ascii_case(side);
            if same_side {
                let old_qty = existing.qty;
                let old_price = existing.entry_price;
                let new_qty = old_qty + qty;
                existing.entry_price = (old_price * old_qty as f64 + fill_price * qty as f64) / new_qty as f64;
                existing.qty = new_qty;
                existing.update_price(fill_price);
                if stop_loss.is_some() { existing.stop_loss = stop_loss; }
                if take_profit.is_some() { existing.take_profit = take_profit; }
            } else {
                let close_qty = qty.min(existing.qty);
                let remaining = existing.qty - close_qty;
                if remaining <= 0 {
                    let pnl = if existing.side.eq_ignore_ascii_case("buy") {
                        (fill_price - existing.entry_price) * close_qty as f64
                    } else {
                        (existing.entry_price - fill_price) * close_qty as f64
                    };
                    drop(existing);
                    self.positions.remove(&key);
                    self.add_realized_pnl(pnl);
                    let value = fill_price * close_qty.unsigned_abs() as f64;
                    self.adjust_cash(value);
                } else {
                    let partial_pnl = if existing.side.eq_ignore_ascii_case("buy") {
                        (fill_price - existing.entry_price) * close_qty as f64
                    } else {
                        (existing.entry_price - fill_price) * close_qty as f64
                    };
                    let partial_value = fill_price * close_qty.unsigned_abs() as f64;
                    self.add_realized_pnl(partial_pnl);
                    self.adjust_cash(partial_value);
                    existing.qty = remaining;
                    existing.update_price(fill_price);
                }
            }
        } else {
            let pos = Position {
                symbol: symbol.to_string(),
                side: side.to_string(),
                qty,
                entry_price: fill_price,
                current_price: fill_price,
                unrealized_pnl: 0.0,
                realized_pnl: 0.0,
                entry_time: chrono::Utc::now().to_rfc3339(),
                stop_loss,
                take_profit,
                asset_class: crate::broker::AssetClass::Equity,
                expiry: None,
                strike: None,
                option_type: None,
            };
            let new_key = pos.key();
            self.positions.insert(new_key, pos);
        }
    }

    pub fn cache_signal(&self, signal: CachedSignal) {
        let key = format!("{}:{}", signal.symbol, signal.strategy);
        self.signal_cache.insert(key, signal);
    }

    pub fn get_cached_signals(&self, symbol: &str) -> Vec<CachedSignal> {
        self.signal_cache.iter()
            .filter(|entry| entry.value().symbol == symbol)
            .map(|entry| entry.value().clone())
            .collect()
    }

    pub fn uptime_seconds(&self) -> u64 {
        self.started_at.elapsed().as_secs()
    }
}

/// Select the broker adapter based on configuration
fn create_broker(config: &EngineConfig, initial_capital: f64) -> Arc<dyn BrokerAdapter> {
    match config.broker.adapter.as_str() {
        "icici_breeze" | "icici" => {
            tracing::info!("Using ICICI Breeze broker adapter");
            Arc::new(IciciBreezeBroker::new(config.broker.icici.clone()))
        }
        "zerodha" | "kite" => {
            tracing::info!("Using Zerodha Kite broker adapter (stub)");
            Arc::new(ZerodhaBroker::new(config.broker.zerodha.clone()))
        }
        "upstox" => {
            tracing::info!("Using Upstox broker adapter (stub)");
            Arc::new(UpstoxBroker::new(config.broker.upstox.clone()))
        }
        _ => {
            tracing::info!("Using paper broker (simulated)");
            Arc::new(PaperBroker::new(initial_capital))
        }
    }
}

fn f64_to_atomic(v: f64) -> AtomicU64 {
    AtomicU64::new(v.to_bits())
}

/// Returns a u32 key encoding the current calendar day (year * 1000 + day_of_year)
fn current_day_key() -> u32 {
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let days_since_epoch = (now / 86400) as u32;
    days_since_epoch
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::EngineConfig;

    fn make_state() -> Arc<AppState> {
        AppState::new(EngineConfig::default(), 1_000_000.0)
    }

    #[test]
    fn test_initial_state() {
        let state = make_state();
        assert_eq!(state.get_nav(), 1_000_000.0);
        assert_eq!(state.get_cash(), 1_000_000.0);
        assert_eq!(state.get_realized_pnl(), 0.0);
        assert_eq!(state.positions.len(), 0);
    }

    #[test]
    fn test_open_and_close_position() {
        let state = make_state();
        let pos = Position {
            symbol: "RELIANCE".into(),
            side: "buy".into(),
            qty: 50,
            entry_price: 2500.0,
            current_price: 2500.0,
            unrealized_pnl: 0.0,
            realized_pnl: 0.0,
            entry_time: "2025-01-01T10:00:00".into(),
            stop_loss: Some(2400.0),
            take_profit: Some(2600.0),
            asset_class: crate::broker::AssetClass::Equity,
            expiry: None,
            strike: None,
            option_type: None,
        };
        assert!(state.open_position(pos).is_ok());
        assert_eq!(state.positions.len(), 1);

        let pnl = state.close_position("RELIANCE", 2600.0);
        assert!(pnl.is_ok());
        assert_eq!(state.positions.len(), 0);
        assert!(state.get_realized_pnl() > 0.0);
    }

    #[test]
    fn test_position_size_limit() {
        let state = make_state();
        let pos = Position {
            symbol: "BIG".into(),
            side: "buy".into(),
            qty: 1000,
            entry_price: 5000.0,
            current_price: 5000.0,
            unrealized_pnl: 0.0,
            realized_pnl: 0.0,
            entry_time: "2025-01-01T10:00:00".into(),
            stop_loss: None,
            take_profit: None,
            asset_class: crate::broker::AssetClass::Equity,
            expiry: None,
            strike: None,
            option_type: None,
        };
        let result = state.open_position(pos);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("exceeds max"));
    }

    #[test]
    fn test_snapshot() {
        let state = make_state();
        let snap = state.snapshot();
        assert_eq!(snap.nav, 1_000_000.0);
        assert_eq!(snap.position_count, 0);
        assert_eq!(snap.drawdown_pct, 0.0);
        assert!(!snap.killed);
    }

    #[test]
    fn test_kill_switch() {
        let state = make_state();
        assert!(!state.is_killed());
        state.activate_kill_switch();
        assert!(state.is_killed());
        let pos = Position {
            symbol: "TEST".into(), side: "buy".into(), qty: 10,
            entry_price: 100.0, current_price: 100.0, unrealized_pnl: 0.0,
            realized_pnl: 0.0, entry_time: "2025-01-01".into(),
            stop_loss: None, take_profit: None,
            asset_class: crate::broker::AssetClass::Equity,
            expiry: None, strike: None, option_type: None,
        };
        assert!(state.open_position(pos).is_err());
        state.deactivate_kill_switch();
        assert!(!state.is_killed());
    }

    #[test]
    fn test_signal_cache() {
        let state = make_state();
        state.cache_signal(CachedSignal {
            symbol: "NIFTY".into(),
            strategy: "ema_crossover".into(),
            side: "buy".into(),
            price: 22000.0,
            confidence: 0.85,
            reason: "EMA crossover".into(),
            timestamp: "2025-01-01T10:00:00".into(),
            ttl_seconds: 300,
            stop_loss: Some(21800.0),
            take_profit: Some(22200.0),
            suggested_qty: Some(50),
        });
        let signals = state.get_cached_signals("NIFTY");
        assert_eq!(signals.len(), 1);
        assert_eq!(signals[0].confidence, 0.85);
    }

    #[test]
    fn test_nav_tracking() {
        let state = make_state();
        state.set_nav(1_100_000.0);
        assert_eq!(state.get_peak_nav(), 1_100_000.0);

        state.set_nav(1_000_000.0);
        assert_eq!(state.get_peak_nav(), 1_100_000.0);
    }

    #[test]
    fn test_close_nonexistent_position() {
        let state = make_state();
        assert!(state.close_position("FAKE", 100.0).is_err());
    }

    #[test]
    fn test_sync_oms_fill_creates_position() {
        let state = make_state();
        state.sync_oms_fill("INFY", "buy", 10, 1500.0, Some(1450.0), Some(1550.0));
        assert_eq!(state.positions.len(), 1);
        let pos = state.positions.get("INFY").unwrap();
        assert_eq!(pos.qty, 10);
        assert_eq!(pos.entry_price, 1500.0);
        assert_eq!(pos.stop_loss, Some(1450.0));
    }

    #[test]
    fn test_sync_oms_fill_adds_to_existing() {
        let state = make_state();
        state.sync_oms_fill("RELIANCE", "buy", 10, 2500.0, None, None);
        state.sync_oms_fill("RELIANCE", "buy", 10, 2600.0, None, None);
        let pos = state.positions.get("RELIANCE").unwrap();
        assert_eq!(pos.qty, 20);
        assert!((pos.entry_price - 2550.0).abs() < 0.01, "avg price should be 2550");
    }

    #[test]
    fn test_sync_oms_fill_closes_opposite() {
        let state = make_state();
        state.sync_oms_fill("TCS", "buy", 10, 3500.0, None, None);
        assert_eq!(state.positions.len(), 1);
        state.sync_oms_fill("TCS", "sell", 10, 3600.0, None, None);
        assert_eq!(state.positions.len(), 0, "opposite fill should close position");
        assert!(state.get_realized_pnl() > 0.0, "should have positive realized PnL");
    }
}
