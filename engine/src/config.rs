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
    #[serde(default)]
    pub auth: AuthConfig,
    #[serde(default)]
    pub persistence: PersistenceConfig,
    #[serde(default)]
    pub tls: TlsConfig,
    #[serde(default)]
    pub broker: BrokerConfig,
    #[serde(default)]
    pub market_data: MarketDataConfig,
    #[serde(default = "default_initial_capital")]
    pub initial_capital: f64,
}

fn default_initial_capital() -> f64 { 1_000_000.0 }

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
    pub vwap_deviation_threshold: f64,
    pub bb_period: usize,
    pub bb_std_mult: f64,
    pub adx_period: usize,
    pub adx_trend_threshold: f64,
    pub gap_min_pct: f64,
    pub sector_ema_period: usize,
    pub supertrend_atr_period: usize,
    pub supertrend_multiplier: f64,
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
            vwap_deviation_threshold: 1.5,
            bb_period: 20,
            bb_std_mult: 2.0,
            adx_period: 14,
            adx_trend_threshold: 25.0,
            gap_min_pct: 1.0,
            sector_ema_period: 21,
            supertrend_atr_period: 10,
            supertrend_multiplier: 3.0,
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

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct AuthConfig {
    pub enabled: bool,
    pub api_key: String,
    pub allowed_origins: Vec<String>,
}

impl Default for AuthConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            api_key: String::new(),
            allowed_origins: vec!["http://localhost:3000".into(), "http://localhost:5173".into()],
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct PersistenceConfig {
    pub enabled: bool,
    pub snapshot_path: String,
    pub snapshot_interval_secs: u64,
}

impl Default for PersistenceConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            snapshot_path: "engine_state.json".into(),
            snapshot_interval_secs: 60,
        }
    }
}

// ─── TLS ──────────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct TlsConfig {
    pub enabled: bool,
    pub cert_path: String,
    pub key_path: String,
}

impl Default for TlsConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            cert_path: "certs/server.crt".into(),
            key_path: "certs/server.key".into(),
        }
    }
}

// ─── Broker ───────────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct BrokerConfig {
    /// Which broker adapter to use: "paper", "icici_breeze", "zerodha", "upstox"
    pub adapter: String,
    #[serde(default)]
    pub icici: IciciBreezeConfig,
    #[serde(default)]
    pub zerodha: ZerodhaConfig,
    #[serde(default)]
    pub upstox: UpstoxConfig,
}

impl Default for BrokerConfig {
    fn default() -> Self {
        Self {
            adapter: "paper".into(),
            icici: IciciBreezeConfig::default(),
            zerodha: ZerodhaConfig::default(),
            upstox: UpstoxConfig::default(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct IciciBreezeConfig {
    pub api_key: String,
    pub secret_key: String,
    pub session_token: String,
    /// URL of the Python Breeze Bridge microservice (server/breeze-bridge/app.py).
    /// All broker calls are routed through this bridge, which wraps the breeze_connect SDK.
    pub bridge_url: String,
    /// Direct API URL — only used as fallback reference, bridge handles actual calls
    pub base_url: String,
    pub ws_url: String,
}

impl Default for IciciBreezeConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            secret_key: String::new(),
            session_token: String::new(),
            bridge_url: "http://127.0.0.1:8001".into(),
            base_url: "https://api.icicidirect.com/breezeapi/api/v2".into(),
            ws_url: "wss://breezeapi.icicidirect.com".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct ZerodhaConfig {
    pub api_key: String,
    pub api_secret: String,
    pub access_token: String,
    pub base_url: String,
}

impl Default for ZerodhaConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            api_secret: String::new(),
            access_token: String::new(),
            base_url: "https://api.kite.trade".into(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct UpstoxConfig {
    pub api_key: String,
    pub api_secret: String,
    pub access_token: String,
    pub base_url: String,
}

impl Default for UpstoxConfig {
    fn default() -> Self {
        Self {
            api_key: String::new(),
            api_secret: String::new(),
            access_token: String::new(),
            base_url: "https://api.upstox.com/v2".into(),
        }
    }
}

// ─── Market Data ──────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
#[serde(default)]
pub struct MarketDataConfig {
    pub enabled: bool,
    /// Symbols to subscribe for live price feed
    pub symbols: Vec<String>,
    /// Reconnect delay in seconds on disconnect
    pub reconnect_delay_secs: u64,
}

impl Default for MarketDataConfig {
    fn default() -> Self {
        Self {
            enabled: false,
            symbols: Vec::new(),
            reconnect_delay_secs: 5,
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
            auth: AuthConfig::default(),
            persistence: PersistenceConfig::default(),
            tls: TlsConfig::default(),
            broker: BrokerConfig::default(),
            market_data: MarketDataConfig::default(),
            initial_capital: 1_000_000.0,
        }
    }
}

impl EngineConfig {
    /// Load config from a TOML file, falling back to defaults for missing fields.
    /// Returns an error if the file exists but cannot be parsed (fail-fast, not silent).
    pub fn load(path: &str) -> Result<Self, String> {
        let path = Path::new(path);
        if !path.exists() {
            tracing::info!("No config file at {}, using defaults", path.display());
            return Ok(Self::default());
        }
        let contents = std::fs::read_to_string(path)
            .map_err(|e| format!("Failed to read {}: {}", path.display(), e))?;
        let config: EngineConfig = toml::from_str(&contents)
            .map_err(|e| format!("Failed to parse {}: {}", path.display(), e))?;
        config.validate()?;
        tracing::info!("Loaded and validated config from {}", path.display());
        Ok(config)
    }

    /// Write the current config as a TOML file (for generating defaults).
    pub fn save(&self, path: &str) -> Result<(), String> {
        let toml_str = toml::to_string_pretty(self).map_err(|e| e.to_string())?;
        std::fs::write(path, toml_str).map_err(|e| e.to_string())
    }

    /// Validate all config values. Returns Err with a description of what's wrong.
    pub fn validate(&self) -> Result<(), String> {
        let mut errors: Vec<String> = Vec::new();

        if self.market.trading_days_per_year <= 0.0 {
            errors.push("market.trading_days_per_year must be > 0".to_string());
        }
        if self.market.risk_free_rate < 0.0 || self.market.risk_free_rate > 1.0 {
            errors.push("market.risk_free_rate must be in [0, 1]".to_string());
        }
        if self.risk.max_position_size_pct <= 0.0 || self.risk.max_position_size_pct > 100.0 {
            errors.push("risk.max_position_size_pct must be in (0, 100]".to_string());
        }
        if self.risk.max_drawdown_pct <= 0.0 || self.risk.max_drawdown_pct > 100.0 {
            errors.push("risk.max_drawdown_pct must be in (0, 100]".to_string());
        }
        if self.risk.max_single_loss_pct <= 0.0 || self.risk.max_single_loss_pct > 100.0 {
            errors.push("risk.max_single_loss_pct must be in (0, 100]".to_string());
        }
        if self.risk.var_confidence <= 0.0 || self.risk.var_confidence >= 1.0 {
            errors.push("risk.var_confidence must be in (0, 1)".to_string());
        }
        if self.costs.commission_per_trade < 0.0 {
            errors.push("costs.commission_per_trade must be >= 0".to_string());
        }
        if self.costs.slippage_bps < 0.0 {
            errors.push("costs.slippage_bps must be >= 0".to_string());
        }
        if self.backtest.ema_short_period == 0 {
            errors.push("backtest.ema_short_period must be > 0".to_string());
        }
        if self.backtest.ema_long_period == 0 {
            errors.push("backtest.ema_long_period must be > 0".to_string());
        }
        if self.backtest.ema_short_period >= self.backtest.ema_long_period {
            errors.push("backtest.ema_short_period must be < ema_long_period".to_string());
        }
        if self.initial_capital <= 0.0 {
            errors.push("initial_capital must be > 0".to_string());
        }

        if errors.is_empty() {
            Ok(())
        } else {
            Err(format!("Config validation failed:\n  - {}", errors.join("\n  - ")))
        }
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
        let config = EngineConfig::load("nonexistent_file_xyz.toml").unwrap();
        assert_eq!(config.server.port, 8400);
    }

    #[test]
    fn test_validation_catches_bad_values() {
        let mut config = EngineConfig::default();
        config.market.trading_days_per_year = 0.0;
        assert!(config.validate().is_err());

        let mut config = EngineConfig::default();
        config.risk.var_confidence = 2.0;
        assert!(config.validate().is_err());

        let mut config = EngineConfig::default();
        config.backtest.ema_short_period = 50;
        config.backtest.ema_long_period = 21;
        assert!(config.validate().is_err());
    }

    #[test]
    fn test_default_config_validates() {
        assert!(EngineConfig::default().validate().is_ok());
    }
}
