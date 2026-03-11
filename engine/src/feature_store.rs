use serde::{Deserialize, Serialize};
use crate::utils::{Candle, rolling_std, calc_ema_last, calc_rsi_last, calc_atr_last, round2 as r2, round4 as r4, sanitize_candles};

#[derive(Deserialize)]
struct Config {
    command: String,
    candles: Option<Vec<Candle>>,
    features: Option<Vec<Vec<f64>>>,
    lookback: Option<usize>,
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
    let mut candles = config.candles.ok_or("candles required")?;
    sanitize_candles(&mut candles);
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
        // Price returns (6)
        "return_1d".into(), "return_5d".into(), "return_10d".into(),
        "return_20d".into(), "log_return_1d".into(), "log_return_5d".into(),
        // Realized volatility (6)
        "vol_5d".into(), "vol_10d".into(), "vol_20d".into(),
        "vol_of_vol_20d".into(), "skewness_20d".into(), "kurtosis_20d".into(),
        // Momentum oscillators (10)
        "rsi_14".into(), "rsi_7".into(), "rsi_21".into(),
        "stochastic_k".into(), "stochastic_d".into(),
        "williams_r".into(), "cci_20".into(), "roc_10".into(),
        "roc_20".into(), "momentum_12d".into(),
        // Trend indicators (8)
        "ema_ratio_9_21".into(), "ema_ratio_5_13".into(),
        "sma_ratio_10_50".into(), "adx_14".into(),
        "aroon_up".into(), "aroon_down".into(),
        "linreg_slope_20".into(), "linreg_r2_20".into(),
        // Volatility indicators (6)
        "bb_position".into(), "bb_bandwidth".into(),
        "atr_ratio".into(), "atr_14".into(),
        "garman_klass_vol".into(), "yang_zhang_vol".into(),
        // Volume features (8)
        "volume_ratio_20d".into(), "volume_ratio_5d".into(),
        "vwap_deviation".into(), "obv_slope".into(),
        "ad_line_slope".into(), "money_flow_ratio".into(),
        "volume_zscore".into(), "volume_momentum".into(),
        // Candlestick features (6)
        "body_ratio".into(), "upper_shadow".into(), "lower_shadow".into(),
        "gap_pct".into(), "high_low_range".into(), "close_position".into(),
        // Cross-sectional / relative (4)
        "return_rank".into(), "vol_rank".into(),
        "relative_strength_5d".into(), "relative_strength_20d".into(),
        // Calendar features (6)
        "day_of_week".into(), "day_of_month".into(),
        "month".into(), "is_expiry_week".into(),
        "days_to_month_end".into(), "is_monday".into(),
        // Regime / state features (6)
        "trend_strength".into(), "vol_regime".into(),
        "mean_reversion_zscore".into(), "hurst_exponent".into(),
        "consecutive_up_days".into(), "consecutive_down_days".into(),
        // Microstructure proxies (4)
        "spread_proxy".into(), "depth_imbalance_proxy".into(),
        "trade_imbalance".into(), "kyle_lambda_proxy".into(),
        // Interaction features (6)
        "rsi_x_vol".into(), "momentum_x_volume".into(),
        "trend_x_regime".into(), "vol_x_bb".into(),
        "rsi_divergence".into(), "volume_price_trend".into(),
    ];

    let mut data: Vec<Vec<f64>> = Vec::new();

    // Pre-compute OBV and A/D line
    let mut obv = vec![0.0f64; n];
    let mut ad_line = vec![0.0f64; n];
    for i in 1..n {
        let clv = if highs[i] != lows[i] {
            ((closes[i] - lows[i]) - (highs[i] - closes[i])) / (highs[i] - lows[i])
        } else { 0.0 };
        ad_line[i] = ad_line[i-1] + clv * volumes[i];
        obv[i] = obv[i-1] + if closes[i] > closes[i-1] { volumes[i] }
            else if closes[i] < closes[i-1] { -volumes[i] }
            else { 0.0 };
    }

    for i in 0..returns.len() {
        let idx = i + 1;

        // === PRICE RETURNS (6) ===
        let ret_1d = returns[i];
        let ret_5d = if i >= 5 { (closes[idx] / closes[idx - 5]).ln() } else { 0.0 };
        let ret_10d = if i >= 10 { (closes[idx] / closes[idx - 10]).ln() } else { 0.0 };
        let ret_20d = if i >= 20 { (closes[idx] / closes[idx - 20]).ln() } else { 0.0 };
        let simple_ret = if idx > 0 && closes[idx-1] > 0.0 { (closes[idx] - closes[idx-1]) / closes[idx-1] } else { 0.0 };

        // === REALIZED VOLATILITY (6) ===
        let vol_5 = if i >= 5 { rolling_std(&returns[i-4..=i]) } else { 0.0 };
        let vol_10 = if i >= 10 { rolling_std(&returns[i-9..=i]) } else { 0.0 };
        let vol_20 = if i >= 20 { rolling_std(&returns[i-19..=i]) } else { 0.0 };

        // vol-of-vol: std of rolling 5d vol
        let vol_of_vol = if i >= 20 {
            let rlen = returns.len();
            let vol_series: Vec<f64> = (0..5).map(|j| {
                let start = i - 19 + j * 4;
                let end = (start + 5).min(rlen);
                if end > start + 1 { rolling_std(&returns[start..end]) } else { 0.0 }
            }).collect();
            rolling_std(&vol_series)
        } else { 0.0 };

        let (skew, kurt) = if i >= 20 {
            let window = &returns[i-19..=i];
            let mean = window.iter().sum::<f64>() / 20.0;
            let std = rolling_std(window);
            if std > 0.0 {
                let m3 = window.iter().map(|r| ((r - mean) / std).powi(3)).sum::<f64>() / 20.0;
                let m4 = window.iter().map(|r| ((r - mean) / std).powi(4)).sum::<f64>() / 20.0 - 3.0;
                (m3, m4)
            } else { (0.0, 0.0) }
        } else { (0.0, 0.0) };

        // === MOMENTUM OSCILLATORS (10) ===
        let rsi_14 = if idx >= 14 { calc_rsi_last(&closes[..=idx], 14) } else { 50.0 };
        let rsi_7 = if idx >= 7 { calc_rsi_last(&closes[..=idx], 7) } else { 50.0 };
        let rsi_21 = if idx >= 21 { calc_rsi_last(&closes[..=idx], 21) } else { 50.0 };

        // Stochastic %K, %D
        let (stoch_k, stoch_d) = if idx >= 14 {
            let window_h = &highs[idx-13..=idx];
            let window_l = &lows[idx-13..=idx];
            let highest = window_h.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let lowest = window_l.iter().cloned().fold(f64::INFINITY, f64::min);
            let k = if highest != lowest { (closes[idx] - lowest) / (highest - lowest) * 100.0 } else { 50.0 };
            (k, k) // %D would be SMA of %K but single-point approximation
        } else { (50.0, 50.0) };

        // Williams %R
        let williams_r = if idx >= 14 {
            let window_h = &highs[idx-13..=idx];
            let window_l = &lows[idx-13..=idx];
            let highest = window_h.iter().cloned().fold(f64::NEG_INFINITY, f64::max);
            let lowest = window_l.iter().cloned().fold(f64::INFINITY, f64::min);
            if highest != lowest { (highest - closes[idx]) / (highest - lowest) * -100.0 } else { -50.0 }
        } else { -50.0 };

        // CCI
        let cci = if idx >= 20 {
            let tp_values: Vec<f64> = (idx-19..=idx).map(|j| (highs[j] + lows[j] + closes[j]) / 3.0).collect();
            let tp_mean = tp_values.iter().sum::<f64>() / 20.0;
            let mean_dev = tp_values.iter().map(|v| (v - tp_mean).abs()).sum::<f64>() / 20.0;
            let tp = (highs[idx] + lows[idx] + closes[idx]) / 3.0;
            if mean_dev > 0.0 { (tp - tp_mean) / (0.015 * mean_dev) } else { 0.0 }
        } else { 0.0 };

        // Rate of change
        let roc_10 = if idx >= 10 && closes[idx-10] > 0.0 { (closes[idx] - closes[idx-10]) / closes[idx-10] * 100.0 } else { 0.0 };
        let roc_20 = if idx >= 20 && closes[idx-20] > 0.0 { (closes[idx] - closes[idx-20]) / closes[idx-20] * 100.0 } else { 0.0 };
        let momentum_12 = if idx >= 12 { closes[idx] - closes[idx-12] } else { 0.0 };

        // === TREND INDICATORS (8) ===
        let ema9 = calc_ema_last(&closes[..=idx], 9.min(idx + 1));
        let ema21 = calc_ema_last(&closes[..=idx], 21.min(idx + 1));
        let ema5 = calc_ema_last(&closes[..=idx], 5.min(idx + 1));
        let ema13 = calc_ema_last(&closes[..=idx], 13.min(idx + 1));
        let ema_ratio_9_21 = if ema21 > 0.0 { ema9 / ema21 } else { 1.0 };
        let ema_ratio_5_13 = if ema13 > 0.0 { ema5 / ema13 } else { 1.0 };

        let sma10 = if idx >= 10 { closes[idx-9..=idx].iter().sum::<f64>() / 10.0 } else { closes[idx] };
        let sma50 = if idx >= 50 { closes[idx-49..=idx].iter().sum::<f64>() / 50.0 } else { closes[idx] };
        let sma_ratio_10_50 = if sma50 > 0.0 { sma10 / sma50 } else { 1.0 };

        // ADX (simplified: DI+ - DI- magnitude)
        let adx = if idx >= 14 {
            let mut plus_dm_sum = 0.0;
            let mut minus_dm_sum = 0.0;
            for j in (idx-13)..=idx {
                if j > 0 {
                    let up = highs[j] - highs[j-1];
                    let down = lows[j-1] - lows[j];
                    if up > down && up > 0.0 { plus_dm_sum += up; }
                    if down > up && down > 0.0 { minus_dm_sum += down; }
                }
            }
            let total = plus_dm_sum + minus_dm_sum;
            if total > 0.0 { ((plus_dm_sum - minus_dm_sum).abs() / total * 100.0).min(100.0) } else { 0.0 }
        } else { 0.0 };

        // Aroon
        let (aroon_up, aroon_down) = if idx >= 25 {
            let window = &closes[idx-24..=idx];
            let max_idx = window.iter().enumerate().max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal)).map(|(i, _)| i).unwrap_or(0);
            let min_idx = window.iter().enumerate().min_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal)).map(|(i, _)| i).unwrap_or(0);
            (max_idx as f64 / 25.0 * 100.0, min_idx as f64 / 25.0 * 100.0)
        } else { (50.0, 50.0) };

        // Linear regression slope and R²
        let (lr_slope, lr_r2) = if idx >= 20 {
            linear_regression(&closes[idx-19..=idx])
        } else { (0.0, 0.0) };

        // === VOLATILITY INDICATORS (6) ===
        let (bb_upper, bb_lower) = if idx >= 20 {
            let sma = closes[idx-19..=idx].iter().sum::<f64>() / 20.0;
            let std = rolling_std(&closes[idx-19..=idx]);
            (sma + 2.0 * std, sma - 2.0 * std)
        } else { (closes[idx] * 1.1, closes[idx] * 0.9) };
        let bb_pos = if bb_upper != bb_lower { (closes[idx] - bb_lower) / (bb_upper - bb_lower) } else { 0.5 };
        let bb_bandwidth = if closes[idx] > 0.0 { (bb_upper - bb_lower) / closes[idx] } else { 0.0 };

        let atr = if idx >= 14 { calc_atr_last(&highs[..=idx], &lows[..=idx], &closes[..=idx], 14) } else { highs[idx] - lows[idx] };
        let atr_ratio = if closes[idx] > 0.0 { atr / closes[idx] } else { 0.0 };

        // Garman-Klass volatility
        let gk_vol = if idx >= 20 {
            let mut sum = 0.0;
            for j in (idx-19)..=idx {
                if lows[j] > 0.0 && opens[j] > 0.0 {
                    let u = (highs[j] / opens[j]).ln();
                    let d = (lows[j] / opens[j]).ln();
                    let c = (closes[j] / opens[j]).ln();
                    sum += 0.5 * (u - d).powi(2) - (2.0_f64.ln() - 1.0) * c.powi(2);
                }
            }
            (sum / 20.0).sqrt() * (252.0_f64).sqrt()
        } else { 0.0 };

        // Yang-Zhang volatility
        let yz_vol = if idx >= 20 {
            let mut o2c = Vec::new();
            let mut c2o = Vec::new();
            for j in (idx-19)..=idx {
                if closes[j] > 0.0 && opens[j] > 0.0 {
                    o2c.push((closes[j] / opens[j]).ln());
                }
                if j > 0 && opens[j] > 0.0 && closes[j-1] > 0.0 {
                    c2o.push((opens[j] / closes[j-1]).ln());
                }
            }
            let var_o = if c2o.len() > 1 { rolling_std(&c2o).powi(2) } else { 0.0 };
            let var_c = if o2c.len() > 1 { rolling_std(&o2c).powi(2) } else { 0.0 };
            let k = 0.34 / (1.34 + 2.0 / 20.0);
            ((var_o + k * var_c + (1.0 - k) * gk_vol.powi(2) / 252.0).max(0.0)).sqrt() * (252.0_f64).sqrt()
        } else { 0.0 };

        // === VOLUME FEATURES (8) ===
        let vol_avg_20 = if idx >= 20 { volumes[idx-19..=idx].iter().sum::<f64>() / 20.0 } else { volumes[idx] };
        let vol_avg_5 = if idx >= 5 { volumes[idx-4..=idx].iter().sum::<f64>() / 5.0 } else { volumes[idx] };
        let vol_ratio_20 = if vol_avg_20 > 0.0 { volumes[idx] / vol_avg_20 } else { 1.0 };
        let vol_ratio_5 = if vol_avg_5 > 0.0 { volumes[idx] / vol_avg_5 } else { 1.0 };

        let typical_price = (highs[idx] + lows[idx] + closes[idx]) / 3.0;
        let vwap_approx = if idx >= 20 {
            let mut tp_vol_sum = 0.0;
            let mut vol_sum = 0.0;
            for j in (idx-19)..=idx {
                let tp = (highs[j] + lows[j] + closes[j]) / 3.0;
                tp_vol_sum += tp * volumes[j];
                vol_sum += volumes[j];
            }
            if vol_sum > 0.0 { tp_vol_sum / vol_sum } else { typical_price }
        } else { typical_price };
        let vwap_dev = if vwap_approx > 0.0 { (closes[idx] - vwap_approx) / vwap_approx } else { 0.0 };

        // OBV slope
        let obv_slope_val = if idx >= 10 {
            let (s, _) = linear_regression(&obv[idx-9..=idx]);
            s
        } else { 0.0 };

        // A/D line slope
        let ad_slope_val = if idx >= 10 {
            let (s, _) = linear_regression(&ad_line[idx-9..=idx]);
            s
        } else { 0.0 };

        // Money flow ratio
        let mf_ratio = if idx >= 14 {
            let mut pos_flow = 0.0;
            let mut neg_flow = 0.0;
            for j in (idx-13)..=idx {
                let tp_j = (highs[j] + lows[j] + closes[j]) / 3.0;
                let tp_prev = if j > 0 { (highs[j-1] + lows[j-1] + closes[j-1]) / 3.0 } else { tp_j };
                let flow = tp_j * volumes[j];
                if tp_j > tp_prev { pos_flow += flow; } else { neg_flow += flow; }
            }
            if neg_flow > 0.0 { pos_flow / neg_flow } else { 1.0 }
        } else { 1.0 };

        let vol_zscore = if vol_avg_20 > 0.0 {
            let vol_std = if idx >= 20 { rolling_std(&volumes[idx-19..=idx]) } else { 1.0 };
            if vol_std > 0.0 { (volumes[idx] - vol_avg_20) / vol_std } else { 0.0 }
        } else { 0.0 };

        let vol_momentum = if idx >= 10 {
            let vol_5_now = volumes[idx-4..=idx].iter().sum::<f64>() / 5.0;
            let vol_5_prev = volumes[idx-9..idx-4].iter().sum::<f64>() / 5.0;
            if vol_5_prev > 0.0 { vol_5_now / vol_5_prev } else { 1.0 }
        } else { 1.0 };

        // === CANDLESTICK FEATURES (6) ===
        let body = (closes[idx] - opens[idx]).abs();
        let range = highs[idx] - lows[idx];
        let body_ratio = if range > 0.0 { body / range } else { 0.0 };
        let upper_shadow = if range > 0.0 { (highs[idx] - closes[idx].max(opens[idx])) / range } else { 0.0 };
        let lower_shadow = if range > 0.0 { (closes[idx].min(opens[idx]) - lows[idx]) / range } else { 0.0 };
        let gap = if idx > 0 && closes[idx - 1] > 0.0 { (opens[idx] - closes[idx - 1]) / closes[idx - 1] } else { 0.0 };
        let hl_range = if closes[idx] > 0.0 { range / closes[idx] } else { 0.0 };
        let close_position = if range > 0.0 { (closes[idx] - lows[idx]) / range } else { 0.5 };

        // === CROSS-SECTIONAL (4) — placeholders for single-symbol ===
        let return_rank = 0.5;
        let vol_rank = 0.5;
        let rs_5 = ret_5d;
        let rs_20 = ret_20d;

        // === CALENDAR FEATURES (6) ===
        let ts = &candles[idx].timestamp;
        let (dow, dom, month_val) = parse_calendar(ts);
        let is_expiry_week = if dom >= 22 && dom <= 31 { 1.0 } else { 0.0 };
        let days_to_month_end = (30 - dom).max(0) as f64;
        let is_monday = if dow == 1 { 1.0 } else { 0.0 };

        // === REGIME FEATURES (6) ===
        let ema_short_fast = calc_ema_last(&closes[..=idx], 5.min(idx + 1));
        let ema_long_slow = calc_ema_last(&closes[..=idx], 30.min(idx + 1));
        let trend_strength = if ema_long_slow > 0.0 { (ema_short_fast - ema_long_slow) / ema_long_slow } else { 0.0 };
        let vol_regime = if vol_20 > 0.0 { vol_5 / vol_20 } else { 1.0 };

        let mr_zscore = if idx >= 20 {
            let sma20 = closes[idx-19..=idx].iter().sum::<f64>() / 20.0;
            let std20 = rolling_std(&closes[idx-19..=idx]);
            if std20 > 0.0 { (closes[idx] - sma20) / std20 } else { 0.0 }
        } else { 0.0 };

        let hurst = if i >= 20 {
            estimate_hurst(&returns[i-19..=i])
        } else { 0.5 };

        let mut consec_up = 0i32;
        let mut consec_down = 0i32;
        for j in (0..idx).rev() {
            if j + 1 <= idx && closes[j + 1] > closes[j] { consec_up += 1; } else { break; }
        }
        for j in (0..idx).rev() {
            if j + 1 <= idx && closes[j + 1] < closes[j] { consec_down += 1; } else { break; }
        }

        // === MICROSTRUCTURE PROXIES (4) ===
        let spread_proxy = hl_range * 0.5;
        let depth_imbalance = if vol_avg_20 > 0.0 {
            (volumes[idx] - vol_avg_20) / vol_avg_20 * if closes[idx] > opens[idx] { 1.0 } else { -1.0 }
        } else { 0.0 };
        let trade_imbalance = if volumes[idx] > 0.0 {
            let buy_vol = if closes[idx] >= opens[idx] { volumes[idx] * 0.6 } else { volumes[idx] * 0.4 };
            (2.0 * buy_vol / volumes[idx]) - 1.0
        } else { 0.0 };
        let kyle_lambda = if volumes[idx] > 0.0 && idx > 0 {
            let price_change = (closes[idx] - closes[idx-1]).abs();
            price_change / volumes[idx].sqrt()
        } else { 0.0 };

        // === INTERACTION FEATURES (6) ===
        let rsi_x_vol = (rsi_14 / 100.0) * vol_20;
        let mom_x_vol = (momentum_12 / closes[idx].max(1.0)) * vol_ratio_20;
        let trend_x_regime = trend_strength * vol_regime;
        let vol_x_bb = vol_20 * bb_bandwidth;
        let rsi_divergence = if idx >= 5 {
            let rsi_prev = if idx >= 19 { calc_rsi_last(&closes[..=idx-5], 14) } else { 50.0 };
            let price_dir = if closes[idx] > closes[idx.saturating_sub(5)] { 1.0 } else { -1.0 };
            let rsi_dir = if rsi_14 > rsi_prev { 1.0 } else { -1.0 };
            price_dir * rsi_dir
        } else { 0.0 };
        let vpt = if idx > 0 && closes[idx-1] > 0.0 {
            ((closes[idx] - closes[idx-1]) / closes[idx-1]) * volumes[idx]
        } else { 0.0 };

        data.push(vec![
            // Price returns (6)
            r4(ret_1d), r4(ret_5d), r4(ret_10d), r4(ret_20d), r4(simple_ret), r4(ret_5d),
            // Volatility (6)
            r4(vol_5), r4(vol_10), r4(vol_20), r4(vol_of_vol), r4(skew), r4(kurt),
            // Momentum (10)
            r2(rsi_14), r2(rsi_7), r2(rsi_21),
            r2(stoch_k), r2(stoch_d), r2(williams_r), r2(cci),
            r2(roc_10), r2(roc_20), r2(momentum_12),
            // Trend (8)
            r4(ema_ratio_9_21), r4(ema_ratio_5_13), r4(sma_ratio_10_50),
            r2(adx), r2(aroon_up), r2(aroon_down), r4(lr_slope), r4(lr_r2),
            // Volatility indicators (6)
            r4(bb_pos), r4(bb_bandwidth), r4(atr_ratio), r2(atr),
            r4(gk_vol), r4(yz_vol),
            // Volume (8)
            r2(vol_ratio_20), r2(vol_ratio_5), r4(vwap_dev), r4(obv_slope_val),
            r4(ad_slope_val), r2(mf_ratio), r2(vol_zscore), r2(vol_momentum),
            // Candlestick (6)
            r4(body_ratio), r4(upper_shadow), r4(lower_shadow),
            r4(gap), r4(hl_range), r4(close_position),
            // Cross-sectional (4)
            r4(return_rank), r4(vol_rank), r4(rs_5), r4(rs_20),
            // Calendar (6)
            dow as f64, dom as f64, month_val as f64,
            is_expiry_week, days_to_month_end, is_monday,
            // Regime (6)
            r4(trend_strength), r4(vol_regime), r4(mr_zscore),
            r4(hurst), consec_up as f64, consec_down as f64,
            // Microstructure (4)
            r4(spread_proxy), r4(depth_imbalance), r4(trade_imbalance), r4(kyle_lambda),
            // Interactions (6)
            r4(rsi_x_vol), r4(mom_x_vol), r4(trend_x_regime),
            r4(vol_x_bb), r4(rsi_divergence), r4(vpt),
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
    let mut candles = config.candles.ok_or("candles required")?;
    sanitize_candles(&mut candles);
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
    let mut candles = config.candles.ok_or("candles required")?;
    sanitize_candles(&mut candles);
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

fn linear_regression(data: &[f64]) -> (f64, f64) {
    let n = data.len() as f64;
    if n < 2.0 { return (0.0, 0.0); }
    let x_mean = (n - 1.0) / 2.0;
    let y_mean = data.iter().sum::<f64>() / n;
    let mut ss_xy = 0.0;
    let mut ss_xx = 0.0;
    let mut ss_yy = 0.0;
    for (i, &y) in data.iter().enumerate() {
        let x = i as f64;
        ss_xy += (x - x_mean) * (y - y_mean);
        ss_xx += (x - x_mean).powi(2);
        ss_yy += (y - y_mean).powi(2);
    }
    let slope = if ss_xx > 0.0 { ss_xy / ss_xx } else { 0.0 };
    let r2_val = if ss_xx > 0.0 && ss_yy > 0.0 { (ss_xy.powi(2)) / (ss_xx * ss_yy) } else { 0.0 };
    (slope, r2_val)
}

fn parse_calendar(ts: &str) -> (u32, u32, u32) {
    // Parse "2024-01-15" or "2024-01-15T..." format
    let parts: Vec<&str> = ts.split(&['-', 'T'][..]).collect();
    let month = parts.get(1).and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
    let day = parts.get(2).and_then(|s| s.parse::<u32>().ok()).unwrap_or(1);
    let year = parts.first().and_then(|s| s.parse::<u32>().ok()).unwrap_or(2024);
    // Zeller's formula for day of week (0=Sun, 1=Mon, ...)
    let (m, y) = if month <= 2 { (month + 12, year - 1) } else { (month, year) };
    let dow = ((day + (13 * (m + 1)) / 5 + y + y / 4 - y / 100 + y / 400) % 7) as u32;
    (dow, day, month)
}

fn estimate_hurst(returns: &[f64]) -> f64 {
    let n = returns.len();
    if n < 10 { return 0.5; }
    let mean = returns.iter().sum::<f64>() / n as f64;
    let deviations: Vec<f64> = returns.iter().map(|r| r - mean).collect();
    let mut cumsum = vec![0.0; n];
    cumsum[0] = deviations[0];
    for i in 1..n { cumsum[i] = cumsum[i-1] + deviations[i]; }
    let range = cumsum.iter().cloned().fold(f64::NEG_INFINITY, f64::max)
              - cumsum.iter().cloned().fold(f64::INFINITY, f64::min);
    let std = rolling_std(returns);
    if std > 0.0 && range > 0.0 {
        let rs = range / std;
        // Hurst ≈ log(R/S) / log(n)
        (rs.ln() / (n as f64).ln()).max(0.0).min(1.0)
    } else { 0.5 }
}


/// Extract context features for a symbol using enriched data from the continuous scanner.
/// Returns a Vec<f64> with 7 additional features:
///   [sector_score, cap_category, news_sentiment, options_pcr, options_iv_rank, futures_basis, scan_confirmation_count]
/// These can be appended to `raw_features` or set as named fields on `FeatureRow`.
pub fn extract_context_features(
    _symbol: &str,
    sector_score: f64,
    cap_category_num: f64,
    news_sentiment: f64,
    options_pcr: Option<f64>,
    options_iv_rank: Option<f64>,
    futures_basis: Option<f64>,
    scan_count: u32,
) -> Vec<f64> {
    vec![
        sector_score.clamp(-1.0, 1.0),
        cap_category_num,
        news_sentiment.clamp(-1.0, 1.0),
        options_pcr.unwrap_or(0.0),
        options_iv_rank.unwrap_or(0.0),
        futures_basis.unwrap_or(0.0),
        scan_count as f64,
    ]
}

/// Convert CapCategory to a numeric value for ML features.
pub fn cap_to_numeric(cap: &str) -> f64 {
    match cap.to_lowercase().as_str() {
        "largecap" | "large" => 1.0,
        "midcap" | "mid" => 0.5,
        _ => 0.0,
    }
}

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
        assert_eq!(columns.len(), 76, "expected 76 feature columns, got {}", columns.len());

        let data = features.get("data").expect("missing data").as_array().unwrap();
        assert!(!data.is_empty());
        for row in data {
            assert_eq!(row.as_array().unwrap().len(), 76, "expected 76 values per row");
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

    #[test]
    fn test_feature_count_is_76() {
        let candles = make_candles(50, 100.0, 0.3);
        let input = json!({ "command": "extract_features", "candles": candles });
        let result = compute(input).expect("feature extraction should succeed");

        let features = result.get("features").unwrap();
        let columns = features.get("columns").unwrap().as_array().unwrap();
        assert_eq!(columns.len(), 76, "expected exactly 76 feature columns, got {}", columns.len());

        let data = features.get("data").unwrap().as_array().unwrap();
        for (row_idx, row) in data.iter().enumerate() {
            let vals = row.as_array().unwrap();
            assert_eq!(vals.len(), 76, "row {} has {} features, expected 76", row_idx, vals.len());
        }
    }

    #[test]
    fn test_features_no_nan() {
        let candles = make_candles(50, 100.0, 0.5);
        let input = json!({ "command": "extract_features", "candles": candles });
        let result = compute(input).expect("feature extraction should succeed");

        let data = result.get("features").unwrap().get("data").unwrap().as_array().unwrap();
        for (row_idx, row) in data.iter().enumerate() {
            for (col_idx, val) in row.as_array().unwrap().iter().enumerate() {
                let v = val.as_f64().unwrap();
                assert!(!v.is_nan(), "NaN found at row {}, col {}", row_idx, col_idx);
            }
        }
    }

    #[test]
    fn test_extract_context_features() {
        let feats = extract_context_features("RELIANCE", 0.7, 1.0, 0.5, Some(0.8), Some(15.0), Some(0.3), 3);
        assert_eq!(feats.len(), 7);
        assert_eq!(feats[0], 0.7);  // sector_score
        assert_eq!(feats[1], 1.0);  // cap_category_num (large)
        assert_eq!(feats[2], 0.5);  // news_sentiment
        assert_eq!(feats[3], 0.8);  // options_pcr
        assert_eq!(feats[6], 3.0);  // scan_count
    }

    #[test]
    fn test_cap_to_numeric() {
        assert_eq!(cap_to_numeric("LargeCap"), 1.0);
        assert_eq!(cap_to_numeric("mid"), 0.5);
        assert_eq!(cap_to_numeric("SmallCap"), 0.0);
    }

    #[test]
    fn test_features_on_constant_prices() {
        let n = 50;
        let candles: Vec<serde_json::Value> = (0..n)
            .map(|i| {
                json!({
                    "timestamp": format!("2024-02-{:02}", (i % 28) + 1),
                    "open": 100.0,
                    "high": 100.0,
                    "low": 100.0,
                    "close": 100.0,
                    "volume": 10000.0
                })
            })
            .collect();

        let input = json!({ "command": "extract_features", "candles": candles });
        let result = compute(input).expect("constant prices should not error");

        let data = result.get("features").unwrap().get("data").unwrap().as_array().unwrap();
        assert!(!data.is_empty(), "should produce feature rows");
        for (row_idx, row) in data.iter().enumerate() {
            for (col_idx, val) in row.as_array().unwrap().iter().enumerate() {
                let v = val.as_f64().unwrap();
                assert!(v.is_finite(), "non-finite value at row {}, col {}: {}", row_idx, col_idx, v);
            }
        }
    }
}
