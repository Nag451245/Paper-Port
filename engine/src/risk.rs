use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
struct RiskInput {
    returns: Vec<f64>,
    initial_capital: f64,
    risk_free_rate: Option<f64>,
}

#[derive(Serialize)]
struct RiskOutput {
    sharpe_ratio: f64,
    sortino_ratio: f64,
    calmar_ratio: f64,
    max_drawdown: f64,
    max_drawdown_percent: f64,
    var_95: f64,
    var_99: f64,
    cvar_95: f64,
    beta: f64,
    alpha: f64,
    volatility: f64,
    annualized_return: f64,
}

pub fn compute(data: Value) -> Result<Value, String> {
    let input: RiskInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid risk input: {}", e))?;

    if input.returns.is_empty() {
        return Ok(serde_json::to_value(RiskOutput {
            sharpe_ratio: 0.0, sortino_ratio: 0.0, calmar_ratio: 0.0,
            max_drawdown: 0.0, max_drawdown_percent: 0.0,
            var_95: 0.0, var_99: 0.0, cvar_95: 0.0,
            beta: 0.0, alpha: 0.0, volatility: 0.0, annualized_return: 0.0,
        }).unwrap());
    }

    let rf = input.risk_free_rate.unwrap_or(0.06 / 252.0);
    let n = input.returns.len() as f64;
    let mean_ret = input.returns.iter().sum::<f64>() / n;
    let excess_returns: Vec<f64> = input.returns.iter().map(|r| r - rf).collect();
    let mean_excess = excess_returns.iter().sum::<f64>() / n;

    let variance = input.returns.iter().map(|r| (r - mean_ret).powi(2)).sum::<f64>() / n;
    let std_dev = variance.sqrt();
    let volatility = std_dev * (252.0_f64).sqrt();
    let annualized_return = mean_ret * 252.0;

    let sharpe = if std_dev > 0.0 { mean_excess / std_dev * (252.0_f64).sqrt() } else { 0.0 };

    let neg_returns: Vec<f64> = input.returns.iter().filter(|&&r| r < 0.0).copied().collect();
    let down_var = if neg_returns.is_empty() { 0.0 } else {
        neg_returns.iter().map(|r| r.powi(2)).sum::<f64>() / neg_returns.len() as f64
    };
    let down_dev = down_var.sqrt();
    let sortino = if down_dev > 0.0 { mean_excess / down_dev * (252.0_f64).sqrt() } else { 0.0 };

    let mut nav = input.initial_capital;
    let mut peak = nav;
    let mut max_dd = 0.0_f64;
    for &ret in &input.returns {
        nav *= 1.0 + ret;
        if nav > peak { peak = nav; }
        let dd = (peak - nav) / peak;
        if dd > max_dd { max_dd = dd; }
    }

    let calmar = if max_dd > 0.0 { annualized_return / (max_dd * 100.0) } else { 0.0 };

    let mut sorted = input.returns.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap());
    let var_95_idx = ((1.0 - 0.95) * n) as usize;
    let var_99_idx = ((1.0 - 0.99) * n) as usize;
    let var_95 = if var_95_idx < sorted.len() { -sorted[var_95_idx] * input.initial_capital } else { 0.0 };
    let var_99 = if var_99_idx < sorted.len() { -sorted[var_99_idx] * input.initial_capital } else { 0.0 };
    let cvar_95 = if var_95_idx > 0 {
        -sorted[..var_95_idx].iter().sum::<f64>() / var_95_idx as f64 * input.initial_capital
    } else { var_95 };

    let output = RiskOutput {
        sharpe_ratio: round2(sharpe),
        sortino_ratio: round2(sortino),
        calmar_ratio: round4(calmar),
        max_drawdown: round2(max_dd * input.initial_capital),
        max_drawdown_percent: round2(max_dd * 100.0),
        var_95: round2(var_95),
        var_99: round2(var_99),
        cvar_95: round2(cvar_95),
        beta: 0.0,
        alpha: 0.0,
        volatility: round2(volatility * 100.0),
        annualized_return: round2(annualized_return * 100.0),
    };

    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
fn round4(v: f64) -> f64 { (v * 10000.0).round() / 10000.0 }
