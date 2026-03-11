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
}

impl Position {
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
        let oms = OMS::new(broker.clone(), fat_finger);
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
                        if let Some(mut pos) = state.positions.get_mut(&tick.symbol) {
                            pos.update_price(tick.ltp);
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
        if let Ok(mut log) = self.audit_log.lock() {
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
        self.audit_log.lock().map(|l| l.clone()).unwrap_or_default()
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
            state.positions.insert(pos.symbol.clone(), pos);
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

        let _guard = self.position_lock.lock().unwrap();

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

        let sym = pos.symbol.clone();
        let detail = format!("side={} qty={} price={:.2}", pos.side, pos.qty, pos.entry_price);
        self.positions.insert(sym.clone(), pos);
        self.recalculate_nav_locked();
        self.log_audit("OPEN_POSITION", Some(&sym), &detail);
        Ok(())
    }

    /// Close a position by symbol. Returns the realized PnL.
    /// Holds position_lock so cash + positions are read atomically in recalculate_nav.
    pub fn close_position(&self, symbol: &str, exit_price: f64) -> Result<f64, String> {
        let _guard = self.position_lock.lock().unwrap();

        match self.positions.remove(symbol) {
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
        let _guard = self.position_lock.lock().unwrap();
        self.recalculate_nav_locked();
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
}
