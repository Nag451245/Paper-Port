use serde::{Deserialize, Serialize};

#[derive(Deserialize)]
struct Config {
    command: String,
    candles: Option<Vec<Candle>>,
    features: Option<Vec<Vec<f64>>>,
    lookback: Option<usize>,
}

#[derive(Deserialize)]
struct Candle {
    timestamp: String,
    open: f64,
    high: f64,
    low: f64,
    close: f64,
    volume: f64,
}

#[derive(Serialize)]
struct FeatureResult {
    features: Option<FeatureMatrix>,
    regime: Option<RegimeResult>,
    anomalies: Option<Vec<AnomalyPoint>>,
}

#[derive(Serialize)]
struct FeatureMatrix {
    columns: Vec<String>,
    data: Vec<Vec<f64>>,
}

#[derive(Serialize)]
struct RegimeResult {
    current_regime: String,
    regime_history: Vec<RegimePoint>,
    transition_probabilities: Vec<Vec<f64>>,
    regime_stats: Vec<RegimeStat>,
}

#[derive(Serialize)]
struct RegimePoint {
    timestamp: String,
    regime: String,
    confidence: f64,
}

#[derive(Serialize)]
struct RegimeStat {
    regime: String,
    avg_return: f64,
    volatility: f64,
    avg_duration: f64,
    frequency: f64,
}

#[derive(Serialize)]
struct AnomalyPoint {
    timestamp: String,
    index: usize,
    score: f64,
    anomaly_type: String,
    details: String,
}

pub fn compute(data: serde_json::Value) -> Result<serde_json::Value, String> {
    let config: Config = serde_json::from_value(data).map_err(|e| format!("Invalid input: {}", e))?;

    match config.command.as_str() {
        "extract_features" => extract_features(config),
        "detect_regime" => detect_regime(config),
        "detect_anomalies" => detect_anomalies(config),
        _ => Err(format!("Unknown feature_store command: {}", config.command)),
    }
}

fn extract_features(config: Config) -> Result<serde_json::Value, String> {
    let candles = config.candles.ok_or("candles required")?;
    let n = candles.len();
    if n < 30 { return Err("Need at least 30 candles".into()); }

    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let highs: Vec<f64> = candles.iter().map(|c| c.high).collect();
    let lows: Vec<f64> = candles.iter().map(|c| c.low).collect();
    let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();
    let opens: Vec<f64> = candles.iter().map(|c| c.open).collect();

    let returns: Vec<f64> = (1..n).map(|i| {
        if closes[i] > 0.0 && closes[i-1] > 0.0 { (closes[i] / closes[i-1]).ln() } else { 0.0 }
    }).collect();

    let columns = vec![
        "return".into(), "log_return_5d".into(), "log_return_10d".into(),
        "volatility_10d".into(), "volatility_20d".into(),
        "rsi_14".into(), "rsi_7".into(),
        "ema_ratio_9_21".into(), "bb_position".into(),
        "volume_ratio".into(), "atr_ratio".into(),
        "body_ratio".into(), "upper_shadow".into(), "lower_shadow".into(),
        "gap".into(), "high_low_range".into(),
    ];

    let mut data: Vec<Vec<f64>> = Vec::new();

    for i in 0..returns.len() {
        let idx = i + 1;
        let ret = returns[i];
        let ret_5d = if i >= 5 { (closes[idx] / closes[idx - 5]).ln() } else { 0.0 };
        let ret_10d = if i >= 10 { (closes[idx] / closes[idx - 10]).ln() } else { 0.0 };

        let vol_10 = if i >= 10 { rolling_std(&returns[i-9..=i]) } else { 0.0 };
        let vol_20 = if i >= 20 { rolling_std(&returns[i-19..=i]) } else { 0.0 };

        let rsi_14 = if idx >= 14 { calc_rsi(&closes[..=idx], 14) } else { 50.0 };
        let rsi_7 = if idx >= 7 { calc_rsi(&closes[..=idx], 7) } else { 50.0 };

        let ema9 = ema(&closes[..=idx], 9.min(idx + 1));
        let ema21 = ema(&closes[..=idx], 21.min(idx + 1));
        let ema_ratio = if ema21 > 0.0 { ema9 / ema21 } else { 1.0 };

        let (bb_upper, bb_lower) = if idx >= 20 {
            let sma = closes[idx-19..=idx].iter().sum::<f64>() / 20.0;
            let std = rolling_std(&closes[idx-19..=idx]);
            (sma + 2.0 * std, sma - 2.0 * std)
        } else { (closes[idx] * 1.1, closes[idx] * 0.9) };
        let bb_pos = if bb_upper != bb_lower { (closes[idx] - bb_lower) / (bb_upper - bb_lower) } else { 0.5 };

        let vol_avg = if idx >= 20 { volumes[idx-19..=idx].iter().sum::<f64>() / 20.0 } else { volumes[idx] };
        let vol_ratio = if vol_avg > 0.0 { volumes[idx] / vol_avg } else { 1.0 };

        let atr = if idx >= 14 { calc_atr(&highs[..=idx], &lows[..=idx], &closes[..=idx], 14) } else { highs[idx] - lows[idx] };
        let atr_ratio = if closes[idx] > 0.0 { atr / closes[idx] } else { 0.0 };

        let body = (closes[idx] - opens[idx]).abs();
        let range = highs[idx] - lows[idx];
        let body_ratio = if range > 0.0 { body / range } else { 0.0 };
        let upper_shadow = if range > 0.0 { (highs[idx] - closes[idx].max(opens[idx])) / range } else { 0.0 };
        let lower_shadow = if range > 0.0 { (closes[idx].min(opens[idx]) - lows[idx]) / range } else { 0.0 };

        let gap = if idx > 0 && closes[idx - 1] > 0.0 { (opens[idx] - closes[idx - 1]) / closes[idx - 1] } else { 0.0 };
        let hl_range = if closes[idx] > 0.0 { range / closes[idx] } else { 0.0 };

        data.push(vec![
            r4(ret), r4(ret_5d), r4(ret_10d),
            r4(vol_10), r4(vol_20),
            r2(rsi_14), r2(rsi_7),
            r4(ema_ratio), r4(bb_pos),
            r2(vol_ratio), r4(atr_ratio),
            r4(body_ratio), r4(upper_shadow), r4(lower_shadow),
            r4(gap), r4(hl_range),
        ]);
    }

    let result = FeatureResult {
        features: Some(FeatureMatrix { columns, data }),
        regime: None,
        anomalies: None,
    };
    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn detect_regime(config: Config) -> Result<serde_json::Value, String> {
    let candles = config.candles.ok_or("candles required")?;
    let n = candles.len();
    if n < 50 { return Err("Need at least 50 candles for regime detection".into()); }

    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let returns: Vec<f64> = (1..n).map(|i| {
        if closes[i] > 0.0 && closes[i-1] > 0.0 { (closes[i] / closes[i-1]).ln() } else { 0.0 }
    }).collect();
    let lookback = config.lookback.unwrap_or(20);

    let mut regime_history: Vec<RegimePoint> = Vec::new();
    let mut regimes: Vec<usize> = Vec::new();

    for i in lookback..returns.len() {
        let window = &returns[i - lookback..i];
        let mean = window.iter().sum::<f64>() / lookback as f64;
        let vol = rolling_std(window);

        let regime = if mean > 0.001 && vol < 0.02 {
            0 // Bull Low Vol
        } else if mean > 0.0 && vol >= 0.02 {
            1 // Bull High Vol
        } else if mean < -0.001 && vol < 0.02 {
            2 // Bear Low Vol
        } else if mean < 0.0 && vol >= 0.02 {
            3 // Bear High Vol
        } else {
            4 // Sideways
        };

        let label = regime_label(regime);
        let confidence = (mean.abs() / vol.max(0.001)).min(1.0);

        regimes.push(regime);
        regime_history.push(RegimePoint {
            timestamp: candles[i + 1].timestamp.clone(),
            regime: label.to_string(),
            confidence: r4(confidence),
        });
    }

    // Transition matrix (5x5)
    let mut transitions = vec![vec![0u32; 5]; 5];
    let mut counts = vec![0u32; 5];
    for i in 1..regimes.len() {
        transitions[regimes[i-1]][regimes[i]] += 1;
        counts[regimes[i-1]] += 1;
    }
    let trans_probs: Vec<Vec<f64>> = transitions.iter().enumerate().map(|(i, row)| {
        row.iter().map(|&c| if counts[i] > 0 { r4(c as f64 / counts[i] as f64) } else { 0.0 }).collect()
    }).collect();

    let regime_stats: Vec<RegimeStat> = (0..5).map(|r| {
        let indices: Vec<usize> = regimes.iter().enumerate().filter(|(_, &v)| v == r).map(|(i, _)| i).collect();
        let freq = indices.len() as f64 / regimes.len().max(1) as f64;
        let avg_ret = if !indices.is_empty() {
            indices.iter().map(|&i| returns[i + lookback]).sum::<f64>() / indices.len() as f64
        } else { 0.0 };
        let vol = if indices.len() > 1 {
            let rets: Vec<f64> = indices.iter().map(|&i| returns[i + lookback]).collect();
            rolling_std(&rets)
        } else { 0.0 };

        let mut durations = Vec::new();
        let mut cur_dur = 0;
        for &reg in &regimes {
            if reg == r { cur_dur += 1; } else { if cur_dur > 0 { durations.push(cur_dur); } cur_dur = 0; }
        }
        if cur_dur > 0 { durations.push(cur_dur); }
        let avg_dur = if !durations.is_empty() { durations.iter().sum::<usize>() as f64 / durations.len() as f64 } else { 0.0 };

        RegimeStat { regime: regime_label(r).to_string(), avg_return: r4(avg_ret * 252.0), volatility: r4(vol * 252.0_f64.sqrt()), avg_duration: r2(avg_dur), frequency: r4(freq) }
    }).collect();

    let current = regimes.last().map(|&r| regime_label(r)).unwrap_or("UNKNOWN");

    let result = FeatureResult {
        features: None,
        regime: Some(RegimeResult {
            current_regime: current.to_string(),
            regime_history,
            transition_probabilities: trans_probs,
            regime_stats,
        }),
        anomalies: None,
    };
    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn detect_anomalies(config: Config) -> Result<serde_json::Value, String> {
    let candles = config.candles.ok_or("candles required")?;
    let n = candles.len();
    if n < 30 { return Err("Need at least 30 candles".into()); }

    let closes: Vec<f64> = candles.iter().map(|c| c.close).collect();
    let volumes: Vec<f64> = candles.iter().map(|c| c.volume).collect();
    let returns: Vec<f64> = (1..n).map(|i| {
        if closes[i] > 0.0 && closes[i-1] > 0.0 { (closes[i] / closes[i-1]).ln() } else { 0.0 }
    }).collect();

    let lookback = config.lookback.unwrap_or(20);
    let mut anomalies: Vec<AnomalyPoint> = Vec::new();

    for i in lookback..returns.len() {
        let idx = i + 1;
        let window = &returns[i - lookback..i];
        let mean = window.iter().sum::<f64>() / lookback as f64;
        let std = rolling_std(window);

        if std > 0.0 {
            let z = (returns[i] - mean) / std;
            if z.abs() > 3.0 {
                anomalies.push(AnomalyPoint {
                    timestamp: candles[idx].timestamp.clone(),
                    index: idx,
                    score: r4(z.abs()),
                    anomaly_type: if z > 0.0 { "PRICE_SPIKE_UP".into() } else { "PRICE_SPIKE_DOWN".into() },
                    details: format!("Return z-score: {:.2}, Return: {:.4}", z, returns[i]),
                });
            }
        }

        if i >= lookback {
            let vol_window = &volumes[idx - lookback..idx];
            let vol_mean = vol_window.iter().sum::<f64>() / lookback as f64;
            let vol_std = rolling_std(vol_window);
            if vol_std > 0.0 {
                let vol_z = (volumes[idx] - vol_mean) / vol_std;
                if vol_z > 3.0 {
                    anomalies.push(AnomalyPoint {
                        timestamp: candles[idx].timestamp.clone(),
                        index: idx,
                        score: r4(vol_z),
                        anomaly_type: "VOLUME_SPIKE".into(),
                        details: format!("Volume z-score: {:.2}, Volume: {:.0}", vol_z, volumes[idx]),
                    });
                }
            }
        }

        if idx >= 2 && candles[idx - 1].close > 0.0 {
            let gap_pct = (candles[idx].open - candles[idx - 1].close).abs() / candles[idx - 1].close;
            if gap_pct > 0.03 {
                anomalies.push(AnomalyPoint {
                    timestamp: candles[idx].timestamp.clone(),
                    index: idx,
                    score: r4(gap_pct * 100.0),
                    anomaly_type: if candles[idx].open > candles[idx - 1].close { "GAP_UP".into() } else { "GAP_DOWN".into() },
                    details: format!("Gap: {:.2}%", gap_pct * 100.0),
                });
            }
        }
    }

    anomalies.sort_by(|a, b| b.score.partial_cmp(&a.score).unwrap_or(std::cmp::Ordering::Equal));

    let result = FeatureResult { features: None, regime: None, anomalies: Some(anomalies) };
    serde_json::to_value(result).map_err(|e| e.to_string())
}

fn regime_label(r: usize) -> &'static str {
    match r {
        0 => "BULL_LOW_VOL",
        1 => "BULL_HIGH_VOL",
        2 => "BEAR_LOW_VOL",
        3 => "BEAR_HIGH_VOL",
        4 => "SIDEWAYS",
        _ => "UNKNOWN",
    }
}

fn rolling_std(data: &[f64]) -> f64 {
    let n = data.len() as f64;
    if n < 2.0 { return 0.0; }
    let mean = data.iter().sum::<f64>() / n;
    (data.iter().map(|v| (v - mean).powi(2)).sum::<f64>() / (n - 1.0)).sqrt()
}

fn ema(data: &[f64], period: usize) -> f64 {
    if data.is_empty() { return 0.0; }
    let period = period.min(data.len());
    let mul = 2.0 / (period as f64 + 1.0);
    let mut e = data[0];
    for i in 1..data.len() {
        e = (data[i] - e) * mul + e;
    }
    e
}

fn calc_rsi(closes: &[f64], period: usize) -> f64 {
    let n = closes.len();
    if n <= period { return 50.0; }
    let mut avg_gain = 0.0;
    let mut avg_loss = 0.0;
    for i in 1..=period {
        let diff = closes[n - period - 1 + i] - closes[n - period - 1 + i - 1];
        if diff > 0.0 { avg_gain += diff; } else { avg_loss += diff.abs(); }
    }
    avg_gain /= period as f64;
    avg_loss /= period as f64;
    if avg_loss == 0.0 { return 100.0; }
    100.0 - 100.0 / (1.0 + avg_gain / avg_loss)
}

fn calc_atr(highs: &[f64], lows: &[f64], closes: &[f64], period: usize) -> f64 {
    let n = highs.len();
    if n < period + 1 { return highs.last().unwrap_or(&0.0) - lows.last().unwrap_or(&0.0); }
    let mut atr = 0.0;
    for i in (n - period)..n {
        let tr = (highs[i] - lows[i])
            .max((highs[i] - closes[i - 1]).abs())
            .max((lows[i] - closes[i - 1]).abs());
        atr += tr;
    }
    atr / period as f64
}

fn r2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
fn r4(v: f64) -> f64 { (v * 10000.0).round() / 10000.0 }

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn make_candles(n: usize, base: f64, trend: f64) -> Vec<serde_json::Value> {
        (0..n).map(|i| {
            let close = base + trend * i as f64;
            json!({
                "timestamp": format!("2024-01-{:02}", (i % 28) + 1),
                "open": close - 0.5,
                "high": close + 1.0,
                "low": close - 1.0,
                "close": close,
                "volume": 10000.0 + (i as f64 * 100.0)
            })
        }).collect()
    }

    #[test]
    fn test_extract_features_basic() {
        let candles = make_candles(35, 100.0, 0.5);
        let input = json!({ "command": "extract_features", "candles": candles });
        let result = compute(input).expect("should succeed");

        let features = result.get("features").expect("missing features");
        let columns = features.get("columns").expect("missing columns").as_array().unwrap();
        assert_eq!(columns.len(), 16);

        let data = features.get("data").expect("missing data").as_array().unwrap();
        assert!(!data.is_empty());
        for row in data {
            assert_eq!(row.as_array().unwrap().len(), 16);
        }
    }

    #[test]
    fn test_extract_features_too_few() {
        let candles = make_candles(20, 100.0, 0.5);
        let input = json!({ "command": "extract_features", "candles": candles });
        let result = compute(input);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("30"));
    }

    #[test]
    fn test_detect_regime_basic() {
        let candles = make_candles(60, 100.0, 1.0);
        let input = json!({ "command": "detect_regime", "candles": candles });
        let result = compute(input).expect("should succeed");

        let regime = result.get("regime").expect("missing regime");
        let current = regime.get("current_regime").expect("missing current_regime").as_str().unwrap();
        let valid_regimes = ["BULL_LOW_VOL", "BULL_HIGH_VOL", "BEAR_LOW_VOL", "BEAR_HIGH_VOL", "SIDEWAYS"];
        assert!(valid_regimes.contains(&current), "unexpected regime: {}", current);

        let history = regime.get("regime_history").expect("missing regime_history").as_array().unwrap();
        assert!(!history.is_empty());

        let stats = regime.get("regime_stats").expect("missing regime_stats").as_array().unwrap();
        assert_eq!(stats.len(), 5);
    }

    #[test]
    fn test_detect_regime_too_few() {
        let candles = make_candles(40, 100.0, 1.0);
        let input = json!({ "command": "detect_regime", "candles": candles });
        let result = compute(input);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("50"));
    }

    #[test]
    fn test_detect_anomalies_basic() {
        let candles = make_candles(35, 100.0, 0.2);
        let input = json!({ "command": "detect_anomalies", "candles": candles });
        let result = compute(input).expect("should succeed");

        let anomalies = result.get("anomalies").expect("missing anomalies").as_array().unwrap();
        for a in anomalies {
            let atype = a.get("anomaly_type").unwrap().as_str().unwrap();
            let valid = ["PRICE_SPIKE_UP", "PRICE_SPIKE_DOWN", "VOLUME_SPIKE", "GAP_UP", "GAP_DOWN"];
            assert!(valid.contains(&atype), "unexpected anomaly type: {}", atype);
            assert!(a.get("score").unwrap().as_f64().unwrap() > 0.0);
        }
    }

    #[test]
    fn test_detect_anomalies_too_few() {
        let candles = make_candles(20, 100.0, 0.5);
        let input = json!({ "command": "detect_anomalies", "candles": candles });
        let result = compute(input);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("30"));
    }

    #[test]
    fn test_unknown_command_error() {
        let candles = make_candles(5, 100.0, 1.0);
        let input = json!({ "command": "bad_command", "candles": candles });
        let result = compute(input);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("Unknown"));
    }

    #[test]
    fn test_zero_close_no_panic() {
        let mut candles = make_candles(35, 100.0, 0.5);
        candles[10] = json!({
            "timestamp": "2024-01-11",
            "open": 0.0, "high": 0.0, "low": 0.0, "close": 0.0, "volume": 10000.0
        });
        candles[11] = json!({
            "timestamp": "2024-01-12",
            "open": 0.0, "high": 0.0, "low": 0.0, "close": 0.0, "volume": 10000.0
        });

        let input = json!({ "command": "extract_features", "candles": candles });
        let result = compute(input);
        assert!(result.is_ok(), "should not panic on zero close: {:?}", result.err());
    }

    #[test]
    fn test_zero_volume_no_panic() {
        let mut candles = make_candles(35, 100.0, 0.5);
        for i in 5..10 {
            candles[i] = json!({
                "timestamp": format!("2024-01-{:02}", i + 1),
                "open": 100.0, "high": 101.0, "low": 99.0, "close": 100.5,
                "volume": 0.0
            });
        }

        let input = json!({ "command": "detect_anomalies", "candles": candles });
        let result = compute(input);
        assert!(result.is_ok(), "should not panic on zero volume: {:?}", result.err());
    }

    #[test]
    fn test_anomaly_detects_spike() {
        let mut candles = make_candles(35, 100.0, 0.1);
        let spike_idx = 30;
        let spike_close = 100.0 + 0.1 * spike_idx as f64;
        candles[spike_idx] = json!({
            "timestamp": format!("2024-01-{:02}", (spike_idx % 28) + 1),
            "open": spike_close,
            "high": spike_close * 1.12,
            "low": spike_close,
            "close": spike_close * 1.10,
            "volume": 10000.0 + (spike_idx as f64 * 100.0)
        });

        let input = json!({ "command": "detect_anomalies", "candles": candles });
        let result = compute(input).expect("should succeed");
        let anomalies = result.get("anomalies").unwrap().as_array().unwrap();

        let has_spike = anomalies.iter().any(|a| {
            let t = a.get("anomaly_type").unwrap().as_str().unwrap();
            t == "PRICE_SPIKE_UP" || t == "GAP_UP"
        });
        assert!(has_spike, "expected a spike anomaly, got: {:?}", anomalies);
    }
}
