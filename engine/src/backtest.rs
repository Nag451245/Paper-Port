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

    for (i, candle) in config.candles.iter().enumerate() {
        equity_curve.push(EquityPoint {
            date: candle.timestamp.clone(),
            nav,
        });

        match &config.strategy {
            s if s == "ema-crossover" || s == "supertrend" => {
                if i >= 21 {
                    let ema_short = ema(&config.candles[..=i], 9);
                    let ema_long = ema(&config.candles[..=i], 21);

                    if position.is_none() && ema_short > ema_long {
                        let qty = (nav * 0.1 / candle.close) as i64;
                        if qty > 0 {
                            position = Some((candle.close, candle.timestamp.clone()));
                        }
                    } else if let Some((entry_price, entry_time)) = &position {
                        if ema_short < ema_long {
                            let qty = (nav * 0.1 / entry_price) as i64;
                            let pnl = (candle.close - entry_price) * qty as f64;
                            nav += pnl;
                            trades.push(TradeEntry {
                                symbol: config.symbol.clone(),
                                side: "BUY".to_string(),
                                entry_price: *entry_price,
                                exit_price: candle.close,
                                qty,
                                pnl,
                                entry_time: entry_time.clone(),
                                exit_time: candle.timestamp.clone(),
                            });
                            position = None;
                        }
                    }
                }
            }
            _ => {}
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

fn round2(v: f64) -> f64 {
    (v * 100.0).round() / 100.0
}
