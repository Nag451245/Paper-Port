use serde::{Deserialize, Serialize};
use std::path::Path;

/// Central configuration for the entire engine.
/// Loaded from `engine.toml` at startup, with sane defaults for every field.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct EngineConfig {
    #[serde(default)]
    pub server: ServerConfig,
    #[serde(default)]
    pub market: MarketConfig,
    #[serde(default)]
    pub risk: RiskConfig,
    #[serde(default)]
    pub costs: CostConfig,
    #[serde(default)]
    pub backtest: BacktestConfig,
    #[serde(default)]
    pub scan: ScanConfig,
    #[serde(default)]
    pub options: OptionsConfig,
    #[serde(default)]
    pub logging: LoggingConfig,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ServerConfig {
    pub host: String,
    pub port: u16,
    pub mode: String,
}

impl Default for ServerConfig {
    fn default() -> Self {
        Self {
            host: "127.0.0.1".into(),
            port: 8400,
            mode: "http".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MarketConfig {
    pub risk_free_rate: f64,
    pub trading_days_per_year: f64,
    pub default_iv: f64,
    pub market_type: String,
}

impl Default for MarketConfig {
    fn default() -> Self {
        Self {
            risk_free_rate: 0.065,
            trading_days_per_year: 252.0,
            default_iv: 0.20,
            market_type: "equity".into(),
        }
    }
}

impl MarketConfig {
    pub fn daily_rf(&self) -> f64 {
        self.risk_free_rate / self.trading_days_per_year
    }

    pub fn annualization_factor(&self) -> f64 {
        self.trading_days_per_year.sqrt()
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct RiskConfig {
    pub max_position_size_pct: f64,
    pub max_single_loss_pct: f64,
    pub max_drawdown_pct: f64,
    pub max_daily_trades: usize,
    pub max_open_positions: usize,
    pub max_portfolio_heat_pct: f64,
    pub var_confidence: f64,
}

impl Default for RiskConfig {
    fn default() -> Self {
        Self {
            max_position_size_pct: 20.0,
            max_single_loss_pct: 2.0,
            max_drawdown_pct: 25.0,
            max_daily_trades: 20,
            max_open_positions: 10,
            max_portfolio_heat_pct: 6.0,
            var_confidence: 0.95,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct CostConfig {
    pub commission_per_trade: f64,
    pub slippage_bps: f64,
    pub stt_pct: f64,
    pub stamp_duty_pct: f64,
    pub exchange_fee_pct: f64,
    pub gst_pct: f64,
}

impl Default for CostConfig {
    fn default() -> Self {
        Self {
            commission_per_trade: 20.0,
            slippage_bps: 5.0,
            stt_pct: 0.025,
            stamp_duty_pct: 0.003,
            exchange_fee_pct: 0.00345,
            gst_pct: 18.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BacktestConfig {
    pub default_position_size_pct: f64,
    pub rsi_oversold: f64,
    pub rsi_overbought: f64,
    pub ema_short_period: usize,
    pub ema_long_period: usize,
    pub sma_short_period: usize,
    pub sma_long_period: usize,
    pub orb_target_pct: f64,
    pub orb_stop_loss_pct: f64,
    pub momentum_lookback: usize,
    pub momentum_hold_days: usize,
    pub mean_reversion_period: usize,
    pub mean_reversion_threshold: f64,
}

impl Default for BacktestConfig {
    fn default() -> Self {
        Self {
            default_position_size_pct: 15.0,
            rsi_oversold: 30.0,
            rsi_overbought: 70.0,
            ema_short_period: 9,
            ema_long_period: 21,
            sma_short_period: 10,
            sma_long_period: 30,
            orb_target_pct: 1.5,
            orb_stop_loss_pct: 0.75,
            momentum_lookback: 20,
            momentum_hold_days: 10,
            mean_reversion_period: 20,
            mean_reversion_threshold: 2.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ScanConfig {
    pub min_candles: usize,
    pub ema_weight: f64,
    pub rsi_weight: f64,
    pub macd_weight: f64,
    pub supertrend_weight: f64,
    pub bollinger_weight: f64,
    pub vwap_weight: f64,
    pub momentum_weight: f64,
    pub volume_weight: f64,
}

impl Default for ScanConfig {
    fn default() -> Self {
        Self {
            min_candles: 26,
            ema_weight: 0.15,
            rsi_weight: 0.10,
            macd_weight: 0.10,
            supertrend_weight: 0.10,
            bollinger_weight: 0.05,
            vwap_weight: 0.05,
            momentum_weight: 0.25,
            volume_weight: 0.20,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct OptionsConfig {
    pub span_margin_index_pct: f64,
    pub span_margin_stock_pct: f64,
    pub default_expiry_days: f64,
}

impl Default for OptionsConfig {
    fn default() -> Self {
        Self {
            span_margin_index_pct: 15.0,
            span_margin_stock_pct: 20.0,
            default_expiry_days: 30.0,
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct LoggingConfig {
    pub level: String,
    pub format: String,
    pub file: Option<String>,
}

impl Default for LoggingConfig {
    fn default() -> Self {
        Self {
            level: "info".into(),
            format: "pretty".into(),
            file: None,
        }
    }
}

impl Default for EngineConfig {
    fn default() -> Self {
        Self {
            server: ServerConfig::default(),
            market: MarketConfig::default(),
            risk: RiskConfig::default(),
            costs: CostConfig::default(),
            backtest: BacktestConfig::default(),
            scan: ScanConfig::default(),
            options: OptionsConfig::default(),
            logging: LoggingConfig::default(),
        }
    }
}

impl EngineConfig {
    /// Load config from a TOML file, falling back to defaults for missing fields.
    pub fn load(path: &str) -> Self {
        let path = Path::new(path);
        if !path.exists() {
            tracing::info!("No config file at {}, using defaults", path.display());
            return Self::default();
        }
        match std::fs::read_to_string(path) {
            Ok(contents) => match toml::from_str::<EngineConfig>(&contents) {
                Ok(config) => {
                    tracing::info!("Loaded config from {}", path.display());
                    config
                }
                Err(e) => {
                    tracing::warn!("Failed to parse {}: {}, using defaults", path.display(), e);
                    Self::default()
                }
            },
            Err(e) => {
                tracing::warn!("Failed to read {}: {}, using defaults", path.display(), e);
                Self::default()
            }
        }
    }

    /// Write the current config as a TOML file (for generating defaults).
    pub fn save(&self, path: &str) -> Result<(), String> {
        let toml_str = toml::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, toml_str).map_err(|e| e.to_string())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_default_config_valid() {
        let config = EngineConfig::default();
        assert_eq!(config.server.port, 8400);
        assert_eq!(config.market.risk_free_rate, 0.065);
        assert_eq!(config.market.trading_days_per_year, 252.0);
        assert_eq!(config.risk.max_drawdown_pct, 25.0);
        assert_eq!(config.costs.commission_per_trade, 20.0);
    }

    #[test]
    fn test_daily_rf() {
        let config = EngineConfig::default();
        let daily = config.market.daily_rf();
        assert!((daily - 0.065 / 252.0).abs() < 1e-10);
    }

    #[test]
    fn test_annualization_factor() {
        let config = EngineConfig::default();
        let factor = config.market.annualization_factor();
        assert!((factor - 252.0_f64.sqrt()).abs() < 1e-10);
    }

    #[test]
    fn test_serialize_roundtrip() {
        let config = EngineConfig::default();
        let toml_str = toml::to_string_pretty(&config).unwrap();
        let parsed: EngineConfig = toml::from_str(&toml_str).unwrap();
        assert_eq!(parsed.server.port, config.server.port);
        assert_eq!(parsed.market.risk_free_rate, config.market.risk_free_rate);
    }

    #[test]
    fn test_partial_toml_fills_defaults() {
        let partial = r#"
[market]
risk_free_rate = 0.05
"#;
        let config: EngineConfig = toml::from_str(partial).unwrap();
        assert_eq!(config.market.risk_free_rate, 0.05);
        assert_eq!(config.market.trading_days_per_year, 252.0);
        assert_eq!(config.server.port, 8400);
    }

    #[test]
    fn test_missing_file_returns_defaults() {
        let config = EngineConfig::load("nonexistent_file_xyz.toml");
        assert_eq!(config.server.port, 8400);
    }
}
