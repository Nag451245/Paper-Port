//! Order book / Level 2 data analysis module for the Capital Guard algo trading engine.
//! Accepts market depth (bid/ask levels with price, qty, order count), computes bid-ask imbalance,
//! large order clustering, spoofing detection, VPIN (order flow toxicity), microprice, and spread.

use serde::{Deserialize, Serialize};
use serde_json::Value;
use crate::utils::{round2, round4};

#[derive(Deserialize)]
struct OrderBookInput {
    symbol: String,
    bids: Vec<Level>,
    asks: Vec<Level>,
    #[serde(default)]
    history: Vec<DepthSnapshot>,
}

#[derive(Deserialize)]
struct Level {
    price: f64,
    qty: f64,
    #[serde(default)]
    orders: u32,
}

#[derive(Deserialize)]
struct DepthSnapshot {
    bids: Vec<Level>,
    asks: Vec<Level>,
}

#[derive(Serialize, Deserialize)]
struct OrderBookAnalysis {
    symbol: String,
    bid_ask_imbalance: f64,
    bid_depth: f64,
    ask_depth: f64,
    large_bid_clusters: Vec<PriceCluster>,
    large_ask_clusters: Vec<PriceCluster>,
    spoofing_alerts: Vec<SpoofAlert>,
    vpin: f64,
    order_flow_bias: String,
    spread_bps: f64,
    microprice: f64,
}

#[derive(Serialize, Deserialize)]
struct PriceCluster {
    price: f64,
    total_qty: f64,
    avg_order_size: f64,
    levels_count: usize,
}

#[derive(Serialize, Deserialize)]
struct SpoofAlert {
    price: f64,
    side: String,
    pattern: String,
    severity: f64,
}

pub fn compute(data: Value) -> Result<Value, String> {
    let input: OrderBookInput =
        serde_json::from_value(data).map_err(|e| format!("Invalid orderbook input: {}", e))?;

    if input.bids.is_empty() && input.asks.is_empty() {
        return Ok(serde_json::to_value(OrderBookAnalysis {
            symbol: input.symbol.clone(),
            bid_ask_imbalance: 0.0,
            bid_depth: 0.0,
            ask_depth: 0.0,
            large_bid_clusters: vec![],
            large_ask_clusters: vec![],
            spoofing_alerts: vec![],
            vpin: 0.0,
            order_flow_bias: "NEUTRAL".to_string(),
            spread_bps: 0.0,
            microprice: 0.0,
        }).map_err(|e| e.to_string())?);
    }

    let best_bid = input.bids.iter().map(|l| l.price).fold(0.0_f64, f64::max);
    let best_ask = input.asks.iter().map(|l| l.price).fold(f64::INFINITY, f64::min);
    let mid = if best_bid > 0.0 && best_ask < f64::INFINITY {
        (best_bid + best_ask) / 2.0
    } else if best_bid > 0.0 {
        best_bid
    } else {
        best_ask
    };

    let bid_depth_1pct = compute_depth_within_pct(&input.bids, best_bid, 0.01, true);
    let ask_depth_1pct = compute_depth_within_pct(&input.asks, best_ask, 0.01, false);

    let bid_vol: f64 = input.bids.iter().map(|l| l.qty).sum();
    let ask_vol: f64 = input.asks.iter().map(|l| l.qty).sum();
    let total_vol = bid_vol + ask_vol;
    let bid_ask_imbalance = if total_vol > 0.0 {
        ((bid_vol - ask_vol) / total_vol).clamp(-1.0, 1.0)
    } else {
        0.0
    };

    let large_bid_clusters = detect_large_order_clusters(&input.bids, true);
    let large_ask_clusters = detect_large_order_clusters(&input.asks, false);

    let spoofing_alerts = detect_spoofing(&input.bids, &input.asks, &input.history);

    let vpin = compute_vpin(&input.bids, &input.asks, &input.history);

    let order_flow_bias = if bid_ask_imbalance > 0.2 {
        "BULLISH"
    } else if bid_ask_imbalance < -0.2 {
        "BEARISH"
    } else {
        "NEUTRAL"
    }
    .to_string();

    let spread_bps = if mid > 0.0 && best_ask < f64::INFINITY && best_bid > 0.0 {
        ((best_ask - best_bid) / mid) * 10_000.0
    } else {
        0.0
    };

    let microprice = compute_microprice(&input.bids, &input.asks);

    let output = OrderBookAnalysis {
        symbol: input.symbol.clone(),
        bid_ask_imbalance: round4(bid_ask_imbalance),
        bid_depth: round2(bid_depth_1pct),
        ask_depth: round2(ask_depth_1pct),
        large_bid_clusters,
        large_ask_clusters,
        spoofing_alerts,
        vpin: round4(vpin),
        order_flow_bias,
        spread_bps: round2(spread_bps),
        microprice: round4(microprice),
    };

    serde_json::to_value(output).map_err(|e| format!("Serialization error: {}", e))
}

fn compute_depth_within_pct(levels: &[Level], reference: f64, pct: f64, is_bid: bool) -> f64 {
    if reference <= 0.0 {
        return 0.0;
    }
    let bound = if is_bid {
        reference * (1.0 - pct)
    } else {
        reference * (1.0 + pct)
    };
    levels
        .iter()
        .filter(|l| {
            if is_bid {
                l.price >= bound && l.price <= reference
            } else {
                l.price >= reference && l.price <= bound
            }
        })
        .map(|l| l.qty)
        .sum()
}

/// Detect large order clusters: orders >2x average size at nearby price levels.
/// Groups consecutive large-order levels within 0.5% of each other into clusters.
fn detect_large_order_clusters(levels: &[Level], is_bid: bool) -> Vec<PriceCluster> {
    if levels.is_empty() {
        return vec![];
    }
    let total_qty: f64 = levels.iter().map(|l| l.qty).sum();
    let total_orders: u32 = levels.iter().map(|l| l.orders.max(1)).sum();
    let avg_order_size = if total_orders > 0 {
        total_qty / total_orders as f64
    } else {
        0.0
    };

    let threshold = avg_order_size * 2.0;
    let mut large_levels: Vec<&Level> = levels
        .iter()
        .filter(|l| {
            let order_size = if l.orders > 0 {
                l.qty / l.orders as f64
            } else {
                l.qty
            };
            order_size >= threshold && l.qty > 0.0
        })
        .collect();

    if large_levels.is_empty() {
        return vec![];
    }

    // Sort by price: bids descending (best first), asks ascending
    if is_bid {
        large_levels.sort_by(|a, b| b.price.partial_cmp(&a.price).unwrap_or(std::cmp::Ordering::Equal));
    } else {
        large_levels.sort_by(|a, b| a.price.partial_cmp(&b.price).unwrap_or(std::cmp::Ordering::Equal));
    }

    // Group nearby levels (within 0.5% of reference price) into clusters
    const NEARBY_PCT: f64 = 0.005;
    let mut clusters: Vec<PriceCluster> = vec![];
    let mut i = 0usize;
    while i < large_levels.len() {
        let anchor = large_levels[i];
        let mut cluster_qty = anchor.qty;
        let mut cluster_orders = anchor.orders.max(1);
        let mut count = 1usize;
        let ref_price = anchor.price;

        let mut j = i + 1;
        while j < large_levels.len() {
            let l = large_levels[j];
            let within = if is_bid {
                l.price >= ref_price * (1.0 - NEARBY_PCT) && l.price <= ref_price * (1.0 + NEARBY_PCT)
            } else {
                l.price >= ref_price * (1.0 - NEARBY_PCT) && l.price <= ref_price * (1.0 + NEARBY_PCT)
            };
            if within {
                cluster_qty += l.qty;
                cluster_orders += l.orders.max(1);
                count += 1;
                j += 1;
            } else {
                break;
            }
        }
        let avg_ord = cluster_qty / cluster_orders as f64;
        clusters.push(PriceCluster {
            price: round4(ref_price),
            total_qty: round2(cluster_qty),
            avg_order_size: round2(avg_ord),
            levels_count: count,
        });
        i = j;
    }

    clusters
}

fn detect_spoofing(
    current_bids: &[Level],
    current_asks: &[Level],
    history: &[DepthSnapshot],
) -> Vec<SpoofAlert> {
    let mut alerts = vec![];
    if history.len() < 3 {
        return alerts;
    }

    let all_levels: Vec<(&[Level], &str)> = vec![
        (current_bids, "BID"),
        (current_asks, "ASK"),
    ];

    for (levels, side) in all_levels {
        let total_qty: f64 = levels.iter().map(|l| l.qty).sum();
        let total_orders: u32 = levels.iter().map(|l| l.orders.max(1)).sum();
        let mut avg_order = if total_orders > 0 {
            total_qty / total_orders as f64
        } else {
            0.0
        };
        if avg_order <= 0.0 {
            for snap in history {
                let levs = if side == "BID" { &snap.bids } else { &snap.asks };
                let sq: f64 = levs.iter().map(|l| l.qty).sum();
                let so: u32 = levs.iter().map(|l| l.orders.max(1)).sum();
                if so > 0 {
                    avg_order = sq / so as f64;
                    break;
                }
            }
        }
        let threshold = (avg_order * 2.0).max(1.0);

        for (i, window) in history.windows(2).enumerate() {
            let prev_levels = if side == "BID" { &window[0].bids } else { &window[0].asks };
            let curr_levels = if side == "BID" { &window[1].bids } else { &window[1].asks };

            for pl in prev_levels {
                let order_size = if pl.orders > 0 {
                    pl.qty / pl.orders as f64
                } else {
                    pl.qty
                };
                if order_size < threshold {
                    continue;
                }
                let exists_curr = curr_levels.iter().any(|l| (l.price - pl.price).abs() < 0.001);
                if !exists_curr {
                    let reappears = history[i + 2..].iter().any(|h| {
                        let levs = if side == "BID" { &h.bids } else { &h.asks };
                        levs.iter().any(|l| {
                            (l.price - pl.price).abs() < 0.001
                                && (if l.orders > 0 { l.qty / l.orders as f64 } else { l.qty }) >= threshold
                        })
                    });
                    if reappears {
                        alerts.push(SpoofAlert {
                            price: round4(pl.price),
                            side: side.to_string(),
                            pattern: "LARGE_ORDER_APPEAR_DISAPPEAR".to_string(),
                            severity: round2((order_size / threshold).min(2.0)),
                        });
                    }
                }
            }
        }
    }

    alerts
}

fn compute_vpin(bids: &[Level], asks: &[Level], history: &[DepthSnapshot]) -> f64 {
    let bid_vol: f64 = bids.iter().map(|l| l.qty).sum();
    let ask_vol: f64 = asks.iter().map(|l| l.qty).sum();
    let total = bid_vol + ask_vol;
    if total <= 0.0 {
        return 0.0;
    }
    let imbalance = (bid_vol - ask_vol).abs() / total;

    if history.is_empty() {
        return imbalance;
    }

    let mut cumulative_imbalance = imbalance;
    let mut count = 1usize;
    for snap in history {
        let bv: f64 = snap.bids.iter().map(|l| l.qty).sum();
        let av: f64 = snap.asks.iter().map(|l| l.qty).sum();
        let tot = bv + av;
        if tot > 0.0 {
            cumulative_imbalance += (bv - av).abs() / tot;
            count += 1;
        }
    }
    cumulative_imbalance / count as f64
}

fn compute_microprice(bids: &[Level], asks: &[Level]) -> f64 {
    let best_bid = bids.iter().map(|l| l.price).fold(0.0_f64, f64::max);
    let best_ask = asks.iter().map(|l| l.price).fold(f64::INFINITY, f64::min);
    let bid_qty: f64 = bids.iter().filter(|l| (l.price - best_bid).abs() < 0.001).map(|l| l.qty).sum();
    let ask_qty: f64 = asks.iter().filter(|l| (l.price - best_ask).abs() < 0.001).map(|l| l.qty).sum();

    let total = bid_qty + ask_qty;
    if total <= 0.0 {
        return if best_bid > 0.0 && best_ask < f64::INFINITY {
            (best_bid + best_ask) / 2.0
        } else if best_bid > 0.0 {
            best_bid
        } else {
            best_ask
        };
    }
    (best_bid * ask_qty + best_ask * bid_qty) / total
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn test_empty_orderbook() {
        let result = compute(json!({
            "symbol": "TEST",
            "bids": [],
            "asks": []
        })).unwrap();
        let out: OrderBookAnalysis = serde_json::from_value(result).unwrap();
        assert_eq!(out.symbol, "TEST");
        assert_eq!(out.bid_ask_imbalance, 0.0);
        assert_eq!(out.bid_depth, 0.0);
        assert_eq!(out.ask_depth, 0.0);
        assert_eq!(out.order_flow_bias, "NEUTRAL");
        assert_eq!(out.vpin, 0.0);
    }

    #[test]
    fn test_bid_ask_imbalance_bullish() {
        let result = compute(json!({
            "symbol": "RELIANCE",
            "bids": [
                { "price": 100.0, "qty": 500.0, "orders": 10 },
                { "price": 99.5, "qty": 300.0, "orders": 5 }
            ],
            "asks": [
                { "price": 100.5, "qty": 100.0, "orders": 5 },
                { "price": 101.0, "qty": 100.0, "orders": 3 }
            ]
        })).unwrap();
        let out: OrderBookAnalysis = serde_json::from_value(result).unwrap();
        assert!(out.bid_ask_imbalance > 0.0, "more bid volume should yield positive imbalance");
        assert_eq!(out.order_flow_bias, "BULLISH");
    }

    #[test]
    fn test_bid_ask_imbalance_bearish() {
        let result = compute(json!({
            "symbol": "TCS",
            "bids": [{ "price": 3500.0, "qty": 50.0, "orders": 5 }],
            "asks": [
                { "price": 3501.0, "qty": 200.0, "orders": 10 },
                { "price": 3502.0, "qty": 250.0, "orders": 8 }
            ]
        })).unwrap();
        let out: OrderBookAnalysis = serde_json::from_value(result).unwrap();
        assert!(out.bid_ask_imbalance < 0.0);
        assert_eq!(out.order_flow_bias, "BEARISH");
    }

    #[test]
    fn test_spread_and_microprice() {
        let result = compute(json!({
            "symbol": "INFY",
            "bids": [
                { "price": 1500.0, "qty": 100.0, "orders": 5 },
                { "price": 1499.0, "qty": 200.0, "orders": 10 }
            ],
            "asks": [
                { "price": 1500.5, "qty": 150.0, "orders": 8 },
                { "price": 1501.0, "qty": 100.0, "orders": 4 }
            ]
        })).unwrap();
        let out: OrderBookAnalysis = serde_json::from_value(result).unwrap();
        assert!(out.spread_bps > 0.0, "spread should be positive");
        assert!(out.microprice >= 1500.0 && out.microprice <= 1500.5);
        assert!(out.bid_depth > 0.0);
        assert!(out.ask_depth > 0.0);
    }

    #[test]
    fn test_large_order_clusters() {
        let result = compute(json!({
            "symbol": "HDFC",
            "bids": [
                { "price": 1600.0, "qty": 10.0, "orders": 10 },
                { "price": 1599.5, "qty": 500.0, "orders": 2 },
                { "price": 1599.0, "qty": 10.0, "orders": 5 }
            ],
            "asks": [
                { "price": 1600.5, "qty": 600.0, "orders": 1 },
                { "price": 1601.0, "qty": 20.0, "orders": 10 }
            ]
        })).unwrap();
        let out: OrderBookAnalysis = serde_json::from_value(result).unwrap();
        assert!(!out.large_bid_clusters.is_empty(), "large bid at 1599.5 should be detected");
        assert!(!out.large_ask_clusters.is_empty(), "large ask at 1600.5 should be detected");
    }

    #[test]
    fn test_spoofing_detection_with_history() {
        let result = compute(json!({
            "symbol": "WIPRO",
            "bids": [
                { "price": 500.0, "qty": 100.0, "orders": 5 },
                { "price": 499.5, "qty": 50.0, "orders": 2 }
            ],
            "asks": [
                { "price": 500.5, "qty": 80.0, "orders": 4 }
            ],
            "history": [
                { "bids": [{ "price": 499.5, "qty": 1000.0, "orders": 1 }], "asks": [] },
                { "bids": [], "asks": [] },
                { "bids": [{ "price": 499.5, "qty": 1000.0, "orders": 1 }], "asks": [] }
            ]
        })).unwrap();
        let out: OrderBookAnalysis = serde_json::from_value(result).unwrap();
        assert!(out.vpin >= 0.0 && out.vpin <= 1.0);
        assert!(out.bid_ask_imbalance >= -1.0 && out.bid_ask_imbalance <= 1.0);
    }

    #[test]
    fn test_neutral_order_flow() {
        let result = compute(json!({
            "symbol": "NIFTY",
            "bids": [{ "price": 22000.0, "qty": 100.0, "orders": 10 }],
            "asks": [{ "price": 22001.0, "qty": 100.0, "orders": 10 }]
        })).unwrap();
        let out: OrderBookAnalysis = serde_json::from_value(result).unwrap();
        assert!((out.bid_ask_imbalance).abs() < 0.2);
        assert_eq!(out.order_flow_bias, "NEUTRAL");
    }
}
