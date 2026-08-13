use crate::broker::{
    BrokerAdapter, BrokerHolding, BrokerPosition, MarginInfo, OrderRequest, OrderResponse,
};
use crate::config::ZerodhaConfig;

/// Zerodha Kite Connect API broker adapter (stub).
///
/// This is a skeleton implementation. To make it functional:
///   1. Obtain an API key from https://developers.kite.trade
///   2. Implement the login flow to get an access_token
///   3. Configure [broker.zerodha] in engine.toml
///   4. Fill in the HTTP calls below using the Kite Connect REST API
///
/// Kite Connect API docs: https://kite.trade/docs/connect/v3/
///
/// Key endpoints:
///   POST /orders/{variety}       — place order
///   DELETE /orders/{variety}/{id} — cancel order
///   PUT /orders/{variety}/{id}   — modify order
///   GET /orders/{id}             — order status
///   GET /portfolio/positions     — positions
///   GET /portfolio/holdings      — holdings
///   GET /user/margins            — margins
pub struct ZerodhaBroker {
    #[allow(dead_code)]
    config: ZerodhaConfig,
}

impl ZerodhaBroker {
    pub fn new(config: ZerodhaConfig) -> Self {
        Self { config }
    }
}

impl BrokerAdapter for ZerodhaBroker {
    fn name(&self) -> &str { "zerodha" }

    fn place_order(&self, _req: &OrderRequest) -> Result<OrderResponse, String> {
        Err("Zerodha adapter is a stub — not implemented. Use 'paper' or 'icici_breeze' broker.adapter in engine.toml".into())
    }

    fn cancel_order(&self, _broker_order_id: &str) -> Result<OrderResponse, String> {
        Err("Zerodha adapter is a stub — not implemented. Use 'paper' or 'icici_breeze'".into())
    }

    fn modify_order(&self, _broker_order_id: &str, _req: &OrderRequest) -> Result<OrderResponse, String> {
        Err("Zerodha adapter is a stub — not implemented. Use 'paper' or 'icici_breeze'".into())
    }

    fn order_status(&self, _broker_order_id: &str) -> Result<OrderResponse, String> {
        Err("Zerodha adapter is a stub — not implemented. Use 'paper' or 'icici_breeze'".into())
    }

    fn positions(&self) -> Result<Vec<BrokerPosition>, String> {
        Err("Zerodha adapter is a stub — not implemented. Use 'paper' or 'icici_breeze'".into())
    }

    fn holdings(&self) -> Result<Vec<BrokerHolding>, String> {
        Err("Zerodha adapter is a stub — not implemented. Use 'paper' or 'icici_breeze'".into())
    }

    fn margins(&self) -> Result<MarginInfo, String> {
        Err("Zerodha adapter is a stub — not implemented. Use 'paper' or 'icici_breeze'".into())
    }

    fn cancel_all_orders(&self) -> Result<usize, String> {
        Err("Zerodha adapter is a stub — not implemented. Use 'paper' or 'icici_breeze'".into())
    }

    fn is_connected(&self) -> bool {
        false
    }

    fn as_any(&self) -> &dyn std::any::Any { self }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::ZerodhaConfig;

    #[test]
    fn test_stub_rejects_orders() {
        let broker = ZerodhaBroker::new(ZerodhaConfig::default());
        let req = crate::broker::OrderRequest {
            symbol: "RELIANCE".into(), exchange: "NSE".into(),
            side: crate::broker::OrderSide::Buy, order_type: crate::broker::OrderType::Limit,
            quantity: 10, price: Some(2500.0), trigger_price: None,
            product: crate::broker::ProductType::Delivery, tag: None,
            ..Default::default()
        };
        assert!(broker.place_order(&req).is_err());
    }

    #[test]
    fn test_disconnected_without_credentials() {
        let broker = ZerodhaBroker::new(ZerodhaConfig::default());
        assert!(!broker.is_connected());
    }
}
