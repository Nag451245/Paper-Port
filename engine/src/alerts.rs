use std::sync::Mutex;
use serde::{Deserialize, Serialize};

/// Alert severity levels
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AlertSeverity {
    Info,
    Warning,
    Critical,
    Emergency,
}

/// Alert types
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum AlertType {
    DrawdownBreached,
    KillSwitchActivated,
    OrderRejected,
    PositionLimitReached,
    DailyTradeLimitReached,
    ConnectionLost,
    ReconciliationMismatch,
    FatFingerBlocked,
    PnlThresholdReached,
    StrategyError,
    SystemError,
}

/// An alert event
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Alert {
    pub id: String,
    pub alert_type: AlertType,
    pub severity: AlertSeverity,
    pub title: String,
    pub message: String,
    pub symbol: Option<String>,
    pub strategy_id: Option<String>,
    pub timestamp: String,
    pub acknowledged: bool,
}

/// Notification channel configuration
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct NotificationConfig {
    pub console_enabled: bool,
    pub webhook_url: Option<String>,
    pub min_severity: AlertSeverity,
}

impl Default for NotificationConfig {
    fn default() -> Self {
        Self {
            console_enabled: true,
            webhook_url: None,
            min_severity: AlertSeverity::Warning,
        }
    }
}

/// Alert manager
pub struct AlertManager {
    alerts: Mutex<Vec<Alert>>,
    config: NotificationConfig,
    next_id: std::sync::atomic::AtomicU64,
}

impl AlertManager {
    pub fn new(config: NotificationConfig) -> Self {
        Self {
            alerts: Mutex::new(Vec::new()),
            config,
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn severity_value(s: &AlertSeverity) -> u8 {
        match s {
            AlertSeverity::Info => 0,
            AlertSeverity::Warning => 1,
            AlertSeverity::Critical => 2,
            AlertSeverity::Emergency => 3,
        }
    }

    /// Fire an alert
    pub fn fire(
        &self,
        alert_type: AlertType,
        severity: AlertSeverity,
        title: &str,
        message: &str,
        symbol: Option<&str>,
        strategy_id: Option<&str>,
    ) -> Alert {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        let alert = Alert {
            id: format!("ALERT-{:06}", id),
            alert_type,
            severity,
            title: title.to_string(),
            message: message.to_string(),
            symbol: symbol.map(|s| s.to_string()),
            strategy_id: strategy_id.map(|s| s.to_string()),
            timestamp: chrono::Utc::now().to_rfc3339(),
            acknowledged: false,
        };

        if Self::severity_value(&severity) >= Self::severity_value(&self.config.min_severity) {
            if self.config.console_enabled {
                let prefix = match severity {
                    AlertSeverity::Info => "[INFO]",
                    AlertSeverity::Warning => "[WARN]",
                    AlertSeverity::Critical => "[CRIT]",
                    AlertSeverity::Emergency => "[EMRG]",
                };
                eprintln!("{} {} — {}", prefix, title, message);
            }
        }

        if let Ok(mut alerts) = self.alerts.lock() {
            alerts.push(alert.clone());
            const MAX_ALERTS: usize = 5_000;
            if alerts.len() > MAX_ALERTS {
                let drain_count = alerts.len() - MAX_ALERTS;
                alerts.drain(..drain_count);
            }
        }

        alert
    }

    /// Get all alerts, optionally filtered
    pub fn get_alerts(&self, min_severity: Option<AlertSeverity>, limit: usize) -> Vec<Alert> {
        self.alerts.lock()
            .map(|alerts| {
                alerts.iter()
                    .rev()
                    .filter(|a| {
                        if let Some(ref sev) = min_severity {
                            Self::severity_value(&a.severity) >= Self::severity_value(sev)
                        } else {
                            true
                        }
                    })
                    .take(limit)
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Acknowledge an alert
    pub fn acknowledge(&self, alert_id: &str) -> bool {
        if let Ok(mut alerts) = self.alerts.lock() {
            if let Some(alert) = alerts.iter_mut().find(|a| a.id == alert_id) {
                alert.acknowledged = true;
                return true;
            }
        }
        false
    }

    /// Get unacknowledged alert count by severity
    pub fn unacknowledged_counts(&self) -> (usize, usize, usize, usize) {
        self.alerts.lock()
            .map(|alerts| {
                let mut info = 0;
                let mut warn = 0;
                let mut crit = 0;
                let mut emrg = 0;
                for a in alerts.iter().filter(|a| !a.acknowledged) {
                    match a.severity {
                        AlertSeverity::Info => info += 1,
                        AlertSeverity::Warning => warn += 1,
                        AlertSeverity::Critical => crit += 1,
                        AlertSeverity::Emergency => emrg += 1,
                    }
                }
                (info, warn, crit, emrg)
            })
            .unwrap_or((0, 0, 0, 0))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_manager() -> AlertManager {
        AlertManager::new(NotificationConfig {
            console_enabled: false,
            ..Default::default()
        })
    }

    #[test]
    fn test_fire_alert() {
        let mgr = make_manager();
        let alert = mgr.fire(
            AlertType::DrawdownBreached,
            AlertSeverity::Critical,
            "Drawdown exceeded",
            "Portfolio drawdown is 26%, limit is 25%",
            None,
            None,
        );
        assert_eq!(alert.alert_type, AlertType::DrawdownBreached);
        assert_eq!(alert.severity, AlertSeverity::Critical);
        assert!(!alert.acknowledged);
    }

    #[test]
    fn test_get_alerts() {
        let mgr = make_manager();
        mgr.fire(AlertType::OrderRejected, AlertSeverity::Warning, "t1", "m1", None, None);
        mgr.fire(AlertType::KillSwitchActivated, AlertSeverity::Emergency, "t2", "m2", None, None);
        let all = mgr.get_alerts(None, 100);
        assert_eq!(all.len(), 2);
        let critical = mgr.get_alerts(Some(AlertSeverity::Critical), 100);
        assert_eq!(critical.len(), 1);
    }

    #[test]
    fn test_acknowledge() {
        let mgr = make_manager();
        let alert = mgr.fire(AlertType::SystemError, AlertSeverity::Warning, "err", "msg", None, None);
        assert!(mgr.acknowledge(&alert.id));
        let alerts = mgr.get_alerts(None, 100);
        assert!(alerts[0].acknowledged);
    }

    #[test]
    fn test_unacknowledged_counts() {
        let mgr = make_manager();
        mgr.fire(AlertType::DrawdownBreached, AlertSeverity::Warning, "w", "m", None, None);
        mgr.fire(AlertType::KillSwitchActivated, AlertSeverity::Emergency, "e", "m", None, None);
        mgr.fire(AlertType::StrategyError, AlertSeverity::Info, "i", "m", None, None);
        let (info, warn, crit, emrg) = mgr.unacknowledged_counts();
        assert_eq!(info, 1);
        assert_eq!(warn, 1);
        assert_eq!(crit, 0);
        assert_eq!(emrg, 1);
    }
}
