# Capital Guard — Regression Test Manifest

## Phase 3: Regression Guard

Every historical bug extracted from git commit history, mapped to its regression test, root cause, and guard status.

---

### Regression Test Manifest

| Bug ID | Git Commit | Bug Description | Root Cause Category | Test ID | Test Count | Guard In Place |
|--------|-----------|-----------------|---------------------|---------|------------|----------------|
| BUG-001 | `8d7ffb2` | P&L timezone: `setHours(0,0,0,0)` uses server TZ, not IST. Daily trade count included 1.5 days of signals (451 vs 50) | **timezone_issue** | REG-001 | 3 | PARTIAL — `target-tracker.service.ts` uses IST but `portfolio.service.ts` still uses `setHours(0,0,0,0)` |
| BUG-002 | `6c6fdde` | P&L holiday fluctuation: unrealized P&L included in dayPnl caused different values on each page load during holidays | **logic_error** | REG-002 | 2 | YES — dayPnl/totalPnl now only count realized trades |
| BUG-003 | `6a26d58` | Dashboard vs Portfolio page show different P&L due to fresh API calls fetching different LTP between navigations | **stale_data** | REG-003 | 4 | YES — 60s staleness cache (`STALE_MS`) in frontend store |
| BUG-004 | `431cd7c` | Ghost executions: AI agent executed signals outside market hours, creating phantom trades at 11 PM | **missing_validation** | REG-004 | 2 | YES — `isMarketOpen()` guard in agent cycle + bot tag blocking |
| BUG-005 | `9cb8636` | Phantom P&L: when summary API failed, frontend computed P&L from cash-only NAV, showing ₹200K phantom loss | **error_handling** | REG-005 | 2 | YES — retain previous summary on API failure |
| BUG-006 | `912d5b9` | Risk rules only applied to BUY: 9 rules had `side==='BUY'` guard, SHORT orders bypassed all risk checks | **logic_error** | REG-006 | 2 | YES — `side==='BUY'` guards removed from all 9 rules |
| BUG-007 | `912d5b9` | Cost calculation used hardcoded 'SELL' for closePosition; SHORT cover (BUY) got wrong STT/stamp duty | **logic_error** | REG-007 | 1 | YES — `exitSide` derived from position direction |
| BUG-008 | `d9b10ec` | Circular dependency: TradeService ↔ TWAPExecutor caused stack overflow on startup | **architecture_error** | REG-008 | 1 | YES — dynamic `import()` for TWAPExecutor |
| BUG-009 | `2ed39cd` | Rate limit exhaustion: WebSocket ticks triggered portfolio refresh → 1500 req/min vs 200/min limit | **performance** | REG-009 | 2 | YES — 60s staleness cache + 5000/min rate limit |
| BUG-010 | `9269e22` | Zero NAV display: Portfolio page read wrong field (`totalNav` vs `current_nav`) | **data_type_mismatch** | REG-010 | 1 | YES — `parseSummary` handles both camelCase and snake_case |
| BUG-011 | `f3394ec` | Double exit: two concurrent exit signals could both transition same order past FILLED state | **race_condition** | REG-011 | 28 | YES — terminal states (FILLED/CANCELLED/REJECTED/EXPIRED) allow zero transitions |
| BUG-012 | `f3394ec` | Fat-finger: no maximum order value limit; qty=10000 typo → ₹25M order on ₹10L account | **missing_validation** | REG-012 | 1 | YES — `maxOrderValue=₹500,000` in risk config |
| BUG-013 | `f3394ec` | Division by zero: stopLoss=entryPrice → riskPerShare=0 → qty=Infinity | **missing_validation** | REG-013 | 3 | YES — returns `qty=0` when riskPerShare ≤ 0 |
| BUG-014 | `ddf558a` | Stale quotes: market orders executed on quotes >30 min old without detection | **external_api_assumption** | REG-014 | 3 | YES — `MAX_QUOTE_AGE_MS=5min` staleness check |
| BUG-015 | `ddf558a` | Race condition: concurrent orders for same symbol bypassed position limits (TOCTOU) | **race_condition** | REG-015 | 2 | YES — Redis NX lock per `portfolio:symbol` |
| BUG-016 | `2ae8295` | NSE expiry day hardcoded as Thursday; SEBI changed to Tuesday effective Sep 2025 | **regulatory_change** | REG-016 | 1 | PARTIAL — updated but still somewhat hardcoded |
| BUG-017 | `3833829` | Command center 500: missing default case for `general_chat` intent → undefined responseContent | **missing_validation** | REG-017 | 1 | YES — default case added + null guard on responseContent |
| BUG-018 | `f3394ec` | Partial fill P&L: used new fill price as entire position exit price instead of blended average | **logic_error** | REG-018 | 1 | YES — OMS `recordFill` computes blended avg = (prev+new)/total |
| BUG-019 | Multiple | NAV corruption: NaN/Infinity from div-by-zero, Number(undefined), or Prisma Decimal miscast | **data_type_mismatch** | REG-019 | 3 | YES — `safeUpdateNav` checks `isFinite() && !isNaN()` |

---

### Root Cause Distribution

| Category | Count | Bug IDs |
|----------|-------|---------|
| logic_error | 4 | BUG-002, BUG-006, BUG-007, BUG-018 |
| missing_validation | 4 | BUG-004, BUG-012, BUG-013, BUG-017 |
| race_condition | 2 | BUG-011, BUG-015 |
| data_type_mismatch | 2 | BUG-010, BUG-019 |
| timezone_issue | 1 | BUG-001 |
| stale_data | 1 | BUG-003 |
| error_handling | 1 | BUG-005 |
| architecture_error | 1 | BUG-008 |
| performance | 1 | BUG-009 |
| external_api_assumption | 1 | BUG-014 |
| regulatory_change | 1 | BUG-016 |

---

### Guard Coverage Summary

| Status | Count | Details |
|--------|-------|---------|
| YES — Guard in place and verified by regression test | 16 | BUG-002 through BUG-015, BUG-017, BUG-018, BUG-019 |
| PARTIAL — Guard exists but known gap remains | 2 | BUG-001 (portfolio.service.ts still uses `setHours`), BUG-016 (expiry day still partially hardcoded) |
| NO — No guard | 0 | |

---

### Suggested Monitoring Alerts (for each bug class)

| Bug Class | Alert Recommendation |
|-----------|---------------------|
| timezone_issue | **ALERT**: Any `setHours(0,0,0,0)` without IST offset in server code → static analysis rule |
| logic_error | **INVARIANT**: `dayPnl === sum(trades.filter(t => t.exitTime >= todayIST).map(t => t.netPnl))` — assert on every API response |
| race_condition | **MONITOR**: Redis lock acquisition failure rate > 5/min → Slack alert |
| missing_validation | **CI GATE**: Zod schema coverage — every POST endpoint must have a schema |
| data_type_mismatch | **RUNTIME ASSERT**: `isFinite(nav) && nav !== 0` before every portfolio.update |
| external_api_assumption | **MONITOR**: Quote cache miss rate + average quote age → dashboard metric |
| performance | **MONITOR**: API response latency P99 > 2s → throttle alert |
| regulatory_change | **CALENDAR**: SEBI circular review quarterly — compare expiry logic against gazette |
