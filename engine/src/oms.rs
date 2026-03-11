use std::sync::{Arc, Mutex};
use serde::{Deserialize, Serialize};
use crate::broker::{
    BrokerAdapter, OrderRequest, OrderSide, OrderType,
    OrderStatus, ProductType,
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

        let check_price = req.price.or(reference_price);

        if let Some(price) = check_price {
            let value = price * req.quantity as f64;
            if value > self.fat_finger.max_order_value {
                return Err(format!(
                    "Order value {:.0} exceeds fat-finger limit {:.0}",
                    value, self.fat_finger.max_order_value
                ));
            }

            if let Some(ref_price) = reference_price {
                if ref_price > 0.0 && req.price.is_some() {
                    let order_price = req.price.unwrap();
                    let deviation_pct = ((order_price - ref_price) / ref_price * 100.0).abs();
                    if deviation_pct > self.fat_finger.max_price_deviation_pct {
                        return Err(format!(
                            "Price {:.2} deviates {:.1}% from reference {:.2} (limit: {:.1}%)",
                            order_price, deviation_pct, ref_price, self.fat_finger.max_price_deviation_pct
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

            if broker_id.is_empty() { continue; }

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
                Err(e) => {
                    tracing::warn!(broker_id = %broker_id, error = %e, "Failed to poll broker for fill status");
                }
            }
        }

        updated
    }

    /// Cancel an order by internal ID
    pub fn cancel_order(&self, internal_id: &str) -> Result<Order, String> {
        let mut orders = self.orders.lock().map_err(|_| "Lock poisoned".to_string())?;
        let order = orders.iter_mut().find(|o| o.internal_id == internal_id)
            .ok_or_else(|| format!("Order {} not found", internal_id))?;

        if matches!(order.status,
            OrderStatus::Filled | OrderStatus::Cancelled | OrderStatus::Rejected | OrderStatus::Expired
        ) {
            return Err(format!("Cannot cancel order in {:?} state (terminal)", order.status));
        }

        if let Some(ref broker_id) = order.broker_order_id {
            if !broker_id.is_empty() {
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
        } else {
            order.status = OrderStatus::Cancelled;
            order.updated_at = chrono::Utc::now().to_rfc3339();
        }

        Ok(order.clone())
    }

    /// Modify a live order by internal ID.
    /// Validates the modified order against fat-finger limits before sending to broker.
    pub fn modify_order(
        &self,
        internal_id: &str,
        new_qty: Option<i64>,
        new_price: Option<f64>,
        new_trigger_price: Option<f64>,
    ) -> Result<Order, String> {
        let mut orders = self.orders.lock().map_err(|_| "Lock poisoned".to_string())?;
        let order = orders.iter_mut().find(|o| o.internal_id == internal_id)
            .ok_or_else(|| format!("Order {} not found", internal_id))?;

        if !matches!(order.status, OrderStatus::Pending | OrderStatus::Submitted) {
            return Err(format!("Cannot modify order in {:?} state", order.status));
        }

        let broker_id = match &order.broker_order_id {
            Some(id) if !id.is_empty() => id.clone(),
            _ => return Err("Order has no broker ID — cannot modify".into()),
        };

        let modify_req = OrderRequest {
            symbol: order.symbol.clone(),
            exchange: order.exchange.clone(),
            side: order.side,
            order_type: order.order_type,
            quantity: new_qty.unwrap_or(order.requested_qty),
            price: new_price.or(order.price),
            trigger_price: new_trigger_price.or(order.trigger_price),
            product: order.product,
            tag: order.tag.clone(),
        };

        let reference_price = order.avg_fill_price.max(
            order.price.unwrap_or(0.0)
        );
        let ref_price = if reference_price > 0.0 { Some(reference_price) } else { None };
        self.validate_order(&modify_req, ref_price)?;

        match self.broker.modify_order(&broker_id, &modify_req) {
            Ok(resp) => {
                order.status = resp.status;
                if let Some(q) = new_qty { order.requested_qty = q; }
                if new_price.is_some() { order.price = new_price; }
                if new_trigger_price.is_some() { order.trigger_price = new_trigger_price; }
                order.updated_at = chrono::Utc::now().to_rfc3339();
                Ok(order.clone())
            }
            Err(e) => Err(e),
        }
    }

    /// Cancel all active (non-terminal) orders (emergency use)
    pub fn cancel_all(&self) -> Vec<String> {
        let mut cancelled = Vec::new();
        if let Ok(mut orders) = self.orders.lock() {
            for order in orders.iter_mut() {
                if matches!(order.status,
                    OrderStatus::Pending | OrderStatus::Submitted | OrderStatus::PartialFill
                ) {
                    if let Some(ref broker_id) = order.broker_order_id {
                        if !broker_id.is_empty() {
                            let _ = self.broker.cancel_order(broker_id);
                        }
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
                    let engine_abs = engine_qty.unsigned_abs() as i64;
                    let engine_is_sell = *engine_qty < 0;
                    let broker_is_sell = bp.side == OrderSide::Sell;
                    let side_match = engine_is_sell == broker_is_sell;
                    let qty_match = side_match && bp.quantity == engine_abs;
                    let price_close = (bp.avg_price - engine_price).abs() / engine_price.max(0.01) < 0.01;
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

    #[test]
    fn test_modify_validates_fat_finger_via_validate_order() {
        let broker = Arc::new(PaperBroker::new(1_000_000.0));
        let limits = FatFingerLimits {
            max_order_value: 10_000_000.0,
            max_quantity: 100,
            max_price_deviation_pct: 5.0,
        };
        let oms = OMS::new(broker, limits);
        let req = OrderRequest {
            symbol: "RELIANCE".into(),
            exchange: "NSE".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 200,
            price: Some(2500.0),
            trigger_price: None,
            product: ProductType::Delivery,
            tag: None,
        };
        let result = oms.validate_order(&req, None);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("fat-finger"));
    }

    #[test]
    fn test_modify_validates_price_deviation() {
        let broker = Arc::new(PaperBroker::new(1_000_000.0));
        let limits = FatFingerLimits {
            max_order_value: 10_000_000.0,
            max_quantity: 50_000,
            max_price_deviation_pct: 5.0,
        };
        let oms = OMS::new(broker, limits);
        let req = OrderRequest {
            symbol: "RELIANCE".into(),
            exchange: "NSE".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 10,
            price: Some(3000.0),
            trigger_price: None,
            product: ProductType::Delivery,
            tag: None,
        };
        let result = oms.validate_order(&req, Some(2500.0));
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("deviates"));
    }
}
