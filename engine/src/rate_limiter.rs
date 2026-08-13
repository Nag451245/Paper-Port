use std::sync::Mutex;
use std::time::Instant;
use tracing::trace;

/// Token-bucket rate limiter for Breeze API calls.
///
/// Refills at `rate_per_sec` tokens per second, up to `max_tokens` burst capacity.
/// Thread-safe: uses a Mutex around the mutable state.
pub struct RateLimiter {
    max_tokens: f64,
    rate_per_sec: f64,
    state: Mutex<RateLimiterState>,
}

struct RateLimiterState {
    tokens: f64,
    last_refill: Instant,
}

impl RateLimiter {
    pub fn new(rate_per_sec: f64, burst: u64) -> Self {
        let max = burst as f64;
        Self {
            max_tokens: max,
            rate_per_sec,
            state: Mutex::new(RateLimiterState {
                tokens: max,
                last_refill: Instant::now(),
            }),
        }
    }

    fn refill(state: &mut RateLimiterState, max: f64, rate: f64) {
        let now = Instant::now();
        let elapsed = now.duration_since(state.last_refill).as_secs_f64();
        state.tokens = (state.tokens + elapsed * rate).min(max);
        state.last_refill = now;
    }

    /// Blocking acquire — waits until a token is available.
    pub fn acquire(&self) {
        loop {
            {
                let mut s = match self.state.lock() {
                    Ok(g) => g,
                    Err(poisoned) => poisoned.into_inner(),
                };
                Self::refill(&mut s, self.max_tokens, self.rate_per_sec);
                if s.tokens >= 1.0 {
                    s.tokens -= 1.0;
                    trace!(remaining = s.tokens, "Rate limiter: token acquired");
                    return;
                }
            }
            let wait_ms = (1000.0 / self.rate_per_sec).ceil() as u64;
            std::thread::sleep(std::time::Duration::from_millis(wait_ms.max(50)));
        }
    }

    /// Non-blocking try-acquire — returns true if a token was consumed.
    pub fn try_acquire(&self) -> bool {
        let mut s = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        Self::refill(&mut s, self.max_tokens, self.rate_per_sec);
        if s.tokens >= 1.0 {
            s.tokens -= 1.0;
            true
        } else {
            false
        }
    }

    /// Returns the current number of available tokens (for diagnostics).
    pub fn available_tokens(&self) -> f64 {
        let mut s = match self.state.lock() {
            Ok(g) => g,
            Err(poisoned) => poisoned.into_inner(),
        };
        Self::refill(&mut s, self.max_tokens, self.rate_per_sec);
        s.tokens
    }
}

/// Rate-limited wrapper around `broker_icici::bridge_get_historical`.
pub fn rate_limited_historical(
    limiter: &RateLimiter,
    bridge_url: &str,
    symbol: &str,
    interval: &str,
    from: &str,
    to: &str,
) -> Result<serde_json::Value, String> {
    limiter.acquire();
    crate::broker_icici::bridge_get_historical(bridge_url, symbol, interval, from, to)
}

/// Rate-limited quote fetch via Breeze Bridge.
/// Returns (last_traded_price, volume) or an error.
pub fn rate_limited_quote(
    limiter: &RateLimiter,
    bridge_url: &str,
    symbol: &str,
) -> Result<(f64, i64), String> {
    limiter.acquire();
    let url = format!("{}/quote/{}", bridge_url, symbol);
    let resp = ureq::get(&url)
        .timeout(std::time::Duration::from_secs(5))
        .call()
        .map_err(|e| format!("Quote request failed: {}", e))?;
    let data: serde_json::Value = resp.into_json()
        .map_err(|e| format!("Failed to parse quote: {}", e))?;
    if let Some(err) = data.get("error").and_then(|v| v.as_str()) {
        return Err(err.to_string());
    }
    let ltp = data.get("ltp").and_then(|v| v.as_f64()).unwrap_or(0.0);
    let vol = data.get("volume").and_then(|v| v.as_i64()).unwrap_or(0);
    if ltp <= 0.0 {
        return Err(format!("No valid LTP for {}", symbol));
    }
    Ok((ltp, vol))
}

// ─── Tests ───────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn test_burst_capacity() {
        let rl = RateLimiter::new(2.0, 5);
        for _ in 0..5 {
            assert!(rl.try_acquire());
        }
        assert!(!rl.try_acquire());
    }

    #[test]
    fn test_refill() {
        let rl = RateLimiter::new(100.0, 5);
        for _ in 0..5 {
            rl.try_acquire();
        }
        assert!(!rl.try_acquire());
        std::thread::sleep(std::time::Duration::from_millis(60));
        assert!(rl.try_acquire());
    }

    #[test]
    fn test_acquire_blocking() {
        let rl = RateLimiter::new(100.0, 1);
        rl.acquire();
        let start = Instant::now();
        rl.acquire();
        let elapsed = start.elapsed().as_millis();
        assert!(elapsed < 500, "blocking acquire should return within 500ms at 100 tok/s");
    }

    #[test]
    fn test_available_tokens() {
        let rl = RateLimiter::new(2.0, 5);
        assert!(rl.available_tokens() >= 4.9);
        rl.try_acquire();
        assert!(rl.available_tokens() >= 3.9);
    }
}
