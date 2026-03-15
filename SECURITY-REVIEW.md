# Capital Guard — Phase 6: Security Review & Pentest Checklist

## Executive Summary

Security review conducted against the Capital Guard trading application, focusing on trading-specific attack surfaces. The review analyzed git history, source code, route definitions, authentication middleware, input validation, and credential storage.

### Critical Findings (Fix Before Live Trading)

| # | Finding | Severity | Location |
|---|---------|----------|----------|
| SEC-001 | IDOR: Any authenticated user can square off any user's intraday position | **CRITICAL** | `risk.ts:97-105` |
| SEC-002 | IDOR: Any authenticated user can update any user's stop-loss | **CRITICAL** | `risk.ts:196-206` |
| SEC-003 | IDOR: `square-off-all` operates globally, not per-user | **CRITICAL** | `risk.ts:92-95` |
| SEC-004 | No 2FA for trade actions (only password-based JWT) | **HIGH** | `auth.ts`, `trades.ts` |
| SEC-005 | JWT token has 24h expiry with no rotation/revocation | **HIGH** | `config.ts:21` |
| SEC-006 | 6 risk/intraday endpoints lack Zod schema validation | **MEDIUM** | `risk.ts` |
| SEC-007 | WebSocket accepts token via query parameter (logged in URLs) | **MEDIUM** | `websocket.ts:225` |
| SEC-008 | No Content-Security-Policy in development mode | **LOW** | `app.ts:92` |

---

## 1. Authentication & Session

### 1.1 Session Token Replay

| Test | Steps | Expected | Actual | Severity |
|------|-------|----------|--------|----------|
| Replay a valid JWT after logout | 1. Login → get token 2. Use token for trades 3. "Logout" (client-side only) 4. Replay same token | Token should be invalid | **Token still works** — no server-side revocation list | **HIGH** |
| Replay token from a different IP | 1. Login from IP-A 2. Copy token 3. Use from IP-B | Should be rejected or flagged | **Token works from any IP** — JWT is not bound to IP or user-agent | **MEDIUM** |
| Use expired token | 1. Get token with 24h expiry 2. Wait 24h+ 3. Use token | 401 Unauthorized | **PASS** — `@fastify/jwt` correctly rejects expired tokens | — |

**Guard status:**
- JWT expiry: 24h (configured via `JWT_EXPIRES_IN`)
- Token revocation: **NOT IMPLEMENTED** — no blocklist/redis TTL
- IP binding: **NOT IMPLEMENTED**
- Refresh token rotation: **NOT IMPLEMENTED** — single long-lived token

**Recommendation:**
1. Reduce JWT expiry to 4 hours for trading applications
2. Implement refresh token rotation (short-lived access + long-lived refresh)
3. Add server-side token revocation via Redis blocklist on logout
4. For LIVE mode: require re-authentication for the first trade of each session

### 1.2 2FA for Trade Actions

| Test | Steps | Expected | Actual | Severity |
|------|-------|----------|--------|----------|
| Place order without 2FA | Login → Place order directly | Should require 2FA confirmation | **No 2FA exists** — orders execute with just JWT | **HIGH** |
| Modify stop-loss without 2FA | Login → Update SL | Should require confirmation | **No confirmation** | **HIGH** |

**Recommendation:**
1. Phase 1 (Paper mode): Add "Confirm Order" dialog in UI (not server-enforced)
2. Phase 2 (Live mode): Implement TOTP-based 2FA for all write operations on `/api/trades/*`
3. The `totp_secret` field already exists in `BreezeCredential` — extend it for app-level 2FA

### 1.3 JWT Expiry and Rotation

| Component | Current State | Recommendation |
|-----------|--------------|----------------|
| Access token expiry | 24 hours | Reduce to 1-4 hours |
| Refresh token | Not implemented | Add with 7-day expiry, rotating on each use |
| Token revocation on logout | Client-side only | Add Redis blocklist (`token:jti → TTL = remaining expiry`) |
| Token binding | None | Bind to IP + User-Agent hash in claims |

---

## 2. Order Integrity

### 2.1 IDOR — Insecure Direct Object Reference

| Test | Endpoint | Steps | Expected | Actual | Severity |
|------|----------|-------|----------|--------|----------|
| SEC-001: Square off another user's position | `POST /api/risk/intraday/square-off/:positionId` | 1. User A has position P1 2. User B sends POST with P1's ID | 403 or 404 | **Position is squared off** — no ownership check | **CRITICAL** |
| SEC-002: Update another user's stop-loss | `POST /api/risk/stop-loss/update` | 1. User A has position 2. User B sends update with position ID | 403 or 404 | **Stop-loss is modified** — no ownership check | **CRITICAL** |
| SEC-003: Square off all positions | `POST /api/risk/intraday/square-off-all` | 1. Any authenticated user calls endpoint | Should only affect caller's positions | **Affects ALL users' positions** | **CRITICAL** |
| Access another user's portfolio summary | `GET /api/portfolio/:id/summary` | Use another user's portfolio ID | 403 or 404 | **PASS** — `getById` checks `userId` | — |
| Cancel another user's order | `DELETE /api/trades/orders/:id` | Use another user's order ID | 403 or 404 | Needs verification — cancel logic should check ownership | **MEDIUM** |

**Recommendation:**
1. Add `getUserId(request)` ownership check to ALL risk/intraday endpoints
2. `square-off-all` must filter by `userId` from JWT
3. `stop-loss/update` must verify position belongs to requesting user
4. Add IDOR regression tests for every write endpoint

### 2.2 Parameter Tampering

| Test | Steps | Expected | Actual | Severity |
|------|-------|----------|--------|----------|
| Negative quantity in order | Send `qty: -100` | 400 validation error | **PASS** — Zod schema enforces `z.number().int().positive()` | — |
| Zero price in LIMIT order | Send `price: 0` | 400 validation error | **PASS** — Zod enforces `z.number().positive()` | — |
| Extremely large quantity | Send `qty: 999999999` | Blocked by risk rules | **PASS** — `maxOrderValue` and `maxPositionPct` cap this | — |
| Invalid exchange code | Send `exchange: 'FAKE'` | 400 validation error | **PASS** — Zod enum restricts to `['NSE','BSE','NFO','MCX','CDS']` | — |
| Invalid side | Send `side: 'SHORT'` | 400 validation error | **PASS** — Zod enum restricts to `['BUY','SELL']` | — |
| Decimal quantity | Send `qty: 5.5` | 400 validation error | **PASS** — Zod enforces `z.number().int()` | — |
| Non-UUID portfolio_id | Send `portfolio_id: 'abc'` | 400 validation error | **PASS** — Zod enforces `z.string().uuid()` | — |

### 2.3 Server-Side vs Client-Side Validation

| Check | Status |
|-------|--------|
| All order parameters validated server-side (Zod) | **YES** — `placeOrderSchema` in `trades.ts` |
| Price/qty validated for sign and type | **YES** — positive integers/numbers |
| Exchange code restricted to enum | **YES** |
| Portfolio ownership verified server-side | **YES** — `getById` checks `userId` |
| Risk limits enforced server-side | **YES** — `preTradeCheck` in `risk.service.ts` |
| Kill switch enforced server-side | **YES** — `isKillSwitchActive()` in `trade.service.ts` |
| Market hours enforced server-side | **YES** — `calendar.isMarketOpen()` check |

---

## 3. API Security

### 3.1 Broker API Key Storage

| Check | Status | Details |
|-------|--------|---------|
| Keys stored encrypted in DB | **YES** | AES-256-CBC with IV, stored as `encryptedApiKey` in `breeze_credentials` table |
| Encryption key separate from DB | **YES** | `ENCRYPTION_KEY` in environment variable, min 16 chars enforced by Zod |
| `.env` excluded from git | **YES** | `.gitignore` includes `.env`, `.dockerignore` includes `.env` |
| `.env.example` has no real values | **YES** | Template values only (empty strings) |
| API keys in `config.ts` have defaults | **CONCERN** | `BREEZE_API_KEY` defaults to `''` — won't fail loudly if missing in LIVE mode |
| Key rotation mechanism | **NO** | No automatic rotation; manual re-credential via `/api/auth/breeze-credentials` |

**Recommendation:**
1. In LIVE mode, require non-empty `BREEZE_API_KEY` (fail fast on startup)
2. Implement key rotation alert: notify when credentials are >90 days old
3. Log all credential access (read/decrypt) events for audit

### 3.2 Rate Limiting

| Endpoint | Limit | Adequate? |
|----------|-------|-----------|
| Global | 5000/min per user (JWT sub) or IP | Adequate for current scale |
| `/api/auth/login` | 20/min | Good — prevents brute force |
| `/api/auth/register` | 20/min | Good |
| `/api/trades/orders` (POST) | Inherits global 5000/min | **TOO HIGH** — a compromised account could place 5000 orders/min. Recommend 60/min for order placement. |
| WebSocket connections | No limit | **CONCERN** — a single user could open hundreds of WebSocket connections |

**Recommendation:**
1. Add per-endpoint rate limit for trade actions: 60/min for order placement
2. Limit WebSocket connections to 5 per user
3. Add rate limit headers (`X-RateLimit-Remaining`) to trade responses

### 3.3 WebSocket Security

| Check | Status | Details |
|-------|--------|---------|
| WebSocket requires authentication | **YES** | JWT verified via `Authorization` header or `?token=` query param |
| Unauthenticated connections closed | **YES** | `socket.close(4401, 'Unauthorized')` |
| Per-message validation | **NO** | Messages from clients are not schema-validated |
| Message size limit | **NO** | No explicit max message size; vulnerable to large payload attacks |
| Token in URL parameter | **CONCERN** | `?token=` leaks JWT in server access logs, browser history, and referrer headers |

**Recommendation:**
1. Prefer `Authorization` header for WebSocket auth; deprecate `?token=` parameter
2. Add message size limit (e.g., 8 KB max)
3. Validate incoming WebSocket messages against a schema (type, payload structure)

---

## 4. Data Exposure

### 4.1 User Enumeration

| Test | Steps | Expected | Actual | Severity |
|------|-------|----------|--------|----------|
| Enumerate users via registration | Register with existing email | Generic error | Needs check — likely returns "Email already exists" revealing valid emails | **MEDIUM** |
| Enumerate via login | Login with wrong password | Generic "Invalid credentials" | **PASS** — returns generic error | — |
| List all users | No admin endpoint exists | Not possible | **PASS** — no user listing endpoint | — |

### 4.2 Data Encryption

| Data | At Rest | In Transit |
|------|---------|------------|
| Passwords | **bcrypt hashed** | HTTPS (depends on deployment) |
| Broker API keys | **AES-256-CBC encrypted** | HTTPS |
| Trade data (P&L, positions) | **Plaintext in PostgreSQL** | HTTPS |
| JWT tokens | N/A (stateless) | HTTPS |

**Recommendation:**
1. Enable PostgreSQL TDE (Transparent Data Encryption) or use Supabase's encryption features for trade data
2. Ensure all production deployments use HTTPS (TLS 1.2+)

### 4.3 Error Message Leakage

| Check | Status | Details |
|-------|--------|---------|
| 500 errors hide internal details | **YES** | Error handler returns `"Internal server error"` for 5xx |
| Stack traces not exposed | **YES** | Only logged server-side via `app.log.error(error)` |
| SQL errors not exposed | **YES** | Prisma errors caught, generic message returned |
| File paths not exposed | **YES** | No path information in error responses |

---

## 5. Injection & Input Validation

### 5.1 SQL Injection

| Test | Target | Method | Result | Severity |
|------|--------|--------|--------|----------|
| Symbol field: `'; DROP TABLE orders; --` | `POST /api/trades/orders` | Parameter injection | **SAFE** — Prisma uses parameterized queries | — |
| Portfolio ID: `1 OR 1=1` | `GET /api/portfolio/:id` | UUID injection | **SAFE** — Zod validates UUID format | — |
| Order filter: `status=FILLED' OR '1'='1` | `GET /api/trades/orders` | Query injection | **SAFE** — Prisma parameterized | — |

**Assessment:** SQL injection risk is **LOW** because Prisma ORM uses parameterized queries throughout. No raw SQL is used in route handlers (only `$queryRaw` in health check which uses a constant query).

### 5.2 Numeric Financial Input Validation

| Input | Validation | Status |
|-------|-----------|--------|
| `qty` | `z.number().int().positive()` | **PASS** — rejects negative, zero, decimal |
| `price` | `z.number().positive().optional()` | **PASS** — rejects negative, zero |
| `trigger_price` | `z.number().positive().optional()` | **PASS** |
| `exit_price` | `z.number().positive()` | **PASS** |
| `strike` | `z.number().positive().optional()` | **PASS** |

**Gap:** Risk route inputs (`/api/risk/intraday/*`) use `request.body as any` without Zod validation. A malicious request could pass non-numeric values for financial fields.

---

## OWASP Top 10 Mapping

| # | OWASP Category | Capital Guard Status | Risk | Action Required |
|---|---------------|---------------------|------|-----------------|
| A01:2021 | **Broken Access Control** | **3 CRITICAL IDORs** in risk routes | **CRITICAL** | Fix SEC-001, SEC-002, SEC-003 immediately |
| A02:2021 | **Cryptographic Failures** | AES-256-CBC for secrets, bcrypt for passwords | **LOW** | Consider upgrading AES-CBC to AES-GCM (authenticated encryption) |
| A03:2021 | **Injection** | Prisma parameterized queries throughout | **LOW** | No action |
| A04:2021 | **Insecure Design** | No 2FA for trading, 24h token expiry | **HIGH** | Implement 2FA for LIVE mode, reduce token expiry |
| A05:2021 | **Security Misconfiguration** | CSP only in production, no WS message limit | **MEDIUM** | Enable CSP in dev, add WS message size limit |
| A06:2021 | **Vulnerable Components** | 7 npm vulnerabilities fixed (b4876ec) | **LOW** | Run `npm audit` regularly |
| A07:2021 | **Identity & Auth Failures** | No token revocation, no IP binding | **MEDIUM** | Implement refresh token rotation |
| A08:2021 | **Software & Data Integrity** | No CSP/SRI for frontend assets | **LOW** | Add SRI hashes in production |
| A09:2021 | **Security Logging Failures** | Trade actions logged, no credential access audit | **MEDIUM** | Add audit logging for credential decrypt events |
| A10:2021 | **Server-Side Request Forgery** | Breeze bridge URL from env, not user input | **LOW** | No action |

---

## Manual Pentest Steps

### PENTEST-001: IDOR on Position Square-Off (CRITICAL)

**Steps:**
1. Create User A with portfolio P-A and open position POS-A
2. Create User B with portfolio P-B
3. Login as User B → get JWT token
4. Send: `POST /api/risk/intraday/square-off/POS-A` with User B's JWT
5. **Expected:** 403 Forbidden or 404 Not Found
6. **Actual (predicted):** Position POS-A is squared off by User B

**Impact:** Any authenticated user can close any other user's positions, causing direct financial harm.

### PENTEST-002: IDOR on Stop-Loss Update (CRITICAL)

**Steps:**
1. User A has position POS-A with SL at ₹2,450
2. Login as User B
3. Send: `POST /api/risk/stop-loss/update` with `{ positionId: POS-A, newStopLoss: 0.01 }`
4. **Expected:** 403 Forbidden
5. **Actual (predicted):** User A's stop-loss is changed to ₹0.01, effectively removing it

**Impact:** Attacker removes another user's stop-loss protection, exposing them to unlimited losses.

### PENTEST-003: Global Square-Off (CRITICAL)

**Steps:**
1. Multiple users have open intraday positions
2. Any user sends: `POST /api/risk/intraday/square-off-all`
3. **Expected:** Only caller's positions are squared off
4. **Actual (predicted):** ALL users' intraday positions are squared off

**Impact:** A single user can force-liquidate every user in the system.

### PENTEST-004: JWT Token Replay After "Logout"

**Steps:**
1. Login → get JWT token T1
2. Click "Logout" in the UI (which only clears client-side storage)
3. Use T1 to `POST /api/trades/orders`
4. **Expected:** 401 Unauthorized
5. **Actual:** Order is placed successfully — token is still valid

### PENTEST-005: WebSocket Token Leakage

**Steps:**
1. Connect to `ws://host/ws?token=eyJ...`
2. Check server access logs
3. Check browser history
4. **Expected:** Token not visible in any log
5. **Actual:** Token visible in query string in access logs and browser history

### PENTEST-006: Order Placement Rate Abuse

**Steps:**
1. Login → get JWT token
2. Script: place 1000 orders in 60 seconds
3. **Expected:** Rate limited after ~60 orders
4. **Actual:** All 1000 orders accepted (5000/min global limit applies to ALL endpoints)

---

## Severity Ratings and Mitigations

| ID | Finding | Severity | Mitigation | Priority |
|----|---------|----------|------------|----------|
| SEC-001 | IDOR: square-off any position | **CRITICAL** | Add `getUserId(request)` check, verify position.portfolio.userId matches | P0 — Fix before ANY user testing |
| SEC-002 | IDOR: modify any stop-loss | **CRITICAL** | Same ownership check | P0 |
| SEC-003 | Global square-off without user scoping | **CRITICAL** | Filter `WHERE userId = ?` | P0 |
| SEC-004 | No 2FA for trade execution | **HIGH** | Implement TOTP for LIVE mode | P1 — Before live trading |
| SEC-005 | 24h JWT with no revocation | **HIGH** | Reduce to 4h, add Redis revocation list | P1 |
| SEC-006 | Risk routes lack input validation | **MEDIUM** | Add Zod schemas to all 6 endpoints | P2 |
| SEC-007 | WS token in URL query param | **MEDIUM** | Deprecate `?token=`, use header only | P2 |
| SEC-008 | No CSP in development | **LOW** | Enable basic CSP in dev mode | P3 |
| SEC-009 | No WS message size limit | **LOW** | Add `maxPayload: 8192` to WS config | P3 |
| SEC-010 | No WS connection limit per user | **MEDIUM** | Track and limit to 5 connections per userId | P2 |
| SEC-011 | Order rate limit too permissive | **MEDIUM** | Add 60/min limit on POST /api/trades/orders | P2 |
| SEC-012 | No credential access audit log | **MEDIUM** | Log decrypt events for BreezeCredential | P2 |
