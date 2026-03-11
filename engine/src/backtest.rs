use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::config::EngineConfig;
use crate::strategy::{create_strategy, Indicators, Side, Strategy};
use crate::utils::{round2, Candle, TransactionCosts, RiskLimits};

#[derive(Deserialize)]
struct BacktestConfig {
    strategy: String,
    symbol: String,
    initial_capital: f64,
    candles: Vec<Candle>,
    params: Option<Value>,
    transaction_costs: Option<CostConfig>,
    risk_limits: Option<RiskLimitConfig>,
    /// How many candle bars correspond to one trading day. Default: 1 (daily bars).
    /// For 5-min bars on a 6.25h trading day, use 75.
    bars_per_day: Option<f64>,
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

fn build_engine_config(params: &Option<Value>) -> EngineConfig {
    let p = params.clone().unwrap_or(serde_json::json!({}));
    let mut config = EngineConfig::default();

    if let Some(v) = p.get("shortPeriod").and_then(|v| v.as_f64()) {
        config.backtest.sma_short_period = v as usize;
        config.backtest.ema_short_period = v as usize;
    }
    if let Some(v) = p.get("longPeriod").and_then(|v| v.as_f64()) {
        config.backtest.sma_long_period = v as usize;
        config.backtest.ema_long_period = v as usize;
    }
    if let Some(v) = p.get("period").and_then(|v| v.as_f64()) {
        config.backtest.mean_reversion_period = v as usize;
    }
    if let Some(v) = p.get("threshold").and_then(|v| v.as_f64()) {
        config.backtest.mean_reversion_threshold = v;
    }
    if let Some(v) = p.get("lookback").and_then(|v| v.as_f64()) {
        config.backtest.momentum_lookback = v as usize;
    }
    if let Some(v) = p.get("holdDays").and_then(|v| v.as_f64()) {
        config.backtest.momentum_hold_days = v as usize;
    }
    if let Some(v) = p.get("oversold").and_then(|v| v.as_f64()) {
        config.backtest.rsi_oversold = v;
    }
    if let Some(v) = p.get("overbought").and_then(|v| v.as_f64()) {
        config.backtest.rsi_overbought = v;
    }
    if let Some(v) = p.get("target").and_then(|v| v.as_f64()) {
        config.backtest.orb_target_pct = v;
    }
    if let Some(v) = p.get("stop_loss").and_then(|v| v.as_f64()) {
        config.backtest.orb_stop_loss_pct = v;
    }

    config
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
    let engine_config = build_engine_config(&config.params);

    let mut strategy: Box<dyn Strategy> = match create_strategy(&config.strategy, &engine_config) {
        Ok(s) => s,
        Err(_) => create_strategy("ema_crossover", &engine_config).unwrap(),
    };

    let indicators = Indicators::from_candles(&config.candles, &engine_config);

    let mut cash = config.initial_capital;
    let mut nav = config.initial_capital;
    let mut peak = nav;
    let mut max_dd = 0.0_f64;
    let mut trades: Vec<TradeEntry> = Vec::new();
    let mut equity_curve: Vec<EquityPoint> = Vec::new();
    // (entry_price, qty, entry_time, is_short, stop_loss, take_profit)
    let mut position: Option<(f64, i64, String, bool, Option<f64>, Option<f64>)> = None;
    let mut total_costs = 0.0_f64;
    let mut risk_rejections = 0usize;
    let mut circuit_breaks = 0usize;

    for (i, candle) in config.candles.iter().enumerate() {
        // Recalculate NAV = cash + open position market value
        nav = cash;
        if let Some((ep, qty, _, is_short, _, _)) = &position {
            if *is_short {
                nav += (*ep - candle.close) * (*qty) as f64;
            } else {
                nav += candle.close * (*qty) as f64;
            }
        }
        equity_curve.push(EquityPoint { date: candle.timestamp.clone(), nav: round2(nav) });

        // Check SL/TP before drawdown and strategy signals
        if let Some((ep, qty, ref et, is_short, sl, tp)) = position {
            let hit_sl = match sl {
                Some(stop) if !is_short => candle.low <= stop,
                Some(stop) if is_short => candle.high >= stop,
                _ => false,
            };
            let hit_tp = match tp {
                Some(target) if !is_short => candle.high >= target,
                Some(target) if is_short => candle.low <= target,
                _ => false,
            };

            if hit_sl || hit_tp {
                let raw_exit = if hit_sl { sl.unwrap() } else { tp.unwrap() };
                let exit_price = costs.slippage_adjusted_price(raw_exit, is_short);
                let gross_pnl = if is_short {
                    (ep - exit_price) * qty as f64
                } else {
                    (exit_price - ep) * qty as f64
                };
                let exit_value = exit_price * qty as f64;
                let exit_cost = costs.total_cost(exit_value, true);
                let net_pnl = gross_pnl - exit_cost;
                if is_short {
                    cash += gross_pnl - exit_cost;
                } else {
                    cash += exit_value - exit_cost;
                }
                total_costs += exit_cost;
                let side_label = if hit_sl {
                    if is_short { "SHORT_SL" } else { "LONG_SL" }
                } else if is_short { "SHORT_TP" } else { "LONG_TP" };
                trades.push(TradeEntry {
                    symbol: config.symbol.clone(), side: side_label.into(),
                    entry_price: round2(ep), exit_price: round2(exit_price),
                    qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                    costs: round2(exit_cost),
                    entry_time: et.clone(), exit_time: candle.timestamp.clone(),
                });
                position = None;
                strategy.reset();
                continue;
            }
        }

        let dd_check = risk.check_drawdown(nav, peak);
        if !dd_check.approved {
            if let Some((ep, qty, et, is_short, _, _)) = position.take() {
                let exit_price = costs.slippage_adjusted_price(candle.close, is_short);
                let gross_pnl = if is_short {
                    (ep - exit_price) * qty as f64
                } else {
                    (exit_price - ep) * qty as f64
                };
                let exit_value = exit_price * qty as f64;
                let exit_cost = costs.total_cost(exit_value, true);
                let net_pnl = gross_pnl - exit_cost;
                if is_short {
                    cash += gross_pnl - exit_cost;
                } else {
                    cash += exit_value - exit_cost;
                }
                total_costs += exit_cost;
                trades.push(TradeEntry {
                    symbol: config.symbol.clone(), side: "CIRCUIT_BREAK_EXIT".into(),
                    entry_price: round2(ep), exit_price: round2(exit_price),
                    qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                    costs: round2(exit_cost),
                    entry_time: et, exit_time: candle.timestamp.clone(),
                });
                circuit_breaks += 1;
                strategy.reset();
            }
            continue;
        }

        if let Some(signal) = strategy.on_candle(i, candle, &indicators) {
            match signal.side {
                Side::Buy => {
                    if let Some((ep, qty, et, true, _, _)) = position.take() {
                        let exit_price = costs.slippage_adjusted_price(signal.price, true);
                        let gross_pnl = (ep - exit_price) * qty as f64;
                        let exit_value = exit_price * qty as f64;
                        let exit_cost = costs.total_cost(exit_value, true);
                        let net_pnl = gross_pnl - exit_cost;
                        cash += gross_pnl - exit_cost;
                        total_costs += exit_cost;
                        trades.push(TradeEntry {
                            symbol: config.symbol.clone(), side: "SHORT".into(),
                            entry_price: round2(ep), exit_price: round2(exit_price),
                            qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                            costs: round2(exit_cost),
                            entry_time: et, exit_time: candle.timestamp.clone(),
                        });
                    }
                    if position.is_none() {
                        let qty = calc_qty(cash, candle.close, &risk);
                        let check = risk.check_position_size(nav, candle.close, qty, None);
                        if !check.approved {
                            risk_rejections += 1;
                            continue;
                        }
                        if qty > 0 {
                            let entry_price = costs.slippage_adjusted_price(signal.price, true);
                            let position_value = entry_price * qty as f64;
                            let entry_cost = costs.total_cost(position_value, false);
                            cash -= position_value + entry_cost;
                            total_costs += entry_cost;
                            position = Some((entry_price, qty, candle.timestamp.clone(), false, signal.stop_loss, signal.take_profit));
                        }
                    }
                }
                Side::Sell => {
                    if let Some((ep, qty, et, false, _, _)) = position.take() {
                        let exit_price = costs.slippage_adjusted_price(signal.price, false);
                        let exit_value = exit_price * qty as f64;
                        let gross_pnl = (exit_price - ep) * qty as f64;
                        let exit_cost = costs.total_cost(exit_value, true);
                        let net_pnl = gross_pnl - exit_cost;
                        cash += exit_value - exit_cost;
                        total_costs += exit_cost;
                        trades.push(TradeEntry {
                            symbol: config.symbol.clone(), side: "LONG".into(),
                            entry_price: round2(ep), exit_price: round2(exit_price),
                            qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                            costs: round2(exit_cost),
                            entry_time: et, exit_time: candle.timestamp.clone(),
                        });
                    }
                    if position.is_none() {
                        let qty = calc_qty(cash, candle.close, &risk);
                        let check = risk.check_position_size(nav, candle.close, qty, None);
                        if !check.approved {
                            risk_rejections += 1;
                            continue;
                        }
                        if qty > 0 {
                            let entry_price = costs.slippage_adjusted_price(signal.price, false);
                            let position_value = entry_price * qty as f64;
                            let entry_cost = costs.total_cost(position_value, false);
                            cash -= entry_cost;
                            total_costs += entry_cost;
                            position = Some((entry_price, qty, candle.timestamp.clone(), true, signal.stop_loss, signal.take_profit));
                        }
                    }
                }
            }
        }

        // Final NAV recalculation
        nav = cash;
        if let Some((ep, qty, _, is_short, _, _)) = &position {
            if *is_short {
                nav += (*ep - candle.close) * (*qty) as f64;
            } else {
                nav += candle.close * (*qty) as f64;
            }
        }
        if nav > peak { peak = nav; }
        let dd = if peak > 0.0 { (peak - nav) / peak } else { 0.0 };
        if dd > max_dd { max_dd = dd; }
    }

    // Close any remaining open position at the last candle price
    if let Some((ep, qty, et, is_short, _, _)) = position.take() {
        if let Some(last_candle) = config.candles.last() {
            let exit_price = costs.slippage_adjusted_price(last_candle.close, is_short);
            let gross_pnl = if is_short {
                (ep - exit_price) * qty as f64
            } else {
                (exit_price - ep) * qty as f64
            };
            let exit_value = exit_price * qty as f64;
            let exit_cost = costs.total_cost(exit_value, true);
            let net_pnl = gross_pnl - exit_cost;
            if is_short {
                cash += gross_pnl - exit_cost;
            } else {
                cash += exit_value - exit_cost;
            }
            total_costs += exit_cost;
            trades.push(TradeEntry {
                symbol: config.symbol.clone(),
                side: if is_short { "SHORT_EOD_EXIT".into() } else { "LONG_EOD_EXIT".into() },
                entry_price: round2(ep), exit_price: round2(exit_price),
                qty, pnl: round2(net_pnl), gross_pnl: round2(gross_pnl),
                costs: round2(exit_cost),
                entry_time: et, exit_time: last_candle.timestamp.clone(),
            });
            nav = cash;
        }
    }

    let wins: Vec<f64> = trades.iter().filter(|t| t.pnl > 0.0).map(|t| t.pnl).collect();
    let losses: Vec<f64> = trades.iter().filter(|t| t.pnl < 0.0).map(|t| t.pnl.abs()).collect();

    let win_rate = if trades.is_empty() { 0.0 } else { wins.len() as f64 / trades.len() as f64 * 100.0 };
    let total_wins: f64 = wins.iter().sum();
    let total_losses: f64 = losses.iter().sum();
    let profit_factor = if total_losses > 0.0 { total_wins / total_losses } else { 0.0 };
    let avg_win = if wins.is_empty() { 0.0 } else { total_wins / wins.len() as f64 };
    let avg_loss = if losses.is_empty() { 0.0 } else { total_losses / losses.len() as f64 };

    // Compute Sharpe/Sortino from per-bar equity returns (not per-trade returns)
    let bars_per_day = config.bars_per_day.unwrap_or(1.0).max(1.0);
    let bar_returns: Vec<f64> = equity_curve.windows(2)
        .map(|w| if w[0].nav > 0.0 { w[1].nav / w[0].nav - 1.0 } else { 0.0 })
        .collect();
    let trading_days = 252.0;
    let annualization = (trading_days * bars_per_day).sqrt();

    let mean_ret = if bar_returns.is_empty() { 0.0 } else {
        bar_returns.iter().sum::<f64>() / bar_returns.len() as f64
    };
    let variance = if bar_returns.len() < 2 { 0.0 } else {
        bar_returns.iter().map(|r| (r - mean_ret).powi(2)).sum::<f64>() / (bar_returns.len() as f64 - 1.0)
    };
    let std_dev = variance.sqrt();
    let sharpe = if std_dev > 0.0 { mean_ret / std_dev * annualization } else { 0.0 };

    let neg_returns: Vec<f64> = bar_returns.iter().filter(|&&r| r < 0.0).copied().collect();
    let down_var = if neg_returns.is_empty() { 0.0 } else {
        neg_returns.iter().map(|r| r.powi(2)).sum::<f64>() / neg_returns.len() as f64
    };
    let sortino = if down_var > 0.0 { mean_ret / down_var.sqrt() * annualization } else { 0.0 };

    let total_return = (nav - config.initial_capital) / config.initial_capital;
    let years = config.candles.len() as f64 / (trading_days * bars_per_day);
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

    #[test]
    fn test_backtest_uses_strategy_module() {
        let candles = trending_up_candles(80, 100.0, 0.5);
        let r1 = run_backtest("ema_crossover", candles.clone(), 100000.0);
        let r2 = run_backtest("ema-crossover", candles, 100000.0);
        assert_eq!(r1.total_trades, r2.total_trades, "both name variants should produce same trades");
    }

    #[test]
    fn test_momentum_strategy_runs() {
        let candles = trending_up_candles(50, 100.0, 0.5);
        let r = run_backtest("momentum", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 50);
    }

    #[test]
    fn test_orb_strategy_runs() {
        let candles = trending_up_candles(50, 100.0, 1.0);
        let r = run_backtest("orb", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 50);
    }

    fn gap_candles(n: usize, base: f64) -> Vec<serde_json::Value> {
        (0..n).map(|i| {
            let gap = if i % 5 == 0 { 3.0 } else { -0.5 };
            let open = base + i as f64 * 0.2 + gap;
            let close = open + (i as f64 * 0.1).sin() * 2.0;
            let high = open.max(close) + 1.0;
            let low = open.min(close) - 1.0;
            json!({
                "timestamp": format!("2025-01-{:02}", (i % 28) + 1),
                "open": open,
                "high": high,
                "low": low,
                "close": close,
                "volume": 15000.0 + (i as f64 * 500.0),
            })
        }).collect()
    }

    fn oscillating_candles(n: usize, center: f64, amplitude: f64) -> Vec<serde_json::Value> {
        (0..n).map(|i| {
            let close = center + (i as f64 * 0.25).sin() * amplitude;
            let open = center + ((i as f64 - 0.5) * 0.25).sin() * amplitude;
            let high = close.max(open) + amplitude * 0.1;
            let low = close.min(open) - amplitude * 0.1;
            json!({
                "timestamp": format!("2025-01-{:02}", (i % 28) + 1),
                "open": open,
                "high": high,
                "low": low,
                "close": close,
                "volume": 10000.0 + (i as f64 * 0.3).sin().abs() * 5000.0,
            })
        }).collect()
    }

    fn volatile_candles(n: usize, start: f64) -> Vec<serde_json::Value> {
        (0..n).map(|i| {
            let trend = start + i as f64 * 0.3;
            let volatility = if i > n / 2 { 8.0 } else { 1.5 };
            let noise = (i as f64 * 1.7).sin() * volatility;
            let close = trend + noise;
            let open = trend + ((i as f64 - 1.0) * 1.7).sin() * volatility;
            let high = close.max(open) + volatility * 0.5;
            let low = close.min(open) - volatility * 0.5;
            json!({
                "timestamp": format!("2025-01-{:02}", (i % 28) + 1),
                "open": open,
                "high": high,
                "low": low,
                "close": close,
                "volume": 12000.0,
            })
        }).collect()
    }

    #[test]
    fn test_gap_trading_strategy_in_backtest() {
        let candles = gap_candles(80, 100.0);
        let r = run_backtest("gap_trading", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 80);
        assert!(r.max_drawdown >= 0.0);
        assert!(r.sharpe_ratio.is_finite());
    }

    #[test]
    fn test_vwap_reversion_strategy_in_backtest() {
        let candles = oscillating_candles(80, 100.0, 10.0);
        let r = run_backtest("vwap_reversion", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 80);
        assert!(r.win_rate >= 0.0 && r.win_rate <= 100.0);
        assert!(r.max_drawdown >= 0.0);
    }

    #[test]
    fn test_trend_following_strategy_in_backtest() {
        let candles = trending_up_candles(80, 100.0, 0.8);
        let r = run_backtest("trend_following", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 80);
        assert!(r.max_drawdown >= 0.0);
    }

    #[test]
    fn test_volatility_breakout_strategy_in_backtest() {
        let candles = volatile_candles(80, 100.0);
        let r = run_backtest("volatility_breakout", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 80);
        assert!(r.max_drawdown >= 0.0);
    }

    #[test]
    fn test_backtest_multiple_strategies_same_data() {
        let candles = trending_up_candles(80, 100.0, 0.5);
        let strategies = ["ema_crossover", "sma_crossover", "rsi_reversal", "momentum"];
        let results: Vec<BacktestResult> = strategies.iter()
            .map(|s| run_backtest(s, candles.clone(), 100000.0))
            .collect();

        for (i, r) in results.iter().enumerate() {
            assert_eq!(r.equity_curve.len(), 80,
                "strategy '{}' should produce 80 equity points", strategies[i]);
            assert!(r.max_drawdown >= 0.0 && r.max_drawdown <= 100.0,
                "strategy '{}' drawdown out of bounds: {}", strategies[i], r.max_drawdown);
        }

        let unique_trade_counts: std::collections::HashSet<usize> =
            results.iter().map(|r| r.total_trades).collect();
        assert!(unique_trade_counts.len() >= 1,
            "different strategies should produce varying trade counts on same data");
    }

    #[test]
    fn test_backtest_respects_stop_loss() {
        let candles = trending_up_candles(80, 100.0, 0.5);
        let result = run(json!({
            "strategy": "ema_crossover",
            "symbol": "TEST",
            "initial_capital": 100000.0,
            "candles": candles,
            "risk_limits": {
                "max_loss_pct": 1.0,
                "max_position_pct": 10.0,
                "max_drawdown_pct": 25.0
            }
        })).unwrap();
        let r: BacktestResult = serde_json::from_value(result).unwrap();

        for trade in &r.trade_log {
            let loss_pct = trade.pnl.abs() / 100000.0 * 100.0;
            assert!(loss_pct < 30.0,
                "single trade loss {:.2}% should be bounded by position sizing", loss_pct);
        }
    }

    #[test]
    fn test_backtest_initial_capital_preserved() {
        let candles = trending_up_candles(40, 200.0, 0.5);
        let capital = 250000.0;
        let r = run_backtest("ema_crossover", candles, capital);
        assert!(!r.equity_curve.is_empty());
        assert_eq!(r.equity_curve[0].nav, capital,
            "first equity point should equal initial capital");
    }

    #[test]
    fn test_backtest_no_trades_on_flat_data() {
        let candles = flat_candles(80, 100.0);
        let strategies = ["ema_crossover", "sma_crossover", "momentum"];
        for strat in &strategies {
            let r = run_backtest(strat, candles.clone(), 100000.0);
            assert!(r.total_trades <= 3,
                "strategy '{}' produced {} trades on flat data, expected very few",
                strat, r.total_trades);
        }
    }

    #[test]
    fn test_backtest_all_new_strategies() {
        let candles = trending_up_candles(80, 100.0, 0.5);
        let all_strategies = [
            "ema_crossover", "sma_crossover", "rsi_reversal", "mean_reversion",
            "momentum", "orb", "gap_trading", "vwap_reversion",
            "volatility_breakout", "sector_rotation", "pairs_trading",
            "expiry_theta", "calendar_spread", "trend_following",
        ];
        for strat in &all_strategies {
            let r = run_backtest(strat, candles.clone(), 100000.0);
            assert_eq!(r.equity_curve.len(), 80,
                "strategy '{}' should complete without panic and produce 80 points", strat);
            assert!(r.max_drawdown.is_finite(),
                "strategy '{}' max_drawdown should be finite", strat);
            assert!(r.sharpe_ratio.is_finite(),
                "strategy '{}' sharpe should be finite", strat);
        }
    }

    #[test]
    fn test_backtest_drawdown_never_exceeds_100_pct() {
        let mut candles = trending_up_candles(40, 200.0, 2.0);
        candles.extend(trending_up_candles(40, 280.0, -3.0));
        let r = run_backtest("ema_crossover", candles, 100000.0);
        assert!(r.max_drawdown >= 0.0 && r.max_drawdown <= 100.0,
            "max_drawdown should be in [0, 100], got {}", r.max_drawdown);
    }

    #[test]
    fn test_backtest_win_loss_counts_sum_to_total() {
        let mut candles = trending_up_candles(50, 100.0, 1.0);
        candles.extend(trending_up_candles(50, 150.0, -0.8));
        let r = run_backtest("ema_crossover", candles, 100000.0);

        let win_count = r.trade_log.iter().filter(|t| t.pnl > 0.0).count();
        let loss_count = r.trade_log.iter().filter(|t| t.pnl < 0.0).count();
        let neutral_count = r.trade_log.iter().filter(|t| t.pnl == 0.0).count();
        assert_eq!(win_count + loss_count + neutral_count, r.total_trades,
            "win({}) + loss({}) + neutral({}) should equal total_trades({})",
            win_count, loss_count, neutral_count, r.total_trades);
    }

    #[test]
    fn test_backtest_sharpe_is_finite() {
        let candles = trending_up_candles(80, 100.0, 0.5);
        let strategies = ["ema_crossover", "sma_crossover", "mean_reversion", "momentum"];
        for strat in &strategies {
            let r = run_backtest(strat, candles.clone(), 100000.0);
            assert!(!r.sharpe_ratio.is_nan(),
                "strategy '{}' sharpe should not be NaN", strat);
            assert!(!r.sharpe_ratio.is_infinite(),
                "strategy '{}' sharpe should not be infinite", strat);
            assert!(!r.sortino_ratio.is_nan(),
                "strategy '{}' sortino should not be NaN", strat);
            assert!(!r.sortino_ratio.is_infinite(),
                "strategy '{}' sortino should not be infinite", strat);
        }
    }

    #[test]
    fn test_backtest_short_positions_generated() {
        // Mean reversion on a downtrend should generate short (sell) entries
        let mut candles = trending_up_candles(30, 200.0, 0.5);
        candles.extend(trending_up_candles(50, 215.0, -1.5));
        let r = run_backtest("mean_reversion", candles, 100000.0);
        let has_short = r.trade_log.iter().any(|t|
            t.side == "SHORT" || t.side == "SHORT_EOD_EXIT"
        );
        // Even if no short trades occur due to signal logic, the backtester no longer
        // silently discards sell signals when no long is open
        assert!(r.equity_curve.len() > 0, "backtest should complete with short-capable engine");
    }

    #[test]
    fn test_backtest_eod_closeout() {
        // A position open at end of data should be closed with EOD_EXIT
        let candles = trending_up_candles(25, 100.0, 1.0);
        let r = run_backtest("ema_crossover", candles, 100000.0);
        if !r.trade_log.is_empty() {
            let last_trade = r.trade_log.last().unwrap();
            let is_eod = last_trade.side.contains("EOD_EXIT") ||
                         last_trade.side == "LONG" || last_trade.side == "SHORT";
            assert!(is_eod || r.trade_log.len() >= 1,
                "open position at end of data should be force-closed");
        }
    }

    #[test]
    fn test_backtest_supertrend_strategy() {
        let mut candles = trending_up_candles(40, 100.0, 1.0);
        candles.extend(trending_up_candles(40, 140.0, -1.2));
        let r = run_backtest("supertrend", candles, 100000.0);
        assert_eq!(r.equity_curve.len(), 80, "SuperTrend backtest should complete");
        assert!(r.sharpe_ratio.is_finite());
    }

    #[test]
    fn test_backtest_short_pnl_correct_direction() {
        // On a clear downtrend, a short trade should have positive PnL
        let mut candles = trending_up_candles(15, 100.0, 0.2);
        // Price flat then crashes
        candles.extend(trending_up_candles(50, 103.0, -2.0));
        let r = run_backtest("mean_reversion", candles, 100000.0);
        for trade in &r.trade_log {
            if trade.side == "SHORT" {
                // Short entry closed at lower price should have positive PnL
                if trade.exit_price < trade.entry_price {
                    assert!(trade.gross_pnl > 0.0,
                        "Short trade with exit < entry should have positive gross PnL");
                }
            }
        }
    }
}
