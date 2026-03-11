use crate::broker::{
    BrokerAdapter, BrokerHolding, BrokerPosition, MarginInfo, OrderRequest, OrderResponse,
    OrderSide, OrderStatus, OrderType, ProductType,
};
use crate::config::IciciBreezeConfig;
use std::sync::atomic::{AtomicBool, Ordering};

/// ICICI Direct Breeze broker adapter — routes all calls through the
/// Python Breeze Bridge microservice (server/breeze-bridge/app.py).
///
/// The bridge wraps the `breeze_connect` Python SDK and runs on port 8001.
/// This adapter never calls the ICICI API directly; the bridge handles
/// authentication, session management, and SDK quirks.
///
/// Session lifecycle:
///   1. The bridge is started separately (e.g. via PM2 or `python app.py`)
///   2. A session token is obtained via ICICI TOTP login
///   3. POST /init is called on the bridge with api_key, api_secret, session_token
///   4. The bridge keeps the session alive and persists it to disk
///   5. This adapter checks /health to confirm session is active
pub struct IciciBreezeBroker {
    config: IciciBreezeConfig,
    connected: AtomicBool,
}

impl IciciBreezeBroker {
    pub fn new(config: IciciBreezeConfig) -> Self {
        let initially_connected = Self::check_bridge_health(&config.bridge_url);
        Self {
            config,
            connected: AtomicBool::new(initially_connected),
        }
    }

    /// Initialize the Breeze session via the bridge's /init endpoint.
    /// Called when credentials are provided or refreshed.
    pub fn init_session(&self) -> Result<(), String> {
        let body = serde_json::json!({
            "api_key": self.config.api_key,
            "api_secret": self.config.secret_key,
            "session_token": self.config.session_token,
        });

        let resp = self.bridge_post("/init", &body)?;
        let success = resp.get("success").and_then(|v| v.as_bool()).unwrap_or(false);
        if success {
            self.connected.store(true, Ordering::Release);
            Ok(())
        } else {
            let err = resp.get("error").and_then(|v| v.as_str()).unwrap_or("Init failed");
            self.connected.store(false, Ordering::Release);
            Err(err.to_string())
        }
    }

    /// Refresh connection status by polling bridge /health
    pub fn refresh_status(&self) -> bool {
        let active = Self::check_bridge_health(&self.config.bridge_url);
        self.connected.store(active, Ordering::Release);
        active
    }

    fn check_bridge_health(bridge_url: &str) -> bool {
        let url = format!("{}/health", bridge_url.trim_end_matches('/'));
        match ureq::get(&url).timeout(std::time::Duration::from_secs(5)).call() {
            Ok(resp) => {
                if let Ok(body) = resp.into_json::<serde_json::Value>() {
                    body.get("session_active")
                        .and_then(|v| v.as_bool())
                        .unwrap_or(false)
                } else {
                    false
                }
            }
            Err(_) => false,
        }
    }

    fn bridge_url(&self, path: &str) -> String {
        format!("{}{}", self.config.bridge_url.trim_end_matches('/'), path)
    }

    fn bridge_get(&self, path: &str) -> Result<serde_json::Value, String> {
        let url = self.bridge_url(path);
        let resp = ureq::get(&url)
            .timeout(std::time::Duration::from_secs(10))
            .call()
            .map_err(|e| {
                if matches!(e, ureq::Error::Status(503, _)) {
                    self.connected.store(false, Ordering::Release);
                    return "Breeze session not active — initialize via /init".to_string();
                }
                format!("Bridge request failed: {}", e)
            })?;

        resp.into_json::<serde_json::Value>()
            .map_err(|e| format!("Failed to parse bridge response: {}", e))
    }

    fn bridge_post(&self, path: &str, body: &serde_json::Value) -> Result<serde_json::Value, String> {
        let url = self.bridge_url(path);
        let resp = ureq::post(&url)
            .timeout(std::time::Duration::from_secs(10))
            .set("Content-Type", "application/json")
            .send_json(body)
            .map_err(|e| {
                if matches!(e, ureq::Error::Status(503, _)) {
                    self.connected.store(false, Ordering::Release);
                    return "Breeze session not active — initialize via /init".to_string();
                }
                format!("Bridge request failed: {}", e)
            })?;

        resp.into_json::<serde_json::Value>()
            .map_err(|e| format!("Failed to parse bridge response: {}", e))
    }

    fn breeze_product(product: ProductType) -> &'static str {
        match product {
            ProductType::Intraday => "intraday",
            ProductType::Delivery => "cash",
        }
    }

    fn breeze_action(side: OrderSide) -> &'static str {
        match side {
            OrderSide::Buy => "buy",
            OrderSide::Sell => "sell",
        }
    }

    fn breeze_order_type(ot: OrderType) -> &'static str {
        match ot {
            OrderType::Market => "market",
            OrderType::Limit => "limit",
            OrderType::StopLoss => "stop_loss_limit",
            OrderType::StopLossMarket => "stop_loss_market",
        }
    }
}

impl BrokerAdapter for IciciBreezeBroker {
    fn name(&self) -> &str {
        "icici_breeze"
    }

    fn place_order(&self, req: &OrderRequest) -> Result<OrderResponse, String> {
        if !self.is_connected() {
            return Err("Breeze Bridge not connected — check bridge health or initialize session".into());
        }

        let body = serde_json::json!({
            "stock_code": req.symbol,
            "exchange_code": req.exchange,
            "product": Self::breeze_product(req.product),
            "action": Self::breeze_action(req.side),
            "order_type": Self::breeze_order_type(req.order_type),
            "quantity": req.quantity,
            "price": req.price.unwrap_or(0.0),
            "stoploss": req.trigger_price.unwrap_or(0.0),
            "validity": "day",
        });

        let resp = self.bridge_post("/order/place", &body)?;

        let raw_order_id = resp.get("order_id")
            .and_then(|v| v.as_str())
            .unwrap_or("")
            .to_string();

        let has_valid_id = !raw_order_id.is_empty();

        let status = if has_valid_id {
            OrderStatus::Submitted
        } else {
            OrderStatus::Rejected
        };

        let message = resp.get("error")
            .and_then(|v| v.as_str())
            .map(|s| s.to_string());

        let broker_order_id = if has_valid_id { raw_order_id } else { format!("REJECTED-{}", chrono::Utc::now().timestamp_millis()) };

        Ok(OrderResponse {
            broker_order_id,
            status,
            filled_qty: 0,
            avg_price: req.price.unwrap_or(0.0),
            message,
            timestamp: chrono::Utc::now().to_rfc3339(),
        })
    }

    fn cancel_order(&self, broker_order_id: &str) -> Result<OrderResponse, String> {
        if !self.is_connected() {
            return Err("Breeze Bridge not connected".into());
        }

        let exchange = if broker_order_id.contains("NFO") || broker_order_id.contains("FO") {
            "NFO"
        } else {
            "NSE"
        };

        let body = serde_json::json!({
            "order_id": broker_order_id,
            "exchange_code": exchange,
        });

        let resp = self.bridge_post("/order/cancel", &body)?;

        let has_error = resp.get("error").is_some();
        Ok(OrderResponse {
            broker_order_id: broker_order_id.to_string(),
            status: if has_error { OrderStatus::Rejected } else { OrderStatus::Cancelled },
            filled_qty: 0,
            avg_price: 0.0,
            message: resp.get("message").and_then(|v| v.as_str()).map(|s| s.to_string()),
            timestamp: chrono::Utc::now().to_rfc3339(),
        })
    }

    fn modify_order(&self, broker_order_id: &str, req: &OrderRequest) -> Result<OrderResponse, String> {
        if !self.is_connected() {
            return Err("Breeze Bridge not connected".into());
        }

        let body = serde_json::json!({
            "order_id": broker_order_id,
            "exchange_code": req.exchange,
            "qty": req.quantity,
            "price": req.price.unwrap_or(0.0),
            "triggerPrice": req.trigger_price.unwrap_or(0.0),
        });

        let resp = self.bridge_post("/order/modify", &body)?;

        let has_error = resp.get("error").is_some();
        Ok(OrderResponse {
            broker_order_id: broker_order_id.to_string(),
            status: if has_error { OrderStatus::Rejected } else { OrderStatus::Submitted },
            filled_qty: 0,
            avg_price: req.price.unwrap_or(0.0),
            message: resp.get("message").and_then(|v| v.as_str()).map(|s| s.to_string()),
            timestamp: chrono::Utc::now().to_rfc3339(),
        })
    }

    fn order_status(&self, broker_order_id: &str) -> Result<OrderResponse, String> {
        if !self.is_connected() {
            return Err("Breeze Bridge not connected".into());
        }

        let resp = self.bridge_get(&format!("/order/status/{}", broker_order_id))?;

        let status_str = resp.get("status")
            .and_then(|v| v.as_str())
            .unwrap_or("UNKNOWN");

        let status = match status_str {
            "FILLED" | "Executed" => OrderStatus::Filled,
            "REJECTED" | "Rejected" => OrderStatus::Rejected,
            "CANCELLED" | "Cancelled" => OrderStatus::Cancelled,
            "PLACED" | "SUBMITTED" => OrderStatus::Submitted,
            _ => OrderStatus::Pending,
        };

        let filled_qty = resp.get("filled_qty")
            .and_then(|v| v.as_i64())
            .unwrap_or(0);

        let avg_price = resp.get("avg_price")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);

        Ok(OrderResponse {
            broker_order_id: broker_order_id.to_string(),
            status,
            filled_qty,
            avg_price,
            message: None,
            timestamp: chrono::Utc::now().to_rfc3339(),
        })
    }

    fn positions(&self) -> Result<Vec<BrokerPosition>, String> {
        if !self.is_connected() {
            return Err("Breeze Bridge not connected".into());
        }

        let resp = self.bridge_get("/positions")?;

        let positions = resp.get("positions")
            .and_then(|v| v.as_array())
            .unwrap_or(&Vec::new())
            .iter()
            .filter_map(|p| {
                let symbol = p.get("stock_code")
                    .or_else(|| p.get("symbol"))
                    .and_then(|v| v.as_str())?
                    .to_string();

                let quantity = p.get("quantity")
                    .and_then(|v| v.as_i64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(0);
                if quantity == 0 { return None; }

                let side = if quantity > 0 { OrderSide::Buy } else { OrderSide::Sell };

                let avg_price = p.get("average_price")
                    .or_else(|| p.get("avg_price"))
                    .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(0.0);

                let ltp = p.get("ltp")
                    .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(avg_price);

                let pnl = p.get("pnl")
                    .and_then(|v| v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
                    .unwrap_or(0.0);

                let product_str = p.get("product").and_then(|v| v.as_str()).unwrap_or("cash");
                let product = if product_str == "intraday" || product_str == "margin" {
                    ProductType::Intraday
                } else {
                    ProductType::Delivery
                };

                Some(BrokerPosition {
                    symbol,
                    exchange: "NSE".to_string(),
                    side,
                    quantity: quantity.unsigned_abs() as i64,
                    avg_price,
                    last_price: ltp,
                    pnl,
                    product,
                })
            })
            .collect();

        Ok(positions)
    }

    fn holdings(&self) -> Result<Vec<BrokerHolding>, String> {
        // The bridge doesn't expose a separate holdings endpoint.
        // Positions from /positions covers both intraday and delivery.
        Ok(Vec::new())
    }

    fn margins(&self) -> Result<MarginInfo, String> {
        if !self.is_connected() {
            return Err("Breeze Bridge not connected".into());
        }

        let resp = self.bridge_get("/margin")?;

        let available = resp.get("available")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let used = resp.get("used")
            .and_then(|v| v.as_f64())
            .unwrap_or(0.0);
        let total = resp.get("total")
            .and_then(|v| v.as_f64())
            .unwrap_or(available + used);

        Ok(MarginInfo {
            available_cash: available,
            used_margin: used,
            total_collateral: total,
            available_margin: available,
        })
    }

    fn cancel_all_orders(&self) -> Result<usize, String> {
        // The bridge doesn't have a single cancel-all endpoint.
        // Use OMS cancel_all which iterates and cancels each order.
        Ok(0)
    }

    fn is_connected(&self) -> bool {
        self.connected.load(Ordering::Acquire)
    }

    fn as_any(&self) -> &dyn std::any::Any { self }
}

/// Fetch a live quote for a single symbol via the bridge's /quote endpoint
pub fn bridge_get_quote(bridge_url: &str, symbol: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/quote/{}", bridge_url.trim_end_matches('/'), symbol);
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(10))
        .call()
        .map_err(|e| format!("Bridge quote fetch failed: {}", e))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("Failed to parse quote response: {}", e))
}

/// Fetch historical bars via the bridge's /historical endpoint
pub fn bridge_get_historical(
    bridge_url: &str,
    symbol: &str,
    interval: &str,
    from: &str,
    to: &str,
) -> Result<serde_json::Value, String> {
    let url = format!(
        "{}/historical/{}?interval={}&from={}&to={}",
        bridge_url.trim_end_matches('/'),
        symbol, interval, from, to,
    );
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("Bridge historical fetch failed: {}", e))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("Failed to parse historical response: {}", e))
}

/// Fetch option chain data for a symbol (NIFTY, BANKNIFTY, FINNIFTY, etc.) via the bridge
pub fn bridge_get_option_chain(
    bridge_url: &str,
    symbol: &str,
    expiry: Option<&str>,
) -> Result<serde_json::Value, String> {
    let base = bridge_url.trim_end_matches('/');
    let url = match expiry {
        Some(exp) => format!("{}/option-chain/{}?expiry={}", base, symbol, exp),
        None => format!("{}/option-chain/{}", base, symbol),
    };
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(25))
        .call()
        .map_err(|e| format!("Bridge option chain fetch failed for {}: {}", symbol, e))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("Failed to parse option chain response: {}", e))
}

/// Fetch available expiry dates for a symbol via the bridge
pub fn bridge_get_expiries(
    bridge_url: &str,
    symbol: &str,
) -> Result<serde_json::Value, String> {
    let url = format!("{}/expiries/{}", bridge_url.trim_end_matches('/'), symbol);
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("Bridge expiries fetch failed for {}: {}", symbol, e))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("Failed to parse expiries response: {}", e))
}

/// Fetch lot sizes for all F&O symbols via the bridge
pub fn bridge_get_lot_sizes(bridge_url: &str) -> Result<serde_json::Value, String> {
    let url = format!("{}/lot-sizes", bridge_url.trim_end_matches('/'));
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(15))
        .call()
        .map_err(|e| format!("Bridge lot sizes fetch failed: {}", e))?;
    resp.into_json::<serde_json::Value>()
        .map_err(|e| format!("Failed to parse lot sizes response: {}", e))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::config::IciciBreezeConfig;

    #[test]
    fn test_disconnected_without_bridge() {
        let mut cfg = IciciBreezeConfig::default();
        cfg.bridge_url = "http://127.0.0.1:19999".into(); // no bridge running
        let broker = IciciBreezeBroker::new(cfg);
        assert!(!broker.is_connected());
    }

    #[test]
    fn test_place_order_rejected_when_disconnected() {
        let mut cfg = IciciBreezeConfig::default();
        cfg.bridge_url = "http://127.0.0.1:19999".into();
        let broker = IciciBreezeBroker::new(cfg);
        let req = OrderRequest {
            symbol: "RELIANCE".into(), exchange: "NSE".into(),
            side: OrderSide::Buy, order_type: OrderType::Limit,
            quantity: 10, price: Some(2500.0), trigger_price: None,
            product: ProductType::Delivery, tag: None,
        };
        let result = broker.place_order(&req);
        assert!(result.is_err());
        assert!(result.unwrap_err().contains("not connected"));
    }

    #[test]
    fn test_bridge_url_construction() {
        let cfg = IciciBreezeConfig::default();
        let broker = IciciBreezeBroker::new(cfg);
        let url = broker.bridge_url("/order/place");
        assert_eq!(url, "http://127.0.0.1:8001/order/place");
    }

    #[test]
    fn test_breeze_product_mapping() {
        assert_eq!(IciciBreezeBroker::breeze_product(ProductType::Intraday), "intraday");
        assert_eq!(IciciBreezeBroker::breeze_product(ProductType::Delivery), "cash");
    }

    #[test]
    fn test_breeze_order_type_mapping() {
        assert_eq!(IciciBreezeBroker::breeze_order_type(OrderType::Market), "market");
        assert_eq!(IciciBreezeBroker::breeze_order_type(OrderType::Limit), "limit");
        assert_eq!(IciciBreezeBroker::breeze_order_type(OrderType::StopLoss), "stop_loss_limit");
        assert_eq!(IciciBreezeBroker::breeze_order_type(OrderType::StopLossMarket), "stop_loss_market");
    }
}
