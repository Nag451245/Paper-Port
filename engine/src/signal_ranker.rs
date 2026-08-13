//! Alert fatigue prevention — signal prioritization by expected edge.
//! Ranks signals by expected_edge = sharpe_contribution * confidence * liquidity_factor,
//! applies diversity filters (max per sector, max same-direction), and returns top N.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::HashMap;

/// Raw input signal.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RawSignal {
    pub symbol: String,
    pub direction: String,
    pub confidence: f64,
    pub strategy: String,
    #[serde(default)]
    pub avg_volume: Option<f64>,
    #[serde(default)]
    pub recent_sharpe: Option<f64>,
    #[serde(default)]
    pub liquidity_score: Option<f64>,
    #[serde(default)]
    pub sector: Option<String>,
}

/// Ranker input with configurable limits.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankerInput {
    pub signals: Vec<RawSignal>,
    #[serde(default)]
    pub max_signals: Option<usize>,
    #[serde(default)]
    pub max_per_sector: Option<usize>,
    #[serde(default)]
    pub max_same_direction: Option<usize>,
}

/// Ranked signal with expected_edge.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankedSignal {
    pub symbol: String,
    pub direction: String,
    pub confidence: f64,
    pub strategy: String,
    pub expected_edge: f64,
    pub rank: usize,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub sector: Option<String>,
}

/// Summary of filter application.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct FilterSummary {
    pub sector_capped: usize,
    pub direction_capped: usize,
    pub max_signals_capped: usize,
}

/// Ranker output.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct RankerOutput {
    pub ranked_signals: Vec<RankedSignal>,
    pub total_input: usize,
    pub total_filtered: usize,
    pub filter_summary: FilterSummary,
}

const DEFAULT_MAX_SIGNALS: usize = 10;
const DEFAULT_MAX_PER_SECTOR: usize = 2;
const DEFAULT_MAX_SAME_DIRECTION: usize = 3;

fn liquidity_factor(liq: f64) -> f64 {
    if liq <= 0.0 {
        0.5
    } else if liq >= 1.0 {
        1.0
    } else {
        0.5 + liq * 0.5
    }
}

fn compute_expected_edge(s: &RawSignal) -> f64 {
    let sharpe = s.recent_sharpe.unwrap_or(0.5).max(0.0).min(2.0);
    let confidence = s.confidence.clamp(0.0, 1.0);
    let liq = s.liquidity_score.unwrap_or(0.7);
    let liq_factor = liquidity_factor(liq);
    sharpe * confidence * liq_factor
}

/// JSON API entry point. Accepts RankerInput as JSON, returns RankerOutput.
pub fn compute(data: Value) -> Result<Value, String> {
    let input: RankerInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid ranker input: {}", e))?;

    let max_signals = input.max_signals.unwrap_or(DEFAULT_MAX_SIGNALS);
    let max_per_sector = input.max_per_sector.unwrap_or(DEFAULT_MAX_PER_SECTOR);
    let max_same_direction = input.max_same_direction.unwrap_or(DEFAULT_MAX_SAME_DIRECTION);

    let total_input = input.signals.len();

    if input.signals.is_empty() {
        return Ok(serde_json::to_value(RankerOutput {
            ranked_signals: Vec::new(),
            total_input: 0,
            total_filtered: 0,
            filter_summary: FilterSummary {
                sector_capped: 0,
                direction_capped: 0,
                max_signals_capped: 0,
            },
        })
        .map_err(|e| format!("Serialization error: {}", e))?);
    }

    let mut with_edge: Vec<(RawSignal, f64)> = input
        .signals
        .into_iter()
        .map(|s| {
            let edge = compute_expected_edge(&s);
            (s, edge)
        })
        .collect();

    with_edge.sort_by(|a, b| b.1.partial_cmp(&a.1).unwrap_or(std::cmp::Ordering::Equal));

    let mut sector_count: HashMap<String, usize> = HashMap::new();
    let mut direction_count: HashMap<String, usize> = HashMap::new();
    let mut sector_capped = 0usize;
    let mut direction_capped = 0usize;

    let mut ranked: Vec<RankedSignal> = Vec::new();
    for (i, (s, edge)) in with_edge.into_iter().enumerate() {
        if ranked.len() >= max_signals {
            break;
        }

        let sector = s.sector.clone().unwrap_or_else(|| "unknown".to_string());
        let dir = s.direction.to_lowercase();
        let dir_key = if dir.contains("sell") || dir.contains("short") {
            "sell"
        } else {
            "buy"
        };

        let sector_ok = sector == "unknown" || *sector_count.get(&sector).unwrap_or(&0) < max_per_sector;
        let dir_ok = *direction_count.get(dir_key).unwrap_or(&0) < max_same_direction;

        if !sector_ok {
            sector_capped += 1;
            continue;
        }
        if !dir_ok {
            direction_capped += 1;
            continue;
        }

        *sector_count.entry(sector.clone()).or_insert(0) += 1;
        *direction_count.entry(dir_key.to_string()).or_insert(0) += 1;

        ranked.push(RankedSignal {
            symbol: s.symbol,
            direction: s.direction,
            confidence: s.confidence,
            strategy: s.strategy,
            expected_edge: (edge * 1000.0).round() / 1000.0,
            rank: ranked.len() + 1,
            sector: Some(sector).filter(|x| x != "unknown"),
        });
    }

    let max_signals_capped = total_input.saturating_sub(ranked.len()).saturating_sub(sector_capped).saturating_sub(direction_capped);
    let total_filtered = ranked.len();

    let output = RankerOutput {
        ranked_signals: ranked,
        total_input,
        total_filtered,
        filter_summary: FilterSummary {
            sector_capped,
            direction_capped,
            max_signals_capped,
        },
    };

    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn sig(symbol: &str, direction: &str, confidence: f64, strategy: &str) -> RawSignal {
        RawSignal {
            symbol: symbol.into(),
            direction: direction.into(),
            confidence,
            strategy: strategy.into(),
            avg_volume: Some(1_000_000.0),
            recent_sharpe: Some(1.0),
            liquidity_score: Some(0.8),
            sector: None,
        }
    }

    fn sig_with_sector(symbol: &str, direction: &str, confidence: f64, sector: &str) -> RawSignal {
        RawSignal {
            symbol: symbol.into(),
            direction: direction.into(),
            confidence,
            strategy: "test".into(),
            avg_volume: None,
            recent_sharpe: Some(1.0),
            liquidity_score: Some(0.8),
            sector: Some(sector.into()),
        }
    }

    #[test]
    fn test_basic_ranking() {
        let input = json!({
            "signals": [
                { "symbol": "A", "direction": "buy", "confidence": 0.9, "strategy": "s1", "recent_sharpe": 1.5, "liquidity_score": 0.9 },
                { "symbol": "B", "direction": "buy", "confidence": 0.5, "strategy": "s2", "recent_sharpe": 1.0, "liquidity_score": 0.5 },
                { "symbol": "C", "direction": "sell", "confidence": 0.8, "strategy": "s3", "recent_sharpe": 1.2, "liquidity_score": 0.7 },
            ]
        });
        let result = compute(input).unwrap();
        let out: RankerOutput = serde_json::from_value(result).unwrap();
        assert_eq!(out.total_input, 3);
        assert_eq!(out.ranked_signals.len(), 3);
        assert!(out.ranked_signals[0].expected_edge >= out.ranked_signals[1].expected_edge);
        assert!(out.ranked_signals[1].expected_edge >= out.ranked_signals[2].expected_edge);
    }

    #[test]
    fn test_sector_cap() {
        let signals: Vec<RawSignal> = (0..6)
            .map(|i| sig_with_sector(
                &format!("S{}", i),
                "buy",
                0.8,
                if i < 3 { "IT" } else { "Banking" },
            ))
            .collect();
        let input = json!({
            "signals": signals,
            "max_signals": 10,
            "max_per_sector": 2,
            "max_same_direction": 5
        });
        let result = compute(serde_json::to_value(input).unwrap()).unwrap();
        let out: RankerOutput = serde_json::from_value(result).unwrap();
        let it_count = out.ranked_signals.iter().filter(|s| s.sector.as_deref() == Some("IT")).count();
        let bank_count = out.ranked_signals.iter().filter(|s| s.sector.as_deref() == Some("Banking")).count();
        assert!(it_count <= 2, "IT sector should be capped at 2, got {}", it_count);
        assert!(bank_count <= 2, "Banking sector should be capped at 2, got {}", bank_count);
        assert!(out.filter_summary.sector_capped >= 2);
    }

    #[test]
    fn test_direction_cap() {
        let signals: Vec<RawSignal> = (0..6)
            .map(|i| sig(&format!("X{}", i), "buy", 0.7 + i as f64 * 0.05, "s"))
            .collect();
        let input = json!({
            "signals": signals,
            "max_signals": 10,
            "max_per_sector": 10,
            "max_same_direction": 3
        });
        let result = compute(serde_json::to_value(input).unwrap()).unwrap();
        let out: RankerOutput = serde_json::from_value(result).unwrap();
        assert!(out.ranked_signals.len() <= 3, "same direction should be capped at 3");
        assert!(out.filter_summary.direction_capped >= 3);
    }

    #[test]
    fn test_empty_signals() {
        let input = json!({ "signals": [] });
        let result = compute(input).unwrap();
        let out: RankerOutput = serde_json::from_value(result).unwrap();
        assert_eq!(out.total_input, 0);
        assert_eq!(out.ranked_signals.len(), 0);
        assert_eq!(out.total_filtered, 0);
    }

    #[test]
    fn test_single_signal() {
        let input = json!({
            "signals": [
                { "symbol": "ONLY", "direction": "buy", "confidence": 0.95, "strategy": "s1" }
            ]
        });
        let result = compute(input).unwrap();
        let out: RankerOutput = serde_json::from_value(result).unwrap();
        assert_eq!(out.total_input, 1);
        assert_eq!(out.ranked_signals.len(), 1);
        assert_eq!(out.ranked_signals[0].symbol, "ONLY");
        assert_eq!(out.ranked_signals[0].rank, 1);
    }

    #[test]
    fn test_max_signals_default() {
        let signals: Vec<RawSignal> = (0..15)
            .map(|i| sig(&format!("T{}", i), if i % 2 == 0 { "buy" } else { "sell" }, 0.6, "s"))
            .collect();
        let input = json!({ "signals": signals });
        let result = compute(serde_json::to_value(input).unwrap()).unwrap();
        let out: RankerOutput = serde_json::from_value(result).unwrap();
        assert!(out.ranked_signals.len() <= 10, "default max_signals should be 10");
    }
}
