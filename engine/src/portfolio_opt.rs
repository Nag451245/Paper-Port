use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Config {
    assets: Vec<AssetData>,
    risk_free_rate: Option<f64>,
    num_portfolios: Option<usize>,
    target_return: Option<f64>,
    views: Option<Vec<View>>,
}

#[derive(Deserialize)]
struct AssetData {
    symbol: String,
    returns: Vec<f64>,
    expected_return: Option<f64>,
}

#[derive(Deserialize)]
struct View {
    asset_index: usize,
    expected_return: f64,
    confidence: f64,
}

#[derive(Serialize)]
struct OptResult {
    min_variance: PortfolioPoint,
    max_sharpe: PortfolioPoint,
    efficient_frontier: Vec<PortfolioPoint>,
    correlation_matrix: Vec<Vec<f64>>,
    covariance_matrix: Vec<Vec<f64>>,
    asset_stats: Vec<AssetStat>,
}

#[derive(Serialize, Clone)]
struct PortfolioPoint {
    weights: Vec<f64>,
    expected_return: f64,
    volatility: f64,
    sharpe_ratio: f64,
}

#[derive(Serialize)]
struct AssetStat {
    symbol: String,
    mean_return: f64,
    volatility: f64,
    sharpe: f64,
}

pub fn compute(data: serde_json::Value) -> Result<serde_json::Value, String> {
    let config: Config = serde_json::from_value(data).map_err(|e| format!("Invalid input: {}", e))?;
    let n = config.assets.len();
    if n < 2 { return Err("Need at least 2 assets".into()); }

    let rf = config.risk_free_rate.unwrap_or(0.065);
    let num_ports = config.num_portfolios.unwrap_or(5000).min(20_000);

    let min_len = config.assets.iter().map(|a| a.returns.len()).min().unwrap_or(0);
    if min_len < 10 { return Err("Need at least 10 return observations per asset".into()); }

    let means: Vec<f64> = config.assets.iter().map(|a| {
        a.expected_return.unwrap_or_else(|| {
            let s: f64 = a.returns.iter().sum();
            (s / a.returns.len() as f64) * 252.0
        })
    }).collect();

    let mut cov = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        let mi = means[i] / 252.0;
        for j in 0..n {
            let mj = means[j] / 252.0;
            let mut sum = 0.0;
            for t in 0..min_len {
                sum += (config.assets[i].returns[t] - mi) * (config.assets[j].returns[t] - mj);
            }
            cov[i][j] = (sum / (min_len - 1) as f64) * 252.0;
        }
    }

    let mut corr = vec![vec![0.0f64; n]; n];
    for i in 0..n {
        for j in 0..n {
            let denom = (cov[i][i] * cov[j][j]).sqrt();
            corr[i][j] = if denom > 0.0 { round4(cov[i][j] / denom) } else { 0.0 };
        }
    }

    // Apply Black-Litterman if views are provided
    let adj_means = if let Some(views) = &config.views {
        apply_black_litterman(&means, &cov, views, rf)
    } else {
        means.clone()
    };

    let mut best_sharpe = PortfolioPoint { weights: vec![1.0 / n as f64; n], expected_return: 0.0, volatility: 1.0, sharpe_ratio: -999.0 };
    let mut min_var = PortfolioPoint { weights: vec![1.0 / n as f64; n], expected_return: 0.0, volatility: 999.0, sharpe_ratio: 0.0 };
    let mut frontier: Vec<PortfolioPoint> = Vec::new();

    for sim in 0..num_ports {
        let w = random_weights(n, sim);
        let ret = portfolio_return(&w, &adj_means);
        let vol = portfolio_vol(&w, &cov);
        let sharpe = if vol > 0.0 { (ret - rf) / vol } else { 0.0 };
        let pt = PortfolioPoint { weights: w.iter().map(|v| round4(*v)).collect(), expected_return: round4(ret), volatility: round4(vol), sharpe_ratio: round4(sharpe) };

        if sharpe > best_sharpe.sharpe_ratio { best_sharpe = pt.clone(); }
        if vol < min_var.volatility { min_var = pt.clone(); }
        frontier.push(pt);
    }

    frontier.sort_by(|a, b| a.volatility.partial_cmp(&b.volatility).unwrap_or(std::cmp::Ordering::Equal));
    let step = (frontier.len() as f64 / 50.0).max(1.0) as usize;
    let sampled: Vec<PortfolioPoint> = frontier.iter().step_by(step).cloned().collect();

    let asset_stats: Vec<AssetStat> = config.assets.iter().enumerate().map(|(i, a)| {
        let vol = cov[i][i].sqrt();
        AssetStat {
            symbol: a.symbol.clone(),
            mean_return: round4(adj_means[i]),
            volatility: round4(vol),
            sharpe: round4(if vol > 0.0 { (adj_means[i] - rf) / vol } else { 0.0 }),
        }
    }).collect();

    let result = OptResult {
        min_variance: min_var,
        max_sharpe: best_sharpe,
        efficient_frontier: sampled,
        correlation_matrix: corr,
        covariance_matrix: cov.iter().map(|row| row.iter().map(|v| round4(*v)).collect()).collect(),
        asset_stats,
    };

    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn apply_black_litterman(prior_means: &[f64], cov: &[Vec<f64>], views: &[View], _rf: f64) -> Vec<f64> {
    let n = prior_means.len();
    let tau = 0.05;
    let mut adjusted = prior_means.to_vec();
    for view in views {
        if view.asset_index < n {
            let blend = view.confidence.min(1.0).max(0.0);
            let omega = cov[view.asset_index][view.asset_index] * tau / blend.max(0.01);
            let scale = tau * cov[view.asset_index][view.asset_index];
            let weight = scale / (scale + omega);
            adjusted[view.asset_index] = prior_means[view.asset_index] * (1.0 - weight) + view.expected_return * weight;
        }
    }
    adjusted
}

fn random_weights(n: usize, seed: usize) -> Vec<f64> {
    let mut w = Vec::with_capacity(n);
    let mut sum = 0.0;
    for i in 0..n {
        let v = ((seed.wrapping_mul(2654435761).wrapping_add(i.wrapping_mul(40503))) as f64 / usize::MAX as f64).abs();
        w.push(v + 0.001);
        sum += v + 0.001;
    }
    for x in w.iter_mut() { *x /= sum; }
    w
}

fn portfolio_return(w: &[f64], means: &[f64]) -> f64 {
    w.iter().zip(means).map(|(wi, mi)| wi * mi).sum()
}

fn portfolio_vol(w: &[f64], cov: &[Vec<f64>]) -> f64 {
    let n = w.len();
    let mut var = 0.0;
    for i in 0..n {
        for j in 0..n {
            var += w[i] * w[j] * cov[i][j];
        }
    }
    var.max(0.0).sqrt()
}

fn round4(v: f64) -> f64 { (v * 10000.0).round() / 10000.0 }
