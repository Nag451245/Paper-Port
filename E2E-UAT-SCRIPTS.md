# Capital Guard — Phase 4: Manual E2E & UAT Test Scripts

## Overview

These test scripts are written for a **non-engineer** (trader, product owner, or QA analyst) to execute manually. Each script covers a critical trading journey and includes exact UI interactions, checkpoints, and fail indicators.

---

## E2E-001: Full Order Lifecycle (Place → Fill → Position → P&L)

**Actor:** Trader
**Estimated Time:** 5 minutes
**Risk Level:** CRITICAL — this is the core trading workflow

### Pre-conditions
- [ ] User is logged in
- [ ] At least one portfolio exists with ≥ ₹50,000 available capital
- [ ] Market is OPEN (check the top bar — it should say "Market Hours" or show a green indicator)
- [ ] No existing position in the test symbol (e.g., RELIANCE)

### Steps

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 1 | Navigate to **Trading Terminal** page | Page loads. Symbol search bar is visible. |
| 2 | Search for "RELIANCE" in the symbol search bar | RELIANCE appears in dropdown with live LTP (price should be a reasonable number like ₹1,200–₹3,000, not ₹0 or ₹99,999) |
| 3 | Click RELIANCE to select it | Symbol details panel appears with live price, change %, and volume |
| 4 | Click **BUY** button | Order form opens with side = BUY pre-selected |
| 5 | Enter Qty = **5**, Order Type = **MARKET** | Estimated order value is displayed (should be ~₹12,500 at ₹2,500/share). Verify it's not ₹0. |
| 6 | Click **Place Order** | **CHECKPOINT 1:** A success toast/notification appears. No error message. |
| 7 | Navigate to **Orders** tab/page | The new order appears in the list |
| 8 | Verify order status | Status shows **FILLED** (for MARKET orders, this should happen within seconds in paper mode) |
| 9 | Verify fill price | Fill price is close to the displayed LTP (±1%). Should NOT be ₹0. |
| 10 | Navigate to **Positions** tab/page | A new LONG position for RELIANCE appears with Qty=5 |
| 11 | Verify position details | Avg Entry Price matches the order fill price. Unrealized P&L shows a number (positive or negative). |
| 12 | Navigate to **Dashboard** | **CHECKPOINT 2:** Day P&L reflects the new trade. It should NOT be ₹0 if position has moved. |
| 13 | Navigate to **Portfolio** page | **CHECKPOINT 3:** Day P&L and Total P&L match the Dashboard values EXACTLY. |

### Pass Criteria
- [ ] Order placed successfully with no errors
- [ ] Order transitions: PENDING → SUBMITTED → FILLED (check order history if available)
- [ ] Position created with correct symbol, qty, and avg price
- [ ] P&L is consistent between Dashboard and Portfolio pages
- [ ] No 500 errors in the browser console (F12 → Console tab)

### Fail Indicators (Subtle Bugs)
- Day P&L shows ₹0 even though you just made a trade → **BUG-002 regression**
- Dashboard shows -₹50,000 Day P&L while Portfolio shows +₹500 → **BUG-003 regression**
- Fill price is exactly ₹0.00 → **BUG: price feed failure**
- Order stays in PENDING forever → **BUG: OMS state machine stuck**
- Available capital didn't decrease after buying → **BUG: NAV not updated**

---

## E2E-002: Order Cancellation Mid-Flight

**Actor:** Trader
**Estimated Time:** 3 minutes
**Risk Level:** HIGH — failed cancellation means unwanted positions

### Pre-conditions
- [ ] User is logged in with capital available
- [ ] Market is OPEN

### Steps

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 1 | Place a **LIMIT** order for RELIANCE at a price **10% below** current LTP | Order created in PENDING/SUBMITTED state (will NOT fill immediately because price is too low) |
| 2 | Navigate to **Orders** page | The LIMIT order appears with status SUBMITTED or PENDING |
| 3 | Click the **Cancel** button (X icon or Cancel link) on the order | **CHECKPOINT:** Order status changes to CANCELLED |
| 4 | Verify the order is no longer active | Order shows CANCELLED status with a timestamp |
| 5 | Navigate to **Positions** | No new position was created for this symbol |
| 6 | Check available capital | Capital should be fully restored (no reduction from the cancelled order) |

### Pass Criteria
- [ ] LIMIT order successfully created
- [ ] Cancellation is immediate and reflected in the UI
- [ ] No position created for the cancelled order
- [ ] Capital not affected by the cancellation

### Fail Indicators
- Cancel button is missing or disabled → **BUG: UI not rendering cancel action**
- Order still shows as PENDING after cancellation → **BUG-011: terminal state violation**
- Capital decreased even though order was cancelled → **BUG: NAV not restored**
- Error toast appears: "Invalid transition" → **BUG: OMS state machine issue**

---

## E2E-003: Stop-Loss Trigger Under Fast Market

**Actor:** Trader
**Estimated Time:** 10 minutes (requires monitoring)
**Risk Level:** CRITICAL — stop-loss failure means unlimited losses

### Pre-conditions
- [ ] Existing LONG position in a volatile stock
- [ ] Stop-loss is set on the position (or set one manually)
- [ ] Market is OPEN with active price movement

### Steps

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 1 | Open the **Positions** page | Your open position shows with current P&L |
| 2 | Note the stop-loss price | Record the SL price (e.g., ₹2,450 for entry at ₹2,500) |
| 3 | Watch the live price feed | Price ticks update in real-time on the position card |
| 4 | When LTP approaches or crosses the stop-loss price | **CHECKPOINT 1:** System should trigger an automatic exit |
| 5 | Check the **Orders** page | A SELL order should appear (auto-generated by stop-loss monitor) |
| 6 | Check the **Positions** page | Position status should change to CLOSED |
| 7 | Check P&L | Realized loss should be approximately (SL price - entry price) × qty |

### Pass Criteria
- [ ] Stop-loss triggers automatically without manual intervention
- [ ] Exit order is created and filled at or near the SL price
- [ ] Position is closed correctly
- [ ] Realized P&L reflects the loss accurately

### Fail Indicators
- Price goes below SL but no order is generated → **CRITICAL: stop-loss monitor not running**
- Two exit orders are generated for the same position → **BUG-011: double exit**
- P&L shows ₹0 after SL trigger → **BUG: cost calculation on exit**
- Exit order is REJECTED → **BUG: market hours check blocking SL exits**

---

## E2E-004: Portfolio Accuracy After Multiple Mixed Trades

**Actor:** Trader
**Estimated Time:** 15 minutes
**Risk Level:** HIGH — cumulative errors compound with each trade

### Pre-conditions
- [ ] Fresh portfolio with ₹1,000,000 initial capital
- [ ] Market is OPEN
- [ ] No existing positions

### Steps

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 1 | BUY 10 RELIANCE at MARKET | Position opens. Capital decreases by ~₹25,000. |
| 2 | BUY 20 TCS at MARKET | Second position opens. Capital decreases further. |
| 3 | SELL 5 RELIANCE at MARKET (partial close) | RELIANCE position reduces to Qty=5. Realized P&L appears. |
| 4 | BUY 10 more RELIANCE at MARKET (average up/down) | RELIANCE position increases to Qty=15. **Avg Entry Price should be blended** — NOT the latest buy price. |
| 5 | Navigate to **Dashboard** | **CHECKPOINT 1:** Record all numbers: Day P&L, Total P&L, NAV, Available Capital |
| 6 | Navigate to **Portfolio** page | **CHECKPOINT 2:** ALL numbers must match Dashboard EXACTLY |
| 7 | Manually verify: NAV = Available Cash + Invested Value + Unrealized P&L | Write down each component and sum them. The result must equal Total NAV shown. |
| 8 | Manually verify: Total P&L = sum of all realized trade net P&L | Check the Trades/History section and sum up netPnl values. Must equal Total P&L shown. |
| 9 | SELL all remaining positions | All positions close. Capital should be close to initial ₹1,000,000 (minus trading costs ± P&L). |
| 10 | Verify final NAV | NAV = initial capital + total realized P&L. No phantom gains or losses. |

### Pass Criteria
- [ ] Blended average price is correct after averaging into a position (Step 4)
- [ ] Dashboard and Portfolio show identical numbers
- [ ] NAV identity holds: Cash + Invested + Unrealized = Total NAV
- [ ] Final NAV after closing all positions = Cash + Realized P&L
- [ ] No leftover "ghost" positions

### Fail Indicators
- Avg Entry Price = last buy price (not blended) → **BUG-018: blended avg not computed**
- Dashboard shows -₹200K but Portfolio shows +₹3K → **BUG-003/BUG-005 regression**
- NAV components don't sum to Total NAV → **BUG: investedValue calculation wrong**
- After closing all positions, Available Cash ≠ NAV → **BUG: NAV reconciliation drift**

---

## E2E-005: Session Expiry During Open Order

**Actor:** Trader → System
**Estimated Time:** 5 minutes
**Risk Level:** HIGH — orphaned orders are a financial risk

### Pre-conditions
- [ ] User is logged in
- [ ] A LIMIT order is open (SUBMITTED status, not yet filled)

### Steps

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 1 | Place a LIMIT order far from market price (won't fill) | Order in SUBMITTED state |
| 2 | Wait for session to expire (or manually clear JWT from browser storage) | |
| 3 | Try to navigate to Orders page | You should be redirected to Login page (HTTP 401) |
| 4 | Log back in | |
| 5 | Navigate to Orders page | **CHECKPOINT:** The LIMIT order should still be visible in its last known state |
| 6 | Verify you can still cancel the order | Cancel button works, order transitions to CANCELLED |

### Pass Criteria
- [ ] Session expiry redirects to login (no blank page or error)
- [ ] Orders survive session expiry (they're server-side state)
- [ ] Re-login restores full access to pending orders
- [ ] Stale orders auto-expire after 4 hours (OMS `expireStaleOrders`)

### Fail Indicators
- Page shows blank/white screen after session expiry → **BUG: no auth error handling in UI**
- Orders disappear after re-login → **BUG: order query tied to session, not user ID**
- Can't cancel the order after re-login → **BUG: IDOR or auth issue**

---

## E2E-006: End-of-Day Reconciliation

**Actor:** Trader (at 3:30 PM IST or later)
**Estimated Time:** 10 minutes
**Risk Level:** CRITICAL — books must balance

### Pre-conditions
- [ ] Multiple trades executed during the day
- [ ] At least 1 open position remaining at EOD
- [ ] Market just closed (after 3:30 PM IST)

### Steps

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 1 | Navigate to **Portfolio** page after market close | All data should still be available (not blank or "market closed") |
| 2 | Record: Available Cash, Invested Value, Unrealized P&L, Total NAV | Write these down on paper or screenshot |
| 3 | Manually calculate: Cash + Invested + Unrealized = Total NAV | **CHECKPOINT 1:** This identity must hold exactly |
| 4 | Navigate to **Trade History** / completed trades | List of all today's closed trades with entry/exit prices, qty, P&L |
| 5 | Sum up all Net P&L from closed trades | **CHECKPOINT 2:** Must equal the "Day P&L" shown on dashboard |
| 6 | Calculate: Initial Capital + Total Realized P&L - Invested Value = Cash | **CHECKPOINT 3:** Must equal the Available Cash shown |
| 7 | Wait 30 minutes | Unrealized P&L should NOT change (market is closed, no price feed) |
| 8 | Refresh the page | **CHECKPOINT 4:** All numbers identical to 30 minutes ago |

### Pass Criteria
- [ ] NAV identity: Cash + Invested + Unrealized = Total NAV (within ₹1 rounding)
- [ ] Day P&L = sum of today's realized trade P&L
- [ ] Cash balance = Initial Capital + Total Realized P&L - Invested Capital
- [ ] Numbers don't fluctuate after market close
- [ ] No "phantom" P&L changes between page refreshes

### Fail Indicators
- P&L changes by ₹50-500 on each refresh → **BUG-002 regression: holiday/after-hours LTP fluctuation**
- Available Cash doesn't reconcile → **BUG: NAV drift, needs reconcileNav**
- Day P&L ≠ sum of trades → **BUG-001: timezone boundary including yesterday's trades**
- Unrealized P&L changes after 4 PM → **BUG-097: persistUnrealizedPnl running after hours**

---

## E2E-007: Error Recovery — Broker API Down Mid-Order

**Actor:** System / Trader
**Estimated Time:** 5 minutes (simulated — only relevant for LIVE mode)
**Risk Level:** CRITICAL — partial execution is the worst case

### Pre-conditions
- [ ] System is in PAPER mode (this test documents expected behavior for LIVE mode planning)

### Steps

| # | Action | Expected Outcome |
|---|--------|-----------------|
| 1 | Place a MARKET order for 5 shares of RELIANCE | Order succeeds in paper mode (simulated execution) |
| 2 | Disconnect internet / block API endpoint (for LIVE mode testing) | In paper mode: this doesn't apply. In LIVE mode: broker API becomes unreachable. |
| 3 | Try placing another order | In paper mode: should succeed (no broker dependency). In LIVE mode: should get clear error: "Broker connection failed" or "Live broker not configured" |
| 4 | Reconnect internet | |
| 5 | Verify portfolio state | All previously placed orders should be in a consistent state (FILLED or CANCELLED, not stuck in SUBMITTED) |
| 6 | Place a new order to verify recovery | Order places successfully |

### Pass Criteria
- [ ] Paper mode orders never depend on broker API
- [ ] Clear error message when broker is unavailable (not a 500 crash)
- [ ] No orphaned orders in SUBMITTED state after recovery
- [ ] OMS `expireStaleOrders` cleans up orders stuck > 4 hours

### Fail Indicators
- 500 error with stack trace visible to user → **BUG: unhandled broker exception**
- Order stuck in SUBMITTED forever → **BUG: no retry/timeout/expiry mechanism**
- Portfolio NAV changed even though order failed → **BUG: NAV updated before fill confirmed**

---

---

# UAT Acceptance Sign-Off Checklist

## Pre-Go-Live Trader Verification

This checklist must be completed by a real trader before the system goes live with real money. Each item requires explicit sign-off.

### Section 1: Capital Safety (MUST PASS — No Exceptions)

| # | Check | Pass/Fail | Signed By | Date |
|---|-------|-----------|-----------|------|
| 1.1 | Total invested value NEVER exceeds declared initial capital | | | |
| 1.2 | Cannot place an order when available capital is insufficient (get clear error message) | | | |
| 1.3 | NAV Identity holds: Available Cash + Invested Value + Unrealized P&L = Total NAV (within ₹1) | | | |
| 1.4 | After closing ALL positions, Total NAV = Initial Capital + Total Realized P&L (within ₹10 for costs) | | | |
| 1.5 | Kill switch immediately blocks ALL new orders when activated | | | |
| 1.6 | Daily drawdown circuit breaker triggers at 2% loss and halts trading | | | |

### Section 2: P&L Accuracy (MUST PASS)

| # | Check | Pass/Fail | Signed By | Date |
|---|-------|-----------|-----------|------|
| 2.1 | Day P&L shows ₹0 before any trades are placed today | | | |
| 2.2 | Day P&L = sum of today's closed trade net P&L (manually verify with at least 3 trades) | | | |
| 2.3 | Total P&L = sum of ALL historical closed trade net P&L | | | |
| 2.4 | Day P&L does NOT change when navigating between Dashboard and Portfolio | | | |
| 2.5 | Day P&L does NOT fluctuate on market holidays or weekends | | | |
| 2.6 | Unrealized P&L is shown separately and updates with live prices | | | |
| 2.7 | A losing trade shows NEGATIVE P&L (not positive or zero) | | | |

### Section 3: Order Execution (MUST PASS)

| # | Check | Pass/Fail | Signed By | Date |
|---|-------|-----------|-----------|------|
| 3.1 | MARKET order fills within 5 seconds (paper mode) | | | |
| 3.2 | LIMIT order does NOT fill when LTP is above the limit price (for BUY) | | | |
| 3.3 | Order can be cancelled before it fills | | | |
| 3.4 | Cancelled order does NOT create a position | | | |
| 3.5 | Fill price is within 1% of LTP for MARKET orders | | | |
| 3.6 | Order is rejected with clear message when market is closed | | | |
| 3.7 | Transaction costs (brokerage, STT, etc.) are displayed on the order | | | |

### Section 4: Position Management (MUST PASS)

| # | Check | Pass/Fail | Signed By | Date |
|---|-------|-----------|-----------|------|
| 4.1 | Buying into an existing position calculates blended average price correctly | | | |
| 4.2 | Partial sell reduces position quantity (doesn't close it fully) | | | |
| 4.3 | Full sell closes the position and shows realized P&L | | | |
| 4.4 | SHORT positions show correct margin requirement (25% NSE, 10% MCX, 5% CDS) | | | |
| 4.5 | Buying to cover a SHORT position nets correctly (cover first, then open LONG with excess) | | | |

### Section 5: Risk Controls (MUST PASS)

| # | Check | Pass/Fail | Signed By | Date |
|---|-------|-----------|-----------|------|
| 5.1 | Cannot open more than 15 positions simultaneously | | | |
| 5.2 | Single position cannot exceed 5% of capital | | | |
| 5.3 | Single order cannot exceed ₹500,000 value | | | |
| 5.4 | After 5 consecutive losses, trading pauses for 30 minutes | | | |
| 5.5 | After 2% daily loss, circuit breaker halts all trading | | | |
| 5.6 | Bot/AI orders are ALWAYS blocked outside market hours (9:15-15:30 IST) | | | |

### Section 6: Data Integrity (MUST PASS)

| # | Check | Pass/Fail | Signed By | Date |
|---|-------|-----------|-----------|------|
| 6.1 | Page refresh preserves all data (no data loss) | | | |
| 6.2 | Session expiry redirects to login (no blank screen) | | | |
| 6.3 | After re-login, all orders and positions are intact | | | |
| 6.4 | Browser back/forward buttons don't corrupt portfolio state | | | |
| 6.5 | No JavaScript errors visible in browser console during normal use (F12 → Console) | | | |

### Section 7: Display & UX (SHOULD PASS)

| # | Check | Pass/Fail | Signed By | Date |
|---|-------|-----------|-----------|------|
| 7.1 | All monetary values show ₹ symbol and proper comma formatting | | | |
| 7.2 | Negative P&L is shown in RED, positive in GREEN | | | |
| 7.3 | Timestamps show IST timezone (not UTC) | | | |
| 7.4 | Market status indicator (Open/Closed/Holiday) is accurate | | | |
| 7.5 | Loading states are shown during API calls (no blank screens) | | | |

---

### Sign-Off

| Role | Name | Signature | Date | Decision |
|------|------|-----------|------|----------|
| Trader / Product Owner | | | | GO / NO-GO |
| QA Lead | | | | GO / NO-GO |
| Engineering Lead | | | | GO / NO-GO |

**Decision: The system is / is not approved for live trading.**

**Conditions (if any):**

_____________________________________________________

_____________________________________________________

_____________________________________________________
