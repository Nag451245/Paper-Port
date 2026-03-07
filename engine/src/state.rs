use std::sync::Arc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use crate::config::EngineConfig;

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
}

// ─── AppState ─────────────────────────────────────────────────────────

/// Shared application state, accessible from every handler via Arc.
/// Uses DashMap for lock-free concurrent reads/writes.
pub struct AppState {
    pub config: EngineConfig,
    pub positions: DashMap<String, Position>,
    pub signal_cache: DashMap<String, CachedSignal>,
    pub nav: std::sync::atomic::AtomicU64,
    pub peak_nav: std::sync::atomic::AtomicU64,
    pub cash: std::sync::atomic::AtomicU64,
    pub realized_pnl: std::sync::atomic::AtomicU64,
    pub daily_trade_count: std::sync::atomic::AtomicUsize,
    /// Stores the day-of-year * 1000 + year for automatic daily reset
    last_reset_day: std::sync::atomic::AtomicU32,
    pub started_at: std::time::Instant,
}

impl AppState {
    pub fn new(config: EngineConfig, initial_capital: f64) -> Arc<Self> {
        Arc::new(Self {
            config,
            positions: DashMap::new(),
            signal_cache: DashMap::new(),
            nav: f64_to_atomic(initial_capital),
            peak_nav: f64_to_atomic(initial_capital),
            cash: f64_to_atomic(initial_capital),
            realized_pnl: f64_to_atomic(0.0),
            daily_trade_count: std::sync::atomic::AtomicUsize::new(0),
            last_reset_day: std::sync::atomic::AtomicU32::new(current_day_key()),
            started_at: std::time::Instant::now(),
        })
    }

    pub fn get_nav(&self) -> f64 {
        atomic_to_f64(&self.nav)
    }

    pub fn set_nav(&self, val: f64) {
        self.nav.store(val.to_bits(), std::sync::atomic::Ordering::Relaxed);
        let peak = self.get_peak_nav();
        if val > peak {
            self.peak_nav.store(val.to_bits(), std::sync::atomic::Ordering::Relaxed);
        }
    }

    pub fn get_peak_nav(&self) -> f64 {
        atomic_to_f64(&self.peak_nav)
    }

    pub fn get_cash(&self) -> f64 {
        atomic_to_f64(&self.cash)
    }

    pub fn set_cash(&self, val: f64) {
        self.cash.store(val.to_bits(), std::sync::atomic::Ordering::Relaxed);
    }

    pub fn get_realized_pnl(&self) -> f64 {
        atomic_to_f64(&self.realized_pnl)
    }

    pub fn add_realized_pnl(&self, pnl: f64) {
        let current = self.get_realized_pnl();
        self.realized_pnl.store((current + pnl).to_bits(), std::sync::atomic::Ordering::Relaxed);
    }

    pub fn increment_trades(&self) -> usize {
        self.check_daily_reset();
        self.daily_trade_count.fetch_add(1, std::sync::atomic::Ordering::Relaxed) + 1
    }

    pub fn reset_daily_trades(&self) {
        self.daily_trade_count.store(0, std::sync::atomic::Ordering::Relaxed);
        self.last_reset_day.store(current_day_key(), std::sync::atomic::Ordering::Relaxed);
    }

    /// Auto-reset trade count if the day has changed
    fn check_daily_reset(&self) {
        let today = current_day_key();
        let last = self.last_reset_day.load(std::sync::atomic::Ordering::Relaxed);
        if today != last {
            self.daily_trade_count.store(0, std::sync::atomic::Ordering::Relaxed);
            self.last_reset_day.store(today, std::sync::atomic::Ordering::Relaxed);
        }
    }

    pub fn snapshot(&self) -> PortfolioSnapshot {
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
            daily_trades: self.daily_trade_count.load(std::sync::atomic::Ordering::Relaxed),
        }
    }

    /// Open a new position. Returns Err if risk limits are exceeded.
    pub fn open_position(&self, pos: Position) -> Result<(), String> {
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

        // Check trade count BEFORE incrementing so rejections don't inflate the counter
        self.check_daily_reset();
        let current_count = self.daily_trade_count.load(std::sync::atomic::Ordering::Relaxed);
        if current_count >= self.config.risk.max_daily_trades {
            return Err(format!("Max daily trades ({}) reached", self.config.risk.max_daily_trades));
        }

        let peak = self.get_peak_nav();
        let dd = (peak - nav) / peak * 100.0;
        if dd > self.config.risk.max_drawdown_pct {
            return Err(format!(
                "Drawdown {:.1}% exceeds circuit breaker {:.1}%", dd, self.config.risk.max_drawdown_pct
            ));
        }

        // All risk checks passed — NOW increment
        self.increment_trades();

        let cost = position_value * self.config.costs.slippage_bps / 10_000.0
            + self.config.costs.commission_per_trade;
        self.set_cash(self.get_cash() - position_value - cost);

        self.positions.insert(pos.symbol.clone(), pos);
        self.recalculate_nav();
        Ok(())
    }

    /// Close a position by symbol. Returns the realized PnL.
    pub fn close_position(&self, symbol: &str, exit_price: f64) -> Result<f64, String> {
        match self.positions.remove(symbol) {
            Some((_, mut pos)) => {
                pos.update_price(exit_price);
                let pnl = pos.unrealized_pnl;
                let value = exit_price * pos.qty.unsigned_abs() as f64;
                let cost = value * self.config.costs.slippage_bps / 10_000.0
                    + self.config.costs.commission_per_trade
                    + if pos.side == "sell" { value * self.config.costs.stt_pct / 100.0 } else { 0.0 };

                let net_pnl = pnl - cost;
                self.add_realized_pnl(net_pnl);
                self.set_cash(self.get_cash() + value - cost);
                self.recalculate_nav();
                self.increment_trades();
                Ok(net_pnl)
            }
            None => Err(format!("No open position for {}", symbol)),
        }
    }

    fn recalculate_nav(&self) {
        let mut total = self.get_cash();
        for entry in self.positions.iter() {
            total += entry.value().market_value();
        }
        self.set_nav(total);
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

fn f64_to_atomic(v: f64) -> std::sync::atomic::AtomicU64 {
    std::sync::atomic::AtomicU64::new(v.to_bits())
}

fn atomic_to_f64(a: &std::sync::atomic::AtomicU64) -> f64 {
    f64::from_bits(a.load(std::sync::atomic::Ordering::Relaxed))
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
