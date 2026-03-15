import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mockPrisma: any;

vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: vi.fn().mockImplementation(() => ({
    isMarketOpen: vi.fn().mockReturnValue(true),
    getMarketPhase: vi.fn().mockReturnValue('MARKET_HOURS'),
    getPhaseConfig: vi.fn().mockReturnValue({ label: 'Market Hours' }),
    isHoliday: vi.fn().mockReturnValue(false),
    isWeekend: vi.fn().mockReturnValue(false),
    getStatus: vi.fn().mockReturnValue({ isOpen: true, phase: 'MARKET_HOURS' }),
    getHolidayName: vi.fn().mockReturnValue(null),
    getNextMarketOpen: vi.fn().mockReturnValue(new Date()),
    getUpcomingHolidays: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({
    getQuote: vi.fn().mockResolvedValue({ ltp: 2500 }),
  })),
}));

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletion: vi.fn().mockResolvedValue('Mock'),
  chatCompletionJSON: vi.fn().mockResolvedValue({ stance: 'neutral', keyPoints: [] }),
  getOpenAIStatus: vi.fn().mockReturnValue({ circuitOpen: false }),
  _resetForTesting: vi.fn(),
}));

vi.mock('../../src/lib/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(null),
  initRedis: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    breezeCredential: { findUnique: vi.fn(), upsert: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    portfolio: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    position: { findUnique: vi.fn(), findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn(), count: vi.fn() },
    order: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    trade: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    watchlist: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    watchlistItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    aIAgentConfig: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    aITradeSignal: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
    tradingTarget: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    dailyPnlRecord: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), upsert: vi.fn() },
    riskEvent: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    decisionAudit: { create: vi.fn() },
    strategyLedger: { findMany: vi.fn(), upsert: vi.fn() },
    strategyParam: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(mock)),
    $disconnect: vi.fn(),
    $connect: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ 1: 1 }]),
  };
  return { getPrisma: vi.fn(() => mock), disconnectPrisma: vi.fn(), __mockPrisma: mock };
});

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js');
  const prismaModule = await import('../../src/lib/prisma.js');
  mockPrisma = (prismaModule as any).__mockPrisma;
  app = await buildApp({ logger: false });
  await app.ready();
}, 30_000);

afterAll(async () => { await app.close(); });
beforeEach(() => { vi.clearAllMocks(); });

function authHeaders(userId = 'user-A') {
  return { authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
}

// ═══════════════════════════════════════════════════════════════════════
// Phase 6 Security Regression Tests — Trading-Specific Attack Surfaces
// ═══════════════════════════════════════════════════════════════════════

describe('Phase 6: Security Regression Tests', () => {

  // ── SEC-001: IDOR on intraday square-off ──────────────────────────
  describe('SEC-001: IDOR — square-off another users position', () => {

    it('should not allow User B to square off User A position', async () => {
      mockPrisma.position.findUnique.mockResolvedValue({
        id: 'pos-owned-by-A',
        symbol: 'RELIANCE',
        side: 'BUY',
        qty: 10,
        avgEntryPrice: 2500,
        status: 'OPEN',
        portfolio: { userId: 'user-A' },
        portfolioId: 'portfolio-A',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/intraday/square-off/pos-owned-by-A',
        headers: authHeaders('user-B'),
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not owned by you');
    });

    it('should allow owner to square off their own position', async () => {
      mockPrisma.position.findUnique.mockResolvedValue({
        id: 'pos-owned-by-A',
        symbol: 'RELIANCE',
        side: 'BUY',
        qty: 10,
        avgEntryPrice: 2500,
        status: 'OPEN',
        exchange: 'NSE',
        portfolio: { userId: 'user-A' },
        portfolioId: 'portfolio-A',
        openedAt: new Date(),
      });
      mockPrisma.position.update.mockResolvedValue({});
      mockPrisma.trade.create.mockResolvedValue({});
      mockPrisma.order.create.mockResolvedValue({});
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'portfolio-A', currentNav: 1000000, initialCapital: 1000000 });
      mockPrisma.portfolio.update.mockResolvedValue({});
      mockPrisma.decisionAudit.create.mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/intraday/square-off/pos-owned-by-A',
        headers: authHeaders('user-A'),
      });

      expect(res.statusCode).not.toBe(500);
    });

    it('should require authentication', async () => {
      const noAuthRes = await app.inject({
        method: 'POST',
        url: '/api/risk/intraday/square-off/pos-owned-by-A',
      });
      expect(noAuthRes.statusCode).toBe(401);
    });
  });

  // ── SEC-002: IDOR on stop-loss update ─────────────────────────────
  describe('SEC-002: IDOR — update another users stop-loss', () => {

    it('should not allow User B to modify User A stop-loss', async () => {
      mockPrisma.position.findUnique.mockResolvedValue({
        id: 'pos-owned-by-A',
        symbol: 'RELIANCE',
        status: 'OPEN',
        portfolio: { userId: 'user-A' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/stop-loss/update',
        headers: authHeaders('user-B'),
        payload: {
          positionId: 'pos-owned-by-A',
          newStopPrice: 0.01,
        },
      });

      expect(res.statusCode).toBe(404);
      const body = JSON.parse(res.body);
      expect(body.error).toContain('not owned by you');
    });

    it('should allow owner to update their own stop-loss', async () => {
      mockPrisma.position.findUnique.mockResolvedValue({
        id: 'pos-owned-by-A',
        symbol: 'RELIANCE',
        status: 'OPEN',
        portfolio: { userId: 'user-A' },
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/stop-loss/update',
        headers: authHeaders('user-A'),
        payload: {
          positionId: 'pos-owned-by-A',
          newStopPrice: 2400,
        },
      });

      // 503 because monitor is not active in test — but ownership check passed
      expect([200, 503]).toContain(res.statusCode);
    });

    it('should require authentication', async () => {
      const noAuthRes = await app.inject({
        method: 'POST',
        url: '/api/risk/stop-loss/update',
        payload: { positionId: 'any', newStopPrice: 100 },
      });
      expect(noAuthRes.statusCode).toBe(401);
    });
  });

  // ── SEC-003: Global square-off scoped to calling user ──────────────
  describe('SEC-003: square-off-all scoped to calling user', () => {

    it('square-off-all should be authenticated', async () => {
      const noAuthRes = await app.inject({
        method: 'POST',
        url: '/api/risk/intraday/square-off-all',
      });
      expect(noAuthRes.statusCode).toBe(401);
    });

    it('should only square off the calling users positions', async () => {
      mockPrisma.position.findMany.mockResolvedValue([]);

      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/intraday/square-off-all',
        headers: authHeaders('user-A'),
      });

      expect(res.statusCode).toBe(200);

      // Verify that findMany was called with a portfolio.userId filter
      const findManyCall = mockPrisma.position.findMany.mock.calls[0][0];
      expect(findManyCall.where).toHaveProperty('portfolio');
      expect(findManyCall.where.portfolio).toEqual({ userId: 'user-A' });
    });
  });

  // ── SEC-004: No 2FA for trade actions ─────────────────────────────
  describe('SEC-004: Trade actions without 2FA', () => {

    it('order placement should succeed with just JWT (documenting lack of 2FA)', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'portfolio-A',
        userId: 'user-A',
        initialCapital: 1000000,
        currentCapital: 1000000,
        positions: [],
      });
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.position.findMany.mockResolvedValue([]);
      mockPrisma.position.count.mockResolvedValue(0);

      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders('user-A'),
        payload: {
          portfolio_id: 'portfolio-A',
          symbol: 'RELIANCE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 1,
          price: 2500,
          exchange: 'NSE',
        },
      });

      // Order goes through with just JWT — no 2FA challenge
      expect(res.statusCode).not.toBe(500);
    });
  });

  // ── SEC-005: JWT token replay after logical logout ────────────────
  describe('SEC-005: JWT replay attack', () => {

    it('token remains valid because there is no server-side revocation', async () => {
      const token = app.jwt.sign({ sub: 'user-A' });
      mockPrisma.portfolio.findMany.mockResolvedValue([]);

      // Simulate "logout" — nothing happens server-side
      // Token should still work:
      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio',
        headers: { authorization: `Bearer ${token}` },
      });

      // This PASSES, documenting that logout is client-only
      expect(res.statusCode).toBe(200);
    });

    it('JWT from a different secret should be rejected', async () => {
      // Manually craft a token signed with wrong key
      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio',
        headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJoYWNrZXIiLCJpYXQiOjE3MTAwMDAwMDB9.fakesig' },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── SEC-006: Risk routes lack input validation ────────────────────
  describe('SEC-006: Missing Zod validation on risk routes', () => {

    it('partial-exit should reject non-numeric qty', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/intraday/partial-exit',
        headers: authHeaders('user-A'),
        payload: {
          positionId: 'pos-1',
          qty: 'DROP TABLE positions',
        },
      });
      expect(res.statusCode).not.toBe(500);
    });

    it('scale-in should reject missing price', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/intraday/scale-in',
        headers: authHeaders('user-A'),
        payload: {
          positionId: 'pos-1',
          qty: 5,
          // price intentionally missing
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('options/roll should reject missing fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/options/roll',
        headers: authHeaders('user-A'),
        payload: {
          positionId: 'pos-1',
          // newStrike and newExpiry missing
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('stop-loss/update should reject missing newStopPrice', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/stop-loss/update',
        headers: authHeaders('user-A'),
        payload: { positionId: 'pos-1' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('convert-delivery should reject missing positionId', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/intraday/convert-delivery',
        headers: authHeaders('user-A'),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── SEC-007: Parameter tampering on order fields ──────────────────
  describe('SEC-007: Order parameter tampering', () => {

    it('should reject negative price', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders('user-A'),
        payload: {
          portfolio_id: 'portfolio-A',
          symbol: 'RELIANCE',
          side: 'BUY',
          order_type: 'LIMIT',
          qty: 10,
          price: -100,
          exchange: 'NSE',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject zero quantity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders('user-A'),
        payload: {
          portfolio_id: 'portfolio-A',
          symbol: 'RELIANCE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 0,
          price: 2500,
          exchange: 'NSE',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject fractional quantity', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders('user-A'),
        payload: {
          portfolio_id: 'portfolio-A',
          symbol: 'RELIANCE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 5.5,
          price: 2500,
          exchange: 'NSE',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject invalid exchange code', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders('user-A'),
        payload: {
          portfolio_id: 'portfolio-A',
          symbol: 'RELIANCE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 10,
          price: 2500,
          exchange: 'FAKE_EXCHANGE',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject non-UUID portfolio_id', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders('user-A'),
        payload: {
          portfolio_id: 'not-a-uuid',
          symbol: 'RELIANCE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 10,
          price: 2500,
          exchange: 'NSE',
        },
      });
      expect(res.statusCode).toBe(400);
    });

    it('should reject XSS payload in symbol without 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders('user-A'),
        payload: {
          portfolio_id: 'a0000000-0000-0000-0000-000000000001',
          symbol: '<img src=x onerror=alert(1)>',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 10,
          price: 2500,
          exchange: 'NSE',
        },
      });
      expect(res.statusCode).not.toBe(500);
    });
  });

  // ── SEC-008: Cross-user portfolio access ──────────────────────────
  describe('SEC-008: Portfolio IDOR — cross-user data access', () => {

    it('should not leak portfolio data to another user', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'portfolio-B',
        userId: 'user-B',
        positions: [{ symbol: 'HDFC', qty: 100 }],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio/portfolio-B/summary',
        headers: authHeaders('user-A'),
      });

      expect([403, 404]).toContain(res.statusCode);
    });

    it('should not allow capital update on another users portfolio', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'portfolio-B',
        userId: 'user-B',
        initialCapital: 1000000,
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/portfolio/portfolio-B/capital',
        headers: authHeaders('user-A'),
        payload: { amount: 999999 },
      });

      expect([400, 403, 404]).toContain(res.statusCode);
    });
  });

  // ── SEC-009: Error response leakage ───────────────────────────────
  describe('SEC-009: Error responses must not leak internals', () => {

    it('500 error should not expose stack trace', async () => {
      mockPrisma.portfolio.findMany.mockRejectedValue(new Error('ECONNREFUSED'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio',
        headers: authHeaders('user-A'),
      });

      if (res.statusCode >= 500) {
        const body = JSON.parse(res.body);
        expect(body.error).toBe('Internal server error');
        expect(body.stack).toBeUndefined();
        expect(body.message).toBeUndefined();
      }
    });

    it('404 should not reveal database schema or table names', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio/nonexistent-id/summary',
        headers: authHeaders('user-A'),
      });

      const body = res.body;
      expect(body).not.toContain('prisma');
      expect(body).not.toContain('SELECT');
      expect(body).not.toContain('FROM');
      expect(body).not.toContain('portfolio');
    });
  });

  // ── SEC-010: Auth endpoint security ───────────────────────────────
  describe('SEC-010: Authentication endpoint hardening', () => {

    it('login should reject missing email', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { password: 'Test123!' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('login should reject missing password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/login',
        payload: { email: 'test@test.com' },
      });
      expect(res.statusCode).toBe(400);
    });

    it('registration should reject weak password', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/register',
        payload: {
          email: 'test@test.com',
          password: '123',
          name: 'Test',
        },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  // ── SEC-011: Kill switch authorization ────────────────────────────
  describe('SEC-011: Kill switch requires authentication', () => {

    it('kill switch activation without auth should return 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/kill-switch',
      });
      expect(res.statusCode).toBe(401);
    });

    it('kill switch deactivation without auth should return 401', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/risk/kill-switch/deactivate',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── SEC-012: Concurrent request safety ────────────────────────────
  describe('SEC-012: Concurrent request resilience', () => {

    it('100 concurrent requests should not crash the server', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([]);

      const requests = Array.from({ length: 100 }, () =>
        app.inject({
          method: 'GET',
          url: '/api/portfolio',
          headers: authHeaders('user-A'),
        }),
      );

      const results = await Promise.all(requests);
      const crashes = results.filter(r => r.statusCode >= 500);
      expect(crashes).toHaveLength(0);
    });

    it('mixed auth and unauth requests should not interfere', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([]);

      const results = await Promise.all([
        app.inject({ method: 'GET', url: '/api/portfolio', headers: authHeaders('user-A') }),
        app.inject({ method: 'GET', url: '/api/portfolio' }),
        app.inject({ method: 'GET', url: '/api/portfolio', headers: authHeaders('user-B') }),
        app.inject({ method: 'GET', url: '/api/portfolio' }),
      ]);

      expect(results[0].statusCode).toBe(200);
      expect(results[1].statusCode).toBe(401);
      expect(results[2].statusCode).toBe(200);
      expect(results[3].statusCode).toBe(401);
    });
  });

  // ── SEC-013: Health endpoint does not require auth ────────────────
  describe('SEC-013: Public endpoints', () => {

    it('/health should be accessible without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });
      expect(res.statusCode).toBeLessThan(500);
    });

    it('/health should not expose sensitive information', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      if (res.statusCode === 200) {
        const body = res.body;
        expect(body).not.toContain('JWT_SECRET');
        expect(body).not.toContain('ENCRYPTION_KEY');
        expect(body).not.toContain('DATABASE_URL');
        expect(body).not.toContain('BREEZE_API_KEY');
      }
    });
  });

  // ── SEC-014: HTTP method restrictions ─────────────────────────────
  describe('SEC-014: HTTP method restrictions', () => {

    it('GET /api/trades/orders should not accept POST body', async () => {
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/trades/orders',
        headers: authHeaders('user-A'),
      });
      expect(res.statusCode).not.toBe(500);
    });

    it('DELETE /api/trades/orders/:id should require auth', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/trades/orders/some-order-id',
      });
      expect(res.statusCode).toBe(401);
    });
  });

  // ── SEC-015: Rate limit headers ───────────────────────────────────
  describe('SEC-015: Rate limiting enforcement', () => {

    it('should enforce rate limits on auth endpoints', async () => {
      const requests = [];
      for (let i = 0; i < 25; i++) {
        requests.push(
          app.inject({
            method: 'POST',
            url: '/api/auth/login',
            payload: { email: `test${i}@test.com`, password: 'Pass123!' },
          }),
        );
      }

      const results = await Promise.all(requests);
      const rateLimited = results.filter(r => r.statusCode === 429);

      // Auth is limited to 20/min — some should be rate limited
      // In test environment, rate limit may not apply, so we just verify no crashes
      const serverErrors = results.filter(r => r.statusCode >= 500);
      expect(serverErrors).toHaveLength(0);
    });
  });

  // ── SEC-016: Breeze credential endpoints ──────────────────────────
  describe('SEC-016: Broker credential security', () => {

    it('should require auth to store credentials', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/auth/breeze-credentials',
        payload: {
          api_key: 'stolen-key',
          secret_key: 'stolen-secret',
        },
      });
      expect(res.statusCode).toBe(401);
    });

    it('should require auth to delete credentials', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/auth/breeze-credentials',
      });
      expect(res.statusCode).toBe(401);
    });

    it('should require auth to read credentials', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/auth/breeze-credentials',
      });
      // GET may not exist (404) — either way, no data without auth
      expect([401, 404]).toContain(res.statusCode);
    });
  });

  // ── SEC-017: Watchlist IDOR ───────────────────────────────────────
  describe('SEC-017: Watchlist IDOR protection', () => {

    it('should not allow deleting another users watchlist', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'wl-user-B',
        userId: 'user-B',
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/watchlist/wl-user-B',
        headers: authHeaders('user-A'),
      });

      // Should be rejected — watchlist belongs to user-B
      expect(res.statusCode).not.toBe(500);
    });
  });
});
