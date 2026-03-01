use serde::{Deserialize, Serialize};
use serde_json::Value;

#[derive(Deserialize)]
struct AdvancedSignalConfig {
    candles: Vec<Candle>,
    compute: Vec<String>,
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
struct AdvancedSignalResult {
    vwap: Option<VWAPResult>,
    volume_profile: Option<VolumeProfileResult>,
    order_flow: Option<OrderFlowResult>,
    market_profile: Option<MarketProfileResult>,
}

#[derive(Serialize)]
struct VWAPResult {
    vwap: f64,
    upper_band_1: f64,
    upper_band_2: f64,
    lower_band_1: f64,
    lower_band_2: f64,
    deviation: f64,
    signal: String,
    series: Vec<VWAPPoint>,
}

#[derive(Serialize)]
struct VWAPPoint {
    timestamp: String,
    vwap: f64,
    upper1: f64,
    lower1: f64,
}

#[derive(Serialize)]
struct VolumeProfileResult {
    poc: f64,
    value_area_high: f64,
    value_area_low: f64,
    total_volume: f64,
    levels: Vec<VolumeLevel>,
    signal: String,
}

#[derive(Serialize)]
struct VolumeLevel {
    price: f64,
    volume: f64,
    percentage: f64,
    is_poc: bool,
    is_value_area: bool,
}

#[derive(Serialize)]
struct OrderFlowResult {
    buy_volume: f64,
    sell_volume: f64,
    imbalance_ratio: f64,
    delta: f64,
    cumulative_delta: f64,
    signal: String,
    recent_deltas: Vec<DeltaPoint>,
}

#[derive(Serialize, Clone)]
struct DeltaPoint {
    timestamp: String,
    delta: f64,
    cumulative: f64,
}

#[derive(Serialize)]
struct MarketProfileResult {
    poc: f64,
    initial_balance_high: f64,
    initial_balance_low: f64,
    value_area_high: f64,
    value_area_low: f64,
    profile_type: String,
    tpo_count: usize,
    signal: String,
}

pub fn compute(data: Value) -> Result<Value, String> {
    let config: AdvancedSignalConfig =
        serde_json::from_value(data).map_err(|e| format!("Invalid config: {}", e))?;

    if config.candles.is_empty() {
        return Err("No candles provided".to_string());
    }

    let computes: Vec<String> = if config.compute.is_empty() {
        vec!["vwap".into(), "volume_profile".into(), "order_flow".into(), "market_profile".into()]
    } else {
        config.compute
    };

    let vwap = if computes.iter().any(|c| c == "vwap") {
        Some(compute_vwap(&config.candles))
    } else { None };

    let volume_profile = if computes.iter().any(|c| c == "volume_profile") {
        Some(compute_volume_profile(&config.candles))
    } else { None };

    let order_flow = if computes.iter().any(|c| c == "order_flow") {
        Some(compute_order_flow(&config.candles))
    } else { None };

    let market_profile = if computes.iter().any(|c| c == "market_profile") {
        Some(compute_market_profile(&config.candles))
    } else { None };

    let result = AdvancedSignalResult { vwap, volume_profile, order_flow, market_profile };
    serde_json::to_value(result).map_err(|e| format!("Serialization error: {}", e))
}

fn compute_vwap(candles: &[Candle]) -> VWAPResult {
    let mut cum_tp_vol = 0.0;
    let mut cum_vol = 0.0;
    let mut cum_tp2_vol = 0.0;
    let mut series = Vec::with_capacity(candles.len());

    for c in candles {
        let tp = (c.high + c.low + c.close) / 3.0;
        cum_tp_vol += tp * c.volume;
        cum_vol += c.volume;
        cum_tp2_vol += tp * tp * c.volume;

        let vwap = if cum_vol > 0.0 { cum_tp_vol / cum_vol } else { tp };
        let variance = if cum_vol > 0.0 {
            (cum_tp2_vol / cum_vol - vwap * vwap).max(0.0)
        } else { 0.0 };
        let std = variance.sqrt();

        series.push(VWAPPoint {
            timestamp: c.timestamp.clone(),
            vwap: round2(vwap),
            upper1: round2(vwap + std),
            lower1: round2(vwap - std),
        });
    }

    let last_vwap = series.last().map(|s| s.vwap).unwrap_or(0.0);
    let last_upper = series.last().map(|s| s.upper1).unwrap_or(0.0);
    let last_lower = series.last().map(|s| s.lower1).unwrap_or(0.0);
    let last_close = candles.last().map(|c| c.close).unwrap_or(0.0);
    let dev = if last_vwap > 0.0 { (last_close - last_vwap) / last_vwap * 100.0 } else { 0.0 };

    let signal = if last_close > last_upper { "OVERBOUGHT" }
        else if last_close < last_lower { "OVERSOLD" }
        else if last_close > last_vwap { "ABOVE_VWAP" }
        else { "BELOW_VWAP" };

    let std = (last_upper - last_vwap).abs();

    VWAPResult {
        vwap: round2(last_vwap),
        upper_band_1: round2(last_upper),
        upper_band_2: round2(last_vwap + 2.0 * std),
        lower_band_1: round2(last_lower),
        lower_band_2: round2(last_vwap - 2.0 * std),
        deviation: round2(dev),
        signal: signal.to_string(),
        series,
    }
}

fn compute_volume_profile(candles: &[Candle]) -> VolumeProfileResult {
    let min_price = candles.iter().map(|c| c.low).fold(f64::INFINITY, f64::min);
    let max_price = candles.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    let range = max_price - min_price;

    if range <= 0.0 {
        return VolumeProfileResult {
            poc: candles.last().map(|c| c.close).unwrap_or(0.0),
            value_area_high: max_price, value_area_low: min_price,
            total_volume: 0.0, levels: vec![], signal: "NEUTRAL".into(),
        };
    }

    let num_levels = 50.min((range / 0.5).ceil() as usize).max(10);
    let step = range / num_levels as f64;
    let mut volumes = vec![0.0f64; num_levels];
    let total_vol: f64 = candles.iter().map(|c| c.volume).sum();

    for c in candles {
        let tp = (c.high + c.low + c.close) / 3.0;
        let idx = ((tp - min_price) / step).floor() as usize;
        let idx = idx.min(num_levels - 1);
        volumes[idx] += c.volume;
    }

    let poc_idx = volumes.iter().enumerate()
        .max_by(|a, b| a.1.partial_cmp(b.1).unwrap_or(std::cmp::Ordering::Equal))
        .map(|(i, _)| i).unwrap_or(0);
    let poc_price = min_price + (poc_idx as f64 + 0.5) * step;

    let va_target = total_vol * 0.7;
    let mut va_vol = volumes[poc_idx];
    let mut va_low_idx = poc_idx;
    let mut va_high_idx = poc_idx;
    while va_vol < va_target {
        let expand_up = if va_high_idx + 1 < num_levels { volumes[va_high_idx + 1] } else { 0.0 };
        let expand_down = if va_low_idx > 0 { volumes[va_low_idx - 1] } else { 0.0 };
        if expand_up >= expand_down && va_high_idx + 1 < num_levels {
            va_high_idx += 1;
            va_vol += volumes[va_high_idx];
        } else if va_low_idx > 0 {
            va_low_idx -= 1;
            va_vol += volumes[va_low_idx];
        } else {
            break;
        }
    }

    let va_high = min_price + (va_high_idx as f64 + 1.0) * step;
    let va_low = min_price + va_low_idx as f64 * step;
    let last_close = candles.last().map(|c| c.close).unwrap_or(poc_price);

    let signal = if last_close > va_high { "BREAKOUT_UP" }
        else if last_close < va_low { "BREAKOUT_DOWN" }
        else if (last_close - poc_price).abs() / poc_price < 0.005 { "AT_POC" }
        else { "IN_VALUE_AREA" };

    let levels: Vec<VolumeLevel> = (0..num_levels).map(|i| {
        let price = min_price + (i as f64 + 0.5) * step;
        VolumeLevel {
            price: round2(price),
            volume: round2(volumes[i]),
            percentage: if total_vol > 0.0 { round2(volumes[i] / total_vol * 100.0) } else { 0.0 },
            is_poc: i == poc_idx,
            is_value_area: i >= va_low_idx && i <= va_high_idx,
        }
    }).collect();

    VolumeProfileResult {
        poc: round2(poc_price),
        value_area_high: round2(va_high),
        value_area_low: round2(va_low),
        total_volume: round2(total_vol),
        levels,
        signal: signal.to_string(),
    }
}

fn compute_order_flow(candles: &[Candle]) -> OrderFlowResult {
    let mut buy_vol = 0.0;
    let mut sell_vol = 0.0;
    let mut cum_delta = 0.0;
    let mut deltas = Vec::with_capacity(candles.len());

    for c in candles {
        let body_ratio = if c.high - c.low > 0.0 {
            (c.close - c.open).abs() / (c.high - c.low)
        } else { 0.5 };

        let (bv, sv) = if c.close >= c.open {
            let bv = c.volume * (0.5 + body_ratio * 0.3);
            (bv, c.volume - bv)
        } else {
            let sv = c.volume * (0.5 + body_ratio * 0.3);
            (c.volume - sv, sv)
        };

        buy_vol += bv;
        sell_vol += sv;
        let delta = bv - sv;
        cum_delta += delta;

        deltas.push(DeltaPoint {
            timestamp: c.timestamp.clone(),
            delta: round2(delta),
            cumulative: round2(cum_delta),
        });
    }

    let total = buy_vol + sell_vol;
    let imbalance = if total > 0.0 { (buy_vol - sell_vol) / total } else { 0.0 };

    let recent_n = 10.min(deltas.len());
    let recent_delta: f64 = deltas[deltas.len() - recent_n..].iter().map(|d| d.delta).sum();

    let signal = if imbalance > 0.3 && recent_delta > 0.0 { "STRONG_BUYING" }
        else if imbalance < -0.3 && recent_delta < 0.0 { "STRONG_SELLING" }
        else if imbalance > 0.1 { "MILD_BUYING" }
        else if imbalance < -0.1 { "MILD_SELLING" }
        else { "BALANCED" };

    OrderFlowResult {
        buy_volume: round2(buy_vol),
        sell_volume: round2(sell_vol),
        imbalance_ratio: round2(imbalance),
        delta: round2(buy_vol - sell_vol),
        cumulative_delta: round2(cum_delta),
        signal: signal.to_string(),
        recent_deltas: deltas[deltas.len().saturating_sub(20)..].to_vec(),
    }
}

fn compute_market_profile(candles: &[Candle]) -> MarketProfileResult {
    if candles.is_empty() {
        return MarketProfileResult {
            poc: 0.0, initial_balance_high: 0.0, initial_balance_low: 0.0,
            value_area_high: 0.0, value_area_low: 0.0,
            profile_type: "unknown".into(), tpo_count: 0, signal: "NEUTRAL".into(),
        };
    }

    let min_p = candles.iter().map(|c| c.low).fold(f64::INFINITY, f64::min);
    let max_p = candles.iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    let range = max_p - min_p;
    if range <= 0.0 {
        return MarketProfileResult {
            poc: candles[0].close, initial_balance_high: max_p, initial_balance_low: min_p,
            value_area_high: max_p, value_area_low: min_p,
            profile_type: "single_tick".into(), tpo_count: 1, signal: "NEUTRAL".into(),
        };
    }

    let tick = (range / 30.0).max(0.5);
    let num_ticks = ((range / tick).ceil() as usize).max(1);
    let mut tpo_counts = vec![0usize; num_ticks];

    for c in candles {
        let low_idx = ((c.low - min_p) / tick).floor() as usize;
        let high_idx = ((c.high - min_p) / tick).floor().min(num_ticks as f64 - 1.0) as usize;
        for i in low_idx..=high_idx.min(num_ticks - 1) {
            tpo_counts[i] += 1;
        }
    }

    let total_tpo: usize = tpo_counts.iter().sum();
    let poc_idx = tpo_counts.iter().enumerate()
        .max_by_key(|(_, &count)| count)
        .map(|(i, _)| i).unwrap_or(0);
    let poc = min_p + (poc_idx as f64 + 0.5) * tick;

    let ib_count = (candles.len() / 6).max(1);
    let ib_high = candles[..ib_count].iter().map(|c| c.high).fold(f64::NEG_INFINITY, f64::max);
    let ib_low = candles[..ib_count].iter().map(|c| c.low).fold(f64::INFINITY, f64::min);

    let va_target = (total_tpo as f64 * 0.7) as usize;
    let mut va_tpo = tpo_counts[poc_idx];
    let mut va_l = poc_idx;
    let mut va_h = poc_idx;
    while va_tpo < va_target {
        let up = if va_h + 1 < num_ticks { tpo_counts[va_h + 1] } else { 0 };
        let dn = if va_l > 0 { tpo_counts[va_l - 1] } else { 0 };
        if up >= dn && va_h + 1 < num_ticks { va_h += 1; va_tpo += tpo_counts[va_h]; }
        else if va_l > 0 { va_l -= 1; va_tpo += tpo_counts[va_l]; }
        else { break; }
    }

    let va_high = min_p + (va_h as f64 + 1.0) * tick;
    let va_low = min_p + va_l as f64 * tick;

    let last = candles.last().unwrap().close;
    let profile_type = if (va_high - va_low) / range < 0.4 { "narrow" }
        else if poc_idx as f64 / num_ticks as f64 > 0.6 { "p_shaped" }
        else if (poc_idx as f64 / num_ticks as f64) < 0.4 { "b_shaped" }
        else { "normal" };

    let signal = if last > ib_high && last > va_high { "BREAKOUT_UP" }
        else if last < ib_low && last < va_low { "BREAKOUT_DOWN" }
        else if (last - poc).abs() / poc < 0.005 { "AT_POC" }
        else { "IN_VALUE_AREA" };

    MarketProfileResult {
        poc: round2(poc),
        initial_balance_high: round2(ib_high),
        initial_balance_low: round2(ib_low),
        value_area_high: round2(va_high),
        value_area_low: round2(va_low),
        profile_type: profile_type.to_string(),
        tpo_count: total_tpo,
        signal: signal.to_string(),
    }
}

fn round2(v: f64) -> f64 { (v * 100.0).round() / 100.0 }
