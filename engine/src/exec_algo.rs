use serde::{Deserialize, Serialize};
use std::sync::{Arc, Mutex};
use std::sync::atomic::{AtomicBool, Ordering};
use crate::broker::{OrderRequest, OrderSide, OrderType, ProductType};
use crate::oms::OMS;

/// Execution algorithm type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ExecAlgoType {
    /// Send the full order as a single limit order (default)
    Direct,
    /// Time-Weighted Average Price: split order into equal slices over a time window
    TWAP,
    /// Volume-Weighted Average Price: weight slices by historical volume profile
    VWAP,
    /// Iceberg: show only a small visible portion, replenish as fills occur
    Iceberg,
}

impl Default for ExecAlgoType {
    fn default() -> Self { Self::Direct }
}

impl ExecAlgoType {
    pub fn from_str_loose(s: &str) -> Self {
        match s.to_lowercase().as_str() {
            "twap" => Self::TWAP,
            "vwap" => Self::VWAP,
            "iceberg" | "ice" => Self::Iceberg,
            _ => Self::Direct,
        }
    }
}

/// Configuration for a TWAP execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TwapConfig {
    /// Total duration in seconds over which to execute
    pub duration_secs: u64,
    /// Number of slices to split the order into
    pub num_slices: u32,
    /// Randomize slice timing by +/- this percentage (0-50)
    pub randomize_pct: f64,
}

impl Default for TwapConfig {
    fn default() -> Self {
        Self {
            duration_secs: 300,
            num_slices: 10,
            randomize_pct: 15.0,
        }
    }
}

/// Configuration for a VWAP execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct VwapConfig {
    /// Total duration in seconds
    pub duration_secs: u64,
    /// Number of slices
    pub num_slices: u32,
    /// Historical volume buckets (weights per slice). If empty, falls back to TWAP.
    pub volume_profile: Vec<f64>,
    /// Max participation rate (fraction of bucket volume to use, 0.0-1.0)
    pub max_participation_rate: f64,
}

impl Default for VwapConfig {
    fn default() -> Self {
        Self {
            duration_secs: 300,
            num_slices: 10,
            volume_profile: Vec::new(),
            max_participation_rate: 0.25,
        }
    }
}

/// Configuration for iceberg execution
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct IcebergConfig {
    /// Visible quantity per slice (the "tip" of the iceberg)
    pub visible_qty: i64,
    /// Delay between replenishments in milliseconds
    pub replenish_delay_ms: u64,
}

impl Default for IcebergConfig {
    fn default() -> Self {
        Self {
            visible_qty: 10,
            replenish_delay_ms: 500,
        }
    }
}

/// An execution plan: describes how to break a parent order into child slices
#[derive(Debug, Clone, Serialize)]
pub struct ExecPlan {
    pub algo: ExecAlgoType,
    pub parent_symbol: String,
    pub parent_side: OrderSide,
    pub total_qty: i64,
    pub slices: Vec<ExecSlice>,
}

#[derive(Debug, Clone, Serialize)]
pub struct ExecSlice {
    pub slice_idx: usize,
    pub qty: i64,
    pub delay_ms: u64,
    pub price_offset_bps: f64,
}

/// Result of executing a plan
#[derive(Debug, Clone, Serialize)]
pub struct ExecResult {
    pub algo: ExecAlgoType,
    pub total_requested: i64,
    pub total_filled: i64,
    pub avg_fill_price: f64,
    pub num_slices_attempted: usize,
    pub num_slices_filled: usize,
    pub num_slices_failed: usize,
    pub vwap_achieved: f64,
    pub elapsed_ms: u64,
}

/// Build a TWAP execution plan
pub fn plan_twap(symbol: &str, side: OrderSide, total_qty: i64, config: &TwapConfig) -> ExecPlan {
    let n = config.num_slices.max(1) as usize;
    let base_qty = total_qty / n as i64;
    let remainder = total_qty - base_qty * n as i64;
    let interval_ms = (config.duration_secs * 1000) / n as u64;

    let slices: Vec<ExecSlice> = (0..n).map(|i| {
        let qty = base_qty + if (i as i64) < remainder { 1 } else { 0 };
        let jitter = if config.randomize_pct > 0.0 {
            let pct = config.randomize_pct.min(50.0) / 100.0;
            let offset = (interval_ms as f64 * pct * ((i % 3) as f64 - 1.0) / 2.0) as i64;
            (interval_ms as i64 + offset).max(100) as u64
        } else {
            interval_ms
        };
        ExecSlice {
            slice_idx: i,
            qty,
            delay_ms: if i == 0 { 0 } else { jitter },
            price_offset_bps: 0.0,
        }
    }).collect();

    ExecPlan {
        algo: ExecAlgoType::TWAP,
        parent_symbol: symbol.to_string(),
        parent_side: side,
        total_qty,
        slices,
    }
}

/// Build a VWAP execution plan
pub fn plan_vwap(symbol: &str, side: OrderSide, total_qty: i64, config: &VwapConfig) -> ExecPlan {
    let n = config.num_slices.max(1) as usize;
    let interval_ms = (config.duration_secs * 1000) / n as u64;

    let weights = if config.volume_profile.len() >= n {
        config.volume_profile[..n].to_vec()
    } else {
        vec![1.0; n]
    };
    let total_weight: f64 = weights.iter().sum();

    let mut allocated = 0i64;
    let slices: Vec<ExecSlice> = (0..n).map(|i| {
        let w = weights[i] / total_weight.max(1e-9);
        let qty = if i == n - 1 {
            total_qty - allocated
        } else {
            let q = (total_qty as f64 * w).round() as i64;
            q.max(0).min(total_qty - allocated)
        };
        allocated += qty;
        ExecSlice {
            slice_idx: i,
            qty,
            delay_ms: if i == 0 { 0 } else { interval_ms },
            price_offset_bps: 0.0,
        }
    }).collect();

    ExecPlan {
        algo: ExecAlgoType::VWAP,
        parent_symbol: symbol.to_string(),
        parent_side: side,
        total_qty,
        slices,
    }
}

/// Build an iceberg execution plan
pub fn plan_iceberg(symbol: &str, side: OrderSide, total_qty: i64, config: &IcebergConfig) -> ExecPlan {
    let visible = config.visible_qty.max(1);
    let n = ((total_qty + visible - 1) / visible) as usize;

    let mut allocated = 0i64;
    let slices: Vec<ExecSlice> = (0..n).map(|i| {
        let qty = visible.min(total_qty - allocated);
        allocated += qty;
        ExecSlice {
            slice_idx: i,
            qty,
            delay_ms: if i == 0 { 0 } else { config.replenish_delay_ms },
            price_offset_bps: 0.0,
        }
    }).collect();

    ExecPlan {
        algo: ExecAlgoType::Iceberg,
        parent_symbol: symbol.to_string(),
        parent_side: side,
        total_qty,
        slices,
    }
}

/// Execute a plan synchronously by submitting each slice through OMS
pub fn execute_plan_sync(
    plan: &ExecPlan,
    oms: &OMS,
    exchange: &str,
    product: ProductType,
    price: Option<f64>,
    strategy_id: Option<String>,
    reference_price: Option<f64>,
) -> ExecResult {
    let start = std::time::Instant::now();
    let mut total_filled = 0i64;
    let mut fill_value = 0.0f64;
    let mut filled_count = 0usize;
    let mut failed_count = 0usize;

    for (i, slice) in plan.slices.iter().enumerate() {
        if slice.qty <= 0 { continue; }

        if i > 0 && slice.delay_ms > 0 {
            std::thread::sleep(std::time::Duration::from_millis(slice.delay_ms));
        }

        let order_req = OrderRequest {
            symbol: plan.parent_symbol.clone(),
            exchange: exchange.to_string(),
            side: plan.parent_side,
            order_type: OrderType::Limit,
            quantity: slice.qty,
            price,
            trigger_price: None,
            product,
            tag: Some(format!("{:?}:slice:{}", plan.algo, slice.slice_idx)),
            ..Default::default()
        };

        match oms.submit_order(order_req, strategy_id.clone(), reference_price) {
            Ok(order) => {
                if order.filled_qty > 0 {
                    total_filled += order.filled_qty;
                    fill_value += order.avg_fill_price * order.filled_qty as f64;
                    filled_count += 1;
                } else {
                    failed_count += 1;
                }
            }
            Err(_) => {
                failed_count += 1;
            }
        }
    }

    let avg_price = if total_filled > 0 { fill_value / total_filled as f64 } else { 0.0 };

    ExecResult {
        algo: plan.algo,
        total_requested: plan.total_qty,
        total_filled,
        avg_fill_price: avg_price,
        num_slices_attempted: plan.slices.len(),
        num_slices_filled: filled_count,
        num_slices_failed: failed_count,
        vwap_achieved: avg_price,
        elapsed_ms: start.elapsed().as_millis() as u64,
    }
}

/// Spawn an async TWAP/VWAP/Iceberg execution that runs slices with real delays.
/// Returns an Arc<ExecResult> that gets populated when execution completes.
pub fn spawn_async_exec(
    plan: ExecPlan,
    oms: Arc<OMS>,
    exchange: String,
    product: ProductType,
    price: Option<f64>,
    strategy_id: Option<String>,
    reference_price: Option<f64>,
    cancel_flag: Arc<AtomicBool>,
) -> Arc<Mutex<Option<ExecResult>>> {
    let result_holder: Arc<Mutex<Option<ExecResult>>> = Arc::new(Mutex::new(None));
    let rh = result_holder.clone();

    tokio::spawn(async move {
        let start = std::time::Instant::now();
        let mut total_filled = 0i64;
        let mut fill_value = 0.0f64;
        let mut filled_count = 0usize;
        let mut failed_count = 0usize;

        for (i, slice) in plan.slices.iter().enumerate() {
            if cancel_flag.load(Ordering::Acquire) {
                break;
            }
            if slice.qty <= 0 { continue; }

            if i > 0 && slice.delay_ms > 0 {
                tokio::time::sleep(std::time::Duration::from_millis(slice.delay_ms)).await;
            }

            if cancel_flag.load(Ordering::Acquire) {
                break;
            }

            let oms_ref = oms.clone();
            let sym = plan.parent_symbol.clone();
            let exch = exchange.clone();
            let sid = strategy_id.clone();
            let side = plan.parent_side;
            let qty = slice.qty;
            let slice_idx = slice.slice_idx;

            let result = tokio::task::spawn_blocking(move || {
                let order_req = OrderRequest {
                    symbol: sym,
                    exchange: exch,
                    side,
                    order_type: OrderType::Limit,
                    quantity: qty,
                    price,
                    trigger_price: None,
                    product,
                    tag: Some(format!("{:?}:slice:{}", plan.algo, slice_idx)),
                    ..Default::default()
                };
                oms_ref.submit_order(order_req, sid, reference_price)
            }).await;

            match result {
                Ok(Ok(order)) if order.filled_qty > 0 => {
                    total_filled += order.filled_qty;
                    fill_value += order.avg_fill_price * order.filled_qty as f64;
                    filled_count += 1;
                }
                _ => { failed_count += 1; }
            }
        }

        let avg_price = if total_filled > 0 { fill_value / total_filled as f64 } else { 0.0 };
        let exec_result = ExecResult {
            algo: plan.algo,
            total_requested: plan.total_qty,
            total_filled,
            avg_fill_price: avg_price,
            num_slices_attempted: plan.slices.len(),
            num_slices_filled: filled_count,
            num_slices_failed: failed_count,
            vwap_achieved: avg_price,
            elapsed_ms: start.elapsed().as_millis() as u64,
        };

        if let Ok(mut guard) = rh.lock() {
            *guard = Some(exec_result);
        }
    });

    result_holder
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::PaperBroker;
    use crate::oms::FatFingerLimits;

    fn make_oms() -> OMS {
        let broker = Arc::new(PaperBroker::new(10_000_000.0));
        OMS::new(broker, FatFingerLimits::default())
    }

    #[test]
    fn test_twap_plan_splits_evenly() {
        let plan = plan_twap("RELIANCE", OrderSide::Buy, 100, &TwapConfig {
            duration_secs: 300, num_slices: 5, randomize_pct: 0.0,
        });
        assert_eq!(plan.slices.len(), 5);
        let total: i64 = plan.slices.iter().map(|s| s.qty).sum();
        assert_eq!(total, 100);
        assert_eq!(plan.slices[0].qty, 20);
    }

    #[test]
    fn test_twap_plan_handles_remainder() {
        let plan = plan_twap("NIFTY", OrderSide::Buy, 103, &TwapConfig {
            duration_secs: 60, num_slices: 10, randomize_pct: 0.0,
        });
        let total: i64 = plan.slices.iter().map(|s| s.qty).sum();
        assert_eq!(total, 103, "all shares must be allocated");
    }

    #[test]
    fn test_vwap_plan_weighted() {
        let plan = plan_vwap("TCS", OrderSide::Sell, 100, &VwapConfig {
            duration_secs: 300,
            num_slices: 4,
            volume_profile: vec![0.1, 0.3, 0.4, 0.2],
            max_participation_rate: 0.25,
        });
        assert_eq!(plan.slices.len(), 4);
        let total: i64 = plan.slices.iter().map(|s| s.qty).sum();
        assert_eq!(total, 100, "all shares must be allocated");
        assert!(plan.slices[2].qty >= plan.slices[0].qty, "heaviest bucket should get more");
    }

    #[test]
    fn test_iceberg_plan() {
        let plan = plan_iceberg("INFY", OrderSide::Buy, 100, &IcebergConfig {
            visible_qty: 15, replenish_delay_ms: 200,
        });
        let total: i64 = plan.slices.iter().map(|s| s.qty).sum();
        assert_eq!(total, 100);
        assert_eq!(plan.slices.len(), 7); // ceil(100/15)
        assert_eq!(plan.slices[0].qty, 15);
        assert_eq!(plan.slices[6].qty, 10); // remainder
    }

    #[test]
    fn test_exec_plan_sync_direct() {
        let oms = make_oms();
        let plan = ExecPlan {
            algo: ExecAlgoType::Direct,
            parent_symbol: "RELIANCE".into(),
            parent_side: OrderSide::Buy,
            total_qty: 10,
            slices: vec![ExecSlice { slice_idx: 0, qty: 10, delay_ms: 0, price_offset_bps: 0.0 }],
        };
        let result = execute_plan_sync(&plan, &oms, "NSE", ProductType::Delivery,
            Some(2500.0), None, None);
        assert_eq!(result.total_filled, 10);
        assert_eq!(result.avg_fill_price, 2500.0);
    }

    #[test]
    fn test_exec_twap_sync_fills_all() {
        let oms = make_oms();
        let plan = plan_twap("HDFC", OrderSide::Buy, 50, &TwapConfig {
            duration_secs: 1, num_slices: 5, randomize_pct: 0.0,
        });
        let result = execute_plan_sync(&plan, &oms, "NSE", ProductType::Delivery,
            Some(2800.0), Some("test".into()), None);
        assert_eq!(result.total_filled, 50);
        assert_eq!(result.num_slices_filled, 5);
        assert_eq!(result.num_slices_failed, 0);
    }

    #[test]
    fn test_exec_iceberg_fills_all() {
        let oms = make_oms();
        let plan = plan_iceberg("SBIN", OrderSide::Buy, 30, &IcebergConfig {
            visible_qty: 10, replenish_delay_ms: 0,
        });
        let result = execute_plan_sync(&plan, &oms, "NSE", ProductType::Delivery,
            Some(600.0), None, None);
        assert_eq!(result.total_filled, 30);
        assert_eq!(result.num_slices_filled, 3);
    }

    #[test]
    fn test_algo_type_parsing() {
        assert_eq!(ExecAlgoType::from_str_loose("twap"), ExecAlgoType::TWAP);
        assert_eq!(ExecAlgoType::from_str_loose("VWAP"), ExecAlgoType::VWAP);
        assert_eq!(ExecAlgoType::from_str_loose("iceberg"), ExecAlgoType::Iceberg);
        assert_eq!(ExecAlgoType::from_str_loose("direct"), ExecAlgoType::Direct);
        assert_eq!(ExecAlgoType::from_str_loose("unknown"), ExecAlgoType::Direct);
    }
}
