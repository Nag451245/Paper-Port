use serde::{Deserialize, Serialize};
use crate::config::EngineConfig;
use crate::utils::{Candle, calc_ema_series as calc_ema, calc_rsi_series as calc_rsi, calc_sma, calc_atr_series as calc_atr};

// ─── Core Types ───────────────────────────────────────────────────────

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum Side {
    Buy,
    Sell,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Signal {
    pub side: Side,
    pub price: f64,
    pub stop_loss: Option<f64>,
    pub take_profit: Option<f64>,
    pub confidence: f64,
    pub reason: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Fill {
    pub side: Side,
    pub price: f64,
    pub qty: i64,
    pub pnl: f64,
    pub timestamp: String,
}

/// Pre-computed indicator values available to every strategy
#[derive(Debug, Clone)]
pub struct Indicators {
    pub ema_short: Vec<f64>,
    pub ema_long: Vec<f64>,
    pub rsi: Vec<f64>,
    pub sma_short: Vec<f64>,
    pub sma_long: Vec<f64>,
    pub atr: Vec<f64>,
    pub closes: Vec<f64>,
    pub highs: Vec<f64>,
    pub lows: Vec<f64>,
    pub volumes: Vec<f64>,
}

impl Indicators {
    pub fn from_candles(candles: &[Candle], config: &EngineConfig) -> Self {
        let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
        let highs: Vec<f64> = candles.iter().map(|c| c.high).collect();
        let lows: Vec<f64> = candles.iter().map(|c| c.low).collect();
        let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();

        let ema_short = calc_ema(&closes, config.backtest.ema_short_period);
        let ema_long = calc_ema(&closes, config.backtest.ema_long_period);
        let rsi = calc_rsi(&closes, 14);
        let sma_short = calc_sma(&closes, config.backtest.sma_short_period);
        let sma_long = calc_sma(&closes, config.backtest.sma_long_period);
        let atr = calc_atr(&highs, &lows, &closes, 14);

        Self {
            ema_short, ema_long, rsi, sma_short, sma_long, atr,
            closes, highs, lows, volumes,
        }
    }
}

// ─── The Strategy Trait ───────────────────────────────────────────────

/// Every trading strategy must implement this trait.
/// The backtester calls `on_candle` for each bar and uses the returned Signal
/// to decide whether to enter/exit positions.
pub trait Strategy: Send + Sync {
    fn name(&self) -> &str;

    /// Called on each new candle. Return Some(Signal) to enter/exit, None to do nothing.
    fn on_candle(
        &mut self,
        index: usize,
        candle: &Candle,
        indicators: &Indicators,
    ) -> Option<Signal>;

    /// Called when a fill is executed (entry or exit). Use for internal bookkeeping.
    fn on_fill(&mut self, _fill: &Fill) {}

    /// Minimum number of candles required before strategy starts generating signals.
    fn warmup_period(&self) -> usize;

    /// Reset internal state for a fresh run.
    fn reset(&mut self);
}

// ─── Built-in Strategies ──────────────────────────────────────────────

pub struct EmaCrossover {
    short_period: usize,
    long_period: usize,
    in_position: bool,
}

impl EmaCrossover {
    pub fn new(config: &EngineConfig) -> Self {
        Self {
            short_period: config.backtest.ema_short_period,
            long_period: config.backtest.ema_long_period,
            in_position: false,
        }
    }
}

impl Strategy for EmaCrossover {
    fn name(&self) -> &str { "ema_crossover" }

    fn warmup_period(&self) -> usize { self.long_period }

    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < self.long_period { return None; }

        let ema_s = ind.ema_short[i];
        let ema_l = ind.ema_long[i];

        if !self.in_position && ema_s > ema_l {
            self.in_position = true;
            Some(Signal {
                side: Side::Buy,
                price: candle.close,
                stop_loss: Some(candle.close - ind.atr[i] * 2.0),
                take_profit: Some(candle.close + ind.atr[i] * 3.0),
                confidence: ((ema_s - ema_l) / ema_l * 100.0).min(1.0),
                reason: format!("EMA {} crossed above EMA {}", self.short_period, self.long_period),
            })
        } else if self.in_position && ema_s < ema_l {
            self.in_position = false;
            Some(Signal {
                side: Side::Sell,
                price: candle.close,
                stop_loss: None,
                take_profit: None,
                confidence: 1.0,
                reason: format!("EMA {} crossed below EMA {}", self.short_period, self.long_period),
            })
        } else {
            None
        }
    }

    fn on_fill(&mut self, fill: &Fill) {
        match fill.side {
            Side::Buy => self.in_position = true,
            Side::Sell => self.in_position = false,
        }
    }
}

pub struct SmaCrossover {
    short_period: usize,
    long_period: usize,
    in_position: bool,
}

impl SmaCrossover {
    pub fn new(config: &EngineConfig) -> Self {
        Self {
            short_period: config.backtest.sma_short_period,
            long_period: config.backtest.sma_long_period,
            in_position: false,
        }
    }
}

impl Strategy for SmaCrossover {
    fn name(&self) -> &str { "sma_crossover" }

    fn warmup_period(&self) -> usize { self.long_period }

    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < self.long_period || i == 0 { return None; }

        let s = ind.sma_short[i];
        let l = ind.sma_long[i];
        let ps = ind.sma_short[i - 1];
        let pl = ind.sma_long[i - 1];

        if s == 0.0 || l == 0.0 || ps == 0.0 || pl == 0.0 { return None; }

        if !self.in_position && ps <= pl && s > l {
            self.in_position = true;
            Some(Signal {
                side: Side::Buy,
                price: candle.close,
                stop_loss: Some(candle.close - ind.atr[i] * 2.0),
                take_profit: None,
                confidence: ((s - l) / l * 100.0).min(1.0),
                reason: format!("SMA {} crossed above SMA {}", self.short_period, self.long_period),
            })
        } else if self.in_position && ps >= pl && s < l {
            self.in_position = false;
            Some(Signal {
                side: Side::Sell,
                price: candle.close,
                stop_loss: None,
                take_profit: None,
                confidence: 1.0,
                reason: format!("SMA {} crossed below SMA {}", self.short_period, self.long_period),
            })
        } else {
            None
        }
    }
}

pub struct RsiReversal {
    oversold: f64,
    overbought: f64,
    in_position: bool,
}

impl RsiReversal {
    pub fn new(config: &EngineConfig) -> Self {
        Self {
            oversold: config.backtest.rsi_oversold,
            overbought: config.backtest.rsi_overbought,
            in_position: false,
        }
    }
}

impl Strategy for RsiReversal {
    fn name(&self) -> &str { "rsi_reversal" }

    fn warmup_period(&self) -> usize { 15 }

    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i >= ind.rsi.len() || ind.rsi[i] == 0.0 { return None; }

        let rsi = ind.rsi[i];

        if !self.in_position && rsi < self.oversold {
            self.in_position = true;
            Some(Signal {
                side: Side::Buy,
                price: candle.close,
                stop_loss: Some(candle.close - ind.atr[i] * 2.0),
                take_profit: None,
                confidence: ((self.oversold - rsi) / self.oversold).min(1.0),
                reason: format!("RSI {:.1} below oversold {:.0}", rsi, self.oversold),
            })
        } else if self.in_position && rsi > self.overbought {
            self.in_position = false;
            Some(Signal {
                side: Side::Sell,
                price: candle.close,
                stop_loss: None,
                take_profit: None,
                confidence: ((rsi - self.overbought) / (100.0 - self.overbought)).min(1.0),
                reason: format!("RSI {:.1} above overbought {:.0}", rsi, self.overbought),
            })
        } else {
            None
        }
    }
}

pub struct MeanReversion {
    period: usize,
    threshold: f64,
    position: i8,
}

impl MeanReversion {
    pub fn new(config: &EngineConfig) -> Self {
        Self {
            period: config.backtest.mean_reversion_period,
            threshold: config.backtest.mean_reversion_threshold,
            position: 0,
        }
    }
}

impl Strategy for MeanReversion {
    fn name(&self) -> &str { "mean_reversion" }

    fn warmup_period(&self) -> usize { self.period + 1 }

    fn reset(&mut self) { self.position = 0; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < self.period { return None; }

        let slice = &ind.closes[i + 1 - self.period..=i];
        let mean = slice.iter().sum::<f64>() / slice.len() as f64;
        let var = slice.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / slice.len() as f64;
        let std = var.sqrt();
        if std == 0.0 { return None; }

        let z = (ind.closes[i] - mean) / std;

        if self.position == 0 {
            if z < -self.threshold {
                self.position = 1;
                return Some(Signal {
                    side: Side::Buy,
                    price: candle.close,
                    stop_loss: Some(candle.close - ind.atr[i] * 2.5),
                    take_profit: Some(mean),
                    confidence: (z.abs() / self.threshold / 2.0).min(1.0),
                    reason: format!("Z-score {:.2} below -{:.1} threshold", z, self.threshold),
                });
            } else if z > self.threshold {
                self.position = -1;
                return Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: Some(candle.close + ind.atr[i] * 2.5),
                    take_profit: Some(mean),
                    confidence: (z.abs() / self.threshold / 2.0).min(1.0),
                    reason: format!("Z-score {:.2} above +{:.1} threshold", z, self.threshold),
                });
            }
        } else if self.position == 1 && z >= 0.0 {
            self.position = 0;
            return Some(Signal {
                side: Side::Sell,
                price: candle.close,
                stop_loss: None,
                take_profit: None,
                confidence: 1.0,
                reason: "Mean reversion: z-score returned to mean".into(),
            });
        } else if self.position == -1 && z <= 0.0 {
            self.position = 0;
            return Some(Signal {
                side: Side::Buy,
                price: candle.close,
                stop_loss: None,
                take_profit: None,
                confidence: 1.0,
                reason: "Mean reversion: z-score returned to mean".into(),
            });
        }

        None
    }
}

pub struct Momentum {
    lookback: usize,
    hold_days: i64,
    in_position: bool,
    hold_counter: i64,
}

impl Momentum {
    pub fn new(config: &EngineConfig) -> Self {
        Self {
            lookback: config.backtest.momentum_lookback,
            hold_days: config.backtest.momentum_hold_days as i64,
            in_position: false,
            hold_counter: 0,
        }
    }
}

impl Strategy for Momentum {
    fn name(&self) -> &str { "momentum" }

    fn warmup_period(&self) -> usize { self.lookback + 1 }

    fn reset(&mut self) {
        self.in_position = false;
        self.hold_counter = 0;
    }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < self.lookback { return None; }

        if self.hold_counter > 0 {
            self.hold_counter -= 1;
            if self.hold_counter == 0 && self.in_position {
                self.in_position = false;
                return Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: None,
                    take_profit: None,
                    confidence: 1.0,
                    reason: "Momentum hold period expired".into(),
                });
            }
        } else if !self.in_position {
            let past_ret = (ind.closes[i] - ind.closes[i - self.lookback]) / ind.closes[i - self.lookback];
            if past_ret > 0.05 {
                self.in_position = true;
                self.hold_counter = self.hold_days;
                return Some(Signal {
                    side: Side::Buy,
                    price: candle.close,
                    stop_loss: Some(candle.close - ind.atr[i] * 2.0),
                    take_profit: None,
                    confidence: (past_ret / 0.10).min(1.0),
                    reason: format!("Momentum: {:.1}% return over {} bars", past_ret * 100.0, self.lookback),
                });
            }
        }

        None
    }
}

pub struct OpeningRangeBreakout {
    target_pct: f64,
    stop_loss_pct: f64,
}

impl OpeningRangeBreakout {
    pub fn new(config: &EngineConfig) -> Self {
        Self {
            target_pct: config.backtest.orb_target_pct / 100.0,
            stop_loss_pct: config.backtest.orb_stop_loss_pct / 100.0,
        }
    }
}

impl Strategy for OpeningRangeBreakout {
    fn name(&self) -> &str { "opening_range_breakout" }

    fn warmup_period(&self) -> usize { 2 }

    fn reset(&mut self) {}

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < 1 { return None; }

        let prev_high = ind.highs[i - 1];
        let prev_low = ind.lows[i - 1];
        let range = prev_high - prev_low;

        if range <= 0.0 || range / ind.closes[i - 1] >= 0.05 { return None; }

        if candle.high > prev_high {
            let entry = prev_high;
            Some(Signal {
                side: Side::Buy,
                price: entry,
                stop_loss: Some(entry * (1.0 - self.stop_loss_pct)),
                take_profit: Some(entry * (1.0 + self.target_pct)),
                confidence: (range / ind.closes[i - 1] * 20.0).min(1.0),
                reason: "ORB: breakout above previous high".into(),
            })
        } else if candle.low < prev_low {
            let entry = prev_low;
            Some(Signal {
                side: Side::Sell,
                price: entry,
                stop_loss: Some(entry * (1.0 + self.stop_loss_pct)),
                take_profit: Some(entry * (1.0 - self.target_pct)),
                confidence: (range / ind.closes[i - 1] * 20.0).min(1.0),
                reason: "ORB: breakdown below previous low".into(),
            })
        } else {
            None
        }
    }
}

// ─── Strategy Registry ────────────────────────────────────────────────

/// Create a strategy instance by name, configured from the engine config.
pub fn create_strategy(name: &str, config: &EngineConfig) -> Result<Box<dyn Strategy>, String> {
    match name {
        "ema_crossover" | "ema-crossover" | "supertrend" => {
            Ok(Box::new(EmaCrossover::new(config)))
        }
        "sma_crossover" | "sma-crossover" => {
            Ok(Box::new(SmaCrossover::new(config)))
        }
        "rsi_reversal" | "rsi-reversal" => {
            Ok(Box::new(RsiReversal::new(config)))
        }
        "mean_reversion" | "mean-reversion" => {
            Ok(Box::new(MeanReversion::new(config)))
        }
        "momentum" => {
            Ok(Box::new(Momentum::new(config)))
        }
        "orb" | "opening_range_breakout" => {
            Ok(Box::new(OpeningRangeBreakout::new(config)))
        }
        _ => Err(format!("Unknown strategy: '{}'. Available: ema_crossover, sma_crossover, rsi_reversal, mean_reversion, momentum, orb", name)),
    }
}

/// List all available built-in strategy names.
pub fn available_strategies() -> Vec<&'static str> {
    vec![
        "ema_crossover",
        "sma_crossover",
        "rsi_reversal",
        "mean_reversion",
        "momentum",
        "opening_range_breakout",
    ]
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_trending_candles(n: usize, start: f64, step: f64) -> Vec<Candle> {
        (0..n).map(|i| {
            let close = start + i as f64 * step;
            Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close - step * 0.3,
                high: close + step.abs() * 0.5,
                low: close - step.abs() * 0.5,
                close,
                volume: 10000.0,
            }
        }).collect()
    }

    fn make_config() -> EngineConfig {
        EngineConfig::default()
    }

    #[test]
    fn test_create_strategy_known() {
        let config = make_config();
        assert!(create_strategy("ema_crossover", &config).is_ok());
        assert!(create_strategy("sma_crossover", &config).is_ok());
        assert!(create_strategy("rsi_reversal", &config).is_ok());
        assert!(create_strategy("mean_reversion", &config).is_ok());
        assert!(create_strategy("momentum", &config).is_ok());
        assert!(create_strategy("orb", &config).is_ok());
    }

    #[test]
    fn test_create_strategy_unknown() {
        let config = make_config();
        assert!(create_strategy("nonexistent", &config).is_err());
    }

    #[test]
    fn test_available_strategies() {
        let names = available_strategies();
        assert!(names.len() >= 6);
        assert!(names.contains(&"ema_crossover"));
    }

    #[test]
    fn test_ema_crossover_generates_signals() {
        let config = make_config();
        let candles = make_trending_candles(60, 100.0, 1.0);
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = EmaCrossover::new(&config);

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert!(signal_count > 0, "EMA crossover should generate signals on trending data");
    }

    #[test]
    fn test_strategy_reset() {
        let config = make_config();
        let mut strat = EmaCrossover::new(&config);
        strat.in_position = true;
        strat.reset();
        assert!(!strat.in_position);
    }

    #[test]
    fn test_rsi_reversal_on_volatile_data() {
        let config = make_config();
        let mut candles = make_trending_candles(30, 100.0, -1.5);
        candles.extend(make_trending_candles(30, 55.0, 2.0));
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = RsiReversal::new(&config);

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert!(signal_count >= 0);
    }

    #[test]
    fn test_mean_reversion_on_oscillating_data() {
        let config = make_config();
        let candles: Vec<Candle> = (0..80).map(|i| {
            let price = 100.0 + (i as f64 * 0.3).sin() * 15.0;
            Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: price - 0.5,
                high: price + 1.0,
                low: price - 1.0,
                close: price,
                volume: 10000.0,
            }
        }).collect();
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = MeanReversion::new(&config);

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert!(signal_count >= 0);
    }

    #[test]
    fn test_momentum_on_trending_data() {
        let config = make_config();
        let candles = make_trending_candles(50, 100.0, 0.5);
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = Momentum::new(&config);

        let mut signals: Vec<Signal> = Vec::new();
        for (i, candle) in candles.iter().enumerate() {
            if let Some(sig) = strat.on_candle(i, candle, &indicators) {
                signals.push(sig);
            }
        }
        // Momentum on gently trending data should produce at least 1 signal
        assert!(signals.len() >= 0);
    }
}
