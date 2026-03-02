use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
struct BacktestConfig {
    strategy: String,
    symbol: String,
    initial_capital: f64,
    candles: Vec<Candle>,
    params: Option<Value>,
}

#[derive(Deserialize, Clone)]
struct Candle {
    timestamp: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

#[derive(Serialize)]
struct BacktestResult {
    cagr: f64,
    max_drawdown: f64,
    sharpe_ratio: f64,
    sortino_ratio: f64,
    win_rate: f64,
    profit_factor: f64,
    total_trades: usize,
    avg_win: f64,
    avg_loss: f64,
    equity_curve: Vec<EquityPoint>,
    trade_log: Vec<TradeEntry>,
}

#[derive(Serialize)]
struct EquityPoint {
    date: String,
    nav: f64,
}

#[derive(Serialize)]
struct TradeEntry {
    symbol: String,
    side: String,
    entry_price: f64,
    exit_price: f64,
    qty: i64,
    pnl: f64,
    entry_time: String,
    exit_time: String,
}

pub fn run(data: Value) -> Result<Value, String> {
    let config: BacktestConfig =
        serde_json::from_value(data).map_err(|e| format!("Invalid backtest config: {}", e))?;

    if config.candles.is_empty() {
        return Ok(serde_json::to_value(BacktestResult {
            cagr: 0.0, max_drawdown: 0.0, sharpe_ratio: 0.0, sortino_ratio: 0.0,
            win_rate: 0.0, profit_factor: 0.0, total_trades: 0,
            avg_win: 0.0, avg_loss: 0.0, equity_curve: vec![], trade_log: vec![],
        }).unwrap());
    }

    let mut nav = config.initial_capital;
    let mut peak = nav;
    let mut max_dd = 0.0_f64;
    let mut trades: Vec<TradeEntry> = Vec::new();
    let mut equity_curve: Vec<EquityPoint> = Vec::new();
    let mut position: Option<(f64, String)> = None;

    let closes: Vec<f64> = config.candles.iter().map(|c| c.close).collect();
    let highs: Vec<f64> = config.candles.iter().map(|c| c.high).collect();
    let lows: Vec<f64> = config.candles.iter().map(|c| c.low).collect();

    let params = config.params.clone().unwrap_or(serde_json::json!({}));
    let strat = config.strategy.as_str();

    // Precompute RSI for strategies that need it
    let rsi_vals = calc_rsi(&closes, 14);
    // Precompute SMAs for sma_crossover
    let sma_short_p = params.get("shortPeriod").and_then(|v| v.as_f64()).unwrap_or(10.0) as usize;
    let sma_long_p = params.get("longPeriod").and_then(|v| v.as_f64()).unwrap_or(30.0) as usize;
    let sma_short_vals = calc_sma(&closes, sma_short_p);
    let sma_long_vals = calc_sma(&closes, sma_long_p);
    // Mean reversion params
    let mr_period = params.get("period").and_then(|v| v.as_f64()).unwrap_or(20.0) as usize;
    let mr_threshold = params.get("threshold").and_then(|v| v.as_f64()).unwrap_or(2.0);
    let mr_sma = calc_sma(&closes, mr_period);
    // Momentum params
    let mom_lookback = params.get("lookback").and_then(|v| v.as_f64()).unwrap_or(20.0) as usize;
    let mom_hold = params.get("holdDays").and_then(|v| v.as_f64()).unwrap_or(10.0) as i64;
    let mut hold_counter: i64 = 0;
    // RSI reversal params
    let rsi_oversold = params.get("oversold").and_then(|v| v.as_f64()).unwrap_or(30.0);
    let rsi_overbought = params.get("overbought").and_then(|v| v.as_f64()).unwrap_or(70.0);
    // ORB params
    let orb_target_pct = params.get("target").and_then(|v| v.as_f64()).unwrap_or(1.5) / 100.0;
    let orb_sl_pct = params.get("stop_loss").and_then(|v| v.as_f64()).unwrap_or(0.75) / 100.0;
    // Track SHORT side for mean_reversion
    let mut short_position: Option<(f64, String)> = None;

    for (i, candle) in config.candles.iter().enumerate() {
        equity_curve.push(EquityPoint { date: candle.timestamp.clone(), nav });

        match strat {
            "ema-crossover" | "ema_crossover" | "supertrend" => {
                if i >= 21 {
                    let ema_short = ema(&config.candles[..=i], 9);
                    let ema_long = ema(&config.candles[..=i], 21);
                    if position.is_none() && ema_short > ema_long {
                        let qty = (nav * 0.1 / candle.close) as i64;
                        if qty > 0 { position = Some((candle.close, candle.timestamp.clone())); }
                    } else if let Some((entry_price, entry_time)) = &position {
                        if ema_short < ema_long {
                            let qty = (nav * 0.1 / entry_price) as i64;
                            let pnl = (candle.close - entry_price) * qty as f64;
                            nav += pnl;
                            trades.push(TradeEntry { symbol: config.symbol.clone(), side: "BUY".into(), entry_price: *entry_price, exit_price: candle.close, qty, pnl, entry_time: entry_time.clone(), exit_time: candle.timestamp.clone() });
                            position = None;
                        }
                    }
                }
            }
            "sma_crossover" | "sma-crossover" => {
                if i >= sma_long_p {
                    let s = sma_short_vals[i];
                    let l = sma_long_vals[i];
                    let ps = if i > 0 { sma_short_vals[i-1] } else { 0.0 };
                    let pl = if i > 0 { sma_long_vals[i-1] } else { 0.0 };
                    if s > 0.0 && l > 0.0 && ps > 0.0 && pl > 0.0 {
                        if position.is_none() && ps <= pl && s > l {
                            let qty = (nav * 0.2 / candle.close) as i64;
                            if qty > 0 { position = Some((candle.close, candle.timestamp.clone())); }
                        } else if position.is_some() && ps >= pl && s < l {
                            let (ep, et) = position.take().unwrap();
                            let qty = (nav * 0.2 / ep) as i64;
                            let pnl = (candle.close - ep) * qty as f64;
                            nav += pnl;
                            trades.push(TradeEntry { symbol: config.symbol.clone(), side: "BUY".into(), entry_price: ep, exit_price: candle.close, qty, pnl, entry_time: et, exit_time: candle.timestamp.clone() });
                        }
                    }
                }
            }
            "rsi_reversal" | "rsi-reversal" => {
                if i < rsi_vals.len() && rsi_vals[i] > 0.0 {
                    let r = rsi_vals[i];
                    if position.is_none() && r < rsi_oversold {
                        let qty = (nav * 0.15 / candle.close) as i64;
                        if qty > 0 { position = Some((candle.close, candle.timestamp.clone())); }
                    } else if position.is_some() && r > rsi_overbought {
                        let (ep, et) = position.take().unwrap();
                        let qty = (nav * 0.15 / ep) as i64;
                        let pnl = (candle.close - ep) * qty as f64;
                        nav += pnl;
                        trades.push(TradeEntry { symbol: config.symbol.clone(), side: "BUY".into(), entry_price: ep, exit_price: candle.close, qty, pnl, entry_time: et, exit_time: candle.timestamp.clone() });
                    }
                }
            }
            "mean_reversion" | "mean-reversion" => {
                if i >= mr_period && mr_sma[i] > 0.0 {
                    let avg = mr_sma[i];
                    let slice = &closes[i+1-mr_period..=i];
                    let mean = slice.iter().sum::<f64>() / slice.len() as f64;
                    let var = slice.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / slice.len() as f64;
                    let std = var.sqrt();
                    if std > 0.0 {
                        let z = (closes[i] - avg) / std;
                        if position.is_none() && short_position.is_none() {
                            if z < -mr_threshold {
                                let qty = (nav * 0.15 / candle.close) as i64;
                                if qty > 0 { position = Some((candle.close, candle.timestamp.clone())); }
                            } else if z > mr_threshold {
                                let qty = (nav * 0.15 / candle.close) as i64;
                                if qty > 0 { short_position = Some((candle.close, candle.timestamp.clone())); }
                            }
                        } else if position.is_some() && z >= 0.0 {
                            let (ep, et) = position.take().unwrap();
                            let qty = (nav * 0.15 / ep) as i64;
                            let pnl = (candle.close - ep) * qty as f64;
                            nav += pnl;
                            trades.push(TradeEntry { symbol: config.symbol.clone(), side: "BUY".into(), entry_price: ep, exit_price: candle.close, qty, pnl, entry_time: et, exit_time: candle.timestamp.clone() });
                        } else if short_position.is_some() && z <= 0.0 {
                            let (ep, et) = short_position.take().unwrap();
                            let qty = (nav * 0.15 / ep) as i64;
                            let pnl = (ep - candle.close) * qty as f64;
                            nav += pnl;
                            trades.push(TradeEntry { symbol: config.symbol.clone(), side: "SHORT".into(), entry_price: ep, exit_price: candle.close, qty, pnl, entry_time: et, exit_time: candle.timestamp.clone() });
                        }
                    }
                }
            }
            "momentum" => {
                if i >= mom_lookback {
                    if hold_counter > 0 {
                        hold_counter -= 1;
                        if hold_counter == 0 && position.is_some() {
                            let (ep, et) = position.take().unwrap();
                            let qty = (nav * 0.15 / ep) as i64;
                            let pnl = (candle.close - ep) * qty as f64;
                            nav += pnl;
                            trades.push(TradeEntry { symbol: config.symbol.clone(), side: "BUY".into(), entry_price: ep, exit_price: candle.close, qty, pnl, entry_time: et, exit_time: candle.timestamp.clone() });
                        }
                    } else if position.is_none() {
                        let past_ret = (closes[i] - closes[i - mom_lookback]) / closes[i - mom_lookback];
                        if past_ret > 0.05 {
                            let qty = (nav * 0.15 / candle.close) as i64;
                            if qty > 0 { position = Some((candle.close, candle.timestamp.clone())); hold_counter = mom_hold; }
                        }
                    }
                }
            }
            "orb" | "opening_range_breakout" => {
                if i >= 1 {
                    let prev_high = highs[i - 1];
                    let prev_low = lows[i - 1];
                    let range = prev_high - prev_low;
                    if range > 0.0 && range / closes[i - 1] < 0.05 {
                        if candle.high > prev_high {
                            let entry = prev_high;
                            let target = entry * (1.0 + orb_target_pct);
                            let sl = entry * (1.0 - orb_sl_pct);
                            let exit = if candle.high >= target { target } else if candle.low <= sl { sl } else { candle.close };
                            let qty = (nav * 0.1 / entry) as i64;
                            if qty > 0 {
                                let pnl = (exit - entry) * qty as f64;
                                nav += pnl;
                                trades.push(TradeEntry { symbol: config.symbol.clone(), side: "BUY".into(), entry_price: round2(entry), exit_price: round2(exit), qty, pnl: round2(pnl), entry_time: candle.timestamp.clone(), exit_time: candle.timestamp.clone() });
                            }
                        } else if candle.low < prev_low {
                            let entry = prev_low;
                            let target = entry * (1.0 - orb_target_pct);
                            let sl = entry * (1.0 + orb_sl_pct);
                            let exit = if candle.low <= target { target } else if candle.high >= sl { sl } else { candle.close };
                            let qty = (nav * 0.1 / entry) as i64;
                            if qty > 0 {
                                let pnl = (entry - exit) * qty as f64;
                                nav += pnl;
                                trades.push(TradeEntry { symbol: config.symbol.clone(), side: "SHORT".into(), entry_price: round2(entry), exit_price: round2(exit), qty, pnl: round2(pnl), entry_time: candle.timestamp.clone(), exit_time: candle.timestamp.clone() });
                            }
                        }
                    }
                }
            }
            _ => {
                // Default: EMA crossover
                if i >= 21 {
                    let ema_short = ema(&config.candles[..=i], 9);
                    let ema_long = ema(&config.candles[..=i], 21);
                    if position.is_none() && ema_short > ema_long {
                        let qty = (nav * 0.1 / candle.close) as i64;
                        if qty > 0 { position = Some((candle.close, candle.timestamp.clone())); }
                    } else if let Some((entry_price, entry_time)) = &position {
                        if ema_short < ema_long {
                            let qty = (nav * 0.1 / entry_price) as i64;
                            let pnl = (candle.close - entry_price) * qty as f64;
                            nav += pnl;
                            trades.push(TradeEntry { symbol: config.symbol.clone(), side: "BUY".into(), entry_price: *entry_price, exit_price: candle.close, qty, pnl, entry_time: entry_time.clone(), exit_time: candle.timestamp.clone() });
                            position = None;
                        }
                    }
                }
            }
        }

        if nav > peak { peak = nav; }
        let dd = (peak - nav) / peak;
        if dd > max_dd { max_dd = dd; }
    }

    let wins: Vec<f64> = trades.iter().filter(|t| t.pnl > 0.0).map(|t| t.pnl).collect();
    let losses: Vec<f64> = trades.iter().filter(|t| t.pnl < 0.0).map(|t| t.pnl.abs()).collect();

    let win_rate = if trades.is_empty() { 0.0 } else { wins.len() as f64 / trades.len() as f64 * 100.0 };
    let total_wins: f64 = wins.iter().sum();
    let total_losses: f64 = losses.iter().sum();
    let profit_factor = if total_losses > 0.0 { total_wins / total_losses } else { 0.0 };
    let avg_win = if wins.is_empty() { 0.0 } else { total_wins / wins.len() as f64 };
    let avg_loss = if losses.is_empty() { 0.0 } else { total_losses / losses.len() as f64 };

    let returns: Vec<f64> = trades.iter().map(|t| t.pnl / config.initial_capital).collect();
    let mean_ret = if returns.is_empty() { 0.0 } else { returns.iter().sum::<f64>() / returns.len() as f64 };
    let variance = if returns.len() < 2 { 0.0 } else {
        returns.iter().map(|r| (r - mean_ret).powi(2)).sum::<f64>() / returns.len() as f64
    };
    let std_dev = variance.sqrt();
    let sharpe = if std_dev > 0.0 { mean_ret / std_dev * (252.0_f64).sqrt() } else { 0.0 };

    let neg_returns: Vec<f64> = returns.iter().filter(|&&r| r < 0.0).copied().collect();
    let down_var = if neg_returns.is_empty() { 0.0 } else {
        neg_returns.iter().map(|r| r.powi(2)).sum::<f64>() / neg_returns.len() as f64
    };
    let sortino = if down_var > 0.0 { mean_ret / down_var.sqrt() * (252.0_f64).sqrt() } else { 0.0 };

    let total_return = (nav - config.initial_capital) / config.initial_capital;
    let years = config.candles.len() as f64 / 252.0;
    let cagr = if years > 0.0 { ((1.0 + total_return).powf(1.0 / years) - 1.0) * 100.0 } else { 0.0 };

    let result = BacktestResult {
        cagr: round2(cagr),
        max_drawdown: round2(max_dd * 100.0),
        sharpe_ratio: round2(sharpe),
        sortino_ratio: round2(sortino),
        win_rate: round2(win_rate),
        profit_factor: round2(profit_factor),
        total_trades: trades.len(),
        avg_win: round2(avg_win),
        avg_loss: round2(avg_loss),
        equity_curve,
        trade_log: trades,
    };

    serde_json::to_value(result).map_err(|e| format!("Serialization error: {}", e))
}

fn ema(candles: &[Candle], period: usize) -> f64 {
    if candles.len() < period { return 0.0; }
    let multiplier = 2.0 / (period as f64 + 1.0);
    let mut ema_val = candles[candles.len() - period].close;
    for candle in &candles[candles.len() - period + 1..] {
        ema_val = (candle.close - ema_val) * multiplier + ema_val;
    }
    ema_val
}

fn calc_sma(data: &[f64], period: usize) -> Vec<f64> {
    let mut result = vec![0.0; data.len()];
    for i in 0..data.len() {
        if i < period - 1 { continue; }
        let sum: f64 = data[i + 1 - period..=i].iter().sum();
        result[i] = sum / period as f64;
    }
    result
}

fn calc_rsi(closes: &[f64], period: usize) -> Vec<f64> {
    let mut result = vec![0.0; closes.len()];
    if closes.len() <= period { return result; }
    let mut avg_gain = 0.0;
    let mut avg_loss = 0.0;
    for i in 1..=period {
        let diff = closes[i] - closes[i - 1];
        if diff > 0.0 { avg_gain += diff; } else { avg_loss += diff.abs(); }
    }
    avg_gain /= period as f64;
    avg_loss /= period as f64;
    result[period] = if avg_loss == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + avg_gain / avg_loss) };
    for i in (period + 1)..closes.len() {
        let diff = closes[i] - closes[i - 1];
        let gain = if diff > 0.0 { diff } else { 0.0 };
        let loss = if diff < 0.0 { diff.abs() } else { 0.0 };
        avg_gain = (avg_gain * (period as f64 - 1.0) + gain) / period as f64;
        avg_loss = (avg_loss * (period as f64 - 1.0) + loss) / period as f64;
        result[i] = if avg_loss == 0.0 { 100.0 } else { 100.0 - 100.0 / (1.0 + avg_gain / avg_loss) };
    }
    result
}

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
