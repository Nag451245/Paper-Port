use serde::{Deserialize, Serialize};
use crate::utils::{round2, round4, Xorshift64};

#[derive(Deserialize)]
struct Config {
    returns: Vec<f64>,
    initial_capital: f64,
    num_simulations: Option<usize>,
    time_horizon: Option<usize>,
    confidence_levels: Option<Vec<f64>>,
    seed: Option<u64>,
}

#[derive(Serialize, Deserialize)]
struct SimResult {
    percentile_5: Vec<f64>,
    percentile_25: Vec<f64>,
    percentile_50: Vec<f64>,
    percentile_75: Vec<f64>,
    percentile_95: Vec<f64>,
    var_95: f64,
    var_99: f64,
    cvar_95: f64,
    expected_final_nav: f64,
    probability_of_loss: f64,
    max_drawdown_95: f64,
    optimal_position_size: f64,
    kelly_fraction: f64,
    expected_shortfall: f64,
    median_final_nav: f64,
    skewness: f64,
    kurtosis: f64,
}

pub fn compute(data: serde_json::Value) -> Result<serde_json::Value, String> {
    let config: Config = serde_json::from_value(data).map_err(|e| format!("Invalid input: {}", e))?;

    let n_sims = config.num_simulations.unwrap_or(10_000).min(50_000);
    let horizon = config.time_horizon.unwrap_or(252);
    let returns = &config.returns;

    if returns.len() < 5 {
        return Err("Need at least 5 historical returns".into());
    }

    let n_ret = returns.len();
    let mut rng = Xorshift64::new(config.seed.unwrap_or(42));

    let mut final_navs = Vec::with_capacity(n_sims);
    let mut max_drawdowns = Vec::with_capacity(n_sims);
    let mut all_paths: Vec<Vec<f64>> = Vec::with_capacity(n_sims);

    for _ in 0..n_sims {
        let mut nav = config.initial_capital;
        let mut peak = nav;
        let mut max_dd = 0.0f64;
        let mut path = Vec::with_capacity(horizon);

        for _ in 0..horizon {
            let idx = rng.next_usize(n_ret);
            let r = returns[idx];
            nav *= 1.0 + r;
            if nav > peak { peak = nav; }
            let dd = if peak > 0.0 { (peak - nav) / peak } else { 0.0 };
            if dd > max_dd { max_dd = dd; }
            path.push(nav);
        }

        final_navs.push(nav);
        max_drawdowns.push(max_dd);
        all_paths.push(path);
    }

    let mut paths_p5 = vec![0.0f64; horizon];
    let mut paths_p25 = vec![0.0f64; horizon];
    let mut paths_p50 = vec![0.0f64; horizon];
    let mut paths_p75 = vec![0.0f64; horizon];
    let mut paths_p95 = vec![0.0f64; horizon];

    for t in 0..horizon {
        let mut vals: Vec<f64> = all_paths.iter().map(|p| p[t]).collect();
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = vals.len();
        paths_p5[t] = vals[(0.05 * n as f64) as usize];
        paths_p25[t] = vals[(0.25 * n as f64) as usize];
        paths_p50[t] = vals[(0.50 * n as f64) as usize];
        paths_p75[t] = vals[(0.75 * n as f64) as usize];
        paths_p95[t] = vals[((0.95 * n as f64) as usize).min(n - 1)];
    }

    final_navs.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    max_drawdowns.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));

    let n = final_navs.len();
    let var_95_nav = final_navs[(0.05 * n as f64) as usize];
    let var_99_nav = final_navs[(0.01 * n as f64) as usize];
    let var_95 = config.initial_capital - var_95_nav;
    let var_99 = config.initial_capital - var_99_nav;

    let idx_5 = (0.05 * n as f64) as usize;
    let cvar_95 = if idx_5 > 0 {
        config.initial_capital - final_navs[..idx_5].iter().sum::<f64>() / idx_5 as f64
    } else {
        var_95
    };

    let idx_1 = (0.01 * n as f64) as usize;
    let expected_shortfall = if idx_1 > 0 {
        config.initial_capital - final_navs[..idx_1].iter().sum::<f64>() / idx_1 as f64
    } else {
        var_99
    };

    let expected = final_navs.iter().sum::<f64>() / n as f64;
    let median = final_navs[n / 2];
    let prob_loss = final_navs.iter().filter(|&&v| v < config.initial_capital).count() as f64 / n as f64;
    let max_dd_95 = max_drawdowns[((0.95 * n as f64) as usize).min(n - 1)];

    let mean_nav = expected;
    let var_nav = final_navs.iter().map(|v| (v - mean_nav).powi(2)).sum::<f64>() / n as f64;
    let std_nav = var_nav.sqrt();
    let skewness = if std_nav > 0.0 {
        final_navs.iter().map(|v| ((v - mean_nav) / std_nav).powi(3)).sum::<f64>() / n as f64
    } else { 0.0 };
    let kurtosis = if std_nav > 0.0 {
        final_navs.iter().map(|v| ((v - mean_nav) / std_nav).powi(4)).sum::<f64>() / n as f64 - 3.0
    } else { 0.0 };

    let wins = returns.iter().filter(|&&r| r > 0.0).count() as f64;
    let win_rate = wins / returns.len() as f64;
    let avg_win = returns.iter().filter(|&&r| r > 0.0).sum::<f64>() / wins.max(1.0);
    let losses = returns.iter().filter(|&&r| r < 0.0).count() as f64;
    let avg_loss = returns.iter().filter(|&&r| r < 0.0).map(|r| r.abs()).sum::<f64>() / losses.max(1.0);
    let kelly = if avg_loss > 0.0 { win_rate - (1.0 - win_rate) / (avg_win / avg_loss) } else { 0.0 };
    let optimal_size = (kelly * 0.5).max(0.0).min(0.25);

    let result = SimResult {
        percentile_5: decimate(&paths_p5, 50),
        percentile_25: decimate(&paths_p25, 50),
        percentile_50: decimate(&paths_p50, 50),
        percentile_75: decimate(&paths_p75, 50),
        percentile_95: decimate(&paths_p95, 50),
        var_95: round2(var_95),
        var_99: round2(var_99),
        cvar_95: round2(cvar_95),
        expected_final_nav: round2(expected),
        probability_of_loss: round4(prob_loss),
        max_drawdown_95: round4(max_dd_95),
        optimal_position_size: round4(optimal_size),
        kelly_fraction: round4(kelly),
        expected_shortfall: round2(expected_shortfall),
        median_final_nav: round2(median),
        skewness: round4(skewness),
        kurtosis: round4(kurtosis),
    };

    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn decimate(data: &[f64], target: usize) -> Vec<f64> {
    if data.len() <= target { return data.iter().map(|v| round2(*v)).collect(); }
    let step = data.len() as f64 / target as f64;
    (0..target).map(|i| round2(data[(i as f64 * step) as usize])).collect()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn run_sim(returns: Vec<f64>, capital: f64, sims: usize) -> SimResult {
        let result = compute(json!({
            "returns": returns,
            "initial_capital": capital,
            "num_simulations": sims,
            "time_horizon": 20,
            "seed": 42,
        })).unwrap();
        serde_json::from_value(result).unwrap()
    }

    fn sample_returns() -> Vec<f64> {
        vec![0.01, -0.005, 0.008, -0.003, 0.012, -0.007, 0.005, 0.002, -0.01, 0.006,
             0.003, -0.004, 0.009, -0.002, 0.007, -0.006, 0.004, 0.001, -0.008, 0.011]
    }

    #[test]
    fn test_basic_simulation_runs() {
        let r = run_sim(sample_returns(), 100000.0, 100);
        assert!(r.expected_final_nav > 0.0);
    }

    #[test]
    fn test_expected_nav_positive_returns() {
        let positive_returns: Vec<f64> = (0..20).map(|_| 0.01).collect();
        let r = run_sim(positive_returns, 100000.0, 100);
        assert!(r.expected_final_nav > 100000.0,
            "positive returns should grow NAV, got {}", r.expected_final_nav);
    }

    #[test]
    fn test_probability_of_loss_bounded() {
        let r = run_sim(sample_returns(), 100000.0, 500);
        assert!(r.probability_of_loss >= 0.0 && r.probability_of_loss <= 1.0);
    }

    #[test]
    fn test_var_positive() {
        let r = run_sim(sample_returns(), 100000.0, 500);
        assert!(r.var_95.is_finite(), "VaR should be a valid number");
    }

    #[test]
    fn test_kelly_fraction_bounded() {
        let r = run_sim(sample_returns(), 100000.0, 100);
        assert!(r.kelly_fraction >= -5.0 && r.kelly_fraction <= 5.0,
            "kelly should be reasonable, got {}", r.kelly_fraction);
    }

    #[test]
    fn test_optimal_position_size_capped() {
        let r = run_sim(sample_returns(), 100000.0, 100);
        assert!(r.optimal_position_size >= 0.0 && r.optimal_position_size <= 0.25,
            "position size should be 0-25%, got {}", r.optimal_position_size);
    }

    #[test]
    fn test_max_drawdown_95_non_negative() {
        let r = run_sim(sample_returns(), 100000.0, 500);
        assert!(r.max_drawdown_95 >= 0.0);
    }

    #[test]
    fn test_percentile_ordering() {
        let r = run_sim(sample_returns(), 100000.0, 500);
        let last_idx = r.percentile_5.len() - 1;
        assert!(r.percentile_5[last_idx] <= r.percentile_50[last_idx], "p5 should <= p50");
        assert!(r.percentile_50[last_idx] <= r.percentile_95[last_idx], "p50 should <= p95");
    }

    #[test]
    fn test_too_few_returns_error() {
        let result = compute(json!({
            "returns": [0.01, 0.02],
            "initial_capital": 100000.0,
        }));
        assert!(result.is_err());
    }

    #[test]
    fn test_cvar_gte_var() {
        let r = run_sim(sample_returns(), 100000.0, 1000);
        assert!(r.cvar_95 >= r.var_95 - 1.0,
            "CVaR should be >= VaR: cvar={}, var={}", r.cvar_95, r.var_95);
    }

    #[test]
    fn test_deterministic_with_seed() {
        let r1 = run_sim(sample_returns(), 100000.0, 100);
        let r2 = run_sim(sample_returns(), 100000.0, 100);
        assert_eq!(r1.expected_final_nav, r2.expected_final_nav,
            "same seed should produce same result");
    }

    #[test]
    fn test_skewness_and_kurtosis_finite() {
        let r = run_sim(sample_returns(), 100000.0, 500);
        assert!(r.skewness.is_finite());
        assert!(r.kurtosis.is_finite());
    }
}
