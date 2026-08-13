//! Strategy graduation pipeline from paper trading to live trading.
//! Tracks performance, enforces graduation criteria, and manages ramp-up allocation.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use std::sync::Mutex;

pub static BRIDGE_STORE: once_cell::sync::Lazy<Mutex<PaperLiveBridge>> =
    once_cell::sync::Lazy::new(|| Mutex::new(PaperLiveBridge::new()));

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Phase {
    Paper,
    Ramp10,
    Ramp25,
    Ramp50,
    Live100,
    Demoted,
}

impl Phase {
    fn allocation_pct(&self) -> f64 {
        match self {
            Phase::Paper => 0.0,
            Phase::Ramp10 => 10.0,
            Phase::Ramp25 => 25.0,
            Phase::Ramp50 => 50.0,
            Phase::Live100 => 100.0,
            Phase::Demoted => 0.0,
        }
    }

    fn next_phase(&self) -> Option<Phase> {
        match self {
            Phase::Paper => Some(Phase::Ramp10),
            Phase::Ramp10 => Some(Phase::Ramp25),
            Phase::Ramp25 => Some(Phase::Ramp50),
            Phase::Ramp50 => Some(Phase::Live100),
            Phase::Live100 | Phase::Demoted => None,
        }
    }

    fn is_ramping(&self) -> bool {
        matches!(self, Phase::Ramp10 | Phase::Ramp25 | Phase::Ramp50)
    }

    fn is_live(&self) -> bool {
        *self == Phase::Live100
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct StrategyPhase {
    pub strategy: String,
    pub phase: Phase,
    pub entered_phase_at: String,
    pub paper_sharpe: f64,
    pub paper_win_rate: f64,
    pub paper_trades: usize,
    pub paper_max_dd: f64,
    pub live_sharpe: f64,
    pub live_win_rate: f64,
    pub live_trades: usize,
    #[serde(rename = "allocation_pct")]
    pub allocation_pct: f64,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GraduationCriteria {
    pub min_paper_trades: usize,
    pub min_sharpe: f64,
    pub min_win_rate: f64,
    pub max_drawdown_pct: f64,
    pub weeks_per_phase: usize,
    pub demotion_sharpe_threshold: f64,
}

impl Default for GraduationCriteria {
    fn default() -> Self {
        Self {
            min_paper_trades: 50,
            min_sharpe: 0.5,
            min_win_rate: 0.45,
            max_drawdown_pct: 15.0,
            weeks_per_phase: 2,
            demotion_sharpe_threshold: -0.5,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BridgeStatus {
    pub strategies: Vec<StrategyPhase>,
    pub paper_count: usize,
    pub ramping_count: usize,
    pub live_count: usize,
    pub demoted_count: usize,
}

pub struct PaperLiveBridge {
    strategies: HashMap<String, StrategyPhase>,
    criteria: GraduationCriteria,
}

impl PaperLiveBridge {
    pub fn new() -> Self {
        Self {
            strategies: HashMap::new(),
            criteria: GraduationCriteria::default(),
        }
    }

    pub fn with_criteria(mut self, criteria: GraduationCriteria) -> Self {
        self.criteria = criteria;
        self
    }

    fn now_iso(&self) -> String {
        chrono::Utc::now().format("%Y-%m-%d").to_string()
    }

    fn weeks_since(&self, entered_at: &str) -> usize {
        let entered = chrono::NaiveDate::parse_from_str(entered_at, "%Y-%m-%d").ok();
        let now = chrono::Utc::now().format("%Y-%m-%d").to_string();
        let now_date = chrono::NaiveDate::parse_from_str(&now, "%Y-%m-%d").ok();
        match (entered, now_date) {
            (Some(e), Some(n)) => {
                let diff = n.signed_duration_since(e);
                (diff.num_days() / 7).max(0) as usize
            }
            _ => 0,
        }
    }

    pub fn register(&mut self, strategy: String) -> StrategyPhase {
        let now = self.now_iso();
        let phase = StrategyPhase {
            strategy: strategy.clone(),
            phase: Phase::Paper,
            entered_phase_at: now.clone(),
            paper_sharpe: 0.0,
            paper_win_rate: 0.0,
            paper_trades: 0,
            paper_max_dd: 0.0,
            live_sharpe: 0.0,
            live_win_rate: 0.0,
            live_trades: 0,
            allocation_pct: 0.0,
        };
        self.strategies.insert(strategy, phase.clone());
        phase
    }

    pub fn update_metrics(
        &mut self,
        strategy: &str,
        paper_sharpe: Option<f64>,
        paper_win_rate: Option<f64>,
        paper_trades: Option<usize>,
        paper_max_dd: Option<f64>,
        live_sharpe: Option<f64>,
        live_win_rate: Option<f64>,
        live_trades: Option<usize>,
    ) -> Result<StrategyPhase, String> {
        let sp = self
            .strategies
            .get_mut(strategy)
            .ok_or_else(|| format!("Strategy '{}' not registered", strategy))?;

        if let Some(v) = paper_sharpe {
            sp.paper_sharpe = v;
        }
        if let Some(v) = paper_win_rate {
            sp.paper_win_rate = v;
        }
        if let Some(v) = paper_trades {
            sp.paper_trades = v;
        }
        if let Some(v) = paper_max_dd {
            sp.paper_max_dd = v;
        }
        if let Some(v) = live_sharpe {
            sp.live_sharpe = v;
        }
        if let Some(v) = live_win_rate {
            sp.live_win_rate = v;
        }
        if let Some(v) = live_trades {
            sp.live_trades = v;
        }
        sp.allocation_pct = sp.phase.allocation_pct();

        Ok(sp.clone())
    }

    pub fn meets_graduation_criteria(&self, sp: &StrategyPhase) -> bool {
        sp.paper_trades >= self.criteria.min_paper_trades
            && sp.paper_sharpe >= self.criteria.min_sharpe
            && sp.paper_win_rate >= self.criteria.min_win_rate
            && sp.paper_max_dd <= self.criteria.max_drawdown_pct
    }

    pub fn check_graduation(&mut self, strategy: &str) -> Result<(bool, Option<Phase>), String> {
        let sp = self
            .strategies
            .get(strategy)
            .ok_or_else(|| format!("Strategy '{}' not registered", strategy))?;

        match sp.phase {
            Phase::Paper => {
                if self.meets_graduation_criteria(sp) {
                    let next = Phase::Ramp10;
                    let mut updated = sp.clone();
                    updated.phase = next;
                    updated.entered_phase_at = self.now_iso();
                    updated.allocation_pct = next.allocation_pct();
                    self.strategies.insert(strategy.to_string(), updated);
                    Ok((true, Some(next)))
                } else {
                    Ok((false, None))
                }
            }
            Phase::Ramp10 | Phase::Ramp25 | Phase::Ramp50 => {
                let weeks_elapsed = self.weeks_since(&sp.entered_phase_at);
                if weeks_elapsed >= self.criteria.weeks_per_phase {
                    if let Some(next) = sp.phase.next_phase() {
                        let mut updated = sp.clone();
                        updated.phase = next;
                        updated.entered_phase_at = self.now_iso();
                        updated.allocation_pct = next.allocation_pct();
                        self.strategies.insert(strategy.to_string(), updated);
                        Ok((true, Some(next)))
                    } else {
                        Ok((false, None))
                    }
                } else {
                    Ok((false, None))
                }
            }
            Phase::Live100 | Phase::Demoted => Ok((false, None)),
        }
    }

    pub fn check_demotion(&mut self, strategy: &str) -> Result<bool, String> {
        let sp = self
            .strategies
            .get(strategy)
            .ok_or_else(|| format!("Strategy '{}' not registered", strategy))?;

        if sp.phase.is_live() && sp.live_trades >= 10 && sp.live_sharpe < self.criteria.demotion_sharpe_threshold {
            let mut updated = sp.clone();
            updated.phase = Phase::Demoted;
            updated.allocation_pct = 0.0;
            self.strategies.insert(strategy.to_string(), updated);
            Ok(true)
        } else {
            Ok(false)
        }
    }

    pub fn demote(&mut self, strategy: &str) -> Result<StrategyPhase, String> {
        let sp = self
            .strategies
            .get_mut(strategy)
            .ok_or_else(|| format!("Strategy '{}' not registered", strategy))?;

        sp.phase = Phase::Demoted;
        sp.allocation_pct = 0.0;
        Ok(sp.clone())
    }

    pub fn get_allocation(&self, strategy: &str) -> Result<f64, String> {
        self.strategies
            .get(strategy)
            .map(|sp| sp.allocation_pct)
            .ok_or_else(|| format!("Strategy '{}' not registered", strategy))
    }

    pub fn status(&self) -> BridgeStatus {
        let strategies: Vec<StrategyPhase> = self.strategies.values().cloned().collect();
        let paper_count = strategies.iter().filter(|s| s.phase == Phase::Paper).count();
        let ramping_count = strategies.iter().filter(|s| s.phase.is_ramping()).count();
        let live_count = strategies.iter().filter(|s| s.phase.is_live()).count();
        let demoted_count = strategies.iter().filter(|s| s.phase == Phase::Demoted).count();

        BridgeStatus {
            strategies,
            paper_count,
            ramping_count,
            live_count,
            demoted_count,
        }
    }

    pub fn set_criteria(&mut self, criteria: GraduationCriteria) {
        self.criteria = criteria;
    }
}

impl Default for PaperLiveBridge {
    fn default() -> Self {
        Self::new()
    }
}

/// JSON API entry point. Expects `{ "command": "...", ... }`.
pub fn compute(data: Value) -> Result<Value, String> {
    let command = data
        .get("command")
        .and_then(|v| v.as_str())
        .unwrap_or("status");

    match command {
        "status" => {
            let store = BRIDGE_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;
            let status = store.status();
            serde_json::to_value(status).map_err(|e| e.to_string())
        }

        "register" => {
            let strategy = data
                .get("strategy")
                .and_then(|v| v.as_str())
                .ok_or("strategy field required")?
                .to_string();
            let mut store = BRIDGE_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;
            let phase = store.register(strategy);
            serde_json::to_value(phase).map_err(|e| e.to_string())
        }

        "update_metrics" => {
            let strategy = data
                .get("strategy")
                .and_then(|v| v.as_str())
                .ok_or("strategy field required")?;
            let mut store = BRIDGE_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;
            let phase = store.update_metrics(
                strategy,
                data.get("paper_sharpe").and_then(|v| v.as_f64()),
                data.get("paper_win_rate").and_then(|v| v.as_f64()),
                data.get("paper_trades").and_then(|v| v.as_u64()).map(|u| u as usize),
                data.get("paper_max_dd").and_then(|v| v.as_f64()),
                data.get("live_sharpe").and_then(|v| v.as_f64()),
                data.get("live_win_rate").and_then(|v| v.as_f64()),
                data.get("live_trades").and_then(|v| v.as_u64()).map(|u| u as usize),
            )?;
            serde_json::to_value(phase).map_err(|e| e.to_string())
        }

        "check_graduation" => {
            let strategy = data
                .get("strategy")
                .and_then(|v| v.as_str())
                .ok_or("strategy field required")?;
            let mut store = BRIDGE_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;
            let (graduated, new_phase) = store.check_graduation(strategy)?;
            Ok(serde_json::json!({
                "graduated": graduated,
                "new_phase": new_phase,
                "strategy": strategy,
            }))
        }

        "get_allocation" => {
            let strategy = data
                .get("strategy")
                .and_then(|v| v.as_str())
                .ok_or("strategy field required")?;
            let store = BRIDGE_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;
            let pct = store.get_allocation(strategy)?;
            Ok(serde_json::json!({
                "strategy": strategy,
                "allocation_pct": pct,
            }))
        }

        "demote" => {
            let strategy = data
                .get("strategy")
                .and_then(|v| v.as_str())
                .ok_or("strategy field required")?;
            let mut store = BRIDGE_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;
            let phase = store.demote(strategy)?;
            serde_json::to_value(phase).map_err(|e| e.to_string())
        }

        "check_demotion" => {
            let strategy = data
                .get("strategy")
                .and_then(|v| v.as_str())
                .ok_or("strategy field required")?;
            let mut store = BRIDGE_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;
            let demoted = store.check_demotion(strategy)?;
            Ok(serde_json::json!({
                "strategy": strategy,
                "demoted": demoted,
            }))
        }

        "set_criteria" => {
            let criteria: GraduationCriteria = serde_json::from_value(
                data.get("criteria")
                    .cloned()
                    .unwrap_or(serde_json::Value::Null),
            )
            .unwrap_or_default();
            let mut store = BRIDGE_STORE.lock().map_err(|e| format!("Lock error: {}", e))?;
            store.set_criteria(criteria);
            Ok(serde_json::json!({ "ok": true }))
        }

        _ => Err(format!("Unknown command: {}", command)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_register() {
        let mut bridge = PaperLiveBridge::new();
        let phase = bridge.register("ema_test".into());
        assert_eq!(phase.strategy, "ema_test");
        assert_eq!(phase.phase, Phase::Paper);
        assert_eq!(phase.allocation_pct, 0.0);
        assert_eq!(phase.paper_trades, 0);
    }

    #[test]
    fn test_graduation_from_paper_to_ramp10() {
        let mut bridge = PaperLiveBridge::new();
        bridge.register("momentum_test".into());
        bridge.update_metrics("momentum_test", Some(0.8), Some(0.52), Some(60), Some(8.0), None, None, None).unwrap();

        let (graduated, new_phase) = bridge.check_graduation("momentum_test").unwrap();
        assert!(graduated);
        assert_eq!(new_phase, Some(Phase::Ramp10));
        assert_eq!(bridge.get_allocation("momentum_test").unwrap(), 10.0);
    }

    #[test]
    fn test_full_lifecycle() {
        let mut bridge = PaperLiveBridge::new().with_criteria(GraduationCriteria {
            weeks_per_phase: 0,
            ..Default::default()
        });
        bridge.register("lifecycle_test".into());
        bridge.update_metrics("lifecycle_test", Some(0.6), Some(0.5), Some(55), Some(10.0), None, None, None).unwrap();

        bridge.check_graduation("lifecycle_test").unwrap();
        bridge.check_graduation("lifecycle_test").unwrap();
        bridge.check_graduation("lifecycle_test").unwrap();
        bridge.check_graduation("lifecycle_test").unwrap();

        let sp = bridge.strategies.get("lifecycle_test").unwrap();
        assert_eq!(sp.phase, Phase::Live100);
        assert_eq!(sp.allocation_pct, 100.0);
    }

    #[test]
    fn test_demote() {
        let mut bridge = PaperLiveBridge::new();
        bridge.register("demote_test".into());
        bridge.update_metrics("demote_test", Some(0.7), Some(0.5), Some(60), Some(5.0), None, None, None).unwrap();
        bridge.check_graduation("demote_test").unwrap();

        let phase = bridge.demote("demote_test").unwrap();
        assert_eq!(phase.phase, Phase::Demoted);
        assert_eq!(phase.allocation_pct, 0.0);
        assert_eq!(bridge.get_allocation("demote_test").unwrap(), 0.0);
    }

    #[test]
    fn test_allocation_percentage_check() {
        let mut bridge = PaperLiveBridge::new().with_criteria(GraduationCriteria {
            weeks_per_phase: 0,
            ..Default::default()
        });
        bridge.register("alloc_test".into());
        bridge.update_metrics("alloc_test", Some(0.6), Some(0.5), Some(55), Some(10.0), None, None, None).unwrap();

        assert_eq!(bridge.get_allocation("alloc_test").unwrap(), 0.0);

        bridge.check_graduation("alloc_test").unwrap();
        assert_eq!(bridge.get_allocation("alloc_test").unwrap(), 10.0);

        bridge.check_graduation("alloc_test").unwrap();
        assert_eq!(bridge.get_allocation("alloc_test").unwrap(), 25.0);

        bridge.check_graduation("alloc_test").unwrap();
        assert_eq!(bridge.get_allocation("alloc_test").unwrap(), 50.0);

        bridge.check_graduation("alloc_test").unwrap();
        assert_eq!(bridge.get_allocation("alloc_test").unwrap(), 100.0);
    }

    #[test]
    fn test_criteria_not_met() {
        let mut bridge = PaperLiveBridge::new();
        bridge.register("weak_test".into());
        bridge.update_metrics("weak_test", Some(0.2), Some(0.35), Some(30), Some(25.0), None, None, None).unwrap();

        let (graduated, _) = bridge.check_graduation("weak_test").unwrap();
        assert!(!graduated);
        let sp = bridge.strategies.get("weak_test").unwrap();
        assert_eq!(sp.phase, Phase::Paper);
        assert_eq!(sp.allocation_pct, 0.0);
    }

    #[test]
    fn test_status_counts() {
        let mut bridge = PaperLiveBridge::new();
        bridge.register("s1".into());
        bridge.register("s2".into());
        bridge.register("s3".into());

        let status = bridge.status();
        assert_eq!(status.paper_count, 3);
        assert_eq!(status.ramping_count, 0);
        assert_eq!(status.live_count, 0);
        assert_eq!(status.demoted_count, 0);
        assert_eq!(status.strategies.len(), 3);
    }

    #[test]
    fn test_update_metrics_missing_strategy() {
        let mut bridge = PaperLiveBridge::new();
        let result = bridge.update_metrics("nonexistent", Some(0.5), None, None, None, None, None, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not registered"));
    }

    #[test]
    fn test_auto_demotion() {
        let mut bridge = PaperLiveBridge::new().with_criteria(GraduationCriteria {
            weeks_per_phase: 0,
            ..Default::default()
        });
        bridge.register("degraded_test".into());
        bridge.update_metrics(
            "degraded_test", Some(0.8), Some(0.55), Some(80), Some(5.0),
            Some(-0.6), Some(0.3), Some(15),
        ).unwrap();

        for _ in 0..4 {
            bridge.check_graduation("degraded_test").unwrap();
        }

        let demoted = bridge.check_demotion("degraded_test").unwrap();
        assert!(demoted);
        assert_eq!(bridge.get_allocation("degraded_test").unwrap(), 0.0);
    }
}
