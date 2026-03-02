use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Config {
    returns: Vec<f64>,
    initial_capital: f64,
    num_simulations: Option<usize>,
    time_horizon: Option<usize>,
    confidence_levels: Option<Vec<f64>>,
}

#[derive(Serialize)]
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
}

pub fn compute(data: serde_json::Value) -> Result<serde_json::Value, String> {
    let config: Config = serde_json::from_value(data).map_err(|e| format!("Invalid input: {}", e))?;

    let n_sims = config.num_simulations.unwrap_or(10_000).min(50_000);
    let horizon = config.time_horizon.unwrap_or(252);
    let returns = &config.returns;

    if returns.len() < 5 {
        return Err("Need at least 5 historical returns".into());
    }

    let mean = returns.iter().sum::<f64>() / returns.len() as f64;
    let var = returns.iter().map(|r| (r - mean).powi(2)).sum::<f64>() / returns.len() as f64;
    let std = var.sqrt();

    let n_ret = returns.len();
    let mut final_navs = Vec::with_capacity(n_sims);
    let mut max_drawdowns = Vec::with_capacity(n_sims);

    let mut paths_p5 = vec![0.0f64; horizon];
    let mut paths_p25 = vec![0.0f64; horizon];
    let mut paths_p50 = vec![0.0f64; horizon];
    let mut paths_p75 = vec![0.0f64; horizon];
    let mut paths_p95 = vec![0.0f64; horizon];

    let mut all_paths: Vec<Vec<f64>> = Vec::with_capacity(n_sims);

    for sim in 0..n_sims {
        let mut nav = config.initial_capital;
        let mut peak = nav;
        let mut max_dd = 0.0f64;
        let mut path = Vec::with_capacity(horizon);

        for t in 0..horizon {
            let idx = simple_hash(sim, t) % n_ret;
            let r = returns[idx];
            nav *= 1.0 + r;
            if nav > peak { peak = nav; }
            let dd = (peak - nav) / peak;
            if dd > max_dd { max_dd = dd; }
            path.push(nav);
        }

        final_navs.push(nav);
        max_drawdowns.push(max_dd);
        all_paths.push(path);
    }

    for t in 0..horizon {
        let mut vals: Vec<f64> = all_paths.iter().map(|p| p[t]).collect();
        vals.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
        let n = vals.len();
        paths_p5[t] = vals[(0.05 * n as f64) as usize];
        paths_p25[t] = vals[(0.25 * n as f64) as usize];
        paths_p50[t] = vals[(0.50 * n as f64) as usize];
        paths_p75[t] = vals[(0.75 * n as f64) as usize];
        paths_p95[t] = vals[(0.95 * n as f64) as usize.min(n - 1)];
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

    let expected = final_navs.iter().sum::<f64>() / n as f64;
    let prob_loss = final_navs.iter().filter(|&&v| v < config.initial_capital).count() as f64 / n as f64;
    let max_dd_95 = max_drawdowns[(0.95 * n as f64) as usize.min(n - 1)];

    let wins = returns.iter().filter(|&&r| r > 0.0).count() as f64;
    let win_rate = wins / returns.len() as f64;
    let avg_win = returns.iter().filter(|&&r| r > 0.0).sum::<f64>() / wins.max(1.0);
    let losses = returns.iter().filter(|&&r| r < 0.0).count() as f64;
    let avg_loss = returns.iter().filter(|&&r| r < 0.0).map(|r| r.abs()).sum::<f64>() / losses.max(1.0);
    let kelly = if avg_loss > 0.0 { win_rate - (1.0 - win_rate) / (avg_win / avg_loss) } else { 0.0 };
    let optimal_size = (kelly * 0.5).max(0.0).min(0.25); // Half-Kelly, capped at 25%

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
    };

    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn simple_hash(sim: usize, t: usize) -> usize {
    let mut h = sim.wrapping_mul(2654435761) ^ t.wrapping_mul(40503);
    h = h.wrapping_mul(h.wrapping_add(1));
    h
}

fn decimate(data: &[f64], target: usize) -> Vec<f64> {
    if data.len() <= target { return data.iter().map(|v| round2(*v)).collect(); }
    let step = data.len() as f64 / target as f64;
    (0..target).map(|i| round2(data[(i as f64 * step) as usize])).collect()
}

fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
fn round4(v: f64) -> f64 { (v * 10000.0).round() / 10000.0 }
