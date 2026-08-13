# Capital Guard — Full Test Suite Specification

## Unit Tests (UT)

Each test carries a unique ID, risk label, and trading-domain rationale.

---

### Category A: Transaction Cost Calculations

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| UT-001 | ⚠️ NSE equity BUY cost breakdown (brokerage, STT, exchange, GST, SEBI, stamp duty) | HIGH | Wrong costs silently eat into P&L; trader sees inflated returns |
| UT-002 | ⚠️ NSE equity SELL cost breakdown (STT on sell side only) | HIGH | STT is asymmetric — BUY has no STT, SELL does. Off-by-one here means every trade P&L is wrong |
| UT-003 | ⚠️ MCX commodity cost breakdown (CTT not STT, different exchange charge rate) | HIGH | MCX uses CTT (0.01%) not STT (0.1%); wrong rate = 10x cost error |
| UT-004 | ⚠️ CDS currency cost breakdown (zero STT on currency derivatives) | HIGH | SEBI exempts currency derivatives from STT; charging it is regulatory non-compliance |
| UT-005 | Brokerage cap at ₹20 per order | MEDIUM | Discount brokers cap at ₹20; miscalculating inflates costs on large orders |
| UT-006 | ⚠️ Stamp duty only on BUY side | HIGH | Stamp duty is legally charged only to the buyer; wrong side = incorrect P&L |
| UT-007 | Zero-quantity order produces zero costs | LOW | Defensive — prevents division by zero in downstream calculations |
| UT-008 | Sub-paise precision: costs on ₹0.05 penny stock | MEDIUM | Micro-cap stocks can have tiny turnover; ensure no floating-point underflow |

### Category B: Execution Simulation (Paper Trading)

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| UT-009 | LIMIT orders have zero slippage/impact | MEDIUM | Limit orders fill at exact price by definition; any slippage is a simulation bug |
| UT-010 | MARKET order slippage is always adverse (BUY fills higher, SELL fills lower) | HIGH | Filling at a better price in simulation creates unrealistic P&L |
| UT-011 | Fill ratio is always ≤ 1.0 and filled qty ≤ requested qty | HIGH | Filling more than requested = phantom shares in portfolio |
| UT-012 | Fill price is always positive | HIGH | Zero or negative fill price would corrupt NAV calculation |
| UT-013 | Spread widening during market open (9:15-9:45 IST) and close (15:00-15:30 IST) | MEDIUM | Realistic simulation — opening/closing auctions have wider spreads |
| UT-014 | MCX has wider base spread (8 bps) than NSE (3 bps) | LOW | Commodities are less liquid; spread model must reflect this |

### Category C: P&L Correctness

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| UT-015 | ⚠️ LONG P&L = (exitPrice - entryPrice) × qty - costs | HIGH | The fundamental P&L formula; wrong sign = profits shown as losses |
| UT-016 | ⚠️ SHORT P&L = (entryPrice - exitPrice) × qty - costs | HIGH | Short P&L is inverted; wrong direction means covering at a loss looks like a gain |
| UT-017 | ⚠️ dayPnl uses IST midnight boundary, not server-local or UTC | HIGH | CONFIRMED BUG: `portfolio.service.ts` uses `setHours(0,0,0,0)` (server TZ) while `target-tracker.service.ts` uses `todayStartIST()` |
| UT-018 | ⚠️ Trade at 23:30 IST is counted as "today", not "tomorrow" | HIGH | Late evening trades must be attributed to the correct trading day |
| UT-019 | ⚠️ getPnlHistory buckets trades by IST date, not UTC date | HIGH | CONFIRMED BUG: `toISOString().split('T')[0]` uses UTC; a trade at 22:00 IST (16:30 UTC) could shift days |
| UT-020 | dayPnl is 0 on market holidays (no new trades) | MEDIUM | Holidays should show zero daily P&L, not carry over stale data |
| UT-021 | totalPnl is still available on holidays from historical trades | MEDIUM | Cumulative P&L must persist regardless of market state |
| UT-022 | ⚠️ Negative netPnl trades reduce totalPnl correctly | HIGH | Losing trades must decrease the aggregate; sign error means hidden losses |
| UT-023 | Decimal precision: 1000 trades × ₹99.99 = ₹99,990 (no floating-point drift) | HIGH | IEEE 754 floating-point accumulation errors on large trade counts |

### Category D: NAV & Portfolio Accounting

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| UT-024 | ⚠️ totalNav = cash + investedValue + unrealizedPnl | HIGH | The fundamental portfolio identity; if this is wrong, the entire dashboard lies |
| UT-025 | ⚠️ LONG investedValue = entryPrice × qty (full notional) | HIGH | Long positions lock full notional value |
| UT-026 | ⚠️ SHORT investedValue = entryPrice × qty × margin_rate | HIGH | Shorts only lock margin; using full notional overstates exposure |
| UT-027 | ⚠️ NSE/BSE SHORT margin rate = 25% | HIGH | Regulatory margin rates must be exact |
| UT-028 | ⚠️ MCX SHORT margin rate = 10% | HIGH | Commodity margins are lower; wrong rate blocks valid trades |
| UT-029 | ⚠️ CDS SHORT margin rate = 5% | HIGH | Currency margin is lowest; wrong rate overstates locked capital |
| UT-030 | ⚠️ reconcileNav: correctCash = initialCapital + realizedPnl − lockedCapital | HIGH | NAV reconciliation is the "source of truth" correction mechanism |
| UT-031 | reconcileNav detects and reports drift correctly | MEDIUM | Drift detection lets the user know their P&L display was inaccurate |
| UT-032 | Zero drift when NAV is already correct | LOW | No-op reconciliation should not modify anything |
| UT-033 | ⚠️ safeUpdateNav rejects NaN/Infinity | HIGH | NaN in NAV would corrupt every subsequent calculation irreversibly |
| UT-034 | safeUpdateNav warns but allows negative NAV (paper mode margin overdraft) | MEDIUM | Paper trading can overdraft; real trading must not |
| UT-035 | ⚠️ updateCapital preserves P&L delta (₹20k profit + new capital = new capital + ₹20k) | HIGH | Changing initial capital must not erase accumulated profits/losses |

### Category E: Order State Machine (OMS)

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| UT-036 | ⚠️ All 11 valid transitions execute correctly | HIGH | The OMS state machine is the single source of truth for order lifecycle |
| UT-037 | ⚠️ All 12 invalid transitions are rejected with error | HIGH | Allowing FILLED→CANCELLED means a trade can "un-happen" — catastrophic |
| UT-038 | ⚠️ Terminal states (FILLED, CANCELLED, REJECTED, EXPIRED) allow no further transitions | HIGH | Once terminal, an order must be immutable — financial audit requirement |
| UT-039 | ⚠️ Partial fill computes blended avg price: (old×oldQty + new×newQty) / totalQty | HIGH | Wrong blended price means entry cost is wrong, P&L is wrong, position sizing is wrong |
| UT-040 | ⚠️ totalFilled ≥ orderQty triggers FILLED, not PARTIALLY_FILLED | HIGH | Order completion detection; staying in PARTIALLY_FILLED forever means position never fully opens |
| UT-041 | Slippage computed in bps: \|fillPrice − idealPrice\| / idealPrice × 10000 | MEDIUM | Slippage tracking is essential for execution quality monitoring |
| UT-042 | filledAt timestamp set on FILLED and PARTIALLY_FILLED only | MEDIUM | Fill timestamps drive execution latency analytics |
| UT-043 | ⚠️ Cancelling a PARTIALLY_FILLED order is valid (broker can partial-fill then cancel remainder) | HIGH | Real-world scenario: exchange fills 30 of 100 shares, then cancels the rest at market close |
| UT-044 | Stale PENDING orders auto-expire (PENDING → CANCELLED after 4 hours) | MEDIUM | Prevents phantom orders from accumulating and confusing position tracking |
| UT-045 | Stale SUBMITTED orders auto-expire (SUBMITTED → EXPIRED after 4 hours) | MEDIUM | Exchange-submitted orders that never fill should not linger indefinitely |
| UT-046 | Transition log caps at 1000 entries (memory leak prevention) | LOW | Unbounded in-memory log would cause OOM in long-running sessions |
| UT-047 | ORDER_STATE_CHANGE event emitted on every transition | MEDIUM | WebSocket and Telegram notifications depend on this event |

### Category F: Risk Engine

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| UT-048 | ⚠️ Order exceeding maxOrderValue (₹500,000) is blocked | HIGH | Prevents runaway orders from a malfunctioning bot |
| UT-049 | ⚠️ Position size > 5% of capital is blocked | HIGH | Single-stock concentration risk; one bad trade shouldn't wipe 25% of capital |
| UT-050 | ⚠️ Max 15 open positions enforced | HIGH | Over-diversification in small accounts leads to unmanageable risk |
| UT-051 | ⚠️ Per-symbol concentration (max 2 positions) enforced | HIGH | Prevents doubling down on a losing symbol via multiple bot strategies |
| UT-052 | ⚠️ Daily drawdown > 2% triggers circuit breaker | HIGH | The last line of defense — stops all trading when the day is clearly going wrong |
| UT-053 | ⚠️ Circuit breaker emits CIRCUIT_BREAKER_TRIGGERED event | HIGH | Risk dashboard and Telegram must be notified immediately |
| UT-054 | ⚠️ Sector concentration > 30% is blocked | HIGH | Prevents all-banking or all-IT portfolio that crashes on sector rotation |
| UT-055 | ⚠️ Portfolio heat > 80% (total exposure / capital) is blocked | HIGH | Over-leveraging beyond 80% leaves no room for adverse moves |
| UT-056 | ⚠️ 5 consecutive losses → 30-minute trading pause | HIGH | Tilt control — forces the trader/bot to cool down after a losing streak |
| UT-057 | ⚠️ 10 daily losses → trading halted for the day | HIGH | Hard stop after systematic failure; prevents death by a thousand cuts |
| UT-058 | ⚠️ Weekly loss > 3% → position sizes halved | HIGH | Progressive risk reduction on drawdown |
| UT-059 | ⚠️ 7 consecutive losing days → auto-trading halted for manual review | HIGH | Structural strategy failure; manual intervention required |
| UT-060 | ⚠️ 3 consecutive losing days → position sizes reduced by 50% | HIGH | Early warning size reduction before full halt |
| UT-061 | ⚠️ forceCloseOnDailyLossLimit closes all open positions | HIGH | Nuclear option — emergency liquidation when circuit breaker fires |
| UT-062 | forceClose handles individual position closure failures gracefully | MEDIUM | One failed close must not prevent closing the others |
| UT-063 | RiskEvent created and persisted for every violation | MEDIUM | Audit trail requirement — every blocked trade must be recorded |
| UT-064 | ⚠️ computePositionSize: qty = riskAmount / riskPerShare | HIGH | Kelly-criterion-style sizing; wrong formula means wrong position sizes |
| UT-065 | computePositionSize returns 0 when stopLoss = entryPrice | MEDIUM | Zero risk-per-share → infinite qty → must return 0 |
| UT-066 | getSizeMultiplier returns 0.25 when both weekly loss AND consecutive days hit | MEDIUM | Compound reduction: 0.5 × 0.5 = 0.25 |

### Category G: Market Calendar

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| UT-067 | NSE market hours: 9:15 AM – 3:30 PM IST | HIGH | Orders outside these hours must be rejected |
| UT-068 | MCX market hours: 9:00 AM – 11:30 PM IST | MEDIUM | Commodity markets have extended hours |
| UT-069 | CDS market hours: 9:00 AM – 5:00 PM IST | MEDIUM | Currency market has its own schedule |
| UT-070 | Weekends (Saturday/Sunday) return isMarketOpen=false | HIGH | Weekend orders must be blocked |
| UT-071 | Known NSE holidays (Republic Day, Holi, Diwali, etc.) return isHoliday=true | HIGH | Holiday trading would fail at the exchange level |
| UT-072 | ⚠️ Muhurat trading session (Diwali evening 6-7 PM) returns isMarketOpen=true | HIGH | Special exception — Diwali evening trading is real but outside normal hours |
| UT-073 | getMarketPhase returns correct phase for each time window | MEDIUM | Bot behavior changes by market phase |
| UT-074 | getNextMarketOpen skips weekends and holidays correctly | LOW | Dashboard UX — shows when to expect next session |

### Category H: Target Tracker

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| UT-075 | ⚠️ LOSS_LIMIT triggers when loss exceeds maxLossAbs | HIGH | Automatic loss limit enforcement — the target's built-in circuit breaker |
| UT-076 | TARGET_HIT triggers when profit exceeds target | MEDIUM | Goal achievement detection; reduces aggression to protect gains |
| UT-077 | ⚠️ Trading disallowed when status = LOSS_LIMIT | HIGH | Must not trade after hitting loss limit |
| UT-078 | Trading disallowed when status = REVIEW_REQUIRED | HIGH | Forces manual review before resuming |
| UT-079 | ⚠️ Aggression = "none" when loss ≥ 70% of maxLoss | HIGH | Approaching stop-out level; all trading should cease |
| UT-080 | ⚠️ Consecutive loss days increment and trigger REVIEW_REQUIRED at 2 | HIGH | Pattern detection — two bad days in a row needs investigation |
| UT-081 | Consecutive loss days reset to 0 on profitable day | MEDIUM | Recovery should reset the counter |
| UT-082 | recordDailyPnl classifies BREAKEVEN when |pnl| ≤ ₹10 | LOW | Prevents noise trades from triggering loss streaks |
| UT-083 | createTarget deactivates existing active targets | MEDIUM | Only one active target at a time |

### Category I: Trading Edge Cases (Domain-Specific)

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| UT-084 | ⚠️ Kill switch blocks all new orders with HTTP 503 | HIGH | Emergency stop for the entire trading system |
| UT-085 | ⚠️ Bot orders blocked outside market hours even with skipMarketCheck | HIGH | Safety net — bots must NEVER place orders after hours |
| UT-086 | ⚠️ Market order rejected when LTP unavailable (price = 0) | HIGH | Placing a market order without a price would buy at any price — dangerous |
| UT-087 | ⚠️ Stale quote rejected (> 5 minutes old) | HIGH | Trading on old data can mean buying at yesterday's price while the stock has crashed |
| UT-088 | ⚠️ BUY order rejected when insufficient capital | HIGH | Must not open positions with money you don't have |
| UT-089 | ⚠️ SELL (short) order rejected when insufficient margin | HIGH | Short selling requires margin; under-margined shorts get force-closed by the exchange |
| UT-090 | ⚠️ Total invested + new order must not exceed declared capital | HIGH | Strict capital discipline — the core promise of paper trading |
| UT-091 | ⚠️ Per-symbol advisory lock prevents concurrent duplicate orders | HIGH | Race condition: two bot signals for RELIANCE simultaneously could bypass position limits |
| UT-092 | ⚠️ TWAP auto-routes when qty ≥ 500 shares (MARKET orders only) | HIGH | Large orders without TWAP cause excessive market impact in live trading |
| UT-093 | ⚠️ BUY on existing SHORT → covers short first, opens long with excess qty | HIGH | Position netting: BUY 100 when SHORT 60 → cover 60 + open LONG 40 |
| UT-094 | ⚠️ SELL on existing LONG → closes long first, opens short with excess qty | HIGH | Same netting logic for the sell side |
| UT-095 | ⚠️ Partial cover: BUY 30 on SHORT 50 → SHORT reduces to 20 | HIGH | Partial netting must not fully close the position |
| UT-096 | ⚠️ Averaging into existing LONG: blended avg = (oldAvg×oldQty + newPrice×newQty) / totalQty | HIGH | Wrong average means wrong unrealized P&L display and wrong stop-loss distances |
| UT-097 | ⚠️ Unrealized P&L skips persist when market is closed | HIGH | CONFIRMED BUG AREA: `persistUnrealizedPnl()` returns early on `!isMarketOpen()` |
| UT-098 | Price feed rejects LTP ≤ 0 | HIGH | Zero/negative prices from API errors would corrupt all calculations |

---

## Integration Tests (IT)

| ID | Test | Risk | Why It Matters |
|----|------|------|----------------|
| IT-001 | POST /api/trades/orders validates Zod schema (snake_case fields) | MEDIUM | Wrong field names → silent validation failure → 400 error |
| IT-002 | POST /api/trades/orders requires authentication (401) | HIGH | Unauthenticated order placement is a security vulnerability |
| IT-003 | GET /api/trades/orders returns orders list for authenticated user | MEDIUM | Order visibility is essential for the trading terminal UI |
| IT-004 | GET /api/trades/positions returns open positions | MEDIUM | Position display drives exit decisions |
| IT-005 | DELETE /api/trades/orders/:id requires authentication | HIGH | Anyone cancelling orders would be catastrophic |
| IT-006 | ⚠️ Negative qty in order payload → 400 rejection | HIGH | Negative quantity could reverse trade direction silently |
| IT-007 | ⚠️ Zero price in LIMIT order → 400 rejection | HIGH | Zero-price limit order would fill at any price like a market order |
| IT-008 | SQL injection in symbol field → no 500, parameterized via Prisma | HIGH | Financial application — injection attacks must be neutralized |
| IT-009 | XSS in string fields → no 500 | MEDIUM | Prevents stored XSS in trade logs |
| IT-010 | Expired JWT token → 401 | HIGH | Stale sessions must not have trading access |
| IT-011 | Malformed JWT → 401 | HIGH | Token tampering must be detected |
| IT-012 | ⚠️ IDOR: accessing another user's portfolio → 403/404 | HIGH | User A must never see or modify User B's positions |
| IT-013 | 50 rapid-fire requests without 500 errors | MEDIUM | DoS resilience — trading APIs must handle burst traffic |
| IT-014 | All 5 protected endpoints return 401 without auth | HIGH | Complete auth coverage verification |
| IT-015 | ⚠️ Portfolio summary shows consistent dayPnl across Dashboard and Portfolio views | HIGH | CONFIRMED BUG: different "today" boundaries caused inconsistent P&L |

---

## Failure Impact Guide

| Risk Level | What Failure Means |
|------------|-------------------|
| ⚠️ HIGH | **Direct financial impact.** Wrong P&L display, incorrect position sizing, capital misallocation, or security breach. The trader makes decisions on wrong data or the system allows unauthorized actions. Must be fixed before live trading. |
| MEDIUM | **Operational degradation.** Analytics inaccuracy, UX confusion, or missed alerts. The trader can still trade safely but gets suboptimal information. |
| LOW | **Minor quality issue.** Edge case handling, cosmetic, or defense-in-depth. No direct impact on trading decisions. |
