use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::utils::{round2, Candle, TransactionCosts, RiskLimits, calc_ema_last, calc_sma, calc_rsi_series};

#[derive(Deserialize)]
struct BacktestConfig {
    strategy: String,
    symbol: String,
    initial_capital: f64,
    candles: Vec<Candle>,
    params: Option<Value>,
    transaction_costs: Option<CostConfig>,
    risk_limits: Option<RiskLimitConfig>,
}

#[derive(Deserialize)]
struct CostConfig {
    commission: Option<f64>,
    slippage_bps: Option<f64>,
    stt_pct: Option<f64>,
}

#[derive(Deserialize)]
struct RiskLimitConfig {
    max_position_pct: Option<f64>,
    max_loss_pct: Option<f64>,
    max_drawdown_pct: Option<f64>,
}

#[derive(Serialize, Deserialize)]
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
    total_costs: f64,
    cost_drag_pct: f64,
    risk_rejections: usize,
    drawdown_circuit_breaks: usize,
    equity_curve: Vec<EquityPoint>,
    trade_log: Vec<TradeEntry>,
}

#[derive(Serialize, Deserialize)]
struct EquityPoint {
    date: String,
    nav: f64,
}

#[derive(Serialize, Deserialize)]
struct TradeEntry {
    symbol: String,
    side: String,
    entry_price: f64,
    exit_price: f64,
    qty: i64,
    pnl: f64,
    gross_pnl: f64,
    costs: f64,
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
            avg_win: 0.0, avg_loss: 0.0,
            total_costs: 0.0, cost_drag_pct: 0.0,
            risk_rejections: 0, drawdown_circuit_breaks: 0,
            equity_curve: vec![], trade_log: vec![],
        }).map_err(|e| e.to_string())?);
    }

    let costs = build_costs(&config.transaction_costs);
    let risk = build_risk_limits(&config.risk_limits);

    let mut cash = config.initial_capital;
    let mut nav = config.initial_capital;
    let mut peak = nav;
    let mut max_dd = 0.0_f64;
    let mut trades: Vec<TradeEntry> = Vec::new();
    let mut equity_curve: Vec<EquityPoint> = Vec::new();
    let mut position: Option<(f64, i64, String)> = None; // (entry_price, qty, entry_time)
    let mut total_costs = 0.0_f64;
    let mut risk_rejections = 0usize;
    let mut circuit_breaks = 0usize;

    let closes: Vec<f64> = config.candles.iter().map(|c| c.close).collect();
    let highs: Vec<f64> = config.candles.iter().map(|c| c.high).collect();
    let lows: Vec<f64> = config.candles.iter().map(|c| c.low).collect();

    let params = config.params.clone().unwrap_or(serde_json::json!({}));
    let strat = config.strategy.as_str();

    let rsi_vals = calc_rsi_series(&closes, 14);
    let sma_short_p = params.get("shortPeriod").and_then(|v| v.as_f64()).unwrap_or(10.0) as usize;
    let sma_long_p = params.get("longPeriod").and_then(|v| v.as_f64()).unwrap_or(30.0) as usize;
    let sma_short_vals = calc_sma(&closes, sma_short_p);
    let sma_long_vals = calc_sma(&closes, sma_long_p);
    let mr_period = params.get("period").and_then(|v| v.as_f64()).unwrap_or(20.0) as usize;
    let mr_threshold = params.get("threshold").and_then(|v| v.as_f64()).unwrap_or(2.0);
    let mr_sma = calc_sma(&closes, mr_period);
    let mom_lookback = params.get("lookback").and_then(|v| v.as_f64()).unwrap_or(20.0) as usize;
    let mom_hold = params.get("holdDays").and_then(|v| v.as_f64()).unwrap_or(10.0) as i64;
    let mut hold_counter: i64 = 0;
    let rsi_oversold = params.get("oversold").and_then(|v| v.as_f64()).unwrap_or(30.0);
    let rsi_overbought = params.get("overbought").and_then(|v| v.as_f64()).unwrap_or(70.0);
    let orb_target_pct = params.get("target").and_then(|v| v.as_f64()).unwrap_or(1.5) / 100.0;
    let orb_sl_pct = params.get("stop_loss").and_then(|v| v.as_f64()).unwrap_or(0.75) / 100.0;
    let mut short_position: Option<(f64, i64, String)> = None; // (entry_price, qty, entry_time)

    // Helper closures for open/close position with proper cash accounting
    // open_long: cash -= position_value + entry_cost
    // close_long: cash += exit_value - exit_cost, pnl = (exit - entry) * qty - costs
    // NAV = cash + open_position_market_value (recalculated each candle)

    for (i, candle) in config.candles.iter().enumerate() {
        // Recalculate NAV = cash + open position market value
        nav = cash;
        if let Some((ep, qty, _)) = &position {
            nav += candle.close * (*qty) as f64;
        }
        if let Some((ep, qty, _)) = &short_position {
            // Short position value: margin locked + unrealized P&L
            nav += (*ep) * (*qty) as f64 + ((*ep) - candle.close) * (*qty) as f64;
        }
        equity_curve.push(EquityPoint { date: candle.timestamp.clone(), nav: round2(nav) });

        let dd_check = risk.check_drawdown(nav, peak);
        if !dd_check.approved {
            if let Some((ep, qty, et)) = position.take() {
                let exit_price = costs.slippage_adjusted_price(candle.close, false);
                let exit_value = exit_price * qty as f64;
                let gross_pnl = (exit_price - ep) * qty as f64;
                let exit_cost = costs.total_cost(exit_value, true);
                let net_pnl = gross_pnl - exit_cost;
                cash += exit_value - exit_cost;
                total_costs += exit_cost;
                trades.push(TradeEntry {
                    symbol: config.symbol.clone(), side: "CIRCUIT_BREAK_EXIT".into(),
                    entry_price: round2(ep), exit_price: round2(exit_price),
                    qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                    costs: round2(exit_cost),
                    entry_time: et, exit_time: candle.timestamp.clone(),
                });
                circuit_breaks += 1;
            }
            continue;
        }

        match strat {
            "ema-crossover" | "ema_crossover" | "supertrend" => {
                if i >= 21 {
                    let ema_short = calc_ema_last(&closes[..=i], 9);
                    let ema_long = calc_ema_last(&closes[..=i], 21);
                    if position.is_none() && ema_short > ema_long {
                        let qty = calc_qty(cash, candle.close, &risk);
                        let check = risk.check_position_size(nav, candle.close, qty, None);
                        if !check.approved {
                            risk_rejections += 1;
                            continue;
                        }
                        if qty > 0 {
                            let entry_price = costs.slippage_adjusted_price(candle.close, true);
                            let position_value = entry_price * qty as f64;
                            let entry_cost = costs.total_cost(position_value, false);
                            cash -= position_value + entry_cost;
                            total_costs += entry_cost;
                            position = Some((entry_price, qty, candle.timestamp.clone()));
                        }
                    } else if let Some((entry_price, qty, entry_time)) = &position {
                        if ema_short < ema_long {
                            let exit_price = costs.slippage_adjusted_price(candle.close, false);
                            let exit_value = exit_price * (*qty) as f64;
                            let gross_pnl = (exit_price - entry_price) * (*qty) as f64;
                            let exit_cost = costs.total_cost(exit_value, true);
                            let net_pnl = gross_pnl - exit_cost;
                            cash += exit_value - exit_cost;
                            total_costs += exit_cost;
                            trades.push(TradeEntry {
                                symbol: config.symbol.clone(), side: "BUY".into(),
                                entry_price: round2(*entry_price), exit_price: round2(exit_price),
                                qty: *qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                                costs: round2(exit_cost),
                                entry_time: entry_time.clone(), exit_time: candle.timestamp.clone(),
                            });
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
                            let qty = calc_qty(cash, candle.close, &risk);
                            let check = risk.check_position_size(nav, candle.close, qty, None);
                            if !check.approved { risk_rejections += 1; continue; }
                            if qty > 0 {
                                let entry_price = costs.slippage_adjusted_price(candle.close, true);
                                let position_value = entry_price * qty as f64;
                                let entry_cost = costs.total_cost(position_value, false);
                                cash -= position_value + entry_cost;
                                total_costs += entry_cost;
                                position = Some((entry_price, qty, candle.timestamp.clone()));
                            }
                        } else if position.is_some() && ps >= pl && s < l {
                            let (ep, qty, et) = position.take().unwrap();
                            let exit_price = costs.slippage_adjusted_price(candle.close, false);
                            let exit_value = exit_price * qty as f64;
                            let gross_pnl = (exit_price - ep) * qty as f64;
                            let exit_cost = costs.total_cost(exit_value, true);
                            let net_pnl = gross_pnl - exit_cost;
                            cash += exit_value - exit_cost;
                            total_costs += exit_cost;
                            trades.push(TradeEntry {
                                symbol: config.symbol.clone(), side: "BUY".into(),
                                entry_price: round2(ep), exit_price: round2(exit_price),
                                qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                                costs: round2(exit_cost),
                                entry_time: et, exit_time: candle.timestamp.clone(),
                            });
                        }
                    }
                }
            }
            "rsi_reversal" | "rsi-reversal" => {
                if i < rsi_vals.len() && rsi_vals[i] > 0.0 {
                    let r = rsi_vals[i];
                    if position.is_none() && r < rsi_oversold {
                        let qty = calc_qty(cash, candle.close, &risk);
                        let check = risk.check_position_size(nav, candle.close, qty, None);
                        if !check.approved { risk_rejections += 1; continue; }
                        if qty > 0 {
                            let entry_price = costs.slippage_adjusted_price(candle.close, true);
                            let position_value = entry_price * qty as f64;
                            let entry_cost = costs.total_cost(position_value, false);
                            cash -= position_value + entry_cost;
                            total_costs += entry_cost;
                            position = Some((entry_price, qty, candle.timestamp.clone()));
                        }
                    } else if position.is_some() && r > rsi_overbought {
                        let (ep, qty, et) = position.take().unwrap();
                        let exit_price = costs.slippage_adjusted_price(candle.close, false);
                        let exit_value = exit_price * qty as f64;
                        let gross_pnl = (exit_price - ep) * qty as f64;
                        let exit_cost = costs.total_cost(exit_value, true);
                        let net_pnl = gross_pnl - exit_cost;
                        cash += exit_value - exit_cost;
                        total_costs += exit_cost;
                        trades.push(TradeEntry {
                            symbol: config.symbol.clone(), side: "BUY".into(),
                            entry_price: round2(ep), exit_price: round2(exit_price),
                            qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                            costs: round2(exit_cost),
                            entry_time: et, exit_time: candle.timestamp.clone(),
                        });
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
                                let qty = calc_qty(cash, candle.close, &risk);
                                let check = risk.check_position_size(nav, candle.close, qty, None);
                                if !check.approved { risk_rejections += 1; continue; }
                                if qty > 0 {
                                    let entry_price = costs.slippage_adjusted_price(candle.close, true);
                                    let position_value = entry_price * qty as f64;
                                    let entry_cost = costs.total_cost(position_value, false);
                                    cash -= position_value + entry_cost;
                                    total_costs += entry_cost;
                                    position = Some((entry_price, qty, candle.timestamp.clone()));
                                }
                            } else if z > mr_threshold {
                                let qty = calc_qty(cash, candle.close, &risk);
                                let check = risk.check_position_size(nav, candle.close, qty, None);
                                if !check.approved { risk_rejections += 1; continue; }
                                if qty > 0 {
                                    let entry_price = costs.slippage_adjusted_price(candle.close, false);
                                    let margin = entry_price * qty as f64;
                                    let entry_cost = costs.total_cost(margin, false);
                                    cash -= margin + entry_cost;
                                    total_costs += entry_cost;
                                    short_position = Some((entry_price, qty, candle.timestamp.clone()));
                                }
                            }
                        } else if position.is_some() && z >= 0.0 {
                            let (ep, qty, et) = position.take().unwrap();
                            let exit_price = costs.slippage_adjusted_price(candle.close, false);
                            let exit_value = exit_price * qty as f64;
                            let gross_pnl = (exit_price - ep) * qty as f64;
                            let exit_cost = costs.total_cost(exit_value, true);
                            let net_pnl = gross_pnl - exit_cost;
                            cash += exit_value - exit_cost;
                            total_costs += exit_cost;
                            trades.push(TradeEntry {
                                symbol: config.symbol.clone(), side: "BUY".into(),
                                entry_price: round2(ep), exit_price: round2(exit_price),
                                qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                                costs: round2(exit_cost),
                                entry_time: et, exit_time: candle.timestamp.clone(),
                            });
                        } else if short_position.is_some() && z <= 0.0 {
                            let (ep, qty, et) = short_position.take().unwrap();
                            let exit_price = costs.slippage_adjusted_price(candle.close, true);
                            let margin = ep * qty as f64;
                            let gross_pnl = (ep - exit_price) * qty as f64;
                            let exit_cost = costs.total_cost(exit_price * qty as f64, true);
                            let net_pnl = gross_pnl - exit_cost;
                            cash += margin + net_pnl;
                            total_costs += exit_cost;
                            trades.push(TradeEntry {
                                symbol: config.symbol.clone(), side: "SHORT".into(),
                                entry_price: round2(ep), exit_price: round2(exit_price),
                                qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                                costs: round2(exit_cost),
                                entry_time: et, exit_time: candle.timestamp.clone(),
                            });
                        }
                    }
                }
            }
            "momentum" => {
                if i >= mom_lookback {
                    if hold_counter > 0 {
                        hold_counter -= 1;
                        if hold_counter == 0 && position.is_some() {
                            let (ep, qty, et) = position.take().unwrap();
                            let exit_price = costs.slippage_adjusted_price(candle.close, false);
                            let exit_value = exit_price * qty as f64;
                            let gross_pnl = (exit_price - ep) * qty as f64;
                            let exit_cost = costs.total_cost(exit_value, true);
                            let net_pnl = gross_pnl - exit_cost;
                            cash += exit_value - exit_cost;
                            total_costs += exit_cost;
                            trades.push(TradeEntry {
                                symbol: config.symbol.clone(), side: "BUY".into(),
                                entry_price: round2(ep), exit_price: round2(exit_price),
                                qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                                costs: round2(exit_cost),
                                entry_time: et, exit_time: candle.timestamp.clone(),
                            });
                        }
                    } else if position.is_none() {
                        let past_ret = (closes[i] - closes[i - mom_lookback]) / closes[i - mom_lookback];
                        if past_ret > 0.05 {
                            let qty = calc_qty(cash, candle.close, &risk);
                            let check = risk.check_position_size(nav, candle.close, qty, None);
                            if !check.approved { risk_rejections += 1; continue; }
                            if qty > 0 {
                                let entry_price = costs.slippage_adjusted_price(candle.close, true);
                                let position_value = entry_price * qty as f64;
                                let entry_cost = costs.total_cost(position_value, false);
                                cash -= position_value + entry_cost;
                                total_costs += entry_cost;
                                position = Some((entry_price, qty, candle.timestamp.clone()));
                                hold_counter = mom_hold;
                            }
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
                            let entry = costs.slippage_adjusted_price(prev_high, true);
                            let target = entry * (1.0 + orb_target_pct);
                            let sl = entry * (1.0 - orb_sl_pct);
                            let exit_raw = if candle.high >= target { target }
                                else if candle.low <= sl { sl }
                                else { candle.close };
                            let exit = costs.slippage_adjusted_price(exit_raw, false);
                            let qty = calc_qty(cash, entry, &risk);
                            if qty > 0 {
                                let gross_pnl = (exit - entry) * qty as f64;
                                let entry_cost = costs.total_cost(entry * qty as f64, false);
                                let exit_cost = costs.total_cost(exit * qty as f64, true);
                                let net_pnl = gross_pnl - entry_cost - exit_cost;
                                cash += net_pnl;
                                total_costs += entry_cost + exit_cost;
                                trades.push(TradeEntry {
                                    symbol: config.symbol.clone(), side: "BUY".into(),
                                    entry_price: round2(entry), exit_price: round2(exit),
                                    qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                                    costs: round2(entry_cost + exit_cost),
                                    entry_time: candle.timestamp.clone(),
                                    exit_time: candle.timestamp.clone(),
                                });
                            }
                        } else if candle.low < prev_low {
                            let entry = costs.slippage_adjusted_price(prev_low, false);
                            let target = entry * (1.0 - orb_target_pct);
                            let sl = entry * (1.0 + orb_sl_pct);
                            let exit_raw = if candle.low <= target { target }
                                else if candle.high >= sl { sl }
                                else { candle.close };
                            let exit = costs.slippage_adjusted_price(exit_raw, true);
                            let qty = calc_qty(cash, entry, &risk);
                            if qty > 0 {
                                let gross_pnl = (entry - exit) * qty as f64;
                                let entry_cost = costs.total_cost(entry * qty as f64, false);
                                let exit_cost = costs.total_cost(exit * qty as f64, true);
                                let net_pnl = gross_pnl - entry_cost - exit_cost;
                                cash += net_pnl;
                                total_costs += entry_cost + exit_cost;
                                trades.push(TradeEntry {
                                    symbol: config.symbol.clone(), side: "SHORT".into(),
                                    entry_price: round2(entry), exit_price: round2(exit),
                                    qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                                    costs: round2(entry_cost + exit_cost),
                                    entry_time: candle.timestamp.clone(),
                                    exit_time: candle.timestamp.clone(),
                                });
                            }
                        }
                    }
                }
            }
            _ => {
                if i >= 21 {
                    let ema_short = calc_ema_last(&closes[..=i], 9);
                    let ema_long = calc_ema_last(&closes[..=i], 21);
                    if position.is_none() && ema_short > ema_long {
                        let qty = calc_qty(cash, candle.close, &risk);
                        if qty > 0 {
                            let entry_price = costs.slippage_adjusted_price(candle.close, true);
                            let position_value = entry_price * qty as f64;
                            let entry_cost = costs.total_cost(position_value, false);
                            cash -= position_value + entry_cost;
                            total_costs += entry_cost;
                            position = Some((entry_price, qty, candle.timestamp.clone()));
                        }
                    } else if let Some((entry_price, qty, entry_time)) = &position {
                        if ema_short < ema_long {
                            let exit_price = costs.slippage_adjusted_price(candle.close, false);
                            let exit_value = exit_price * (*qty) as f64;
                            let gross_pnl = (exit_price - entry_price) * (*qty) as f64;
                            let exit_cost = costs.total_cost(exit_value, true);
                            let net_pnl = gross_pnl - exit_cost;
                            cash += exit_value - exit_cost;
                            total_costs += exit_cost;
                            trades.push(TradeEntry {
                                symbol: config.symbol.clone(), side: "BUY".into(),
                                entry_price: round2(*entry_price), exit_price: round2(exit_price),
                                qty: *qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                                costs: round2(exit_cost),
                                entry_time: entry_time.clone(), exit_time: candle.timestamp.clone(),
                            });
                            position = None;
                        }
                    }
                }
            }
        }

        // Final NAV recalculation
        nav = cash;
        if let Some((_, qty, _)) = &position {
            nav += candle.close * (*qty) as f64;
        }
        if let Some((ep, qty, _)) = &short_position {
            nav += (*ep) * (*qty) as f64 + ((*ep) - candle.close) * (*qty) as f64;
        }
        if nav > peak { peak = nav; }
        let dd = if peak > 0.0 { (peak - nav) / peak } else { 0.0 };
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

    let cost_drag = if config.initial_capital > 0.0 {
        total_costs / config.initial_capital * 100.0
    } else { 0.0 };

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
        total_costs: round2(total_costs),
        cost_drag_pct: round2(cost_drag),
        risk_rejections,
        drawdown_circuit_breaks: circuit_breaks,
        equity_curve,
        trade_log: trades,
    };

    serde_json::to_value(result).map_err(|e| format!("Serialization error: {}", e))
}

fn build_costs(config: &Option<CostConfig>) -> TransactionCosts {
    match config {
        Some(c) => TransactionCosts {
            commission_per_trade: c.commission.unwrap_or(20.0),
            slippage_bps: c.slippage_bps.unwrap_or(5.0),
            stt_pct: c.stt_pct.unwrap_or(0.025),
            ..TransactionCosts::default()
        },
        None => TransactionCosts::default(),
    }
}

fn build_risk_limits(config: &Option<RiskLimitConfig>) -> RiskLimits {
    match config {
        Some(c) => RiskLimits {
            max_position_size_pct: c.max_position_pct.unwrap_or(20.0),
            max_single_loss_pct: c.max_loss_pct.unwrap_or(2.0),
            max_drawdown_pct: c.max_drawdown_pct.unwrap_or(25.0),
            ..RiskLimits::default()
        },
        None => RiskLimits::default(),
    }
}

fn calc_qty(nav: f64, price: f64, risk: &RiskLimits) -> i64 {
    if price <= 0.0 { return 0; }
    let max_value = nav * risk.max_position_size_pct / 100.0;
    (max_value / price).min(i64::MAX as f64) as i64
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn trending_up_candles(n: usize, start: f64, step: f64) -> Vec<serde_json::Value> {
        (0..n).map(|i| {
            let close = start + i as f64 * step;
            json!({
                "timestamp": format!("2025-01-{:02}", (i % 28) + 1),
                "open": close - step * 0.3,
                "high": close + step * 0.2,
                "low": close - step * 0.5,
                "close": close,
                "volume": 10000.0,
            })
        }).collect()
    }

    fn flat_candles(n: usize, price: f64) -> Vec<serde_json::Value> {
        (0..n).map(|i| json!({
            "timestamp": format!("2025-01-{:02}", (i % 28) + 1),
            "open": price, "high": price + 0.5, "low": price - 0.5,
            "close": price, "volume": 10000.0,
        })).collect()
    }

    fn run_backtest(strategy: &str, candles: Vec<serde_json::Value>, capital: f64) -> BacktestResult {
        let result = run(json!({
            "strategy": strategy,
            "symbol": "TEST",
            "initial_capital": capital,
            "candles": candles,
        })).unwrap();
        serde_json::from_value(result).unwrap()
    }

    #[test]
    fn test_empty_candles() {
        let r = run_backtest("ema-crossover", vec![], 100000.0);
        assert_eq!(r.total_trades, 0);
        assert_eq!(r.cagr, 0.0);
        assert_eq!(r.max_drawdown, 0.0);
    }

    #[test]
    fn test_flat_market_few_trades() {
        let candles = flat_candles(60, 100.0);
        let r = run_backtest("ema-crossover", candles, 100000.0);
        assert!(r.total_trades <= 2, "flat market should produce very few EMA crossover trades");
    }

    #[test]
    fn test_equity_curve_length_matches_candles() {
        let candles = trending_up_candles(50, 100.0, 1.0);
        let r = run_backtest("ema-crossover", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 50, "equity curve should have one point per candle");
    }

    #[test]
    fn test_equity_curve_starts_at_initial_capital() {
        let candles = trending_up_candles(30, 100.0, 1.0);
        let r = run_backtest("ema-crossover", candles, 500000.0);
        assert_eq!(r.equity_curve[0].nav, 500000.0, "equity curve should start at initial capital");
    }

    #[test]
    fn test_win_rate_bounded() {
        let candles = trending_up_candles(100, 100.0, 0.5);
        let r = run_backtest("ema-crossover", candles, 100000.0);
        assert!(r.win_rate >= 0.0 && r.win_rate <= 100.0,
            "win rate should be 0-100%, got {}", r.win_rate);
    }

    #[test]
    fn test_trade_log_consistency() {
        let candles = trending_up_candles(80, 100.0, 0.5);
        let r = run_backtest("sma_crossover", candles, 100000.0);
        for trade in &r.trade_log {
            assert!(trade.qty > 0, "trade qty should be positive");
            assert!(trade.entry_price > 0.0, "entry price should be positive");
            assert!(trade.exit_price > 0.0, "exit price should be positive");
            assert_eq!(trade.symbol, "TEST");
        }
    }

    #[test]
    fn test_max_drawdown_bounded() {
        let candles = trending_up_candles(60, 100.0, 1.0);
        let r = run_backtest("ema-crossover", candles, 100000.0);
        assert!(r.max_drawdown >= 0.0 && r.max_drawdown <= 100.0,
            "max drawdown should be 0-100%, got {}", r.max_drawdown);
    }

    #[test]
    fn test_rsi_reversal_strategy_runs() {
        let mut candles = trending_up_candles(30, 100.0, -1.0);
        candles.extend(trending_up_candles(30, 70.0, 1.5));
        let r = run_backtest("rsi_reversal", candles, 100000.0);
        assert!(r.equity_curve.len() == 60);
    }

    #[test]
    fn test_mean_reversion_strategy_runs() {
        let mut candles: Vec<serde_json::Value> = Vec::new();
        for i in 0..80 {
            let price = 100.0 + (i as f64 * 0.3).sin() * 15.0;
            candles.push(json!({
                "timestamp": format!("2025-01-{:02}", (i % 28) + 1),
                "open": price - 0.5, "high": price + 1.0, "low": price - 1.0,
                "close": price, "volume": 10000.0,
            }));
        }
        let r = run_backtest("mean_reversion", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 80);
    }

    #[test]
    fn test_unknown_strategy_defaults_to_ema() {
        let candles = trending_up_candles(50, 100.0, 1.0);
        let r = run_backtest("nonexistent_strategy", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 50);
    }

    #[test]
    fn test_transaction_costs_reduce_pnl() {
        let candles = trending_up_candles(80, 100.0, 0.5);
        let r = run_backtest("ema-crossover", candles, 100000.0);
        if r.total_trades > 0 {
            assert!(r.total_costs > 0.0, "trades should incur costs");
            assert!(r.cost_drag_pct > 0.0, "cost drag should be positive");
        }
    }

    #[test]
    fn test_trade_has_cost_breakdown() {
        let candles = trending_up_candles(80, 100.0, 0.5);
        let r = run_backtest("ema-crossover", candles, 100000.0);
        for trade in &r.trade_log {
            assert!(trade.costs >= 0.0, "trade costs should be non-negative");
            assert!(trade.gross_pnl.is_finite(), "gross_pnl should be finite");
        }
    }
}
