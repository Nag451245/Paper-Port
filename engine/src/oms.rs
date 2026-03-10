use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use crate::broker::{
    BrokerAdapter, OrderRequest, OrderResponse, OrderSide, OrderType,
    OrderStatus, ProductType, BrokerPosition,
};

/// Internal order with full lifecycle tracking
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Order {
    pub internal_id: String,
    pub broker_order_id: Option<String>,
    pub symbol: String,
    pub exchange: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub product: ProductType,
    pub requested_qty: i64,
    pub filled_qty: i64,
    pub price: Option<f64>,
    pub trigger_price: Option<f64>,
    pub avg_fill_price: f64,
    pub status: OrderStatus,
    pub tag: Option<String>,
    pub strategy_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
    pub rejection_reason: Option<String>,
}

/// Fat-finger protection config
#[derive(Debug, Clone)]
pub struct FatFingerLimits {
    pub max_order_value: f64,
    pub max_quantity: i64,
    pub max_price_deviation_pct: f64,
}

impl Default for FatFingerLimits {
    fn default() -> Self {
        Self {
            max_order_value: 10_000_000.0,
            max_quantity: 50_000,
            max_price_deviation_pct: 5.0,
        }
    }
}

/// Order Management System
pub struct OMS {
    orders: Mutex<Vec<Order>>,
    broker: Arc<dyn BrokerAdapter>,
    fat_finger: FatFingerLimits,
    next_id: std::sync::atomic::AtomicU64,
}

impl OMS {
    pub fn new(broker: Arc<dyn BrokerAdapter>, fat_finger: FatFingerLimits) -> Self {
        Self {
            orders: Mutex::new(Vec::new()),
            broker,
            fat_finger,
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn next_id(&self) -> String {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("OMS-{:08}", id)
    }

    /// Pre-trade validation: fat-finger protection
    fn validate_order(&self, req: &OrderRequest, reference_price: Option<f64>) -> Result<(), String> {
        if req.quantity <= 0 {
            return Err("Quantity must be positive".into());
        }
        if req.quantity > self.fat_finger.max_quantity {
            return Err(format!(
                "Quantity {} exceeds fat-finger limit {}",
                req.quantity, self.fat_finger.max_quantity
            ));
        }

        if let Some(price) = req.price {
            let value = price * req.quantity as f64;
            if value > self.fat_finger.max_order_value {
                return Err(format!(
                    "Order value {:.0} exceeds fat-finger limit {:.0}",
                    value, self.fat_finger.max_order_value
                ));
            }

            if let Some(ref_price) = reference_price {
                if ref_price > 0.0 {
                    let deviation_pct = ((price - ref_price) / ref_price * 100.0).abs();
                    if deviation_pct > self.fat_finger.max_price_deviation_pct {
                        return Err(format!(
                            "Price {:.2} deviates {:.1}% from reference {:.2} (limit: {:.1}%)",
                            price, deviation_pct, ref_price, self.fat_finger.max_price_deviation_pct
                        ));
                    }
                }
            }
        }

        Ok(())
    }

    /// Submit an order through the OMS pipeline
    pub fn submit_order(
        &self,
        req: OrderRequest,
        strategy_id: Option<String>,
        reference_price: Option<f64>,
    ) -> Result<Order, String> {
        self.validate_order(&req, reference_price)?;

        let internal_id = self.next_id();
        let now = chrono::Utc::now().to_rfc3339();

        let mut order = Order {
            internal_id: internal_id.clone(),
            broker_order_id: None,
            symbol: req.symbol.clone(),
            exchange: req.exchange.clone(),
            side: req.side,
            order_type: req.order_type,
            product: req.product,
            requested_qty: req.quantity,
            filled_qty: 0,
            price: req.price,
            trigger_price: req.trigger_price,
            avg_fill_price: 0.0,
            status: OrderStatus::Pending,
            tag: req.tag.clone(),
            strategy_id,
            created_at: now.clone(),
            updated_at: now.clone(),
            rejection_reason: None,
        };

        match self.broker.place_order(&req) {
            Ok(resp) => {
                order.broker_order_id = Some(resp.broker_order_id);
                order.status = resp.status;
                order.filled_qty = resp.filled_qty;
                order.avg_fill_price = resp.avg_price;
                order.updated_at = resp.timestamp;
                if resp.status == OrderStatus::Rejected {
                    order.rejection_reason = resp.message;
                }
            }
            Err(e) => {
                order.status = OrderStatus::Rejected;
                order.rejection_reason = Some(e.clone());
                order.updated_at = chrono::Utc::now().to_rfc3339();
            }
        }

        if let Ok(mut orders) = self.orders.lock() {
            orders.push(order.clone());
        }

        Ok(order)
    }

    /// Poll the broker for fill updates on all submitted (non-terminal) orders.
    /// Call periodically to keep engine positions in sync with broker.
    pub fn sync_pending_fills(&self) -> Vec<Order> {
        let mut updated = Vec::new();
        let mut orders = match self.orders.lock() {
            Ok(o) => o,
            Err(_) => return updated,
        };

        for order in orders.iter_mut() {
            let needs_sync = matches!(order.status,
                OrderStatus::Submitted | OrderStatus::PartialFill
            );
            if !needs_sync { continue; }

            let broker_id = match &order.broker_order_id {
                Some(id) => id.clone(),
                None => continue,
            };

            match self.broker.order_status(&broker_id) {
                Ok(resp) => {
                    let changed = resp.status != order.status || resp.filled_qty != order.filled_qty;
                    if changed {
                        order.status = resp.status;
                        order.filled_qty = resp.filled_qty;
                        order.avg_fill_price = resp.avg_price;
                        order.updated_at = resp.timestamp;
                        updated.push(order.clone());
                    }
                }
                Err(_) => { /* broker unreachable, will retry next cycle */ }
            }
        }

        updated
    }

    /// Cancel an order by internal ID
    pub fn cancel_order(&self, internal_id: &str) -> Result<Order, String> {
        let mut orders = self.orders.lock().map_err(|_| "Lock poisoned".to_string())?;
        let order = orders.iter_mut().find(|o| o.internal_id == internal_id)
            .ok_or_else(|| format!("Order {} not found", internal_id))?;

        if order.status == OrderStatus::Filled || order.status == OrderStatus::Cancelled {
            return Err(format!("Cannot cancel order in {:?} state", order.status));
        }

        if let Some(ref broker_id) = order.broker_order_id {
            match self.broker.cancel_order(broker_id) {
                Ok(resp) => {
                    order.status = resp.status;
                    order.updated_at = chrono::Utc::now().to_rfc3339();
                }
                Err(e) => return Err(e),
            }
        } else {
            order.status = OrderStatus::Cancelled;
            order.updated_at = chrono::Utc::now().to_rfc3339();
        }

        Ok(order.clone())
    }

    /// Cancel all pending/submitted orders (emergency use)
    pub fn cancel_all(&self) -> Vec<String> {
        let mut cancelled = Vec::new();
        if let Ok(mut orders) = self.orders.lock() {
            for order in orders.iter_mut() {
                if order.status == OrderStatus::Pending || order.status == OrderStatus::Submitted {
                    if let Some(ref broker_id) = order.broker_order_id {
                        let _ = self.broker.cancel_order(broker_id);
                    }
                    order.status = OrderStatus::Cancelled;
                    order.updated_at = chrono::Utc::now().to_rfc3339();
                    cancelled.push(order.internal_id.clone());
                }
            }
        }
        cancelled
    }

    /// Get all orders
    pub fn get_orders(&self) -> Vec<Order> {
        self.orders.lock().map(|o| o.clone()).unwrap_or_default()
    }

    /// Get orders for a specific strategy
    pub fn get_orders_by_strategy(&self, strategy_id: &str) -> Vec<Order> {
        self.orders.lock()
            .map(|orders| {
                orders.iter()
                    .filter(|o| o.strategy_id.as_deref() == Some(strategy_id))
                    .cloned()
                    .collect()
            })
            .unwrap_or_default()
    }

    /// Reconcile engine positions with broker positions
    pub fn reconcile(&self, engine_positions: &[(String, i64, f64)]) -> ReconciliationReport {
        let broker_positions = self.broker.positions().unwrap_or_default();
        let mut mismatches = Vec::new();
        let mut matched = 0;

        for (symbol, engine_qty, engine_price) in engine_positions {
            let broker_pos = broker_positions.iter().find(|p| p.symbol == *symbol);
            match broker_pos {
                Some(bp) => {
                    let qty_match = bp.quantity == engine_qty.unsigned_abs() as i64;
                    let price_close = (bp.avg_price - engine_price).abs() / engine_price.max(1.0) < 0.01;
                    if qty_match && price_close {
                        matched += 1;
                    } else {
                        mismatches.push(ReconciliationMismatch {
                            symbol: symbol.clone(),
                            engine_qty: *engine_qty,
                            broker_qty: bp.quantity,
                            engine_price: *engine_price,
                            broker_price: bp.avg_price,
                            mismatch_type: if !qty_match { "quantity" } else { "price" }.into(),
                        });
                    }
                }
                None => {
                    if *engine_qty != 0 {
                        mismatches.push(ReconciliationMismatch {
                            symbol: symbol.clone(),
                            engine_qty: *engine_qty,
                            broker_qty: 0,
                            engine_price: *engine_price,
                            broker_price: 0.0,
                            mismatch_type: "missing_at_broker".into(),
                        });
                    }
                }
            }
        }

        for bp in &broker_positions {
            let engine_has = engine_positions.iter().any(|(s, _, _)| s == &bp.symbol);
            if !engine_has && bp.quantity > 0 {
                mismatches.push(ReconciliationMismatch {
                    symbol: bp.symbol.clone(),
                    engine_qty: 0,
                    broker_qty: bp.quantity,
                    engine_price: 0.0,
                    broker_price: bp.avg_price,
                    mismatch_type: "missing_at_engine".into(),
                });
            }
        }

        ReconciliationReport {
            matched,
            mismatches,
            timestamp: chrono::Utc::now().to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconciliationMismatch {
    pub symbol: String,
    pub engine_qty: i64,
    pub broker_qty: i64,
    pub engine_price: f64,
    pub broker_price: f64,
    pub mismatch_type: String,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ReconciliationReport {
    pub matched: usize,
    pub mismatches: Vec<ReconciliationMismatch>,
    pub timestamp: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::broker::PaperBroker;

    fn make_oms() -> OMS {
        let broker = Arc::new(PaperBroker::new(1_000_000.0));
        OMS::new(broker, FatFingerLimits::default())
    }

    #[test]
    fn test_submit_order() {
        let oms = make_oms();
        let req = OrderRequest {
            symbol: "RELIANCE".into(),
            exchange: "NSE".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 10,
            price: Some(2500.0),
            trigger_price: None,
            product: ProductType::Delivery,
            tag: None,
        };
        let order = oms.submit_order(req, Some("test_strategy".into()), None).unwrap();
        assert_eq!(order.status, OrderStatus::Filled);
        assert_eq!(order.filled_qty, 10);
        assert!(order.broker_order_id.is_some());
    }

    #[test]
    fn test_fat_finger_quantity_limit() {
        let oms = make_oms();
        let req = OrderRequest {
            symbol: "NIFTY".into(),
            exchange: "NSE".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 100_000,
            price: Some(100.0),
            trigger_price: None,
            product: ProductType::Intraday,
            tag: None,
        };
        let result = oms.submit_order(req, None, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("fat-finger"));
    }

    #[test]
    fn test_fat_finger_value_limit() {
        let oms = make_oms();
        let req = OrderRequest {
            symbol: "RELIANCE".into(),
            exchange: "NSE".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 10_000,
            price: Some(5000.0),
            trigger_price: None,
            product: ProductType::Delivery,
            tag: None,
        };
        let result = oms.submit_order(req, None, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("fat-finger"));
    }

    #[test]
    fn test_fat_finger_price_deviation() {
        let oms = make_oms();
        let req = OrderRequest {
            symbol: "INFY".into(),
            exchange: "NSE".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 10,
            price: Some(2000.0),
            trigger_price: None,
            product: ProductType::Delivery,
            tag: None,
        };
        let result = oms.submit_order(req, None, Some(1500.0));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("deviates"));
    }

    #[test]
    fn test_cancel_order() {
        let oms = make_oms();
        let req = OrderRequest {
            symbol: "TCS".into(),
            exchange: "NSE".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 5,
            price: Some(3500.0),
            trigger_price: None,
            product: ProductType::Delivery,
            tag: None,
        };
        let order = oms.submit_order(req, None, None).unwrap();
        let result = oms.cancel_order(&order.internal_id);
        assert!(result.is_err() || result.unwrap().status == OrderStatus::Cancelled);
    }

    #[test]
    fn test_get_orders() {
        let oms = make_oms();
        let req = OrderRequest {
            symbol: "HDFC".into(),
            exchange: "NSE".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 1,
            price: Some(2800.0),
            trigger_price: None,
            product: ProductType::Delivery,
            tag: None,
        };
        oms.submit_order(req, Some("strat1".into()), None).unwrap();
        assert_eq!(oms.get_orders().len(), 1);
        assert_eq!(oms.get_orders_by_strategy("strat1").len(), 1);
        assert_eq!(oms.get_orders_by_strategy("other").len(), 0);
    }

    #[test]
    fn test_reconciliation_matched() {
        let oms = make_oms();
        let engine_positions: Vec<(String, i64, f64)> = vec![];
        let report = oms.reconcile(&engine_positions);
        assert_eq!(report.matched, 0);
        assert!(report.mismatches.is_empty());
    }
}
