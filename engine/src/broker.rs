use serde::{Deserialize, Serialize};

/// Order side
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderSide {
    Buy,
    Sell,
}

/// Order type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderType {
    Market,
    Limit,
    StopLoss,
    StopLossMarket,
}

/// Order status in the lifecycle
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum OrderStatus {
    Pending,
    Submitted,
    PartialFill,
    Filled,
    Cancelled,
    Rejected,
    Expired,
}

/// Product type
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
pub enum ProductType {
    /// Intraday (MIS)
    Intraday,
    /// Carry-forward / delivery (CNC / NRML)
    Delivery,
}

/// Request to place an order
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderRequest {
    pub symbol: String,
    pub exchange: String,
    pub side: OrderSide,
    pub order_type: OrderType,
    pub quantity: i64,
    pub price: Option<f64>,
    pub trigger_price: Option<f64>,
    pub product: ProductType,
    pub tag: Option<String>,
}

/// Broker-returned order confirmation
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct OrderResponse {
    pub broker_order_id: String,
    pub status: OrderStatus,
    pub filled_qty: i64,
    pub avg_price: f64,
    pub message: Option<String>,
    pub timestamp: String,
}

/// Position as reported by the broker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerPosition {
    pub symbol: String,
    pub exchange: String,
    pub side: OrderSide,
    pub quantity: i64,
    pub avg_price: f64,
    pub last_price: f64,
    pub pnl: f64,
    pub product: ProductType,
}

/// Holdings as reported by the broker
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct BrokerHolding {
    pub symbol: String,
    pub quantity: i64,
    pub avg_price: f64,
    pub last_price: f64,
    pub pnl: f64,
}

/// Margin information
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct MarginInfo {
    pub available_cash: f64,
    pub used_margin: f64,
    pub total_collateral: f64,
    pub available_margin: f64,
}

/// Trait all broker adapters must implement
pub trait BrokerAdapter: Send + Sync {
    fn name(&self) -> &str;

    fn place_order(&self, req: &OrderRequest) -> Result<OrderResponse, String>;
    fn cancel_order(&self, broker_order_id: &str) -> Result<OrderResponse, String>;
    fn modify_order(&self, broker_order_id: &str, req: &OrderRequest) -> Result<OrderResponse, String>;
    fn order_status(&self, broker_order_id: &str) -> Result<OrderResponse, String>;

    fn positions(&self) -> Result<Vec<BrokerPosition>, String>;
    fn holdings(&self) -> Result<Vec<BrokerHolding>, String>;
    fn margins(&self) -> Result<MarginInfo, String>;

    fn cancel_all_orders(&self) -> Result<usize, String>;

    fn is_connected(&self) -> bool;

    /// Allows downcasting to concrete adapter types (e.g. for session management)
    fn as_any(&self) -> &dyn std::any::Any;
}

/// Paper-trading adapter that simulates broker behavior in-memory
pub struct PaperBroker {
    orders: std::sync::Mutex<Vec<(String, OrderRequest, OrderResponse)>>,
    fills: std::sync::Mutex<Vec<BrokerPosition>>,
    cash: std::sync::atomic::AtomicU64,
    next_id: std::sync::atomic::AtomicU64,
}

impl PaperBroker {
    pub fn new(initial_cash: f64) -> Self {
        Self {
            orders: std::sync::Mutex::new(Vec::new()),
            fills: std::sync::Mutex::new(Vec::new()),
            cash: std::sync::atomic::AtomicU64::new(initial_cash.to_bits()),
            next_id: std::sync::atomic::AtomicU64::new(1),
        }
    }

    fn next_order_id(&self) -> String {
        let id = self.next_id.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
        format!("PAPER-{:06}", id)
    }

    fn get_cash(&self) -> f64 {
        f64::from_bits(self.cash.load(std::sync::atomic::Ordering::Acquire))
    }
}

impl BrokerAdapter for PaperBroker {
    fn name(&self) -> &str { "paper" }

    fn place_order(&self, req: &OrderRequest) -> Result<OrderResponse, String> {
        let fill_price = req.price.unwrap_or(0.0);
        if fill_price <= 0.0 && req.order_type != OrderType::Market {
            return Err("Limit/SL orders require a price".into());
        }

        let order_id = self.next_order_id();
        let value = fill_price * req.quantity.unsigned_abs() as f64;

        if req.side == OrderSide::Buy && value > self.get_cash() {
            return Ok(OrderResponse {
                broker_order_id: order_id.clone(),
                status: OrderStatus::Rejected,
                filled_qty: 0,
                avg_price: 0.0,
                message: Some("Insufficient funds".into()),
                timestamp: chrono::Utc::now().to_rfc3339(),
            });
        }

        let resp = OrderResponse {
            broker_order_id: order_id.clone(),
            status: OrderStatus::Filled,
            filled_qty: req.quantity.abs(),
            avg_price: fill_price,
            message: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
        };

        if let Ok(mut orders) = self.orders.lock() {
            orders.push((order_id.clone(), req.clone(), resp.clone()));
        }
        if let Ok(mut fills) = self.fills.lock() {
            fills.push(BrokerPosition {
                symbol: req.symbol.clone(),
                exchange: req.exchange.clone(),
                side: req.side,
                quantity: req.quantity.abs(),
                avg_price: fill_price,
                last_price: fill_price,
                pnl: 0.0,
                product: req.product,
            });
        }
        Ok(resp)
    }

    fn cancel_order(&self, broker_order_id: &str) -> Result<OrderResponse, String> {
        Ok(OrderResponse {
            broker_order_id: broker_order_id.to_string(),
            status: OrderStatus::Cancelled,
            filled_qty: 0,
            avg_price: 0.0,
            message: Some("Cancelled (paper)".into()),
            timestamp: chrono::Utc::now().to_rfc3339(),
        })
    }

    fn modify_order(&self, broker_order_id: &str, _req: &OrderRequest) -> Result<OrderResponse, String> {
        Ok(OrderResponse {
            broker_order_id: broker_order_id.to_string(),
            status: OrderStatus::Submitted,
            filled_qty: 0,
            avg_price: 0.0,
            message: Some("Modified (paper)".into()),
            timestamp: chrono::Utc::now().to_rfc3339(),
        })
    }

    fn order_status(&self, broker_order_id: &str) -> Result<OrderResponse, String> {
        if let Ok(orders) = self.orders.lock() {
            for (id, _req, resp) in orders.iter() {
                if id == broker_order_id {
                    return Ok(resp.clone());
                }
            }
        }
        Err(format!("Order {} not found", broker_order_id))
    }

    fn positions(&self) -> Result<Vec<BrokerPosition>, String> {
        Ok(self.fills.lock().map(|f| f.clone()).unwrap_or_default())
    }

    fn holdings(&self) -> Result<Vec<BrokerHolding>, String> {
        Ok(Vec::new())
    }

    fn margins(&self) -> Result<MarginInfo, String> {
        let cash = self.get_cash();
        Ok(MarginInfo {
            available_cash: cash,
            used_margin: 0.0,
            total_collateral: cash,
            available_margin: cash,
        })
    }

    fn cancel_all_orders(&self) -> Result<usize, String> {
        Ok(0)
    }

    fn is_connected(&self) -> bool { true }

    fn as_any(&self) -> &dyn std::any::Any { self }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_paper_broker_place_order() {
        let broker = PaperBroker::new(1_000_000.0);
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
        let resp = broker.place_order(&req).unwrap();
        assert_eq!(resp.status, OrderStatus::Filled);
        assert_eq!(resp.filled_qty, 10);
    }

    #[test]
    fn test_paper_broker_positions() {
        let broker = PaperBroker::new(1_000_000.0);
        let req = OrderRequest {
            symbol: "INFY".into(),
            exchange: "NSE".into(),
            side: OrderSide::Buy,
            order_type: OrderType::Limit,
            quantity: 5,
            price: Some(1500.0),
            trigger_price: None,
            product: ProductType::Intraday,
            tag: None,
        };
        broker.place_order(&req).unwrap();
        let positions = broker.positions().unwrap();
        assert_eq!(positions.len(), 1);
        assert_eq!(positions[0].symbol, "INFY");
    }

    #[test]
    fn test_paper_broker_cancel() {
        let broker = PaperBroker::new(1_000_000.0);
        let resp = broker.cancel_order("PAPER-000001").unwrap();
        assert_eq!(resp.status, OrderStatus::Cancelled);
    }

    #[test]
    fn test_paper_broker_margins() {
        let broker = PaperBroker::new(500_000.0);
        let margins = broker.margins().unwrap();
        assert_eq!(margins.available_cash, 500_000.0);
    }
}
