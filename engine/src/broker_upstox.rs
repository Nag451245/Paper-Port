use crate::broker::{
    BrokerAdapter, BrokerHolding, BrokerPosition, MarginInfo, OrderRequest, OrderResponse,
};
use crate::config::UpstoxConfig;

/// Upstox API v2 broker adapter (stub).
///
/// This is a skeleton implementation. To make it functional:
///   1. Register an app at https://account.upstox.com/developer/apps
///   2. Implement the OAuth2 flow to get an access_token
///   3. Configure [broker.upstox] in engine.toml
///   4. Fill in the HTTP calls below using the Upstox REST API
///
/// Upstox API v2 docs: https://upstox.com/developer/api-documentation/
///
/// Key endpoints:
///   POST /order/place           — place order
///   DELETE /order/cancel        — cancel order
///   PUT /order/modify           — modify order
///   GET /order/details          — order status
///   GET /portfolio/positions    — positions
///   GET /portfolio/long-term-holdings — holdings
///   GET /user/get-funds-and-margin    — margins
pub struct UpstoxBroker {
    #[allow(dead_code)]
    config: UpstoxConfig,
}

impl UpstoxBroker {
    pub fn new(config: UpstoxConfig) -> Self {
        Self { config }
    }
}

impl BrokerAdapter for UpstoxBroker {
    fn name(&self) -> &str { "upstox" }

    fn place_order(&self, _req: &OrderRequest) -> Result<OrderResponse, String> {
        Err("Upstox adapter not yet implemented — see broker_upstox.rs for instructions".into())
    }

    fn cancel_order(&self, _broker_order_id: &str) -> Result<OrderResponse, String> {
        Err("Upstox adapter not yet implemented".into())
    }

    fn modify_order(&self, _broker_order_id: &str, _req: &OrderRequest) -> Result<OrderResponse, String> {
        Err("Upstox adapter not yet implemented".into())
    }

    fn order_status(&self, _broker_order_id: &str) -> Result<OrderResponse, String> {
        Err("Upstox adapter not yet implemented".into())
    }

    fn positions(&self) -> Result<Vec<BrokerPosition>, String> {
        Err("Upstox adapter not yet implemented".into())
    }

    fn holdings(&self) -> Result<Vec<BrokerHolding>, String> {
        Err("Upstox adapter not yet implemented".into())
    }

    fn margins(&self) -> Result<MarginInfo, String> {
        Err("Upstox adapter not yet implemented".into())
    }

    fn cancel_all_orders(&self) -> Result<usize, String> {
        Err("Upstox adapter not yet implemented".into())
    }

    fn is_connected(&self) -> bool {
        !self.config.api_key.is_empty() && !self.config.access_token.is_empty()
    }

    fn as_any(&self) -> &dyn std::any::Any { self }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::UpstoxConfig;

    #[test]
    fn test_stub_rejects_orders() {
        let broker = UpstoxBroker::new(UpstoxConfig::default());
        let req = crate::broker::OrderRequest {
            symbol: "RELIANCE".into(), exchange: "NSE".into(),
            side: crate::broker::OrderSide::Buy, order_type: crate::broker::OrderType::Limit,
            quantity: 10, price: Some(2500.0), trigger_price: None,
            product: crate::broker::ProductType::Delivery, tag: None,
        };
        assert!(broker.place_order(&req).is_err());
    }

    #[test]
    fn test_disconnected_without_credentials() {
        let broker = UpstoxBroker::new(UpstoxConfig::default());
        assert!(!broker.is_connected());
    }
}
