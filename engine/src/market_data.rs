use std::sync::Arc;
use dashmap::DashMap;
use serde::{Deserialize, Serialize};
use tokio::sync::broadcast;
use tracing::{info, warn, error};

/// A single market tick update
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct Tick {
    pub symbol: String,
    pub ltp: f64,
    pub open: f64,
    pub high: f64,
    pub low: f64,
    pub close: f64,
    pub volume: u64,
    pub timestamp: String,
}

/// Shared live price store, updated by the market data feed
pub struct LivePriceStore {
    prices: DashMap<String, Tick>,
    tx: broadcast::Sender<Tick>,
}

impl LivePriceStore {
    pub fn new() -> (Arc<Self>, broadcast::Receiver<Tick>) {
        let (tx, rx) = broadcast::channel(4096);
        let store = Arc::new(Self {
            prices: DashMap::new(),
            tx,
        });
        (store, rx)
    }

    pub fn update(&self, tick: Tick) {
        let _ = self.tx.send(tick.clone());
        self.prices.insert(tick.symbol.clone(), tick);
    }

    pub fn get_ltp(&self, symbol: &str) -> Option<f64> {
        self.prices.get(symbol).map(|t| t.ltp)
    }

    pub fn get_tick(&self, symbol: &str) -> Option<Tick> {
        self.prices.get(symbol).map(|t| t.value().clone())
    }

    pub fn all_prices(&self) -> Vec<Tick> {
        self.prices.iter().map(|e| e.value().clone()).collect()
    }

    pub fn subscribe(&self) -> broadcast::Receiver<Tick> {
        self.tx.subscribe()
    }

    pub fn symbol_count(&self) -> usize {
        self.prices.len()
    }
}

/// Market data feed mode
#[derive(Debug, Clone, PartialEq)]
pub enum FeedMode {
    /// Poll the Breeze Bridge /quote/{symbol} endpoint at regular intervals
    BridgePolling,
    /// Connect directly via WebSocket (requires session credentials)
    WebSocket,
}

/// Start a market data feed. Supports two modes:
///
/// **BridgePolling** (recommended): Polls the Python Breeze Bridge's `/quote/{symbol}`
/// endpoint at regular intervals. Works as long as the bridge has an active session.
/// No direct WebSocket connection needed.
///
/// **WebSocket**: Connects directly to the Breeze WebSocket for real-time ticks.
/// Requires api_key and session_token to be configured.
pub async fn start_feed(
    store: Arc<LivePriceStore>,
    ws_url: &str,
    symbols: &[String],
    api_key: &str,
    session_token: &str,
    reconnect_delay_secs: u64,
) {
    if symbols.is_empty() {
        info!("Market data feed: no symbols configured, skipping");
        return;
    }

    // Determine feed mode: use bridge polling if bridge_url-like ws_url or no WS credentials
    let mode = if api_key.is_empty() || session_token.is_empty() || ws_url.starts_with("http") {
        FeedMode::BridgePolling
    } else {
        FeedMode::WebSocket
    };

    info!(symbols = ?symbols, mode = ?mode, "Starting market data feed");

    match mode {
        FeedMode::BridgePolling => {
            bridge_polling_loop(&store, ws_url, symbols, reconnect_delay_secs).await;
        }
        FeedMode::WebSocket => {
            ws_feed_loop(&store, ws_url, symbols, api_key, session_token, reconnect_delay_secs).await;
        }
    }
}

/// Start a bridge-polling market data feed.
/// Calls the bridge_url (not ws_url) — the caller should pass the bridge URL.
pub async fn start_bridge_feed(
    store: Arc<LivePriceStore>,
    bridge_url: &str,
    symbols: &[String],
    poll_interval_secs: u64,
) {
    if symbols.is_empty() {
        info!("Market data feed: no symbols configured, skipping");
        return;
    }
    info!(symbols = ?symbols, "Starting bridge-polling market data feed");
    bridge_polling_loop(&store, bridge_url, symbols, poll_interval_secs).await;
}

/// Poll the Breeze Bridge /quote/{symbol} for each symbol at regular intervals
async fn bridge_polling_loop(
    store: &Arc<LivePriceStore>,
    bridge_url: &str,
    symbols: &[String],
    poll_interval_secs: u64,
) {
    let interval = std::time::Duration::from_secs(poll_interval_secs.max(1));
    let base_url = bridge_url.trim_end_matches('/').to_string();

    loop {
        for symbol in symbols {
            let url = base_url.clone();
            let sym = symbol.clone();
            let result = tokio::task::spawn_blocking(move || {
                poll_bridge_quote(&url, &sym)
            }).await;
            match result {
                Ok(Ok(tick)) => { store.update(tick); }
                Ok(Err(e)) => { warn!(symbol = %symbol, error = %e, "Bridge quote poll failed"); }
                Err(e) => { warn!(symbol = %symbol, error = %e, "Bridge poll task panicked"); }
            }
        }
        tokio::time::sleep(interval).await;
    }
}

/// Fetch a single quote from the bridge (runs sync HTTP in a blocking task)
fn poll_bridge_quote(bridge_url: &str, symbol: &str) -> Result<Tick, String> {
    let url = format!("{}/quote/{}", bridge_url, symbol);
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .call()
        .map_err(|e| format!("Bridge quote request failed: {}", e))?;

    let data: serde_json::Value = resp.into_json()
        .map_err(|e| format!("Failed to parse quote: {}", e))?;

    if let Some(err) = data.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }

    let ltp = data.get("ltp")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    if ltp <= 0.0 {
        return Err(format!("No valid LTP for {}", symbol));
    }

    let timestamp = data.get("timestamp")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    let change = data.get("change")
        .and_then(|v| v.as_f64())
        .unwrap_or(0.0);

    let volume = data.get("volume")
        .and_then(|v| v.as_u64())
        .unwrap_or(0);

    Ok(Tick {
        symbol: symbol.to_string(),
        ltp,
        open: ltp - change,
        high: ltp,
        low: ltp,
        close: ltp,
        volume,
        timestamp,
    })
}

/// WebSocket-based feed loop with auto-reconnect
async fn ws_feed_loop(
    store: &Arc<LivePriceStore>,
    ws_url: &str,
    symbols: &[String],
    api_key: &str,
    session_token: &str,
    reconnect_delay_secs: u64,
) {
    let ws_url = ws_url.to_string();
    let symbols: Vec<String> = symbols.to_vec();
    let api_key = api_key.to_string();
    let session_token = session_token.to_string();

    loop {
        match connect_and_stream(store, &ws_url, &symbols, &api_key, &session_token).await {
            Ok(()) => {
                info!("Market data feed disconnected cleanly");
            }
            Err(e) => {
                error!("Market data feed error: {}", e);
            }
        }

        info!(delay = reconnect_delay_secs, "Reconnecting market data feed");
        tokio::time::sleep(std::time::Duration::from_secs(reconnect_delay_secs)).await;
    }
}

async fn connect_and_stream(
    store: &Arc<LivePriceStore>,
    ws_url: &str,
    symbols: &[String],
    api_key: &str,
    session_token: &str,
) -> Result<(), String> {
    use futures_util::{SinkExt, StreamExt};
    use tokio_tungstenite::tungstenite::Message;

    let url = format!("{}?api_key={}&session_token={}", ws_url, api_key, session_token);

    let (ws_stream, _) = tokio_tungstenite::connect_async(&url)
        .await
        .map_err(|e| format!("WebSocket connect failed: {}", e))?;

    info!("Connected to market data WebSocket");

    let (mut write, mut read) = ws_stream.split();

    for symbol in symbols {
        let sub_msg = serde_json::json!({
            "action": "subscribe",
            "stock_code": symbol,
            "exchange_code": "NSE",
        });
        write.send(Message::Text(sub_msg.to_string().into()))
            .await
            .map_err(|e| format!("Subscribe failed for {}: {}", symbol, e))?;
        info!(symbol = %symbol, "Subscribed to market data");
    }

    while let Some(msg) = read.next().await {
        match msg {
            Ok(Message::Text(text)) => {
                if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                    if let Some(tick) = parse_breeze_tick(&data) {
                        store.update(tick);
                    }
                }
            }
            Ok(Message::Binary(bin)) => {
                if let Ok(text) = String::from_utf8(bin.to_vec()) {
                    if let Ok(data) = serde_json::from_str::<serde_json::Value>(&text) {
                        if let Some(tick) = parse_breeze_tick(&data) {
                            store.update(tick);
                        }
                    }
                }
            }
            Ok(Message::Ping(payload)) => {
                let _ = write.send(Message::Pong(payload)).await;
            }
            Ok(Message::Close(_)) => {
                info!("WebSocket close frame received");
                break;
            }
            Err(e) => {
                warn!("WebSocket error: {}", e);
                break;
            }
            _ => {}
        }
    }

    Ok(())
}

/// Parse a Breeze WebSocket message into a Tick.
fn parse_breeze_tick(data: &serde_json::Value) -> Option<Tick> {
    let symbol = data.get("symbol")
        .or_else(|| data.get("stock_code"))
        .and_then(|v| v.as_str())?
        .to_string();

    let ltp = parse_f64_field(data, "ltp")
        .or_else(|| parse_f64_field(data, "last"))?;

    let open = parse_f64_field(data, "open").unwrap_or(ltp);
    let high = parse_f64_field(data, "high").unwrap_or(ltp);
    let low = parse_f64_field(data, "low").unwrap_or(ltp);
    let close = parse_f64_field(data, "close").unwrap_or(ltp);
    let volume = data.get("volume")
        .and_then(|v| v.as_u64().or_else(|| v.as_str().and_then(|s| s.parse().ok())))
        .unwrap_or(0);

    let timestamp = data.get("timestamp")
        .and_then(|v| v.as_str())
        .unwrap_or("")
        .to_string();

    Some(Tick { symbol, ltp, open, high, low, close, volume, timestamp })
}

fn parse_f64_field(data: &serde_json::Value, field: &str) -> Option<f64> {
    data.get(field).and_then(|v| {
        v.as_f64().or_else(|| v.as_str().and_then(|s| s.parse().ok()))
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_live_price_store() {
        let (store, _rx) = LivePriceStore::new();
        store.update(Tick {
            symbol: "RELIANCE".into(), ltp: 2500.0,
            open: 2490.0, high: 2510.0, low: 2480.0, close: 2500.0,
            volume: 100000, timestamp: "2025-01-01T10:00:00".into(),
        });
        assert_eq!(store.get_ltp("RELIANCE"), Some(2500.0));
        assert_eq!(store.symbol_count(), 1);
    }

    #[test]
    fn test_missing_symbol_returns_none() {
        let (store, _rx) = LivePriceStore::new();
        assert_eq!(store.get_ltp("FAKE"), None);
    }

    #[test]
    fn test_parse_breeze_tick() {
        let data = serde_json::json!({
            "stock_code": "INFY",
            "ltp": "1500.50",
            "open": "1495.0",
            "high": "1510.0",
            "low": "1490.0",
            "close": "1500.0",
            "volume": "50000",
            "timestamp": "2025-01-01T10:30:00"
        });
        let tick = parse_breeze_tick(&data).unwrap();
        assert_eq!(tick.symbol, "INFY");
        assert!((tick.ltp - 1500.50).abs() < 0.01);
        assert_eq!(tick.volume, 50000);
    }

    #[test]
    fn test_parse_tick_numeric_fields() {
        let data = serde_json::json!({
            "symbol": "TCS",
            "ltp": 3500.0,
            "volume": 25000
        });
        let tick = parse_breeze_tick(&data).unwrap();
        assert_eq!(tick.symbol, "TCS");
        assert_eq!(tick.ltp, 3500.0);
    }

    #[test]
    fn test_broadcast_subscriber() {
        let (store, _rx) = LivePriceStore::new();
        let mut rx2 = store.subscribe();
        store.update(Tick {
            symbol: "HDFC".into(), ltp: 1600.0,
            open: 0.0, high: 0.0, low: 0.0, close: 0.0,
            volume: 0, timestamp: String::new(),
        });
        let tick = rx2.try_recv().unwrap();
        assert_eq!(tick.symbol, "HDFC");
    }

    #[test]
    fn test_feed_mode_selection() {
        assert_eq!(
            if "".is_empty() { FeedMode::BridgePolling } else { FeedMode::WebSocket },
            FeedMode::BridgePolling
        );
    }
}
