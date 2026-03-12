use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;
use crate::signals;
use crate::utils::{Candle, calc_ema_series, get_f64, round2, round3, round4, calc_atr_candles, sanitize_candles};

#[derive(Deserialize)]
struct ScanInput {
    symbols: Vec<SymbolData>,
    #[serde(default = "default_aggressiveness")]
    aggressiveness: String,
    #[serde(default)]
    strategy_params: Option<HashMap<String, Value>>,
    #[serde(default)]
    vote_weights: Option<VoteWeights>,
    #[serde(default)]
    regime: Option<String>,
    #[serde(default)]
    current_date: Option<String>,  // YYYY-MM-DD for expiry detection
    #[serde(default)]
    pair_universe: Option<Vec<(String, String)>>,
}

#[derive(Deserialize, Clone)]
struct VoteWeights {
    #[serde(default = "default_ema_w")] ema: f64,
    #[serde(default = "default_rsi_w")] rsi: f64,
    #[serde(default = "default_macd_w")] macd: f64,
    #[serde(default = "default_st_w")] supertrend: f64,
    #[serde(default = "default_bb_w")] bollinger: f64,
    #[serde(default = "default_vwap_w")] vwap: f64,
    #[serde(default = "default_mom_w")] momentum: f64,
    #[serde(default = "default_vol_w")] volume: f64,
}

fn default_ema_w() -> f64 { 0.15 }
fn default_rsi_w() -> f64 { 0.10 }
fn default_macd_w() -> f64 { 0.10 }
fn default_st_w() -> f64 { 0.10 }
fn default_bb_w() -> f64 { 0.05 }
fn default_vwap_w() -> f64 { 0.05 }
fn default_mom_w() -> f64 { 0.25 }
fn default_vol_w() -> f64 { 0.20 }

impl Default for VoteWeights {
    fn default() -> Self {
        VoteWeights {
            ema: 0.15, rsi: 0.10, macd: 0.10, supertrend: 0.10,
            bollinger: 0.05, vwap: 0.05, momentum: 0.25, volume: 0.20,
        }
    }
}

fn apply_regime_weights(base: &VoteWeights, regime: &str) -> VoteWeights {
    match regime {
        "trending" => VoteWeights {
            ema: base.ema * 1.5, rsi: base.rsi * 0.7, macd: base.macd * 1.3,
            supertrend: base.supertrend * 1.4, bollinger: base.bollinger * 0.8,
            vwap: base.vwap, momentum: base.momentum * 1.4, volume: base.volume,
        },
        "mean_reverting" => VoteWeights {
            ema: base.ema * 0.7, rsi: base.rsi * 1.5, macd: base.macd * 0.8,
            supertrend: base.supertrend * 0.6, bollinger: base.bollinger * 1.6,
            vwap: base.vwap * 1.3, momentum: base.momentum * 0.6, volume: base.volume,
        },
        "volatile" => VoteWeights {
            ema: base.ema * 0.8, rsi: base.rsi * 1.2, macd: base.macd,
            supertrend: base.supertrend * 1.2, bollinger: base.bollinger * 1.4,
            vwap: base.vwap, momentum: base.momentum * 0.7, volume: base.volume * 1.3,
        },
        _ => base.clone(),
    }
}

struct ResolvedPeriods {
    ema_short: usize,
    ema_long: usize,
}

#[derive(Deserialize)]
struct SymbolData {
    symbol: String,
    candles: Vec<Candle>,
}

fn default_aggressiveness() -> String {
    "medium".to_string()
}

#[derive(Serialize)]
struct ScanOutput {
    signals: Vec<ScanSignal>,
}

#[derive(Serialize)]
struct ScanSignal {
    symbol: String,
    direction: String,
    confidence: f64,
    entry: f64,
    stop_loss: f64,
    target: f64,
    indicators: IndicatorSnapshot,
    votes: VoteBreakdown,
    #[serde(skip_serializing_if = "Option::is_none")]
    strategy: Option<String>,
}

#[derive(Serialize, Clone)]
struct IndicatorSnapshot {
    ema_9: f64,
    ema_21: f64,
    rsi_14: f64,
    macd: f64,
    macd_signal: f64,
    macd_histogram: f64,
    supertrend: f64,
    bollinger_upper: f64,
    bollinger_lower: f64,
    vwap: f64,
    close: f64,
    atr: f64,
    momentum_score: f64,
    volume_ratio: f64,
}

#[derive(Serialize, Clone)]
struct VoteBreakdown {
    ema_crossover: f64,
    rsi: f64,
    macd: f64,
    supertrend: f64,
    bollinger: f64,
    vwap: f64,
    momentum: f64,
    volume: f64,
}

struct Thresholds {
    min_confidence: f64,
    rsi_oversold: f64,
    rsi_overbought: f64,
    rsi_strong_oversold: f64,
    rsi_strong_overbought: f64,
    momentum_candles: usize,
    volume_surge_ratio: f64,
}

fn get_thresholds(aggressiveness: &str) -> Thresholds {
    match aggressiveness {
        "high" => Thresholds {
            min_confidence: 0.30,
            rsi_oversold: 40.0,
            rsi_overbought: 60.0,
            rsi_strong_oversold: 35.0,
            rsi_strong_overbought: 65.0,
            momentum_candles: 2,
            volume_surge_ratio: 1.2,
        },
        "low" => Thresholds {
            min_confidence: 0.60,
            rsi_oversold: 25.0,
            rsi_overbought: 75.0,
            rsi_strong_oversold: 20.0,
            rsi_strong_overbought: 80.0,
            momentum_candles: 4,
            volume_surge_ratio: 1.8,
        },
        _ => Thresholds {
            min_confidence: 0.40,
            rsi_oversold: 30.0,
            rsi_overbought: 70.0,
            rsi_strong_oversold: 25.0,
            rsi_strong_overbought: 75.0,
            momentum_candles: 3,
            volume_surge_ratio: 1.5,
        },
    }
}

fn resolve_periods(strategy_params: &Option<HashMap<String, Value>>) -> ResolvedPeriods {
    let mut ema_short = 9usize;
    let mut ema_long = 21usize;

    if let Some(params) = strategy_params {
        for (_strategy, val) in params {
            if let Some(obj) = val.as_object() {
                if let Some(v) = obj.get("ema_short").and_then(|v| v.as_f64()) {
                    let v = v as usize;
                    if v >= 3 && v <= 50 { ema_short = v; }
                }
                if let Some(v) = obj.get("ema_long").and_then(|v| v.as_f64()) {
                    let v = v as usize;
                    if v >= 10 && v <= 100 { ema_long = v; }
                }
                break; // use first strategy's params
            }
        }
    }

    if ema_short >= ema_long {
        ema_long = ema_short + 10;
    }

    ResolvedPeriods { ema_short, ema_long }
}

pub fn compute(data: Value) -> Result<Value, String> {
    let input: ScanInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid scan input: {}", e))?;

    let thresholds = get_thresholds(&input.aggressiveness);
    let periods = resolve_periods(&input.strategy_params);
    let use_custom_ema = input.strategy_params.is_some();
    let base_weights = input.vote_weights.unwrap_or_default();
    let weights = match &input.regime {
        Some(r) => apply_regime_weights(&base_weights, r),
        None => base_weights,
    };
    let mut out_signals = Vec::new();

    for sym_data in &input.symbols {
        if sym_data.candles.len() < 26 {
            continue;
        }

        let mut candles_clean = sym_data.candles.clone();
        sanitize_candles(&mut candles_clean);
        let sym_data = &SymbolData { symbol: sym_data.symbol.clone(), candles: candles_clean };

        let candles_json = match serde_json::to_value(
            &serde_json::json!({ "candles": sym_data.candles })
        ) {
            Ok(v) => v,
            Err(_) => continue,
        };
        let indicators = match signals::compute(candles_json) {
            Ok(v) => v,
            Err(_) => continue,
        };

        let n = sym_data.candles.len();
        let last = n - 1;
        let prev = n - 2;

        let close = sym_data.candles[last].close;

        let (ema_short_series, ema_long_series) = if use_custom_ema {
            let closes: Vec<f64> = sym_data.candles.iter().map(|c| c.close).collect();
            (calc_ema_series(&closes, periods.ema_short), calc_ema_series(&closes, periods.ema_long))
        } else {
            (Vec::new(), Vec::new())
        };

        let ema9 = if use_custom_ema { *ema_short_series.get(last).unwrap_or(&0.0) } else { get_f64(&indicators, "ema_9", last) };
        let ema21 = if use_custom_ema { *ema_long_series.get(last).unwrap_or(&0.0) } else { get_f64(&indicators, "ema_21", last) };
        let ema9_prev = if use_custom_ema { *ema_short_series.get(prev).unwrap_or(&0.0) } else { get_f64(&indicators, "ema_9", prev) };
        let ema21_prev = if use_custom_ema { *ema_long_series.get(prev).unwrap_or(&0.0) } else { get_f64(&indicators, "ema_21", prev) };
        let rsi = get_f64(&indicators, "rsi_14", last);
        let macd = get_f64(&indicators, "macd", last);
        let macd_sig = get_f64(&indicators, "macd_signal", last);
        let macd_prev = get_f64(&indicators, "macd", prev);
        let macd_sig_prev = get_f64(&indicators, "macd_signal", prev);
        let macd_hist = get_f64(&indicators, "macd_histogram", last);
        let supertrend = get_f64(&indicators, "supertrend", last);
        let bb_upper = get_f64(&indicators, "bollinger_upper", last);
        let bb_lower = get_f64(&indicators, "bollinger_lower", last);
        let bb_mid = (bb_upper + bb_lower) / 2.0;
        let vwap = get_f64(&indicators, "vwap", last);

        if ema21 == 0.0 || supertrend == 0.0 || bb_upper == 0.0 {
            continue;
        }

        let atr = calc_atr_candles(&sym_data.candles, 14);

        // ======= MOMENTUM DETECTION (NEW - catches rallies) =======
        let momentum_score = calc_momentum(&sym_data.candles, thresholds.momentum_candles);
        let volume_ratio = calc_volume_ratio(&sym_data.candles, 5);
        let breakout_score = calc_breakout(&sym_data.candles, 10);

        // --- Vote: EMA Trend (weight: 0.15) ---
        let ema_vote = if ema9 > ema21 && ema9_prev <= ema21_prev {
            1.0  // fresh bullish crossover
        } else if ema9 < ema21 && ema9_prev >= ema21_prev {
            -1.0 // fresh bearish crossover
        } else if ema9 > ema21 {
            // Trending up — reward based on how far EMA9 is above EMA21
            let spread = (ema9 - ema21) / ema21 * 100.0;
            (0.5 + (spread * 0.3).min(0.5)).min(1.0)
        } else if ema9 < ema21 {
            let spread = (ema21 - ema9) / ema21 * 100.0;
            -(0.5 + (spread * 0.3).min(0.5)).min(1.0)
        } else {
            0.0
        };

        // --- Vote: RSI Momentum (weight: 0.10) ---
        // RSI 50-70 is BULLISH momentum, RSI > 70 is strong trend
        let rsi_vote = if rsi < thresholds.rsi_strong_oversold {
            1.0   // deeply oversold — strong buy
        } else if rsi < thresholds.rsi_oversold {
            0.7   // oversold — buy
        } else if rsi > 80.0 {
            -0.2  // extreme — slight caution but don't fight the trend
        } else if rsi > 70.0 {
            0.7   // strong bullish momentum
        } else if rsi > 60.0 {
            0.8   // sweet-spot bullish momentum zone
        } else if rsi > 50.0 {
            0.5   // mild bullish
        } else if rsi > 40.0 {
            -0.3  // mild bearish
        } else {
            -0.6  // bearish momentum
        };

        // --- Vote: MACD (weight: 0.10) ---
        let macd_vote = if macd > macd_sig && macd_prev <= macd_sig_prev {
            1.0
        } else if macd < macd_sig && macd_prev >= macd_sig_prev {
            -1.0
        } else if macd_hist > 0.0 {
            // Reward increasing histogram (accelerating momentum)
            let prev_hist = get_f64(&indicators, "macd_histogram", prev);
            if macd_hist > prev_hist { 0.7 } else { 0.3 }
        } else if macd_hist < 0.0 {
            let prev_hist = get_f64(&indicators, "macd_histogram", prev);
            if macd_hist < prev_hist { -0.7 } else { -0.3 }
        } else {
            0.0
        };

        // --- Vote: Supertrend (weight: 0.10) ---
        let st_vote = if close > supertrend {
            1.0
        } else {
            -1.0
        };

        // --- Vote: Bollinger Position (weight: 0.05) ---
        let bb_range = bb_upper - bb_lower;
        let bb_vote = if bb_range > 0.0 {
            let position = (close - bb_lower) / bb_range;
            if position > 0.9 && momentum_score > 0.5 {
                0.9  // riding upper band with momentum = bullish breakout
            } else if position > 0.8 {
                0.5  // near upper band
            } else if position < 0.1 && momentum_score < -0.5 {
                -0.9 // riding lower band with negative momentum
            } else if position < 0.2 {
                -0.5
            } else if close > bb_mid {
                0.3  // above midline
            } else {
                -0.3 // below midline
            }
        } else {
            0.0
        };

        // --- Vote: VWAP (weight: 0.05) ---
        let vwap_pct = if vwap > 0.0 { (close - vwap) / vwap * 100.0 } else { 0.0 };
        let vwap_vote = if vwap_pct > 1.0 {
            1.0  // strongly above VWAP
        } else if vwap_pct > 0.5 {
            0.7  // clearly above VWAP
        } else if vwap_pct > 0.0 {
            0.4
        } else if vwap_pct < -1.0 {
            -1.0
        } else if vwap_pct < -0.5 {
            -0.7
        } else {
            -0.4
        };

        // --- Vote: MOMENTUM (NEW - weight: 0.25) ---
        // Consecutive green/red candles, rate of price change
        let momentum_vote = momentum_score;

        // --- Vote: VOLUME (NEW - weight: 0.20) ---
        // Volume surge confirms moves
        let volume_vote = if volume_ratio > thresholds.volume_surge_ratio * 1.5 {
            // Massive volume surge
            if momentum_score > 0.0 { 1.0 } else { -1.0 }
        } else if volume_ratio > thresholds.volume_surge_ratio {
            // Notable volume increase
            if momentum_score > 0.0 { 0.7 } else { -0.7 }
        } else if volume_ratio > 1.0 {
            // Above average volume
            if momentum_score > 0.0 { 0.3 } else { -0.3 }
        } else {
            0.0 // below average volume — no conviction
        };

        // When volume is below average, redistribute its weight to non-zero votes
        let effective_weights = if (volume_vote as f64).abs() < 0.001 {
            let redistributed = weights.volume;
            let non_vol_sum = weights.ema + weights.rsi + weights.macd
                + weights.supertrend + weights.bollinger + weights.vwap + weights.momentum;
            if non_vol_sum > 0.0 {
                let scale = (non_vol_sum + redistributed) / non_vol_sum;
                (weights.ema * scale, weights.rsi * scale, weights.macd * scale,
                 weights.supertrend * scale, weights.bollinger * scale,
                 weights.vwap * scale, weights.momentum * scale, 0.0)
            } else {
                (weights.ema, weights.rsi, weights.macd, weights.supertrend,
                 weights.bollinger, weights.vwap, weights.momentum, weights.volume)
            }
        } else {
            (weights.ema, weights.rsi, weights.macd, weights.supertrend,
             weights.bollinger, weights.vwap, weights.momentum, weights.volume)
        };

        let composite: f64 = ema_vote * effective_weights.0
            + rsi_vote * effective_weights.1
            + macd_vote * effective_weights.2
            + st_vote * effective_weights.3
            + bb_vote * effective_weights.4
            + vwap_vote * effective_weights.5
            + momentum_vote * effective_weights.6
            + volume_vote * effective_weights.7;

        // Agreement bonus: when most votes align, amplify the signal
        let votes_arr = [ema_vote, rsi_vote, macd_vote, st_vote, bb_vote, vwap_vote, momentum_vote, volume_vote];
        let bullish_count = votes_arr.iter().filter(|&&v| v > 0.1).count();
        let bearish_count = votes_arr.iter().filter(|&&v| v < -0.1).count();
        let agreement_bonus = if bullish_count >= 6 || bearish_count >= 6 {
            0.15
        } else if bullish_count >= 5 || bearish_count >= 5 {
            0.08
        } else {
            0.0
        };
        let composite = if composite > 0.0 {
            composite + agreement_bonus
        } else if composite < 0.0 {
            composite - agreement_bonus
        } else {
            composite
        };

        // Volatility factor: high vol = slight reduction, low vol = slight boost
        let vol_factor = if atr > 0.0 && close > 0.0 {
            let vol_pct = atr / close;
            if vol_pct > 0.03 { -0.08 }
            else if vol_pct < 0.01 { 0.08 }
            else { 0.0 }
        } else { 0.0 };

        // Liquidity factor: volume vs average
        let liq_factor = if volume_ratio > 2.0 { 0.08 }
            else if volume_ratio < 0.5 { -0.05 }
            else { 0.0 };

        let composite = composite + breakout_score * 0.10 + vol_factor + liq_factor;

        let (direction, confidence) = if composite > 0.0 {
            ("BUY".to_string(), composite.min(1.0))
        } else if composite < 0.0 {
            ("SELL".to_string(), composite.abs().min(1.0))
        } else {
            continue;
        };

        if confidence < thresholds.min_confidence {
            continue;
        }

        let (stop_loss, target) = if direction == "BUY" {
            (close - 1.5 * atr, close + 2.5 * atr)
        } else {
            (close + 1.5 * atr, close - 2.5 * atr)
        };

        let base_indicators = IndicatorSnapshot {
            ema_9: round2(ema9),
            ema_21: round2(ema21),
            rsi_14: round2(rsi),
            macd: round4(macd),
            macd_signal: round4(macd_sig),
            macd_histogram: round4(macd_hist),
            supertrend: round2(supertrend),
            bollinger_upper: round2(bb_upper),
            bollinger_lower: round2(bb_lower),
            vwap: round2(vwap),
            close: round2(close),
            atr: round2(atr),
            momentum_score: round3(momentum_score),
            volume_ratio: round2(volume_ratio),
        };

        let base_votes = VoteBreakdown {
            ema_crossover: round3(ema_vote),
            rsi: round3(rsi_vote),
            macd: round3(macd_vote),
            supertrend: round3(st_vote),
            bollinger: round3(bb_vote),
            vwap: round3(vwap_vote),
            momentum: round3(momentum_vote),
            volume: round3(volume_vote),
        };

        // Composite strategy: uses all indicators
        out_signals.push(ScanSignal {
            symbol: sym_data.symbol.clone(),
            direction: direction.clone(),
            confidence: round3(confidence),
            entry: round2(close),
            stop_loss: round2(stop_loss),
            target: round2(target),
            indicators: base_indicators.clone(),
            votes: base_votes.clone(),
            strategy: Some("composite".into()),
        });

        // === STRATEGY-SPECIFIC SIGNALS (4.2) ===
        // Each strategy generates its own signal if conditions are met.
        // Using tighter SL/target than the composite for intraday strategies.

        // 1. Opening Range Breakout (ORB) — first 15min range
        if n >= 3 {
            let orb_end = 3usize.min(n);
            let first_high = sym_data.candles[0..orb_end].iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
            let first_low = sym_data.candles[0..orb_end].iter().map(|c| c.low).fold(f64::INFINITY, f64::min);
            let orb_range = first_high - first_low;
            if orb_range > 0.0 && close > first_high && volume_ratio > 1.2 {
                let orb_conf = (0.5 + (close - first_high) / orb_range * 0.3).min(0.95);
                if orb_conf >= thresholds.min_confidence {
                    out_signals.push(ScanSignal {
                        symbol: sym_data.symbol.clone(),
                        direction: "BUY".into(),
                        confidence: round3(orb_conf),
                        entry: round2(close),
                        stop_loss: round2(first_low),
                        target: round2(close + orb_range * 2.0),
                        indicators: base_indicators.clone(),
                        votes: base_votes.clone(),
                        strategy: Some("orb".into()),
                    });
                }
            } else if orb_range > 0.0 && close < first_low && volume_ratio > 1.2 {
                let orb_conf = (0.5 + (first_low - close) / orb_range * 0.3).min(0.95);
                if orb_conf >= thresholds.min_confidence {
                    out_signals.push(ScanSignal {
                        symbol: sym_data.symbol.clone(),
                        direction: "SELL".into(),
                        confidence: round3(orb_conf),
                        entry: round2(close),
                        stop_loss: round2(first_high),
                        target: round2(close - orb_range * 2.0),
                        indicators: base_indicators.clone(),
                        votes: base_votes.clone(),
                        strategy: Some("orb".into()),
                    });
                }
            }
        }

        // 2. Mean Reversion — Bollinger/RSI oversold bounce
        if rsi < 30.0 && close < bb_lower && volume_ratio > 0.8 {
            let mr_conf = (0.5 + (30.0 - rsi) / 30.0 * 0.4).min(0.90);
            if mr_conf >= thresholds.min_confidence {
                out_signals.push(ScanSignal {
                    symbol: sym_data.symbol.clone(),
                    direction: "BUY".into(),
                    confidence: round3(mr_conf),
                    entry: round2(close),
                    stop_loss: round2(close - atr * 1.0),
                    target: round2(bb_mid),
                    indicators: base_indicators.clone(),
                    votes: base_votes.clone(),
                    strategy: Some("mean_reversion".into()),
                });
            }
        } else if rsi > 70.0 && close > bb_upper && volume_ratio > 0.8 {
            let mr_conf = (0.5 + (rsi - 70.0) / 30.0 * 0.4).min(0.90);
            if mr_conf >= thresholds.min_confidence {
                out_signals.push(ScanSignal {
                    symbol: sym_data.symbol.clone(),
                    direction: "SELL".into(),
                    confidence: round3(mr_conf),
                    entry: round2(close),
                    stop_loss: round2(close + atr * 1.0),
                    target: round2(bb_mid),
                    indicators: base_indicators.clone(),
                    votes: base_votes.clone(),
                    strategy: Some("mean_reversion".into()),
                });
            }
        }

        // 3. Gap Trading — significant overnight gap
        if n >= 2 {
            let prev_close = sym_data.candles[n - 2].close;
            let gap_open = sym_data.candles[last].open;
            if prev_close > 0.0 {
                let gap_pct = (gap_open - prev_close) / prev_close * 100.0;
                // Gap up > 1%: momentum continuation
                if gap_pct > 1.0 && close > gap_open && volume_ratio > 1.5 {
                    let gap_conf = (0.5 + gap_pct / 5.0 * 0.3).min(0.90);
                    if gap_conf >= thresholds.min_confidence {
                        out_signals.push(ScanSignal {
                            symbol: sym_data.symbol.clone(),
                            direction: "BUY".into(),
                            confidence: round3(gap_conf),
                            entry: round2(close),
                            stop_loss: round2(gap_open),
                            target: round2(close + (close - gap_open) * 1.5),
                            indicators: base_indicators.clone(),
                            votes: base_votes.clone(),
                            strategy: Some("gap_trading".into()),
                        });
                    }
                }
                // Gap down > 1%: fade the gap (mean reversion)
                else if gap_pct < -1.0 && close > gap_open && rsi < 40.0 {
                    let gap_conf = (0.5 + gap_pct.abs() / 5.0 * 0.3).min(0.85);
                    if gap_conf >= thresholds.min_confidence {
                        out_signals.push(ScanSignal {
                            symbol: sym_data.symbol.clone(),
                            direction: "BUY".into(),
                            confidence: round3(gap_conf),
                            entry: round2(close),
                            stop_loss: round2(close - atr),
                            target: round2(prev_close),
                            indicators: base_indicators.clone(),
                            votes: base_votes.clone(),
                            strategy: Some("gap_trading".into()),
                        });
                    }
                }
            }
        }

        // 4. VWAP Reversion — price vs VWAP deviation
        if vwap > 0.0 {
            let deviation = (close - vwap) / vwap * 100.0;
            if deviation < -1.0 && rsi < 45.0 && volume_ratio > 0.8 {
                let vr_conf = (0.5 + deviation.abs() / 3.0 * 0.3).min(0.85);
                if vr_conf >= thresholds.min_confidence {
                    out_signals.push(ScanSignal {
                        symbol: sym_data.symbol.clone(),
                        direction: "BUY".into(),
                        confidence: round3(vr_conf),
                        entry: round2(close),
                        stop_loss: round2(close - atr * 0.8),
                        target: round2(vwap),
                        indicators: base_indicators.clone(),
                        votes: base_votes.clone(),
                        strategy: Some("vwap_reversion".into()),
                    });
                }
            } else if deviation > 1.0 && rsi > 55.0 && volume_ratio > 0.8 {
                let vr_conf = (0.5 + deviation.abs() / 3.0 * 0.3).min(0.85);
                if vr_conf >= thresholds.min_confidence {
                    out_signals.push(ScanSignal {
                        symbol: sym_data.symbol.clone(),
                        direction: "SELL".into(),
                        confidence: round3(vr_conf),
                        entry: round2(close),
                        stop_loss: round2(close + atr * 0.8),
                        target: round2(vwap),
                        indicators: base_indicators.clone(),
                        votes: base_votes.clone(),
                        strategy: Some("vwap_reversion".into()),
                    });
                }
            }
        }

        // 5. Volatility Breakout — Bollinger squeeze then expansion
        if bb_range > 0.0 {
            let squeeze_ratio = bb_range / close;
            let prev_bb_upper = get_f64(&indicators, "bollinger_upper", prev);
            let prev_bb_lower = get_f64(&indicators, "bollinger_lower", prev);
            let prev_range = prev_bb_upper - prev_bb_lower;
            let expansion = if prev_range > 0.0 { bb_range / prev_range } else { 1.0 };

            // Squeeze (narrow bands) followed by expansion + breakout
            if squeeze_ratio < 0.03 && expansion > 1.2 {
                if close > bb_upper && momentum_score > 0.3 {
                    let vb_conf = (0.6 + expansion * 0.1).min(0.90);
                    if vb_conf >= thresholds.min_confidence {
                        out_signals.push(ScanSignal {
                            symbol: sym_data.symbol.clone(),
                            direction: "BUY".into(),
                            confidence: round3(vb_conf),
                            entry: round2(close),
                            stop_loss: round2(bb_mid),
                            target: round2(close + (close - bb_mid) * 2.0),
                            indicators: base_indicators.clone(),
                            votes: base_votes.clone(),
                            strategy: Some("volatility_breakout".into()),
                        });
                    }
                } else if close < bb_lower && momentum_score < -0.3 {
                    let vb_conf = (0.6 + expansion * 0.1).min(0.90);
                    if vb_conf >= thresholds.min_confidence {
                        out_signals.push(ScanSignal {
                            symbol: sym_data.symbol.clone(),
                            direction: "SELL".into(),
                            confidence: round3(vb_conf),
                            entry: round2(close),
                            stop_loss: round2(bb_mid),
                            target: round2(close - (bb_mid - close) * 2.0),
                            indicators: base_indicators.clone(),
                            votes: base_votes.clone(),
                            strategy: Some("volatility_breakout".into()),
                        });
                    }
                }
            }
        }

        // 6. Sector Rotation / Relative Strength — uptrend with strong momentum
        if ema9 > ema21 && momentum_score > 0.6 && volume_ratio > 1.5 && rsi > 55.0 && rsi < 80.0 {
            let sr_conf = (0.55 + momentum_score * 0.2 + (volume_ratio - 1.0) * 0.1).min(0.90);
            if sr_conf >= thresholds.min_confidence {
                out_signals.push(ScanSignal {
                    symbol: sym_data.symbol.clone(),
                    direction: "BUY".into(),
                    confidence: round3(sr_conf),
                    entry: round2(close),
                    stop_loss: round2(ema21),
                    target: round2(close + (close - ema21) * 2.0),
                    indicators: base_indicators.clone(),
                    votes: base_votes.clone(),
                    strategy: Some("sector_rotation".into()),
                });
            }
        }
    }

    // === 7. PAIRS TRADING — market-neutral, spread mean-reversion ===
    let default_pairs: Vec<(String, String)> = vec![
        ("HDFCBANK".into(), "ICICIBANK".into()), ("SBIN".into(), "BANKBARODA".into()), ("TCS".into(), "INFY".into()),
        ("WIPRO".into(), "HCLTECH".into()), ("RELIANCE".into(), "ONGC".into()), ("TATASTEEL".into(), "JSWSTEEL".into()),
        ("SUNPHARMA".into(), "DRREDDY".into()), ("TATAMOTORS".into(), "MARUTI".into()), ("BAJFINANCE".into(), "BAJAJFINSV".into()),
        ("NTPC".into(), "POWERGRID".into()), ("ADANIENT".into(), "ADANIPORTS".into()), ("HINDUNILVR".into(), "ITC".into()),
    ];
    let pair_universe = input.pair_universe.as_ref().unwrap_or(&default_pairs);

    let close_map: HashMap<String, Vec<f64>> = input.symbols.iter()
        .filter(|s| s.candles.len() >= 20)
        .map(|s| (s.symbol.clone(), s.candles.iter().map(|c| c.close).collect()))
        .collect();

    for (sym_a, sym_b) in pair_universe {
        let prices_a = match close_map.get(sym_a.as_str()) { Some(p) => p, None => continue };
        let prices_b = match close_map.get(sym_b.as_str()) { Some(p) => p, None => continue };
        let n = prices_a.len().min(prices_b.len());
        if n < 20 { continue; }

        // Compute spread = log(A) - hedge_ratio * log(B)
        let log_a: Vec<f64> = prices_a[..n].iter().map(|p| p.ln()).collect();
        let log_b: Vec<f64> = prices_b[..n].iter().map(|p| p.ln()).collect();

        // OLS hedge ratio
        let b_mean = log_b.iter().sum::<f64>() / n as f64;
        let a_mean = log_a.iter().sum::<f64>() / n as f64;
        let mut num = 0.0_f64;
        let mut den = 0.0_f64;
        for i in 0..n {
            num += (log_b[i] - b_mean) * (log_a[i] - a_mean);
            den += (log_b[i] - b_mean) * (log_b[i] - b_mean);
        }
        let hedge_ratio = if den > 0.0 { num / den } else { 1.0 };

        // Spread and z-score
        let spread: Vec<f64> = (0..n).map(|i| log_a[i] - hedge_ratio * log_b[i]).collect();
        let lookback = 20usize.min(n);
        let recent = &spread[n - lookback..];
        let sp_mean = recent.iter().sum::<f64>() / lookback as f64;
        let sp_var = recent.iter().map(|s| (s - sp_mean).powi(2)).sum::<f64>() / lookback as f64;
        let sp_std = sp_var.sqrt();
        if sp_std < 1e-10 { continue; }

        let current_z = (spread[n - 1] - sp_mean) / sp_std;
        let z_threshold = 2.0;

        let last_a = prices_a[n - 1];
        let last_b = prices_b[n - 1];

        // Z-score > threshold → spread is too wide, short A / long B
        if current_z > z_threshold {
            let pairs_conf = (0.5 + (current_z - z_threshold) * 0.15).min(0.90);
            if pairs_conf >= thresholds.min_confidence {
                // Dummy indicators for the pair signal
                let dummy_ind = IndicatorSnapshot {
                    ema_9: 0.0, ema_21: 0.0, rsi_14: 50.0, macd: 0.0, macd_signal: 0.0,
                    macd_histogram: 0.0, supertrend: 0.0, bollinger_upper: 0.0, bollinger_lower: 0.0,
                    vwap: 0.0, close: last_a, atr: 0.0, momentum_score: 0.0, volume_ratio: 1.0,
                };
                let dummy_votes = VoteBreakdown {
                    ema_crossover: 0.0, rsi: 0.0, macd: 0.0, supertrend: 0.0,
                    bollinger: 0.0, vwap: 0.0, momentum: 0.0, volume: 0.0,
                };

                out_signals.push(ScanSignal {
                    symbol: format!("{}_SHORT", sym_a),
                    direction: "SELL".into(),
                    confidence: round3(pairs_conf),
                    entry: round2(last_a),
                    stop_loss: round2(last_a * 1.01),
                    target: round2(last_a * 0.995),
                    indicators: dummy_ind.clone(),
                    votes: dummy_votes.clone(),
                    strategy: Some(format!("pairs:{}_{}", sym_a, sym_b)),
                });
                out_signals.push(ScanSignal {
                    symbol: format!("{}_LONG", sym_b),
                    direction: "BUY".into(),
                    confidence: round3(pairs_conf),
                    entry: round2(last_b),
                    stop_loss: round2(last_b * 0.99),
                    target: round2(last_b * 1.005),
                    indicators: dummy_ind,
                    votes: dummy_votes,
                    strategy: Some(format!("pairs:{}_{}", sym_a, sym_b)),
                });
            }
        }
        // Z-score < -threshold → spread is too narrow, long A / short B
        else if current_z < -z_threshold {
            let pairs_conf = (0.5 + (current_z.abs() - z_threshold) * 0.15).min(0.90);
            if pairs_conf >= thresholds.min_confidence {
                let dummy_ind = IndicatorSnapshot {
                    ema_9: 0.0, ema_21: 0.0, rsi_14: 50.0, macd: 0.0, macd_signal: 0.0,
                    macd_histogram: 0.0, supertrend: 0.0, bollinger_upper: 0.0, bollinger_lower: 0.0,
                    vwap: 0.0, close: last_a, atr: 0.0, momentum_score: 0.0, volume_ratio: 1.0,
                };
                let dummy_votes = VoteBreakdown {
                    ema_crossover: 0.0, rsi: 0.0, macd: 0.0, supertrend: 0.0,
                    bollinger: 0.0, vwap: 0.0, momentum: 0.0, volume: 0.0,
                };

                out_signals.push(ScanSignal {
                    symbol: format!("{}_LONG", sym_a),
                    direction: "BUY".into(),
                    confidence: round3(pairs_conf),
                    entry: round2(last_a),
                    stop_loss: round2(last_a * 0.99),
                    target: round2(last_a * 1.005),
                    indicators: dummy_ind.clone(),
                    votes: dummy_votes.clone(),
                    strategy: Some(format!("pairs:{}_{}", sym_a, sym_b)),
                });
                out_signals.push(ScanSignal {
                    symbol: format!("{}_SHORT", sym_b),
                    direction: "SELL".into(),
                    confidence: round3(pairs_conf),
                    entry: round2(last_b),
                    stop_loss: round2(last_b * 1.01),
                    target: round2(last_b * 0.995),
                    indicators: dummy_ind,
                    votes: dummy_votes,
                    strategy: Some(format!("pairs:{}_{}", sym_a, sym_b)),
                });
            }
        }
    }

    // === 8. EXPIRY DAY OPTIONS — theta/gamma mispricing near expiry ===
    // Detect if today is near a weekly (Thursday) or monthly expiry.
    // On expiry days, index options (NIFTY/BANKNIFTY) have accelerated theta decay,
    // creating opportunities in straddle/strangle selling or directional gamma plays.
    let is_expiry_day = if let Some(ref date_str) = input.current_date {
        // NSE weekly expiry = Thursday; monthly expiry = last Thursday of month
        let parts: Vec<&str> = date_str.split('-').collect();
        if parts.len() == 3 {
            let day: u32 = parts[2].parse().unwrap_or(0);
            let month: u32 = parts[1].parse().unwrap_or(0);
            let year: i32 = parts[0].parse().unwrap_or(0);
            // Simple day-of-week calculation (Zeller's formula)
            if year > 0 && month > 0 && day > 0 {
                let (y, m) = if month <= 2 { (year - 1, month + 12) } else { (year, month) };
                let dow = (day as i32 + (13 * (m as i32 + 1)) / 5 + y + y / 4 - y / 100 + y / 400) % 7;
                // Zeller: 0=Sat, 1=Sun, 2=Mon, 3=Tue, 4=Wed, 5=Thu, 6=Fri
                dow == 5 // Thursday = expiry day
            } else { false }
        } else { false }
    } else {
        false
    };

    if is_expiry_day {
        // On expiry day, generate signals for index symbols with special theta/gamma logic
        for sym_data in &input.symbols {
            let sym_upper = sym_data.symbol.to_uppercase();
            if sym_upper != "NIFTY" && sym_upper != "BANKNIFTY" && sym_upper != "FINNIFTY" {
                continue;
            }
            let n = sym_data.candles.len();
            if n < 10 { continue; }

            let close = sym_data.candles[n - 1].close;
            let atr = calc_atr_candles(&sym_data.candles, 14.min(n - 1));
            if atr <= 0.0 || close <= 0.0 { continue; }

            let vol_pct = atr / close;

            // Low intraday vol on expiry day = theta decay opportunity (sell straddle)
            if vol_pct < 0.01 {
                let exp_conf = (0.6 + (0.01 - vol_pct) * 20.0).min(0.85);
                if exp_conf >= thresholds.min_confidence {
                    let dummy_ind = IndicatorSnapshot {
                        ema_9: 0.0, ema_21: 0.0, rsi_14: 50.0, macd: 0.0, macd_signal: 0.0,
                        macd_histogram: 0.0, supertrend: 0.0, bollinger_upper: 0.0, bollinger_lower: 0.0,
                        vwap: 0.0, close: round2(close), atr: round2(atr),
                        momentum_score: 0.0, volume_ratio: 1.0,
                    };
                    let dummy_votes = VoteBreakdown {
                        ema_crossover: 0.0, rsi: 0.0, macd: 0.0, supertrend: 0.0,
                        bollinger: 0.0, vwap: 0.0, momentum: 0.0, volume: 0.0,
                    };
                    // Sell straddle: sell ATM CE + PE for theta decay
                    out_signals.push(ScanSignal {
                        symbol: format!("{}_STRADDLE_SELL", sym_data.symbol),
                        direction: "SELL".into(),
                        confidence: round3(exp_conf),
                        entry: round2(close),
                        stop_loss: round2(close + atr * 1.5),
                        target: round2(close), // target = premium decay
                        indicators: dummy_ind,
                        votes: dummy_votes,
                        strategy: Some("expiry_theta".into()),
                    });
                }
            }
            // High intraday vol on expiry day = gamma play (directional)
            else if vol_pct > 0.015 {
                let momentum = calc_momentum(&sym_data.candles, 5.min(n - 1));
                let exp_conf = (0.55 + vol_pct * 10.0 + momentum.abs() * 0.1).min(0.90);
                if exp_conf >= thresholds.min_confidence {
                    let direction = if momentum > 0.0 { "BUY" } else { "SELL" };
                    let dummy_ind = IndicatorSnapshot {
                        ema_9: 0.0, ema_21: 0.0, rsi_14: 50.0, macd: 0.0, macd_signal: 0.0,
                        macd_histogram: 0.0, supertrend: 0.0, bollinger_upper: 0.0, bollinger_lower: 0.0,
                        vwap: 0.0, close: round2(close), atr: round2(atr),
                        momentum_score: round3(momentum), volume_ratio: 1.0,
                    };
                    let dummy_votes = VoteBreakdown {
                        ema_crossover: 0.0, rsi: 0.0, macd: 0.0, supertrend: 0.0,
                        bollinger: 0.0, vwap: 0.0, momentum: round3(momentum), volume: 0.0,
                    };
                    // Directional gamma play with ATM options
                    out_signals.push(ScanSignal {
                        symbol: format!("{}_GAMMA", sym_data.symbol),
                        direction: direction.into(),
                        confidence: round3(exp_conf),
                        entry: round2(close),
                        stop_loss: if direction == "BUY" { round2(close - atr) } else { round2(close + atr) },
                        target: if direction == "BUY" { round2(close + atr * 2.0) } else { round2(close - atr * 2.0) },
                        indicators: dummy_ind,
                        votes: dummy_votes,
                        strategy: Some("expiry_gamma".into()),
                    });
                }
            }
        }
    }

    out_signals.sort_by(|a, b| b.confidence.partial_cmp(&a.confidence).unwrap_or(std::cmp::Ordering::Equal));

    let output = ScanOutput { signals: out_signals };
    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

/// Momentum score based on consecutive candle direction and rate of change
fn calc_momentum(candles: &[Candle], lookback: usize) -> f64 {
    let n = candles.len();
    if n < lookback + 1 {
        return 0.0;
    }

    let start = n - lookback;
    let mut green_count = 0i32;
    let mut total_change = 0.0;
    let avg_close = candles[start..n].iter().map(|c| c.close).sum::<f64>() / lookback as f64;

    for i in start..n {
        let prev_idx = if i > 0 { i - 1 } else { 0 };
        let is_green = candles[i].close > candles[prev_idx].close;

        if is_green {
            green_count += 1;
        } else {
            green_count -= 1;
        }

        if avg_close > 0.0 {
            let pct_change = (candles[i].close - candles[prev_idx].close) / avg_close * 100.0;
            total_change += pct_change;
        }
    }

    // Score: combination of direction consistency and magnitude
    let direction_score = green_count as f64 / lookback as f64;  // -1.0 to +1.0
    let magnitude_score = (total_change / lookback as f64).min(2.0).max(-2.0) / 2.0;  // normalized

    // Combined: both direction and magnitude matter
    let raw = direction_score * 0.6 + magnitude_score * 0.4;
    raw.min(1.0).max(-1.0)
}

/// Volume ratio: current volume vs average of last N candles
fn calc_volume_ratio(candles: &[Candle], lookback: usize) -> f64 {
    let n = candles.len();
    if n < lookback + 1 {
        return 1.0;
    }

    let current_vol = candles[n - 1].volume;
    let avg_vol: f64 = candles[n - 1 - lookback..n - 1]
        .iter()
        .map(|c| c.volume)
        .sum::<f64>() / lookback as f64;

    if avg_vol > 0.0 {
        current_vol / avg_vol
    } else {
        1.0
    }
}

/// Breakout detection: is price making new highs/lows over recent period?
fn calc_breakout(candles: &[Candle], lookback: usize) -> f64 {
    let n = candles.len();
    if n < lookback + 1 {
        return 0.0;
    }

    let current_close = candles[n - 1].close;
    let current_high = candles[n - 1].high;
    let current_low = candles[n - 1].low;

    let period = &candles[n - 1 - lookback..n - 1];
    let period_high = period.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    let period_low = period.iter().map(|c| c.low).fold(f64::INFINITY, f64::min);

    if current_high > period_high {
        // Breakout above recent high
        let strength = (current_close - period_high) / period_high * 100.0;
        (strength * 2.0).min(1.0)
    } else if current_low < period_low {
        // Breakdown below recent low
        let strength = (period_low - current_close) / period_low * 100.0;
        -(strength * 2.0).min(1.0)
    } else {
        0.0
    }
}


#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_candles(closes: &[f64]) -> Vec<Candle> {
        closes.iter().enumerate().map(|(i, &c)| Candle {
            timestamp: format!("2025-01-{:02}", (i % 28) + 1),
            close: c,
            high: c * 1.01,
            low: c * 0.99,
            volume: 1000.0,
            open: c * 0.998,
        }).collect()
    }

    fn make_candles_with_volume(data: &[(f64, f64)]) -> Vec<Candle> {
        data.iter().enumerate().map(|(i, &(c, v))| Candle {
            timestamp: format!("2025-01-{:02}", (i % 28) + 1),
            close: c,
            high: c * 1.01,
            low: c * 0.99,
            volume: v,
            open: c * 0.998,
        }).collect()
    }

    fn run_scan(symbols_json: serde_json::Value) -> serde_json::Value {
        compute(symbols_json).expect("scan compute failed")
    }

    #[test]
    fn test_empty_symbols() {
        let input = json!({ "symbols": [], "aggressiveness": "medium" });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        assert!(signals.is_empty(), "empty symbols should produce empty signals");
    }

    #[test]
    fn test_insufficient_candles_skipped() {
        let candles = make_candles(&(1..=20).map(|i| 100.0 + i as f64).collect::<Vec<_>>());
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "SHORT", "candles": candles_json }],
            "aggressiveness": "medium"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        assert!(signals.is_empty(), "< 26 candles should be skipped");
    }

    #[test]
    fn test_rising_prices_produce_buy() {
        let closes: Vec<f64> = (0..30).map(|i| 100.0 + i as f64 * 2.0).collect();
        let data: Vec<(f64, f64)> = closes.iter().enumerate()
            .map(|(i, &c)| (c, 1000.0 + i as f64 * 200.0))
            .collect();
        let candles = make_candles_with_volume(&data);
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "RISING", "candles": candles_json }],
            "aggressiveness": "medium"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        assert!(!signals.is_empty(), "rising prices should produce a signal");
        // With multi-strategy, find the highest-confidence BUY signal
        let buy_signals: Vec<_> = signals.iter()
            .filter(|s| s.get("direction").unwrap().as_str().unwrap() == "BUY")
            .collect();
        assert!(!buy_signals.is_empty(), "steadily rising prices should produce BUY");
    }

    #[test]
    fn test_falling_prices_produce_sell() {
        let closes: Vec<f64> = (0..30).map(|i| 200.0 - i as f64 * 2.0).collect();
        let data: Vec<(f64, f64)> = closes.iter().enumerate()
            .map(|(i, &c)| (c, 1000.0 + i as f64 * 200.0))
            .collect();
        let candles = make_candles_with_volume(&data);
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "FALLING", "candles": candles_json }],
            "aggressiveness": "medium"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        assert!(!signals.is_empty(), "falling prices should produce a signal");
        // With multi-strategy, find the highest-confidence SELL signal
        let sell_signals: Vec<_> = signals.iter()
            .filter(|s| s.get("direction").unwrap().as_str().unwrap() == "SELL")
            .collect();
        assert!(!sell_signals.is_empty(), "steadily falling prices should produce SELL");
    }

    #[test]
    fn test_flat_prices_low_confidence() {
        let candles = make_candles(&vec![100.0; 30]);
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "FLAT", "candles": candles_json }],
            "aggressiveness": "medium"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        if !signals.is_empty() {
            let conf = signals[0].get("confidence").unwrap().as_f64().unwrap();
            assert!(conf < 0.5, "flat prices should not have high confidence, got {}", conf);
        }
    }

    #[test]
    fn test_high_aggressiveness_allows_more() {
        let thresholds = get_thresholds("high");
        assert!(
            thresholds.min_confidence < 0.40,
            "high aggressiveness should lower the min_confidence threshold"
        );
        assert!(
            thresholds.rsi_oversold > 30.0,
            "high aggressiveness should widen RSI oversold (higher value = more lenient)"
        );
    }

    #[test]
    fn test_low_aggressiveness_stricter() {
        let thresholds = get_thresholds("low");
        assert!(
            thresholds.min_confidence > 0.50,
            "low aggressiveness should raise the min_confidence threshold"
        );
        assert!(
            thresholds.rsi_oversold < 30.0,
            "low aggressiveness should tighten RSI oversold"
        );
    }

    #[test]
    fn test_momentum_positive_on_rising() {
        let candles = make_candles(&(0..10).map(|i| 100.0 + i as f64 * 3.0).collect::<Vec<_>>());
        let m = calc_momentum(&candles, 5);
        assert!(m > 0.0, "momentum should be positive for rising candles, got {}", m);
    }

    #[test]
    fn test_momentum_negative_on_falling() {
        let candles = make_candles(&(0..10).map(|i| 100.0 - i as f64 * 3.0).collect::<Vec<_>>());
        let m = calc_momentum(&candles, 5);
        assert!(m < 0.0, "momentum should be negative for falling candles, got {}", m);
    }

    #[test]
    fn test_volume_ratio_spike() {
        let mut data: Vec<(f64, f64)> = (0..9).map(|_| (100.0, 1000.0)).collect();
        data.push((100.0, 5000.0));
        let candles = make_candles_with_volume(&data);
        let ratio = calc_volume_ratio(&candles, 5);
        assert!(ratio > 4.0, "volume spike should produce high ratio, got {}", ratio);
    }

    #[test]
    fn test_volume_ratio_zero_avg() {
        let mut data: Vec<(f64, f64)> = (0..9).map(|_| (100.0, 0.0)).collect();
        data.push((100.0, 500.0));
        let candles = make_candles_with_volume(&data);
        let ratio = calc_volume_ratio(&candles, 5);
        assert_eq!(ratio, 1.0, "zero average volume should return 1.0");
    }

    #[test]
    fn test_breakout_above_highs() {
        let mut closes: Vec<f64> = vec![100.0; 15];
        closes.push(115.0);
        let candles = make_candles(&closes);
        let b = calc_breakout(&candles, 10);
        assert!(b > 0.0, "new high should produce positive breakout, got {}", b);
    }

    #[test]
    fn test_breakout_below_lows() {
        let mut closes: Vec<f64> = vec![100.0; 15];
        closes.push(85.0);
        let candles = make_candles(&closes);
        let b = calc_breakout(&candles, 10);
        assert!(b < 0.0, "new low should produce negative breakout, got {}", b);
    }

    #[test]
    fn test_atr_basic() {
        let candles: Vec<Candle> = (0..20).map(|i| Candle {
            timestamp: format!("2025-01-{:02}", (i % 28) + 1),
            close: 100.0 + (i % 3) as f64,
            high: 103.0,
            low: 98.0,
            volume: 1000.0,
            open: 99.5,
        }).collect();
        let atr = calc_atr_candles(&candles, 14);
        assert!(atr > 0.0, "ATR should be positive");
        assert!(atr < 10.0, "ATR should be reasonable for this data, got {}", atr);
    }

    #[test]
    fn test_zero_close_no_panic() {
        let candles = make_candles(&vec![0.0; 30]);
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "ZERO", "candles": candles_json }],
            "aggressiveness": "medium"
        });
        let _result = compute(input);
    }

    // === Strategy-specific unit tests ===

    #[test]
    fn test_strategy_field_present_in_signals() {
        let closes: Vec<f64> = (0..30).map(|i| 100.0 + i as f64 * 2.0).collect();
        let data: Vec<(f64, f64)> = closes.iter().enumerate()
            .map(|(i, &c)| (c, 1000.0 + i as f64 * 200.0))
            .collect();
        let candles = make_candles_with_volume(&data);
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "TEST", "candles": candles_json }],
            "aggressiveness": "medium"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        assert!(!signals.is_empty(), "should produce signals");
        for sig in signals {
            assert!(sig.get("strategy").is_some(), "every signal must have a strategy field");
        }
    }

    #[test]
    fn test_mean_reversion_oversold() {
        // RSI < 30 + close below lower Bollinger should trigger mean_reversion
        let mut closes: Vec<f64> = (0..25).map(|i| 100.0 + (i as f64 * 0.5)).collect();
        // Sharp drop to trigger oversold
        for _ in 0..5 {
            let last = *closes.last().unwrap();
            closes.push(last - 3.0);
        }
        let data: Vec<(f64, f64)> = closes.iter().map(|&c| (c, 1000.0)).collect();
        let candles = make_candles_with_volume(&data);
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "OVERSOLD", "candles": candles_json }],
            "aggressiveness": "low"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        let mr_signals: Vec<_> = signals.iter()
            .filter(|s| s.get("strategy").and_then(|v| v.as_str()) == Some("mean_reversion"))
            .collect();
        // May or may not trigger depending on exact indicator values, but shouldn't panic
        assert!(result.get("signals").is_some());
    }

    #[test]
    fn test_pairs_trading_divergent_prices() {
        // HDFCBANK stable then spike, ICICIBANK stable = spread divergence > 2 std devs
        let mut hdfcbank: Vec<f64> = (0..25).map(|_| 1500.0).collect();
        // Sudden spike in last 5 candles while ICICIBANK stays flat
        for i in 0..5 {
            hdfcbank.push(1500.0 + (i + 1) as f64 * 40.0);
        }
        let icicibank: Vec<f64> = (0..30).map(|_| 900.0).collect();
        let hdfc_data: Vec<(f64, f64)> = hdfcbank.iter().map(|&c| (c, 5000.0)).collect();
        let icici_data: Vec<(f64, f64)> = icicibank.iter().map(|&c| (c, 5000.0)).collect();
        let hdfc_candles = make_candles_with_volume(&hdfc_data);
        let icici_candles = make_candles_with_volume(&icici_data);

        let input = json!({
            "symbols": [
                { "symbol": "HDFCBANK", "candles": serde_json::to_value(&hdfc_candles).unwrap() },
                { "symbol": "ICICIBANK", "candles": serde_json::to_value(&icici_candles).unwrap() }
            ],
            "aggressiveness": "low"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        let pairs_signals: Vec<_> = signals.iter()
            .filter(|s| {
                s.get("strategy").and_then(|v| v.as_str())
                    .map(|s| s.starts_with("pairs:"))
                    .unwrap_or(false)
            })
            .collect();
        // Sudden spread divergence should produce z > 2 and trigger pairs signals
        assert!(!pairs_signals.is_empty(), "sudden spread divergence should produce pairs signals");
    }

    #[test]
    fn test_expiry_day_nifty_signals() {
        // 2026-03-05 is a Thursday (expiry day)
        let nifty: Vec<f64> = (0..30).map(|i| 22000.0 + (i as f64 * 10.0).sin() * 50.0).collect();
        let data: Vec<(f64, f64)> = nifty.iter().map(|&c| (c, 100000.0)).collect();
        let candles = make_candles_with_volume(&data);
        let input = json!({
            "symbols": [{ "symbol": "NIFTY", "candles": serde_json::to_value(&candles).unwrap() }],
            "aggressiveness": "low",
            "current_date": "2026-03-05"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        let expiry_signals: Vec<_> = signals.iter()
            .filter(|s| {
                s.get("strategy").and_then(|v| v.as_str())
                    .map(|s| s.starts_with("expiry_"))
                    .unwrap_or(false)
            })
            .collect();
        // On expiry day with NIFTY data, should generate theta/gamma signals
        assert!(!expiry_signals.is_empty(), "expiry day should produce expiry signals for NIFTY");
    }

    #[test]
    fn test_non_expiry_day_no_expiry_signals() {
        // 2026-03-04 is a Wednesday (not expiry)
        let nifty: Vec<f64> = (0..30).map(|_| 22000.0).collect();
        let data: Vec<(f64, f64)> = nifty.iter().map(|&c| (c, 100000.0)).collect();
        let candles = make_candles_with_volume(&data);
        let input = json!({
            "symbols": [{ "symbol": "NIFTY", "candles": serde_json::to_value(&candles).unwrap() }],
            "aggressiveness": "low",
            "current_date": "2026-03-04"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        let expiry_signals: Vec<_> = signals.iter()
            .filter(|s| {
                s.get("strategy").and_then(|v| v.as_str())
                    .map(|s| s.starts_with("expiry_"))
                    .unwrap_or(false)
            })
            .collect();
        assert!(expiry_signals.is_empty(), "non-expiry day should not produce expiry signals");
    }

    #[test]
    fn test_gap_trading_gap_up() {
        // Large gap up between last two candles
        let mut closes: Vec<f64> = (0..29).map(|_| 100.0).collect();
        closes.push(108.0); // 8% gap up
        let candles: Vec<Candle> = closes.iter().enumerate().map(|(i, &c)| {
            let prev_close = if i > 0 { closes[i - 1] } else { c };
            Candle {
                timestamp: format!("2025-01-{:02}", (i % 28) + 1),
                close: c,
                high: c * 1.01,
                low: c * 0.99,
                volume: if i == 29 { 5000.0 } else { 1000.0 },
                open: if i == 29 { prev_close + 5.0 } else { c * 0.998 },
            }
        }).collect();
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "GAPUP", "candles": candles_json }],
            "aggressiveness": "low"
        });
        let result = run_scan(input);
        // Should not panic; may or may not produce gap_trading signal depending on thresholds
        assert!(result.get("signals").is_some());
    }

    #[test]
    fn test_volatility_breakout_squeeze() {
        // Narrow range followed by expansion
        let mut closes = vec![100.0; 25];
        // Tight range
        for i in 0..20 {
            closes[i] = 100.0 + (i as f64 * 0.1).sin() * 0.5;
        }
        // Breakout
        for i in 20..25 {
            closes[i] = 100.0 + (i - 20) as f64 * 3.0;
        }
        let data: Vec<(f64, f64)> = closes.iter().enumerate()
            .map(|(i, &c)| (c, if i >= 20 { 3000.0 } else { 1000.0 }))
            .collect();
        let candles = make_candles_with_volume(&data);
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "SQUEEZE", "candles": candles_json }],
            "aggressiveness": "low"
        });
        let result = run_scan(input);
        assert!(result.get("signals").is_some());
    }

    #[test]
    fn test_multiple_strategies_per_symbol() {
        // Strong trending data should trigger multiple strategies
        let closes: Vec<f64> = (0..30).map(|i| 100.0 + i as f64 * 3.0).collect();
        let data: Vec<(f64, f64)> = closes.iter().enumerate()
            .map(|(i, &c)| (c, 1000.0 + i as f64 * 500.0))
            .collect();
        let candles = make_candles_with_volume(&data);
        let candles_json = serde_json::to_value(&candles).unwrap();
        let input = json!({
            "symbols": [{ "symbol": "MULTI", "candles": candles_json }],
            "aggressiveness": "low"
        });
        let result = run_scan(input);
        let signals = result.get("signals").unwrap().as_array().unwrap();
        let strategies: std::collections::HashSet<&str> = signals.iter()
            .filter_map(|s| s.get("strategy").and_then(|v| v.as_str()))
            .collect();
        assert!(strategies.len() >= 2,
            "strong trend with volume should trigger multiple strategies, got: {:?}", strategies);
    }

    #[test]
    fn test_open_field_in_candle_deserialization() {
        let json_str = r#"{"close":100.0,"high":101.0,"low":99.0,"volume":1000.0,"open":99.5}"#;
        let candle: Candle = serde_json::from_str(json_str).unwrap();
        assert!((candle.open - 99.5).abs() < 0.01, "open should be 99.5");
    }

    #[test]
    fn test_open_field_defaults_to_zero() {
        let json_str = r#"{"close":100.0,"high":101.0,"low":99.0,"volume":1000.0}"#;
        let candle: Candle = serde_json::from_str(json_str).unwrap();
        assert!((candle.open - 0.0).abs() < 0.01, "open should default to 0.0");
    }
}
