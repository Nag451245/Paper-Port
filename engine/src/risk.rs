use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::utils::{round2, round4, pearson_correlation};

#[derive(Deserialize)]
struct RiskInput {
    returns: Vec<f64>,
    initial_capital: f64,
    risk_free_rate: Option<f64>,
    benchmark_returns: Option<Vec<f64>>,
}

#[derive(Serialize, Deserialize)]
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
    information_ratio: f64,
    treynor_ratio: f64,
    tail_ratio: f64,
    win_rate: f64,
    avg_win_loss_ratio: f64,
    correlation_to_benchmark: f64,
    max_drawdown_duration: usize,
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
            information_ratio: 0.0, treynor_ratio: 0.0, tail_ratio: 1.0,
            win_rate: 0.0, avg_win_loss_ratio: 0.0,
            correlation_to_benchmark: 0.0, max_drawdown_duration: 0,
        }).map_err(|e| e.to_string())?);
    }

    let rf_daily = input.risk_free_rate.unwrap_or(0.06 / 252.0);
    let n = input.returns.len() as f64;
    let mean_ret = input.returns.iter().sum::<f64>() / n;
    let excess_returns: Vec<f64> = input.returns.iter().map(|r| r - rf_daily).collect();
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
    let mut dd_start: Option<usize> = None;
    let mut max_dd_duration = 0usize;
    let mut current_dd_duration = 0usize;

    for (i, &ret) in input.returns.iter().enumerate() {
        nav *= 1.0 + ret;
        if nav > peak {
            peak = nav;
            if dd_start.is_some() {
                if current_dd_duration > max_dd_duration {
                    max_dd_duration = current_dd_duration;
                }
                dd_start = None;
                current_dd_duration = 0;
            }
        } else {
            if dd_start.is_none() { dd_start = Some(i); }
            current_dd_duration += 1;
        }
        let dd = if peak > 0.0 { (peak - nav) / peak } else { 0.0 };
        if dd > max_dd { max_dd = dd; }
    }
    if current_dd_duration > max_dd_duration {
        max_dd_duration = current_dd_duration;
    }

    let calmar = if max_dd > 0.0 { annualized_return / max_dd } else { 0.0 };

    let mut sorted = input.returns.clone();
    sorted.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let var_95_idx = ((1.0 - 0.95) * n) as usize;
    let var_99_idx = ((1.0 - 0.99) * n) as usize;
    let var_95 = if var_95_idx < sorted.len() { -sorted[var_95_idx] * input.initial_capital } else { 0.0 };
    let var_99 = if var_99_idx < sorted.len() { -sorted[var_99_idx] * input.initial_capital } else { 0.0 };
    let cvar_95 = if var_95_idx > 0 {
        -sorted[..var_95_idx].iter().sum::<f64>() / var_95_idx as f64 * input.initial_capital
    } else { var_95 };

    // Beta and Alpha calculation against benchmark
    let (beta, alpha, corr_to_bench, info_ratio, treynor) = if let Some(ref bench) = input.benchmark_returns {
        let min_len = input.returns.len().min(bench.len());
        if min_len >= 5 {
            let port = &input.returns[..min_len];
            let bmark = &bench[..min_len];

            let bench_mean = bmark.iter().sum::<f64>() / min_len as f64;
            let port_mean = port.iter().sum::<f64>() / min_len as f64;

            let mut cov_pb = 0.0;
            let mut var_b = 0.0;
            for i in 0..min_len {
                cov_pb += (port[i] - port_mean) * (bmark[i] - bench_mean);
                var_b += (bmark[i] - bench_mean).powi(2);
            }
            cov_pb /= min_len as f64;
            var_b /= min_len as f64;

            let b = if var_b > 0.0 { cov_pb / var_b } else { 1.0 };
            let a = (port_mean - rf_daily - b * (bench_mean - rf_daily)) * 252.0;
            let corr = pearson_correlation(port, bmark);

            let tracking: Vec<f64> = (0..min_len).map(|i| port[i] - bmark[i]).collect();
            let track_mean = tracking.iter().sum::<f64>() / min_len as f64;
            let track_std = (tracking.iter().map(|t| (t - track_mean).powi(2)).sum::<f64>() / min_len as f64).sqrt();
            let ir = if track_std > 0.0 { track_mean / track_std * (252.0_f64).sqrt() } else { 0.0 };

            let tr = if b.abs() > 0.01 { (annualized_return - rf_daily * 252.0) / b } else { 0.0 };

            (b, a, corr, ir, tr)
        } else {
            (1.0, 0.0, 0.0, 0.0, 0.0)
        }
    } else {
        (1.0, 0.0, 0.0, 0.0, 0.0)
    };

    // Tail ratio: 95th percentile / abs(5th percentile)
    let p95 = sorted[((0.95 * n) as usize).min(sorted.len() - 1)];
    let p5 = sorted[(0.05 * n) as usize];
    let tail_ratio = if p5.abs() > 1e-10 { p95 / p5.abs() } else { 1.0 };

    let wins = input.returns.iter().filter(|&&r| r > 0.0).count() as f64;
    let losses_count = input.returns.iter().filter(|&&r| r < 0.0).count() as f64;
    let win_rate = wins / n * 100.0;
    let avg_win = if wins > 0.0 { input.returns.iter().filter(|&&r| r > 0.0).sum::<f64>() / wins } else { 0.0 };
    let avg_loss_val = if losses_count > 0.0 {
        input.returns.iter().filter(|&&r| r < 0.0).map(|r| r.abs()).sum::<f64>() / losses_count
    } else { 0.0 };
    let win_loss_ratio = if avg_loss_val > 0.0 { avg_win / avg_loss_val } else { 0.0 };

    let output = RiskOutput {
        sharpe_ratio: round2(sharpe),
        sortino_ratio: round2(sortino),
        calmar_ratio: round4(calmar),
        max_drawdown: round2(max_dd * input.initial_capital),
        max_drawdown_percent: round2(max_dd * 100.0),
        var_95: round2(var_95),
        var_99: round2(var_99),
        cvar_95: round2(cvar_95),
        beta: round4(beta),
        alpha: round4(alpha),
        volatility: round2(volatility * 100.0),
        annualized_return: round2(annualized_return * 100.0),
        information_ratio: round4(info_ratio),
        treynor_ratio: round4(treynor),
        tail_ratio: round4(tail_ratio),
        win_rate: round2(win_rate),
        avg_win_loss_ratio: round4(win_loss_ratio),
        correlation_to_benchmark: round4(corr_to_bench),
        max_drawdown_duration: max_dd_duration,
    };

    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn compute_risk(returns: Vec<f64>, capital: f64) -> RiskOutput {
        let result = compute(json!({
            "returns": returns,
            "initial_capital": capital,
        })).unwrap();
        serde_json::from_value(result).unwrap()
    }

    fn compute_risk_with_benchmark(returns: Vec<f64>, benchmark: Vec<f64>, capital: f64) -> RiskOutput {
        let result = compute(json!({
            "returns": returns,
            "initial_capital": capital,
            "benchmark_returns": benchmark,
        })).unwrap();
        serde_json::from_value(result).unwrap()
    }

    #[test]
    fn test_empty_returns() {
        let r = compute_risk(vec![], 100000.0);
        assert_eq!(r.sharpe_ratio, 0.0);
        assert_eq!(r.max_drawdown, 0.0);
        assert_eq!(r.var_95, 0.0);
    }

    #[test]
    fn test_all_positive_returns_no_drawdown() {
        let returns = vec![0.01, 0.02, 0.015, 0.005, 0.01];
        let r = compute_risk(returns, 100000.0);
        assert_eq!(r.max_drawdown, 0.0, "no drawdown when all returns positive");
        assert_eq!(r.max_drawdown_percent, 0.0);
        assert!(r.sharpe_ratio > 0.0, "sharpe should be positive for all-positive returns");
        assert!(r.annualized_return > 0.0);
    }

    #[test]
    fn test_drawdown_calculation() {
        let returns = vec![0.10, -0.20];
        let r = compute_risk(returns, 100000.0);
        assert!((r.max_drawdown_percent - 20.0).abs() < 1.0,
            "max drawdown should be ~20%, got {}", r.max_drawdown_percent);
    }

    #[test]
    fn test_sharpe_sign_matches_return_sign() {
        let positive = compute_risk(vec![0.01; 20], 100000.0);
        assert!(positive.sharpe_ratio > 0.0, "positive returns -> positive sharpe");

        let negative = compute_risk(vec![-0.01; 20], 100000.0);
        assert!(negative.sharpe_ratio < 0.0, "negative returns -> negative sharpe");
    }

    #[test]
    fn test_sortino_ignores_upside() {
        let returns = vec![0.05, 0.03, 0.04, 0.02, 0.06];
        let r = compute_risk(returns, 100000.0);
        assert_eq!(r.sortino_ratio, 0.0, "no downside returns -> sortino 0");
    }

    #[test]
    fn test_var_with_known_distribution() {
        let mut returns: Vec<f64> = (0..100).map(|i| (i as f64 - 50.0) / 1000.0).collect();
        returns.sort_by(|a, b| a.partial_cmp(b).unwrap());
        let r = compute_risk(returns, 100000.0);
        assert!(r.var_95 > 0.0, "VaR 95 should be positive for mixed returns");
        assert!(r.var_99 >= r.var_95, "VaR 99 should be >= VaR 95");
        assert!(r.cvar_95 >= r.var_95, "CVaR 95 should be >= VaR 95");
    }

    #[test]
    fn test_volatility_is_annualized() {
        let returns = vec![0.01, -0.01, 0.01, -0.01, 0.01];
        let r = compute_risk(returns, 100000.0);
        assert!(r.volatility > 1.0, "annualized vol should be > daily vol (expressed as %)");
    }

    #[test]
    fn test_calmar_ratio() {
        let returns = vec![0.01, -0.05, 0.02, 0.01, -0.02, 0.03];
        let r = compute_risk(returns, 100000.0);
        if r.max_drawdown_percent > 0.0 {
            assert!(r.calmar_ratio.is_finite(), "calmar should be finite when drawdown > 0");
        }
    }

    #[test]
    fn test_constant_returns_zero_volatility() {
        let returns = vec![0.01; 10];
        let r = compute_risk(returns, 100000.0);
        assert_eq!(r.volatility, 0.0, "constant returns -> zero volatility");
    }

    #[test]
    fn test_beta_with_benchmark() {
        let port = vec![0.01, -0.005, 0.008, -0.003, 0.012, -0.007, 0.005, 0.002, -0.01, 0.006];
        let bench = vec![0.005, -0.003, 0.004, -0.002, 0.006, -0.004, 0.003, 0.001, -0.005, 0.003];
        let r = compute_risk_with_benchmark(port, bench, 100000.0);
        assert!(r.beta > 0.0, "portfolio tracking benchmark should have positive beta, got {}", r.beta);
        assert!(r.beta.is_finite());
        assert!(r.alpha.is_finite());
        assert!(r.correlation_to_benchmark > 0.0, "correlated returns should show positive correlation");
    }

    #[test]
    fn test_win_rate() {
        let returns = vec![0.01, 0.02, -0.01, -0.02, 0.03];
        let r = compute_risk(returns, 100000.0);
        assert!((r.win_rate - 60.0).abs() < 0.1, "3 wins out of 5 = 60%, got {}", r.win_rate);
    }

    #[test]
    fn test_max_drawdown_duration() {
        let returns = vec![0.01, 0.02, -0.01, -0.02, -0.01, 0.05];
        let r = compute_risk(returns, 100000.0);
        assert!(r.max_drawdown_duration >= 3, "should track drawdown duration, got {}", r.max_drawdown_duration);
    }
}
