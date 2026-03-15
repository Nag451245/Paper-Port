# Capital Guard — Phase 5: Performance Test Plan

## Architecture Context (Performance-Relevant)

| Component | Technology | Key Constraint |
|-----------|-----------|----------------|
| API Server | Fastify 5 (Node.js, single-threaded) | CPU-bound during JSON serialization and P&L recalculation |
| Database | PostgreSQL via Supabase (PgBouncer on port 6543) | Connection pool is managed by Supabase, not by the app |
| ORM | Prisma 6 (single PrismaClient singleton) | Prisma's internal pool defaults to `num_cpus * 2 + 1` connections |
| Cache | Redis (optional) | Not always present; advisory locks fall back to no-op |
| WebSocket | Fastify WebSocket | All connections share the single Node.js event loop |
| Price Feed | PriceFeedService (2s tick interval) | Each tick queries MarketDataService for N subscribed symbols |
| Broker API | ICICI Breeze (Python bridge on :8001) | External dependency with 15s timeout, unknown rate limit |
| AI/ML | OpenAI/Gemini + Python FastAPI ML service | Network-bound, token-limited, variable latency |
| Rust Engine | capital-guard-engine (:8400) | Separate process; IPC overhead |
| Rate Limit | 5000 req/min global, 20 req/min on auth endpoints | |

---

## 1. Latency Tests

### 1.1 Order Placement Round-Trip Time

| Metric | SLA Target | Measurement |
|--------|------------|-------------|
| Paper MARKET order (place → FILLED) | **< 200ms** | Time from POST /api/trades/orders to FILLED status in response |
| Paper LIMIT order (place → SUBMITTED) | **< 100ms** | Time from POST to SUBMITTED acknowledgment |
| Live MARKET order (place → FILLED) | **< 5000ms** | Includes broker API round-trip + fill polling (up to 15 polls × 2s) |

**Auto-fail conditions:**
- P95 latency > 500ms for paper MARKET orders
- Any single order > 10s for paper mode
- Any order that never reaches terminal state (FILLED/CANCELLED/REJECTED) within 60s

### 1.2 Market Data Tick-to-Display Latency

| Metric | SLA Target | Measurement |
|--------|------------|-------------|
| Tick arrival → WebSocket broadcast | **< 50ms** | PriceFeedService.tick() internal processing time |
| WebSocket → UI render | **< 100ms** | Client-side measurement (Lighthouse, RUM) |
| End-to-end (API → screen) | **< 200ms** | Total tick-to-pixel time |

**Auto-fail conditions:**
- WebSocket message queue backing up (>100 pending messages per client)
- Tick processing time > 500ms (means next tick overlaps with current)

### 1.3 Portfolio P&L Recalculation Time

| Positions | SLA Target | What's Calculated |
|-----------|------------|-------------------|
| 1 position | **< 50ms** | getSummary: 1 LTP fetch + trade aggregation |
| 5 positions | **< 150ms** | 5 parallel LTP fetches + investedValue + unrealizedPnl |
| 15 positions (max) | **< 500ms** | 15 LTP fetches (5s timeout each) + all aggregations |
| 15 positions + 1000 historical trades | **< 1000ms** | Full summary with totalPnl from all historical trades |

**Auto-fail conditions:**
- getSummary > 2s for any position count
- getSummary returns NaN or Infinity for any field

**Known bottleneck:** `getSummary` makes N sequential `getQuote()` calls where N = number of open positions. With 15 positions and a 5s timeout per quote, worst-case is 75s (serial). The code now uses `Promise.allSettled` for parallel fetches, reducing this to ~5s worst-case.

---

## 2. Throughput / Load Tests

### 2.1 Concurrent Order Placement

| Scenario | Load | SLA | Duration |
|----------|------|-----|----------|
| Normal trading | 5 concurrent users, 2 orders/min each | P95 < 300ms, 0% errors | 10 min |
| Active day | 20 concurrent users, 5 orders/min each | P95 < 500ms, < 0.1% errors | 10 min |
| Peak load | 50 concurrent users, 10 orders/min each | P95 < 1000ms, < 1% errors | 5 min |

**Auto-fail conditions:**
- Error rate > 5% at any load level
- Any HTTP 500 response
- Rate limit errors (429) for non-auth endpoints at < 5000 req/min

### 2.2 Market Open Burst (First 5 Minutes)

| Metric | Target |
|--------|--------|
| Burst: 100 orders in 60 seconds | All acknowledged within 2s |
| Bot signal flood: 50 signals evaluated + 20 orders placed | < 30s total |
| Price feed: 50 symbols with 2s tick interval | Zero missed ticks |
| Concurrent: getSummary + placeOrder + WebSocket | No deadlock, no timeout |

**Auto-fail conditions:**
- Redis advisory lock timeout > 30s on any symbol
- OMS stuck in non-terminal state (PENDING/SUBMITTED) > 4 hours
- Kill switch check (Rust engine) takes > 5s per order

### 2.3 WebSocket Feed Capacity

| Symbols | Tick Interval | Target Throughput | Bandwidth |
|---------|--------------|-------------------|-----------|
| 10 symbols | 2s | 5 msgs/sec/client | ~2 KB/s |
| 50 symbols | 2s | 25 msgs/sec/client | ~10 KB/s |
| 200 symbols | 2s | 100 msgs/sec/client | ~40 KB/s |
| 200 symbols × 20 clients | 2s | 2000 msgs/sec total | ~800 KB/s |

**Auto-fail conditions:**
- Client disconnect due to slow consumer (back-pressure)
- Memory growth > 100 MB per 10 clients
- Event loop lag > 100ms during feed broadcast

---

## 3. Stress / Spike Tests

### 3.1 10x Normal Load

| Normal | 10x | Expected Behavior |
|--------|-----|-------------------|
| 5 users, 10 orders/min | 50 users, 100 orders/min | Graceful degradation. Orders queue. No data loss. |
| 50 symbol feed | 500 symbol feed | Some ticks delayed, no crash. |
| 5 concurrent getSummary | 50 concurrent getSummary | Slower but correct results. |

**Pass criteria:** System remains operational. May be slow but no data corruption, no crashes, no incorrect P&L.

### 3.2 Database Connection Pool Exhaustion

| Scenario | Expected Behavior |
|----------|-------------------|
| 50 concurrent long-running queries | Prisma queues requests; timeout after 15s |
| PgBouncer pool exhausted (Supabase: typically 15 connections) | New requests wait in queue; no crash |
| Redis unavailable | Advisory locks degrade to no-op; orders proceed without lock |

**Auto-fail conditions:**
- Prisma throws "Connection pool exhausted" AND server crashes
- Any request causes a process exit
- Data corruption when pool is exhausted (e.g., partial transaction commit)

### 3.3 Broker API Rate Limit Breach

| Scenario | Expected Behavior |
|----------|-------------------|
| Breeze API returns 429 | Order fails with clear error: "Broker rate limited" |
| Breeze API returns 200 but order actually rejected | Poll detects REJECTED status; user sees rejection reason |
| Breeze API times out (>15s) | Order stays in SUBMITTED; auto-expires after 4 hours |
| Breeze bridge process crashes | Paper mode unaffected; live mode returns "Broker not configured" |

**Auto-fail conditions:**
- 429 from broker causes a 500 to the user (should be 400 or 503)
- Order in SUBMITTED state forever (no auto-expiry)

---

## 4. Endurance Test (8-Hour Trading Day)

### Simulation Profile

| Phase | Time (IST) | Activity |
|-------|------------|----------|
| Pre-market | 8:00–9:15 | Bot scans, signal evaluation, watchlist enrichment |
| Market open burst | 9:15–9:30 | 50 orders in 15 min, high price volatility |
| Morning trading | 9:30–12:00 | 2 orders/min, continuous price feed |
| Lunch lull | 12:00–13:30 | Low activity, 1 order every 5 min |
| Afternoon trading | 13:30–15:00 | 3 orders/min, increasing volatility |
| Market close | 15:00–15:30 | Final burst, stop-loss triggers, position squaring |
| Post-market | 15:30–16:00 | P&L reconciliation, daily summary |

### Metrics to Monitor

| Metric | Alert Threshold | Critical Threshold |
|--------|----------------|-------------------|
| Node.js heap used | > 512 MB | > 1 GB |
| Event loop lag | > 50ms | > 200ms |
| Open file descriptors | > 500 | > 900 (OS limit usually 1024) |
| WebSocket connections | > 50 | > 100 |
| Prisma connection pool utilization | > 70% | > 90% |
| OMS transition log size (in-memory) | > 500 entries | > 900 (truncates at 1000) |
| Redis memory | > 100 MB | > 500 MB |
| Log file size | > 500 MB / day | > 1 GB / day |

### Auto-fail conditions (endurance)
- Heap grows monotonically without GC recovery → **memory leak**
- File descriptor count increases without decrease → **connection leak**
- Response time degrades >2x from hour 1 to hour 8 → **resource exhaustion**
- Any process crash/restart during the 8-hour run

---

## 5. Single Most Likely Bottleneck

### Verdict: **Sequential LTP fetches in `getSummary`**

The `PortfolioService.getSummary()` method fetches live quotes (LTP) for every open position. Although the code now uses `Promise.allSettled` for parallelism, the MarketDataService has a 15-second cache and depends on the Breeze bridge (Python process on :8001). Under load:

1. **15 positions × N concurrent users** = 15N simultaneous HTTP requests to the Breeze bridge
2. The Breeze bridge is a **single-threaded Flask/FastAPI process**
3. Each Breeze API call has a **15-second timeout**
4. If the bridge becomes saturated, all `getSummary` calls block until timeout

**Impact chain:**
```
User hits Dashboard → getSummary(15 positions)
  → 15 parallel getQuote() calls → Breeze bridge (:8001)
    → Each queues behind Flask's single worker
      → First 3 return in 200ms, next 12 queue for 1-2s each
        → Total getSummary time: 3-5 seconds
          → 20 concurrent users = 300 queued requests at bridge
            → Timeouts cascade → phantom P&L errors
```

**Mitigation recommendations:**
1. **Batch quote API**: Replace 15 individual `/quote/` calls with a single `/quotes?symbols=A,B,C` endpoint on the bridge
2. **Shared LTP cache**: PriceFeedService already tracks `lastPrices` — `getSummary` should read from this cache instead of calling the bridge
3. **Connection pool for bridge**: Use a connection-pooled HTTP client with max 5 concurrent connections to prevent bridge saturation
4. **Circuit breaker on bridge**: If bridge fails 3 consecutive calls, use cached prices for 60s before retrying
