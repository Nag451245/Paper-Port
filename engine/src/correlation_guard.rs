//! Correlation-aware position management module.
//! Blocks entries when portfolio-level correlation or sector concentration exceeds thresholds.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::utils::pearson_correlation;

const DEFAULT_MAX_CORRELATION: f64 = 0.7;
const DEFAULT_MAX_SECTOR_CONCENTRATION: f64 = 0.4;

#[derive(Deserialize)]
pub struct CorrelationGuardInput {
    pub command: String,
    pub current_positions: Vec<PositionReturns>,
    pub proposed_entry: Option<ProposedEntry>,
    #[serde(default)]
    pub max_correlation: Option<f64>,
    #[serde(default)]
    pub max_sector_concentration: Option<f64>,
}

#[derive(Deserialize, Clone)]
pub struct PositionReturns {
    pub symbol: String,
    pub sector: String,
    pub returns: Vec<f64>,
    pub weight: f64,
}

#[derive(Deserialize, Clone)]
pub struct ProposedEntry {
    pub symbol: String,
    pub sector: String,
    pub returns: Vec<f64>,
}

#[derive(Serialize, Deserialize)]
pub struct EntryCheckResult {
    pub allowed: bool,
    pub reason: String,
    pub max_correlation_found: f64,
    pub correlated_with: Vec<String>,
    pub sector_concentration: f64,
    pub portfolio_risk_score: f64,
}

#[derive(Serialize, Deserialize)]
pub struct CorrelatedPair {
    pub symbol_a: String,
    pub symbol_b: String,
    pub correlation: f64,
}

#[derive(Serialize, Deserialize)]
pub struct CorrelationMatrix {
    pub symbols: Vec<String>,
    pub matrix: Vec<Vec<f64>>,
    pub high_correlation_pairs: Vec<CorrelatedPair>,
    pub portfolio_diversification_ratio: f64,
}

#[derive(Serialize, Deserialize)]
pub struct PortfolioRiskResult {
    pub portfolio_diversification_ratio: f64,
    pub sector_concentration: f64,
    pub max_sector_weight: f64,
    pub max_correlation: f64,
    pub concentration_score: f64,
}

/// Align returns to minimum length across all series for correlation computation.
fn align_returns(positions: &[PositionReturns], proposed: Option<&ProposedEntry>) -> (Vec<Vec<f64>>, Vec<String>, Vec<String>, Vec<f64>) {
    let mut min_len = usize::MAX;
    for p in positions {
        if !p.returns.is_empty() {
            min_len = min_len.min(p.returns.len());
        }
    }
    if let Some(pe) = proposed {
        if !pe.returns.is_empty() {
            min_len = min_len.min(pe.returns.len());
        }
    }
    if min_len == usize::MAX {
        min_len = 0;
    }

    let mut aligned: Vec<Vec<f64>> = Vec::new();
    let mut symbols: Vec<String> = Vec::new();
    let mut sectors: Vec<String> = Vec::new();
    let mut weights: Vec<f64> = Vec::new();

    for p in positions {
        if p.returns.len() >= min_len && min_len >= 2 {
            aligned.push(p.returns[..min_len].to_vec());
            symbols.push(p.symbol.clone());
            sectors.push(p.sector.clone());
            weights.push(p.weight);
        }
    }
    if let Some(pe) = proposed {
        if pe.returns.len() >= min_len && min_len >= 2 {
            aligned.push(pe.returns[..min_len].to_vec());
            symbols.push(pe.symbol.clone());
            sectors.push(pe.sector.clone());
            weights.push(0.0);
        }
    }

    (aligned, symbols, sectors, weights)
}

fn compute_correlation_matrix(returns: &[Vec<f64>]) -> Vec<Vec<f64>> {
    let n = returns.len();
    let mut matrix = vec![vec![0.0; n]; n];
    for i in 0..n {
        matrix[i][i] = 1.0;
        for j in (i + 1)..n {
            let c = pearson_correlation(&returns[i], &returns[j]);
            matrix[i][j] = c;
            matrix[j][i] = c;
        }
    }
    matrix
}

fn sector_concentration(sectors: &[String], weights: &[f64]) -> (f64, f64) {
    if sectors.is_empty() || weights.is_empty() {
        return (0.0, 0.0);
    }
    let total: f64 = weights.iter().sum();
    if total <= 0.0 {
        return (0.0, 0.0);
    }
    let mut sector_weights: std::collections::HashMap<String, f64> = std::collections::HashMap::new();
    for (sector, &w) in sectors.iter().zip(weights.iter()) {
        *sector_weights.entry(sector.clone()).or_insert(0.0) += w;
    }
    let max_sector: f64 = sector_weights.values().cloned().fold(0.0, f64::max);
    let max_sector_weight = max_sector / total;
    let herfindahl: f64 = sector_weights.values()
        .map(|&w| (w / total).powi(2))
        .sum();
    (max_sector_weight, herfindahl)
}

fn portfolio_diversification_ratio(returns: &[Vec<f64>], weights: &[f64]) -> f64 {
    let n = returns.len();
    if n < 2 || weights.len() != n {
        return 1.0;
    }
    let total_w: f64 = weights.iter().sum();
    if total_w <= 0.0 {
        return 1.0;
    }
    let min_len = returns.iter().map(|r| r.len()).min().unwrap_or(0);
    if min_len < 2 {
        return 1.0;
    }

    let mut individual_vols = Vec::with_capacity(n);
    for r in returns {
        let mean = r[..min_len].iter().sum::<f64>() / min_len as f64;
        let var = r[..min_len].iter().map(|x| (x - mean).powi(2)).sum::<f64>() / min_len as f64;
        individual_vols.push(var.sqrt());
    }

    let avg_vol: f64 = individual_vols.iter().zip(weights.iter())
        .map(|(v, w)| v * w / total_w)
        .sum();

    let mut port_returns = vec![0.0; min_len];
    for (r, w) in returns.iter().zip(weights.iter()) {
        let w_norm = w / total_w;
        for (i, &ret) in r[..min_len].iter().enumerate() {
            port_returns[i] += ret * w_norm;
        }
    }
    let port_mean = port_returns.iter().sum::<f64>() / min_len as f64;
    let port_var = port_returns.iter().map(|x| (x - port_mean).powi(2)).sum::<f64>() / min_len as f64;
    let port_vol = port_var.sqrt();

    if port_vol > 0.0 && avg_vol > 0.0 {
        avg_vol / port_vol
    } else {
        1.0
    }
}

fn portfolio_risk_score(
    matrix: &[Vec<f64>],
    sector_conc: f64,
    diversification: f64,
) -> f64 {
    let n = matrix.len();
    if n < 2 {
        return 0.0;
    }
    let mut avg_corr = 0.0;
    let mut count = 0usize;
    for i in 0..n {
        for j in (i + 1)..n {
            avg_corr += matrix[i][j].abs();
            count += 1;
        }
    }
    let avg_corr = if count > 0 { avg_corr / count as f64 } else { 0.0 };
    let corr_risk = avg_corr;
    let sector_risk = sector_conc;
    let div_penalty = if diversification < 1.0 { 1.0 - diversification } else { 0.0 };
    (corr_risk * 0.4 + sector_risk * 0.4 + div_penalty * 0.2).min(1.0)
}

fn high_correlation_pairs(matrix: &[Vec<f64>], symbols: &[String], threshold: f64) -> Vec<CorrelatedPair> {
    let mut pairs = Vec::new();
    for i in 0..matrix.len() {
        for j in (i + 1)..matrix.len() {
            let c = matrix[i][j];
            if c.abs() >= threshold {
                pairs.push(CorrelatedPair {
                    symbol_a: symbols[i].clone(),
                    symbol_b: symbols[j].clone(),
                    correlation: (c * 10000.0).round() / 10000.0,
                });
            }
        }
    }
    pairs.sort_by(|a, b| b.correlation.abs().partial_cmp(&a.correlation.abs()).unwrap_or(std::cmp::Ordering::Equal));
    pairs
}

fn round4(x: f64) -> f64 {
    (x * 10000.0).round() / 10000.0
}

pub fn compute(data: Value) -> Result<Value, String> {
    let input: CorrelationGuardInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid correlation_guard input: {}", e))?;

    let max_corr = input.max_correlation.unwrap_or(DEFAULT_MAX_CORRELATION);
    let max_sector = input.max_sector_concentration.unwrap_or(DEFAULT_MAX_SECTOR_CONCENTRATION);

    match input.command.as_str() {
        "check_entry" => {
            let proposed = input.proposed_entry.as_ref()
                .ok_or_else(|| "check_entry requires proposed_entry".to_string())?;

            let (aligned, symbols, sectors, weights) = align_returns(
                &input.current_positions,
                Some(proposed),
            );

            if aligned.is_empty() {
                return Ok(serde_json::to_value(EntryCheckResult {
                    allowed: true,
                    reason: "No existing positions with sufficient return history; entry allowed".to_string(),
                    max_correlation_found: 0.0,
                    correlated_with: vec![],
                    sector_concentration: 1.0,
                    portfolio_risk_score: 0.0,
                }).map_err(|e| e.to_string())?);
            }

            let matrix = compute_correlation_matrix(&aligned);
            let (sector_conc, _herfindahl) = sector_concentration(&sectors, &weights);
            let div_ratio = portfolio_diversification_ratio(&aligned, &weights);
            let risk_score = portfolio_risk_score(&matrix, sector_conc, div_ratio);

            let proposed_idx = symbols.iter().position(|s| s == &proposed.symbol).unwrap_or(symbols.len() - 1);
            let mut max_corr_found = 0.0f64;
            let mut correlated_with = Vec::new();

            for (i, sym) in symbols.iter().enumerate() {
                if i != proposed_idx {
                    let c = matrix[proposed_idx][i];
                    let abs_c = c.abs();
                    if abs_c > max_corr_found {
                        max_corr_found = abs_c;
                    }
                    if abs_c >= max_corr {
                        correlated_with.push(sym.clone());
                    }
                }
            }

            let blocked_by_corr = max_corr_found >= max_corr;
            let blocked_by_sector = sector_conc >= max_sector;

            let (allowed, reason) = if blocked_by_corr && blocked_by_sector {
                (false, format!(
                    "Blocked: correlation {:.4} >= {} and sector concentration {:.2}% >= {:.0}%",
                    max_corr_found, max_corr, sector_conc * 100.0, max_sector * 100.0
                ))
            } else if blocked_by_corr {
                (false, format!(
                    "Blocked: max correlation {:.4} with {:?} exceeds threshold {}",
                    max_corr_found, correlated_with, max_corr
                ))
            } else if blocked_by_sector {
                (false, format!(
                    "Blocked: sector concentration {:.2}% exceeds threshold {:.0}%",
                    sector_conc * 100.0, max_sector * 100.0
                ))
            } else {
                (true, "Entry allowed".to_string())
            };

            Ok(serde_json::to_value(EntryCheckResult {
                allowed,
                reason,
                max_correlation_found: round4(max_corr_found),
                correlated_with,
                sector_concentration: round4(sector_conc),
                portfolio_risk_score: round4(risk_score),
            }).map_err(|e| e.to_string())?)
        }

        "matrix" => {
            let (aligned, symbols, _sectors, weights) = align_returns(
                &input.current_positions,
                input.proposed_entry.as_ref(),
            );

            if aligned.len() < 2 {
                return Ok(serde_json::to_value(CorrelationMatrix {
                    symbols: symbols.clone(),
                    matrix: if aligned.is_empty() { vec![] } else { vec![vec![1.0]] },
                    high_correlation_pairs: vec![],
                    portfolio_diversification_ratio: 1.0,
                }).map_err(|e| e.to_string())?);
            }

            let matrix: Vec<Vec<f64>> = compute_correlation_matrix(&aligned)
                .into_iter()
                .map(|row| row.into_iter().map(round4).collect())
                .collect();

            let high_pairs = high_correlation_pairs(&matrix, &symbols, max_corr);
            let div_ratio = portfolio_diversification_ratio(&aligned, &weights);

            Ok(serde_json::to_value(CorrelationMatrix {
                symbols,
                matrix,
                high_correlation_pairs: high_pairs,
                portfolio_diversification_ratio: round4(div_ratio),
            }).map_err(|e| e.to_string())?)
        }

        "portfolio_risk" => {
            let (aligned, _symbols, sectors, weights) = align_returns(
                &input.current_positions,
                input.proposed_entry.as_ref(),
            );

            if aligned.is_empty() {
                return Ok(serde_json::to_value(PortfolioRiskResult {
                    portfolio_diversification_ratio: 1.0,
                    sector_concentration: 0.0,
                    max_sector_weight: 0.0,
                    max_correlation: 0.0,
                    concentration_score: 0.0,
                }).map_err(|e| e.to_string())?);
            }

            let matrix = compute_correlation_matrix(&aligned);
            let (max_sector_weight, concentration_score) = sector_concentration(&sectors, &weights);
            let div_ratio = portfolio_diversification_ratio(&aligned, &weights);

            let max_corr = matrix.iter()
                .enumerate()
                .flat_map(|(i, row)| row.iter().enumerate().skip(i + 1).map(move |(j, &c)| (i, j, c)))
                .map(|(_, _, c)| c.abs())
                .fold(0.0f64, f64::max);

            Ok(serde_json::to_value(PortfolioRiskResult {
                portfolio_diversification_ratio: round4(div_ratio),
                sector_concentration: round4(max_sector_weight),
                max_sector_weight: round4(max_sector_weight),
                max_correlation: round4(max_corr),
                concentration_score: round4(concentration_score),
            }).map_err(|e| e.to_string())?)
        }

        _ => Err(format!("Unknown command: {}", input.command)),
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn make_returns(base: f64, noise: f64, len: usize) -> Vec<f64> {
        (0..len).map(|i| base + noise * (i as f64 * 0.1).sin()).collect()
    }

    /// Returns with different pattern for low correlation (sin vs cos vs different phase).
    fn make_returns_cos(base: f64, noise: f64, len: usize) -> Vec<f64> {
        (0..len).map(|i| base + noise * (i as f64 * 0.1).cos()).collect()
    }
    /// Returns with different frequency for low correlation.
    fn make_returns_freq(base: f64, noise: f64, len: usize, freq: f64) -> Vec<f64> {
        (0..len).map(|i| base + noise * (i as f64 * freq).sin()).collect()
    }

    #[test]
    fn test_allowed_entry() {
        // Use orthogonal patterns: sin, cos, and different freq so correlations stay low
        let returns_a = make_returns(0.01, 0.02, 50);
        let returns_b = make_returns_cos(-0.005, 0.03, 50);
        let returns_c = make_returns_freq(0.02, 0.01, 50, 0.5);
        let returns_d = make_returns_freq(-0.01, 0.02, 50, 0.23);

        let data = serde_json::json!({
            "command": "check_entry",
            "current_positions": [
                { "symbol": "A", "sector": "Tech", "returns": returns_a, "weight": 0.33 },
                { "symbol": "B", "sector": "Finance", "returns": returns_b, "weight": 0.33 },
                { "symbol": "C", "sector": "Healthcare", "returns": returns_c, "weight": 0.34 }
            ],
            "proposed_entry": { "symbol": "D", "sector": "Energy", "returns": returns_d },
            "max_correlation": 0.7,
            "max_sector_concentration": 0.4
        });

        let result = compute(data).unwrap();
        let out: EntryCheckResult = serde_json::from_value(result).unwrap();
        assert!(out.allowed, "Entry should be allowed: {}", out.reason);
        assert!(out.max_correlation_found < 0.7);
    }

    #[test]
    fn test_blocked_by_correlation() {
        let same_series = make_returns(0.01, 0.02, 50);
        let almost_same = same_series.iter().map(|x| x + 0.001).collect::<Vec<f64>>();

        let data = serde_json::json!({
            "command": "check_entry",
            "current_positions": [
                { "symbol": "A", "sector": "Tech", "returns": same_series.clone(), "weight": 0.5 },
                { "symbol": "B", "sector": "Finance", "returns": almost_same.clone(), "weight": 0.5 }
            ],
            "proposed_entry": { "symbol": "C", "sector": "Healthcare", "returns": same_series },
            "max_correlation": 0.7
        });

        let result = compute(data).unwrap();
        let out: EntryCheckResult = serde_json::from_value(result).unwrap();
        assert!(!out.allowed);
        assert!(out.reason.contains("correlation") || out.reason.contains("Blocked"));
    }

    #[test]
    fn test_blocked_by_sector() {
        let r1 = make_returns(0.01, 0.02, 50);
        let r2 = make_returns(-0.01, 0.02, 50);
        let r3 = make_returns(0.005, 0.02, 50);

        let data = serde_json::json!({
            "command": "check_entry",
            "current_positions": [
                { "symbol": "A", "sector": "Tech", "returns": r1.clone(), "weight": 0.5 },
                { "symbol": "B", "sector": "Tech", "returns": r2.clone(), "weight": 0.5 }
            ],
            "proposed_entry": { "symbol": "C", "sector": "Tech", "returns": r3 },
            "max_correlation": 0.95,
            "max_sector_concentration": 0.4
        });

        let result = compute(data).unwrap();
        let out: EntryCheckResult = serde_json::from_value(result).unwrap();
        assert!(!out.allowed);
        assert!(out.reason.contains("sector") || out.reason.contains("Blocked"));
    }

    #[test]
    fn test_matrix_computation() {
        let r1 = make_returns(0.01, 0.02, 50);
        let r2 = make_returns(-0.01, 0.03, 50);
        let r3 = make_returns(0.005, 0.01, 50);

        let data = serde_json::json!({
            "command": "matrix",
            "current_positions": [
                { "symbol": "A", "sector": "Tech", "returns": r1, "weight": 0.33 },
                { "symbol": "B", "sector": "Finance", "returns": r2, "weight": 0.33 },
                { "symbol": "C", "sector": "Healthcare", "returns": r3, "weight": 0.34 }
            ]
        });

        let result = compute(data).unwrap();
        let out: CorrelationMatrix = serde_json::from_value(result).unwrap();
        assert_eq!(out.symbols.len(), 3);
        assert_eq!(out.matrix.len(), 3);
        assert_eq!(out.matrix[0].len(), 3);
        assert!((out.matrix[0][0] - 1.0).abs() < 1e-6);
        assert!(out.portfolio_diversification_ratio > 0.0);
    }

    #[test]
    fn test_empty_portfolio() {
        let r = make_returns(0.01, 0.02, 50);

        let data = serde_json::json!({
            "command": "check_entry",
            "current_positions": [],
            "proposed_entry": { "symbol": "NEW", "sector": "Tech", "returns": r }
        });

        let result = compute(data).unwrap();
        let out: EntryCheckResult = serde_json::from_value(result).unwrap();
        assert!(out.allowed);
        assert_eq!(out.max_correlation_found, 0.0);
        assert!(out.correlated_with.is_empty());
    }

    #[test]
    fn test_portfolio_risk_command() {
        let r1 = make_returns(0.01, 0.02, 50);
        let r2 = make_returns(-0.01, 0.02, 50);

        let data = serde_json::json!({
            "command": "portfolio_risk",
            "current_positions": [
                { "symbol": "A", "sector": "Tech", "returns": r1, "weight": 0.5 },
                { "symbol": "B", "sector": "Finance", "returns": r2, "weight": 0.5 }
            ]
        });

        let result = compute(data).unwrap();
        let out: PortfolioRiskResult = serde_json::from_value(result).unwrap();
        assert!(out.portfolio_diversification_ratio > 0.0);
        assert!(out.sector_concentration <= 1.0);
        assert!(out.max_correlation <= 1.0);
        assert!(out.concentration_score >= 0.0);
    }

    #[test]
    fn test_matrix_empty_portfolio() {
        let data = serde_json::json!({
            "command": "matrix",
            "current_positions": []
        });

        let result = compute(data).unwrap();
        let out: CorrelationMatrix = serde_json::from_value(result).unwrap();
        assert!(out.symbols.is_empty());
        assert!(out.matrix.is_empty());
        assert!(out.high_correlation_pairs.is_empty());
    }
}
