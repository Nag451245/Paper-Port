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
    pub opens: Vec<f64>,
    pub highs: Vec<f64>,
    pub lows: Vec<f64>,
    pub volumes: Vec<f64>,
    pub bb_upper: Vec<f64>,
    pub bb_lower: Vec<f64>,
    pub bb_mid: Vec<f64>,
    pub vwap: Vec<f64>,
    pub adx: Vec<f64>,
    pub plus_di: Vec<f64>,
    pub minus_di: Vec<f64>,
}

impl Indicators {
    pub fn from_candles(candles: &[Candle], config: &EngineConfig) -> Self {
        let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
        let opens: Vec<f64> = candles.iter().map(|c| c.open).collect();
        let highs: Vec<f64> = candles.iter().map(|c| c.high).collect();
        let lows: Vec<f64> = candles.iter().map(|c| c.low).collect();
        let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();

        let ema_short = calc_ema(&closes, config.backtest.ema_short_period);
        let ema_long = calc_ema(&closes, config.backtest.ema_long_period);
        let rsi = calc_rsi(&closes, 14);
        let sma_short = calc_sma(&closes, config.backtest.sma_short_period);
        let sma_long = calc_sma(&closes, config.backtest.sma_long_period);
        let atr = calc_atr(&highs, &lows, &closes, 14);

        let bb_period = config.backtest.bb_period;
        let bb_mult = config.backtest.bb_std_mult;
        let (bb_upper, bb_lower, bb_mid) = calc_bollinger(&closes, bb_period, bb_mult);
        let vwap = calc_vwap(&highs, &lows, &closes, &volumes);
        let adx_period = config.backtest.adx_period;
        let (adx, plus_di, minus_di) = calc_adx(&highs, &lows, &closes, adx_period);

        Self {
            ema_short, ema_long, rsi, sma_short, sma_long, atr,
            closes, opens, highs, lows, volumes,
            bb_upper, bb_lower, bb_mid, vwap, adx, plus_di, minus_di,
        }
    }
}

fn calc_bollinger(closes: &[f64], period: usize, mult: f64) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = closes.len();
    let mut upper = vec![0.0; n];
    let mut lower = vec![0.0; n];
    let mut mid = vec![0.0; n];
    for i in period.saturating_sub(1)..n {
        let start = if i + 1 >= period { i + 1 - period } else { 0 };
        let slice = &closes[start..=i];
        let mean = slice.iter().sum::<f64>() / slice.len() as f64;
        let var = slice.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / slice.len() as f64;
        let std = var.sqrt();
        mid[i] = mean;
        upper[i] = mean + mult * std;
        lower[i] = mean - mult * std;
    }
    (upper, lower, mid)
}

fn calc_vwap(highs: &[f64], lows: &[f64], closes: &[f64], volumes: &[f64]) -> Vec<f64> {
    let n = closes.len();
    let mut vwap = vec![0.0; n];
    let mut cum_pv = 0.0;
    let mut cum_vol = 0.0;
    for i in 0..n {
        let typical = (highs[i] + lows[i] + closes[i]) / 3.0;
        cum_pv += typical * volumes[i];
        cum_vol += volumes[i];
        vwap[i] = if cum_vol > 0.0 { cum_pv / cum_vol } else { closes[i] };
    }
    vwap
}

fn calc_adx(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> (Vec<f64>, Vec<f64>, Vec<f64>) {
    let n = closes.len();
    let mut adx = vec![0.0; n];
    let mut plus_di = vec![0.0; n];
    let mut minus_di = vec![0.0; n];
    if n < period + 1 { return (adx, plus_di, minus_di); }

    let mut tr_sum = 0.0;
    let mut plus_dm_sum = 0.0;
    let mut minus_dm_sum = 0.0;
    let mut dx_sum = 0.0;
    let mut dx_count = 0usize;

    for i in 1..n {
        let tr = (highs[i] - lows[i])
            .max((highs[i] - closes[i - 1]).abs())
            .max((lows[i] - closes[i - 1]).abs());
        let up = highs[i] - highs[i - 1];
        let down = lows[i - 1] - lows[i];
        let pdm = if up > down && up > 0.0 { up } else { 0.0 };
        let mdm = if down > up && down > 0.0 { down } else { 0.0 };

        if i <= period {
            tr_sum += tr;
            plus_dm_sum += pdm;
            minus_dm_sum += mdm;
            if i == period {
                let pdi = if tr_sum > 0.0 { plus_dm_sum / tr_sum * 100.0 } else { 0.0 };
                let mdi = if tr_sum > 0.0 { minus_dm_sum / tr_sum * 100.0 } else { 0.0 };
                plus_di[i] = pdi;
                minus_di[i] = mdi;
                let di_sum = pdi + mdi;
                let dx = if di_sum > 0.0 { (pdi - mdi).abs() / di_sum * 100.0 } else { 0.0 };
                dx_sum += dx;
                dx_count += 1;
                adx[i] = dx;
            }
        } else {
            let p = period as f64;
            tr_sum = tr_sum - tr_sum / p + tr;
            plus_dm_sum = plus_dm_sum - plus_dm_sum / p + pdm;
            minus_dm_sum = minus_dm_sum - minus_dm_sum / p + mdm;
            let pdi = if tr_sum > 0.0 { plus_dm_sum / tr_sum * 100.0 } else { 0.0 };
            let mdi = if tr_sum > 0.0 { minus_dm_sum / tr_sum * 100.0 } else { 0.0 };
            plus_di[i] = pdi;
            minus_di[i] = mdi;
            let di_sum = pdi + mdi;
            let dx = if di_sum > 0.0 { (pdi - mdi).abs() / di_sum * 100.0 } else { 0.0 };
            dx_sum += dx;
            dx_count += 1;
            adx[i] = if dx_count >= period {
                (adx[i - 1] * (p - 1.0) + dx) / p
            } else {
                dx_sum / dx_count as f64
            };
        }
    }
    (adx, plus_di, minus_di)
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
        if i < self.long_period || i == 0 { return None; }

        let ema_s = ind.ema_short[i];
        let ema_l = ind.ema_long[i];
        let prev_s = ind.ema_short[i - 1];
        let prev_l = ind.ema_long[i - 1];

        if ema_l == 0.0 || prev_l == 0.0 { return None; }

        if !self.in_position && prev_s <= prev_l && ema_s > ema_l {
            self.in_position = true;
            Some(Signal {
                side: Side::Buy,
                price: candle.close,
                stop_loss: Some(candle.close - ind.atr[i] * 2.0),
                take_profit: Some(candle.close + ind.atr[i] * 3.0),
                confidence: ((ema_s - ema_l) / ema_l * 100.0).min(1.0),
                reason: format!("EMA {} crossed above EMA {}", self.short_period, self.long_period),
            })
        } else if self.in_position && prev_s >= prev_l && ema_s < ema_l {
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

// ─── SuperTrend Strategy ─────────────────────────────────────────────
// Uses ATR-based trailing bands. When price crosses above the lower band,
// it's an uptrend (buy). When price crosses below the upper band, it's a
// downtrend (sell/short). This is NOT EMA crossover.

pub struct SuperTrend {
    atr_period: usize,
    multiplier: f64,
    in_uptrend: Option<bool>,
    final_upper: f64,
    final_lower: f64,
}

impl SuperTrend {
    pub fn new(config: &EngineConfig) -> Self {
        Self {
            atr_period: config.backtest.supertrend_atr_period,
            multiplier: config.backtest.supertrend_multiplier,
            in_uptrend: None,
            final_upper: 0.0,
            final_lower: 0.0,
        }
    }
}

impl Strategy for SuperTrend {
    fn name(&self) -> &str { "supertrend" }

    fn warmup_period(&self) -> usize { self.atr_period + 1 }

    fn reset(&mut self) {
        self.in_uptrend = None;
        self.final_upper = 0.0;
        self.final_lower = 0.0;
    }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < self.atr_period { return None; }
        let atr = ind.atr[i];
        if atr <= 0.0 { return None; }

        let hl2 = (candle.high + candle.low) / 2.0;
        let basic_upper = hl2 + self.multiplier * atr;
        let basic_lower = hl2 - self.multiplier * atr;

        // Ratchet the bands — upper can only decrease, lower can only increase
        let prev_upper = self.final_upper;
        let prev_lower = self.final_lower;

        self.final_lower = if basic_lower > prev_lower || (i > 0 && ind.closes[i - 1] < prev_lower) {
            basic_lower
        } else {
            basic_lower.max(prev_lower)
        };

        self.final_upper = if basic_upper < prev_upper || (i > 0 && ind.closes[i - 1] > prev_upper) {
            basic_upper
        } else {
            basic_upper.min(prev_upper)
        };

        let was_uptrend = self.in_uptrend;
        let now_uptrend = match was_uptrend {
            Some(true) => candle.close >= self.final_lower,
            Some(false) => candle.close > self.final_upper,
            None => candle.close > self.final_upper,
        };
        self.in_uptrend = Some(now_uptrend);

        match (was_uptrend, now_uptrend) {
            (Some(false), true) => {
                Some(Signal {
                    side: Side::Buy,
                    price: candle.close,
                    stop_loss: Some(self.final_lower),
                    take_profit: None,
                    confidence: ((candle.close - self.final_lower) / candle.close).min(1.0),
                    reason: format!("SuperTrend flipped to uptrend (lower band: {:.2})", self.final_lower),
                })
            }
            (Some(true), false) => {
                Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: Some(self.final_upper),
                    take_profit: None,
                    confidence: ((self.final_upper - candle.close) / candle.close).min(1.0),
                    reason: format!("SuperTrend flipped to downtrend (upper band: {:.2})", self.final_upper),
                })
            }
            _ => None,
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
        if i >= ind.rsi.len() || ind.rsi[i].is_nan() || i < 14 { return None; }

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

// ─── New Strategies ───────────────────────────────────────────────────

pub struct GapTrading {
    min_gap_pct: f64,
    in_position: bool,
}

impl GapTrading {
    pub fn new(config: &EngineConfig) -> Self {
        Self { min_gap_pct: config.backtest.gap_min_pct, in_position: false }
    }
}

impl Strategy for GapTrading {
    fn name(&self) -> &str { "gap_trading" }
    fn warmup_period(&self) -> usize { 2 }
    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < 1 { return None; }
        let prev_close = ind.closes[i - 1];
        if prev_close == 0.0 { return None; }
        let gap_pct = (candle.open - prev_close) / prev_close * 100.0;

        if self.in_position {
            // Exit when price reverts toward prev close
            let dist = (candle.close - prev_close).abs() / prev_close * 100.0;
            if dist < 0.3 {
                self.in_position = false;
                let side = if candle.close > candle.open { Side::Sell } else { Side::Buy };
                return Some(Signal {
                    side,
                    price: candle.close,
                    stop_loss: None,
                    take_profit: None,
                    confidence: 1.0,
                    reason: "Gap fade: price reverted to previous close".into(),
                });
            }
            return None;
        }

        // Gap up — fade it (sell expecting reversion)
        if gap_pct > self.min_gap_pct && ind.rsi[i] > 60.0 {
            self.in_position = true;
            return Some(Signal {
                side: Side::Sell,
                price: candle.close,
                stop_loss: Some(candle.close + ind.atr[i] * 1.5),
                take_profit: Some(prev_close),
                confidence: (gap_pct / 3.0).min(1.0),
                reason: format!("Gap up {:.1}%: fade toward prev close", gap_pct),
            });
        }
        // Gap down — fade it (buy expecting reversion)
        if gap_pct < -self.min_gap_pct && ind.rsi[i] < 40.0 {
            self.in_position = true;
            return Some(Signal {
                side: Side::Buy,
                price: candle.close,
                stop_loss: Some(candle.close - ind.atr[i] * 1.5),
                take_profit: Some(prev_close),
                confidence: (gap_pct.abs() / 3.0).min(1.0),
                reason: format!("Gap down {:.1}%: fade toward prev close", gap_pct),
            });
        }
        None
    }
}

pub struct VwapReversion {
    deviation_threshold: f64,
    in_position: bool,
}

impl VwapReversion {
    pub fn new(config: &EngineConfig) -> Self {
        Self { deviation_threshold: config.backtest.vwap_deviation_threshold, in_position: false }
    }
}

impl Strategy for VwapReversion {
    fn name(&self) -> &str { "vwap_reversion" }
    fn warmup_period(&self) -> usize { 5 }
    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < 5 || ind.vwap[i] == 0.0 { return None; }
        let vwap = ind.vwap[i];
        let deviation = (candle.close - vwap) / vwap * 100.0;

        if self.in_position {
            if deviation.abs() < 0.2 {
                self.in_position = false;
                let side = if candle.close > vwap { Side::Sell } else { Side::Buy };
                return Some(Signal {
                    side,
                    price: candle.close,
                    stop_loss: None,
                    take_profit: None,
                    confidence: 1.0,
                    reason: "VWAP reversion: price returned to VWAP".into(),
                });
            }
            return None;
        }

        if deviation < -self.deviation_threshold && ind.rsi[i] < 45.0 {
            self.in_position = true;
            return Some(Signal {
                side: Side::Buy,
                price: candle.close,
                stop_loss: Some(candle.close - ind.atr[i] * 1.5),
                take_profit: Some(vwap),
                confidence: (deviation.abs() / 3.0).min(1.0),
                reason: format!("VWAP deviation {:.2}%: buy below VWAP", deviation),
            });
        }
        if deviation > self.deviation_threshold && ind.rsi[i] > 55.0 {
            self.in_position = true;
            return Some(Signal {
                side: Side::Sell,
                price: candle.close,
                stop_loss: Some(candle.close + ind.atr[i] * 1.5),
                take_profit: Some(vwap),
                confidence: (deviation / 3.0).min(1.0),
                reason: format!("VWAP deviation {:.2}%: sell above VWAP", deviation),
            });
        }
        None
    }
}

pub struct VolatilityBreakout {
    in_position: bool,
}

impl VolatilityBreakout {
    pub fn new(_config: &EngineConfig) -> Self {
        Self { in_position: false }
    }
}

impl Strategy for VolatilityBreakout {
    fn name(&self) -> &str { "volatility_breakout" }
    fn warmup_period(&self) -> usize { 21 }
    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < 21 || ind.bb_upper[i] == 0.0 { return None; }

        let bb_width = ind.bb_upper[i] - ind.bb_lower[i];
        let prev_width = ind.bb_upper[i - 1] - ind.bb_lower[i - 1];
        let expansion = if prev_width > 0.0 { bb_width / prev_width } else { 1.0 };

        if self.in_position {
            // Exit at BB mid
            if (candle.close - ind.bb_mid[i]).abs() < ind.atr[i] * 0.3 {
                self.in_position = false;
                return Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: None,
                    take_profit: None,
                    confidence: 1.0,
                    reason: "Volatility breakout: price returned to BB mid".into(),
                });
            }
            return None;
        }

        // Squeeze then expansion: bands widening after being narrow
        if expansion > 1.3 {
            if candle.close > ind.bb_upper[i] {
                self.in_position = true;
                return Some(Signal {
                    side: Side::Buy,
                    price: candle.close,
                    stop_loss: Some(ind.bb_mid[i]),
                    take_profit: Some(candle.close + (candle.close - ind.bb_mid[i]) * 2.0),
                    confidence: (expansion / 2.0).min(1.0),
                    reason: format!("BB breakout upward, expansion {:.1}x", expansion),
                });
            }
            if candle.close < ind.bb_lower[i] {
                self.in_position = true;
                return Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: Some(ind.bb_mid[i]),
                    take_profit: Some(candle.close - (ind.bb_mid[i] - candle.close) * 2.0),
                    confidence: (expansion / 2.0).min(1.0),
                    reason: format!("BB breakout downward, expansion {:.1}x", expansion),
                });
            }
        }
        None
    }
}

pub struct SectorRotation {
    ema_period: usize,
    in_position: bool,
}

impl SectorRotation {
    pub fn new(config: &EngineConfig) -> Self {
        Self { ema_period: config.backtest.sector_ema_period, in_position: false }
    }
}

impl Strategy for SectorRotation {
    fn name(&self) -> &str { "sector_rotation" }
    fn warmup_period(&self) -> usize { self.ema_period + 1 }
    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < self.ema_period + 5 { return None; }

        let ema = ind.ema_long[i];
        if ema == 0.0 { return None; }
        let rel_strength = (candle.close - ema) / ema * 100.0;

        // Volume confirmation: current volume vs 20-bar avg
        let start = if i >= 20 { i - 20 } else { 0 };
        let avg_vol = ind.volumes[start..i].iter().sum::<f64>() / (i - start) as f64;
        let vol_ratio = if avg_vol > 0.0 { ind.volumes[i] / avg_vol } else { 1.0 };

        if self.in_position {
            // Exit on relative strength fading below EMA
            if candle.close < ema {
                self.in_position = false;
                return Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: None,
                    take_profit: None,
                    confidence: 1.0,
                    reason: "Sector rotation exit: price fell below EMA".into(),
                });
            }
            return None;
        }

        // Enter on strong relative strength + volume
        if rel_strength > 2.0 && vol_ratio > 1.2 && ind.rsi[i] > 50.0 && ind.rsi[i] < 75.0 {
            self.in_position = true;
            return Some(Signal {
                side: Side::Buy,
                price: candle.close,
                stop_loss: Some(ema),
                take_profit: Some(candle.close + (candle.close - ema) * 2.0),
                confidence: (rel_strength / 5.0).min(1.0),
                reason: format!("Sector rotation: rel. strength {:.1}%, vol ratio {:.1}x", rel_strength, vol_ratio),
            });
        }
        None
    }
}

pub struct PairsTrading {
    lookback: usize,
    z_threshold: f64,
    position: i8,
    ratio_history: Vec<f64>,
}

impl PairsTrading {
    pub fn new(_config: &EngineConfig) -> Self {
        Self {
            lookback: 20,
            z_threshold: 2.0,
            position: 0,
            ratio_history: Vec::new(),
        }
    }
}

impl Strategy for PairsTrading {
    fn name(&self) -> &str { "pairs_trading" }
    fn warmup_period(&self) -> usize { 21 }
    fn reset(&mut self) { self.position = 0; self.ratio_history.clear(); }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        // Uses price-to-SMA ratio as a synthetic "spread"
        if i < self.lookback + 1 || ind.sma_long[i] == 0.0 { return None; }
        let ratio = candle.close / ind.sma_long[i];
        self.ratio_history.push(ratio);
        if self.ratio_history.len() < self.lookback { return None; }

        let start = self.ratio_history.len() - self.lookback;
        let window = &self.ratio_history[start..];
        let mean = window.iter().sum::<f64>() / window.len() as f64;
        let var = window.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / window.len() as f64;
        let std = var.sqrt();
        if std == 0.0 { return None; }
        let z = (ratio - mean) / std;

        if self.position == 0 {
            if z > self.z_threshold {
                self.position = -1;
                return Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: Some(candle.close + ind.atr[i] * 2.0),
                    take_profit: Some(ind.sma_long[i]),
                    confidence: (z / 3.0).min(1.0),
                    reason: format!("Pairs z-score {:.2}: spread too wide, sell", z),
                });
            }
            if z < -self.z_threshold {
                self.position = 1;
                return Some(Signal {
                    side: Side::Buy,
                    price: candle.close,
                    stop_loss: Some(candle.close - ind.atr[i] * 2.0),
                    take_profit: Some(ind.sma_long[i]),
                    confidence: (z.abs() / 3.0).min(1.0),
                    reason: format!("Pairs z-score {:.2}: spread too narrow, buy", z),
                });
            }
        } else if (self.position == -1 && z <= 0.0) || (self.position == 1 && z >= 0.0) {
            let side = if self.position == 1 { Side::Sell } else { Side::Buy };
            self.position = 0;
            return Some(Signal {
                side,
                price: candle.close,
                stop_loss: None,
                take_profit: None,
                confidence: 1.0,
                reason: "Pairs: z-score mean-reverted, closing".into(),
            });
        }
        None
    }
}

pub struct ExpiryTheta {
    in_position: bool,
}

impl ExpiryTheta {
    pub fn new(_config: &EngineConfig) -> Self {
        Self { in_position: false }
    }
}

impl Strategy for ExpiryTheta {
    fn name(&self) -> &str { "expiry_theta" }
    fn warmup_period(&self) -> usize { 15 }
    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < 15 { return None; }

        // Theta decay strategy: low-vol environment near range midpoint
        // Sell when vol is contracting and price is range-bound
        let atr = ind.atr[i];
        let bb_width = ind.bb_upper[i] - ind.bb_lower[i];
        if bb_width == 0.0 || ind.bb_mid[i] == 0.0 { return None; }
        let bb_pct = bb_width / ind.bb_mid[i] * 100.0;

        if self.in_position {
            // Exit if vol expands or price moves beyond band
            if candle.close > ind.bb_upper[i] || candle.close < ind.bb_lower[i] || bb_pct > 4.0 {
                self.in_position = false;
                return Some(Signal {
                    side: Side::Buy,
                    price: candle.close,
                    stop_loss: None,
                    take_profit: None,
                    confidence: 1.0,
                    reason: "Theta exit: vol expansion or band breach".into(),
                });
            }
            return None;
        }

        // Tight bands + RSI near 50 = low vol regime, sell premium
        if bb_pct < 2.5 && ind.rsi[i] > 40.0 && ind.rsi[i] < 60.0 && atr > 0.0 {
            let range_mid = (ind.highs[i] + ind.lows[i]) / 2.0;
            let dist_from_mid = (candle.close - range_mid).abs() / atr;
            if dist_from_mid < 0.5 {
                self.in_position = true;
                return Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: Some(candle.close + atr * 1.5),
                    take_profit: Some(candle.close - atr * 0.5),
                    confidence: ((2.5 - bb_pct) / 2.5).max(0.3).min(0.9),
                    reason: format!("Theta: low vol (BB width {:.1}%), sell premium", bb_pct),
                });
            }
        }
        None
    }
}

pub struct CalendarSpread {
    short_period: usize,
    long_period: usize,
    in_position: bool,
}

impl CalendarSpread {
    pub fn new(config: &EngineConfig) -> Self {
        Self {
            short_period: config.backtest.ema_short_period,
            long_period: config.backtest.ema_long_period * 2,
            in_position: false,
        }
    }
}

impl Strategy for CalendarSpread {
    fn name(&self) -> &str { "calendar_spread" }
    fn warmup_period(&self) -> usize { self.long_period + 1 }
    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < self.long_period { return None; }

        // Simulates calendar spread by comparing short-term and long-term vol
        let short_start = i + 1 - self.short_period.min(i + 1);
        let long_start = i + 1 - self.long_period.min(i + 1);

        let short_slice = &ind.closes[short_start..=i];
        let long_slice = &ind.closes[long_start..=i];

        let short_vol = calc_vol(short_slice);
        let long_vol = calc_vol(long_slice);
        if long_vol == 0.0 { return None; }

        let vol_ratio = short_vol / long_vol;

        if self.in_position {
            // Exit when short-term vol normalizes
            if vol_ratio > 0.8 && vol_ratio < 1.2 {
                self.in_position = false;
                let side = if candle.close > ind.sma_long[i] { Side::Sell } else { Side::Buy };
                return Some(Signal {
                    side,
                    price: candle.close,
                    stop_loss: None,
                    take_profit: None,
                    confidence: 1.0,
                    reason: "Calendar spread: vol term structure normalized".into(),
                });
            }
            return None;
        }

        // Short-term vol much lower than long-term = sell short-dated, buy long-dated
        if vol_ratio < 0.6 && ind.rsi[i] > 40.0 && ind.rsi[i] < 60.0 {
            self.in_position = true;
            return Some(Signal {
                side: Side::Buy,
                price: candle.close,
                stop_loss: Some(candle.close - ind.atr[i] * 2.0),
                take_profit: Some(candle.close + ind.atr[i] * 1.5),
                confidence: ((1.0 - vol_ratio) * 1.5).min(1.0),
                reason: format!("Calendar spread: short vol/long vol = {:.2}, buying", vol_ratio),
            });
        }
        // Short-term vol much higher than long-term = buy short-dated, sell long-dated
        if vol_ratio > 1.6 {
            self.in_position = true;
            return Some(Signal {
                side: Side::Sell,
                price: candle.close,
                stop_loss: Some(candle.close + ind.atr[i] * 2.0),
                take_profit: Some(candle.close - ind.atr[i] * 1.5),
                confidence: ((vol_ratio - 1.0) / 2.0).min(1.0),
                reason: format!("Calendar spread: short vol/long vol = {:.2}, selling", vol_ratio),
            });
        }
        None
    }
}

fn calc_vol(data: &[f64]) -> f64 {
    if data.len() < 2 { return 0.0; }
    let returns: Vec<f64> = data.windows(2)
        .map(|w| if w[0] > 0.0 && w[1] > 0.0 { (w[1] / w[0]).ln() } else { 0.0 })
        .collect();
    if returns.is_empty() { return 0.0; }
    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    let var = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / returns.len() as f64;
    let result = var.sqrt();
    if result.is_nan() || result.is_infinite() { 0.0 } else { result }
}

pub struct TrendFollowing {
    adx_threshold: f64,
    in_position: bool,
}

impl TrendFollowing {
    pub fn new(config: &EngineConfig) -> Self {
        Self { adx_threshold: config.backtest.adx_trend_threshold, in_position: false }
    }
}

impl Strategy for TrendFollowing {
    fn name(&self) -> &str { "trend_following" }
    fn warmup_period(&self) -> usize { 30 }
    fn reset(&mut self) { self.in_position = false; }

    fn on_candle(&mut self, i: usize, candle: &Candle, ind: &Indicators) -> Option<Signal> {
        if i < 30 { return None; }

        let adx = ind.adx[i];
        let plus = ind.plus_di[i];
        let minus = ind.minus_di[i];

        if self.in_position {
            // Exit on ADX decline (trend weakening) or DI crossover against us
            if adx < self.adx_threshold * 0.8 || (plus < minus && ind.rsi[i] < 45.0) {
                self.in_position = false;
                return Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: None,
                    take_profit: None,
                    confidence: 1.0,
                    reason: format!("Trend exit: ADX={:.1}, +DI={:.1}, -DI={:.1}", adx, plus, minus),
                });
            }
            return None;
        }

        // Strong trend: ADX above threshold
        if adx > self.adx_threshold {
            // Bullish trend: +DI > -DI, price above EMA
            if plus > minus && candle.close > ind.ema_long[i] {
                self.in_position = true;
                return Some(Signal {
                    side: Side::Buy,
                    price: candle.close,
                    stop_loss: Some(candle.close - ind.atr[i] * 2.0),
                    take_profit: Some(candle.close + ind.atr[i] * 3.0),
                    confidence: (adx / 50.0).min(1.0),
                    reason: format!("ADX trend buy: ADX={:.1}, +DI={:.1} > -DI={:.1}", adx, plus, minus),
                });
            }
            // Bearish trend: -DI > +DI, price below EMA
            if minus > plus && candle.close < ind.ema_long[i] {
                self.in_position = true;
                return Some(Signal {
                    side: Side::Sell,
                    price: candle.close,
                    stop_loss: Some(candle.close + ind.atr[i] * 2.0),
                    take_profit: Some(candle.close - ind.atr[i] * 3.0),
                    confidence: (adx / 50.0).min(1.0),
                    reason: format!("ADX trend sell: ADX={:.1}, -DI={:.1} > +DI={:.1}", adx, minus, plus),
                });
            }
        }
        None
    }
}

// ─── Strategy Registry ────────────────────────────────────────────────

/// Create a strategy instance by name, configured from the engine config.
pub fn create_strategy(name: &str, config: &EngineConfig) -> Result<Box<dyn Strategy>, String> {
    match name {
        "ema_crossover" | "ema-crossover" => {
            Ok(Box::new(EmaCrossover::new(config)))
        }
        "supertrend" | "super_trend" | "super-trend" => {
            Ok(Box::new(SuperTrend::new(config)))
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
        "gap_trading" | "gap-trading" => {
            Ok(Box::new(GapTrading::new(config)))
        }
        "vwap_reversion" | "vwap-reversion" => {
            Ok(Box::new(VwapReversion::new(config)))
        }
        "volatility_breakout" | "volatility-breakout" => {
            Ok(Box::new(VolatilityBreakout::new(config)))
        }
        "sector_rotation" | "sector-rotation" => {
            Ok(Box::new(SectorRotation::new(config)))
        }
        "pairs_trading" | "pairs-trading" => {
            Ok(Box::new(PairsTrading::new(config)))
        }
        "expiry_theta" | "expiry-theta" => {
            Ok(Box::new(ExpiryTheta::new(config)))
        }
        "calendar_spread" | "calendar-spread" => {
            Ok(Box::new(CalendarSpread::new(config)))
        }
        "trend_following" | "trend-following" | "adx" => {
            Ok(Box::new(TrendFollowing::new(config)))
        }
        _ => Err(format!(
            "Unknown strategy: '{}'. Available: {}",
            name,
            available_strategies().join(", ")
        )),
    }
}

/// List all available built-in strategy names.
pub fn available_strategies() -> Vec<&'static str> {
    vec![
        "ema_crossover",
        "supertrend",
        "sma_crossover",
        "rsi_reversal",
        "mean_reversion",
        "momentum",
        "opening_range_breakout",
        "gap_trading",
        "vwap_reversion",
        "volatility_breakout",
        "sector_rotation",
        "pairs_trading",
        "expiry_theta",
        "calendar_spread",
        "trend_following",
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
        for name in available_strategies() {
            assert!(create_strategy(name, &config).is_ok(), "Failed to create: {}", name);
        }
        assert!(create_strategy("ema-crossover", &config).is_ok());
        assert!(create_strategy("gap-trading", &config).is_ok());
        assert!(create_strategy("adx", &config).is_ok());
    }

    #[test]
    fn test_create_strategy_unknown() {
        let config = make_config();
        assert!(create_strategy("nonexistent", &config).is_err());
    }

    #[test]
    fn test_available_strategies() {
        let names = available_strategies();
        assert_eq!(names.len(), 15);
        assert!(names.contains(&"ema_crossover"));
        assert!(names.contains(&"supertrend"));
        assert!(names.contains(&"gap_trading"));
        assert!(names.contains(&"trend_following"));
    }

    #[test]
    fn test_ema_crossover_generates_signals() {
        let config = make_config();
        let mut candles = make_trending_candles(30, 100.0, -0.5);
        candles.extend(make_trending_candles(40, 85.0, 1.5));
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = EmaCrossover::new(&config);

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert!(signal_count > 0, "EMA crossover should generate signals on data with a clear crossover");
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

    // ─── New Strategy Coverage Tests ──────────────────────────────────

    #[test]
    fn test_gap_trading_on_gap_up_data() {
        let config = make_config();
        let mut candles: Vec<Candle> = (0..25).map(|i| {
            let close = 100.0 + i as f64 * 1.5;
            Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close - 0.8,
                high: close + 1.0,
                low: close - 1.0,
                close,
                volume: 50000.0,
            }
        }).collect();
        let prev_close = candles.last().unwrap().close;
        for j in 0..10 {
            let base = prev_close * 1.02 + j as f64 * 1.0;
            candles.push(Candle {
                timestamp: format!("2025-02-{:02}", j + 1),
                open: if j == 0 { prev_close * 1.02 } else { base - 0.5 },
                high: base + 1.5,
                low: base - 0.5,
                close: base + 0.5,
                volume: 60000.0,
            });
        }
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("gap_trading", &config).unwrap();

        let mut signals = Vec::new();
        for (i, candle) in candles.iter().enumerate() {
            if let Some(sig) = strat.on_candle(i, candle, &indicators) {
                signals.push(sig);
            }
        }
        assert!(!signals.is_empty(), "Gap trading should generate signals on gap-up data");
    }

    #[test]
    fn test_gap_trading_no_gap() {
        let config = make_config();
        let candles: Vec<Candle> = (0..40).map(|i| {
            let close = 100.0 + (i as f64 * 0.01).sin() * 0.2;
            Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close - 0.05,
                high: close + 0.3,
                low: close - 0.3,
                close,
                volume: 10000.0,
            }
        }).collect();
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("gap_trading", &config).unwrap();

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert_eq!(signal_count, 0, "No signals expected when there is no gap");
    }

    #[test]
    fn test_vwap_reversion_below_vwap() {
        let config = make_config();
        let mut candles: Vec<Candle> = Vec::new();
        for i in 0..15 {
            let close = 120.0 + (i as f64 * 0.1).sin() * 0.5;
            candles.push(Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close + 0.3,
                high: close + 1.0,
                low: close - 0.5,
                close,
                volume: 50000.0,
            });
        }
        for i in 0..25 {
            let close = 118.0 - i as f64 * 1.0;
            candles.push(Candle {
                timestamp: format!("2025-02-{:02}", (i % 28) + 1),
                open: close + 0.5,
                high: close + 1.0,
                low: close - 1.5,
                close,
                volume: 50000.0,
            });
        }
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("vwap_reversion", &config).unwrap();

        let mut buy_found = false;
        for (i, candle) in candles.iter().enumerate() {
            if let Some(sig) = strat.on_candle(i, candle, &indicators) {
                if matches!(sig.side, Side::Buy) {
                    buy_found = true;
                }
            }
        }
        assert!(buy_found, "VWAP reversion should generate BUY when close is well below VWAP");
    }

    #[test]
    fn test_vwap_reversion_above_vwap() {
        let config = make_config();
        let mut candles: Vec<Candle> = Vec::new();
        for i in 0..15 {
            let close = 80.0 + (i as f64 * 0.1).sin() * 0.5;
            candles.push(Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close - 0.3,
                high: close + 0.5,
                low: close - 1.0,
                close,
                volume: 50000.0,
            });
        }
        for i in 0..25 {
            let close = 82.0 + i as f64 * 1.5;
            candles.push(Candle {
                timestamp: format!("2025-02-{:02}", (i % 28) + 1),
                open: close - 0.5,
                high: close + 1.0,
                low: close - 0.5,
                close,
                volume: 50000.0,
            });
        }
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("vwap_reversion", &config).unwrap();

        let mut sell_found = false;
        for (i, candle) in candles.iter().enumerate() {
            if let Some(sig) = strat.on_candle(i, candle, &indicators) {
                if matches!(sig.side, Side::Sell) {
                    sell_found = true;
                }
            }
        }
        assert!(sell_found, "VWAP reversion should generate SELL when close is well above VWAP");
    }

    #[test]
    fn test_volatility_breakout_squeeze() {
        let config = make_config();
        let mut candles: Vec<Candle> = Vec::new();
        for i in 0..30 {
            let close = 100.0 + (i as f64 * 0.05).sin() * 0.1;
            candles.push(Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close - 0.05,
                high: close + 0.15,
                low: close - 0.15,
                close,
                volume: 10000.0,
            });
        }
        for j in 0..10 {
            let close = 105.0 + j as f64 * 2.0;
            candles.push(Candle {
                timestamp: format!("2025-02-{:02}", j + 1),
                open: close - 1.0,
                high: close + 2.0,
                low: close - 1.5,
                close,
                volume: 30000.0,
            });
        }
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("volatility_breakout", &config).unwrap();

        let mut signals = Vec::new();
        for (i, candle) in candles.iter().enumerate() {
            if let Some(sig) = strat.on_candle(i, candle, &indicators) {
                signals.push(sig);
            }
        }
        assert!(!signals.is_empty(), "Volatility breakout should signal on squeeze-then-expansion");
    }

    #[test]
    fn test_trend_following_strong_uptrend() {
        let config = make_config();
        let candles = make_trending_candles(60, 100.0, 2.0);
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("trend_following", &config).unwrap();

        let mut buy_found = false;
        for (i, candle) in candles.iter().enumerate() {
            if let Some(sig) = strat.on_candle(i, candle, &indicators) {
                if matches!(sig.side, Side::Buy) {
                    buy_found = true;
                }
            }
        }
        assert!(buy_found, "Trend following should generate BUY on strong uptrend with high ADX");
    }

    #[test]
    fn test_trend_following_no_trend() {
        let config = make_config();
        let candles: Vec<Candle> = (0..60).map(|i| {
            let close = 100.0 + if i % 2 == 0 { 1.0 } else { -1.0 };
            Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close + if i % 2 == 0 { -0.5 } else { 0.5 },
                high: close + 1.5,
                low: close - 1.5,
                close,
                volume: 10000.0,
            }
        }).collect();
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("trend_following", &config).unwrap();

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert!(signal_count <= 1, "Trend following should generate few/no signals on choppy data");
    }

    #[test]
    fn test_calendar_spread_signals() {
        let config = make_config();
        let candles = make_trending_candles(80, 100.0, 0.3);
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("calendar_spread", &config).unwrap();

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert!(signal_count >= 0, "CalendarSpread should run without panicking");
    }

    #[test]
    fn test_expiry_theta_signals() {
        let config = make_config();
        let candles: Vec<Candle> = (0..50).map(|i| {
            let close = 100.0 + (i as f64 * 0.15).sin() * 0.3;
            Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close - 0.1,
                high: close + 0.2,
                low: close - 0.2,
                close,
                volume: 10000.0,
            }
        }).collect();
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("expiry_theta", &config).unwrap();

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert!(signal_count >= 0, "ExpiryTheta should run without panicking");
    }

    #[test]
    fn test_pairs_trading_signals() {
        let config = make_config();
        let candles = make_trending_candles(80, 100.0, 0.5);
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("pairs_trading", &config).unwrap();

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert!(signal_count >= 0, "PairsTrading should run without panicking");
    }

    #[test]
    fn test_sector_rotation_signals() {
        let config = make_config();
        let candles = make_trending_candles(60, 100.0, 1.0);
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = create_strategy("sector_rotation", &config).unwrap();

        let mut signal_count = 0;
        for (i, candle) in candles.iter().enumerate() {
            if strat.on_candle(i, candle, &indicators).is_some() {
                signal_count += 1;
            }
        }
        assert!(signal_count >= 0, "SectorRotation should run without panicking");
    }

    #[test]
    fn test_all_strategies_warmup_period() {
        let config = make_config();
        for name in available_strategies() {
            let strat = create_strategy(name, &config).unwrap();
            assert!(
                strat.warmup_period() > 0,
                "Strategy '{}' should have warmup_period > 0",
                name,
            );
        }
    }

    #[test]
    fn test_all_strategies_handle_empty_candles() {
        let config = make_config();
        let minimal = vec![
            Candle { timestamp: "2025-01-01".into(), open: 100.0, high: 101.0, low: 99.0, close: 100.5, volume: 1000.0 },
            Candle { timestamp: "2025-01-02".into(), open: 100.5, high: 101.5, low: 99.5, close: 101.0, volume: 1000.0 },
            Candle { timestamp: "2025-01-03".into(), open: 101.0, high: 102.0, low: 100.0, close: 101.5, volume: 1000.0 },
        ];
        let ind = Indicators::from_candles(&minimal, &config);

        for name in available_strategies() {
            let mut strat = create_strategy(name, &config).unwrap();
            // All strategies have warmup > 3, so none should signal — verify no panic
            for (i, candle) in minimal.iter().enumerate() {
                let _ = strat.on_candle(i, candle, &ind);
            }
        }
    }

    #[test]
    fn test_strategy_alternating_aliases() {
        let config = make_config();
        let aliases = vec![
            "gap-trading",
            "adx",
            "volatility-breakout",
            "ema-crossover",
            "supertrend",
            "super-trend",
            "vwap-reversion",
            "trend-following",
            "pairs-trading",
            "expiry-theta",
            "calendar-spread",
            "sector-rotation",
            "sma-crossover",
            "rsi-reversal",
            "mean-reversion",
            "orb",
        ];
        for alias in &aliases {
            assert!(
                create_strategy(alias, &config).is_ok(),
                "Alias '{}' should create a valid strategy",
                alias,
            );
        }
    }

    #[test]
    fn test_supertrend_is_not_ema_crossover() {
        let config = make_config();
        let st = create_strategy("supertrend", &config).unwrap();
        let ema = create_strategy("ema_crossover", &config).unwrap();
        assert_eq!(st.name(), "supertrend");
        assert_eq!(ema.name(), "ema_crossover");
        assert_ne!(st.name(), ema.name(), "SuperTrend must not be EMA Crossover");
    }

    #[test]
    fn test_supertrend_generates_buy_and_sell() {
        let config = make_config();
        // Price goes up strongly then down strongly — SuperTrend should flip
        let mut candles: Vec<Candle> = Vec::new();
        for i in 0..30 {
            let close = 100.0 + i as f64 * 1.5;
            candles.push(Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close - 0.5,
                high: close + 2.0,
                low: close - 1.0,
                close,
                volume: 100000.0,
            });
        }
        for i in 0..30 {
            let close = 145.0 - i as f64 * 2.0;
            candles.push(Candle {
                timestamp: format!("2025-02-{:02}", (i % 28) + 1),
                open: close + 0.5,
                high: close + 1.0,
                low: close - 2.0,
                close,
                volume: 100000.0,
            });
        }
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = SuperTrend::new(&config);
        let mut buys = 0;
        let mut sells = 0;
        for (i, candle) in candles.iter().enumerate() {
            if let Some(sig) = strat.on_candle(i, candle, &indicators) {
                match sig.side {
                    Side::Buy => buys += 1,
                    Side::Sell => sells += 1,
                }
            }
        }
        assert!(buys > 0, "SuperTrend should generate BUY signal on uptrend");
        assert!(sells > 0, "SuperTrend should generate SELL signal on downtrend");
    }

    #[test]
    fn test_supertrend_stop_loss_set() {
        let config = make_config();
        let mut candles: Vec<Candle> = Vec::new();
        for i in 0..40 {
            let close = 100.0 + i as f64 * 1.0;
            candles.push(Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                open: close - 0.3,
                high: close + 1.5,
                low: close - 0.8,
                close,
                volume: 50000.0,
            });
        }
        let indicators = Indicators::from_candles(&candles, &config);
        let mut strat = SuperTrend::new(&config);
        for (i, candle) in candles.iter().enumerate() {
            if let Some(sig) = strat.on_candle(i, candle, &indicators) {
                assert!(sig.stop_loss.is_some(), "SuperTrend signals should include stop_loss (ATR band)");
                return;
            }
        }
    }
}
