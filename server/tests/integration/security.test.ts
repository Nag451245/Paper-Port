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

function authHeaders(userId = 'test-user') {
  return { authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
}

describe('Security Tests', () => {

  // ══════════════════════════════════════════════════════════════════
  // IT-014 ⚠️ HIGH RISK: All protected endpoints return 401 without auth
  // WHAT: 5 protected API endpoints must reject unauthenticated requests.
  // WHY: Any unprotected endpoint is a security vulnerability.
  // PRECONDITIONS: No Authorization header.
  // EXPECTED: HTTP 401 for each endpoint.
  // FAILURE IMPACT: Unauthorized access to portfolios, orders, or risk data.
  // ══════════════════════════════════════════════════════════════════

  describe('Authentication enforcement', () => {
    const protectedEndpoints = [
      { method: 'GET' as const, url: '/api/portfolio' },
      { method: 'GET' as const, url: '/api/trades/orders' },
      { method: 'GET' as const, url: '/api/trades/positions' },
      { method: 'GET' as const, url: '/api/risk/daily-summary' },
      { method: 'GET' as const, url: '/api/ai/config' },
    ];

    it.each(protectedEndpoints)(
      'IT-014: should return 401 for $method $url without auth',
      async ({ method, url }) => {
        const res = await app.inject({ method, url });
        expect(res.statusCode).toBe(401);
      },
    );

    // ════════════════════════════════════════════════════════════════
    // IT-010 ⚠️ HIGH RISK: Expired JWT token rejection
    // WHAT: Tokens past their expiry must be rejected.
    // WHY: Stale sessions must not have trading access.
    // PRECONDITIONS: JWT with expiresIn=1 second, tested after 1.1s delay.
    // EXPECTED: HTTP 401 or 403.
    // FAILURE IMPACT: Old sessions can still place/cancel trades.
    // ════════════════════════════════════════════════════════════════
    it('IT-010: should reject expired JWT tokens', async () => {
      const expiredToken = app.jwt.sign({ sub: 'test-user' }, { expiresIn: 1 });
      await new Promise(r => setTimeout(r, 1100));

      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio',
        headers: { authorization: `Bearer ${expiredToken}` },
      });

      expect([401, 403]).toContain(res.statusCode);
    });

    // ════════════════════════════════════════════════════════════════
    // IT-011 ⚠️ HIGH RISK: Malformed JWT rejection
    // WHAT: Non-JWT strings in auth header must be rejected.
    // WHY: Token tampering must be detected immediately.
    // PRECONDITIONS: Authorization header with garbage token.
    // EXPECTED: HTTP 401.
    // FAILURE IMPACT: Bypassing authentication entirely.
    // ════════════════════════════════════════════════════════════════
    it('IT-011: should reject malformed JWT tokens', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio',
        headers: { authorization: 'Bearer not-a-real-token' },
      });

      expect(res.statusCode).toBe(401);
    });

    it('IT-011b: should reject requests with empty Authorization header', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio',
        headers: { authorization: '' },
      });

      expect(res.statusCode).toBe(401);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // IT-012 ⚠️ HIGH RISK: IDOR protection — cross-user portfolio access
  // WHAT: User A must not access User B's portfolio data.
  // WHY: In a trading app, seeing another user's positions/P&L is
  //       a serious privacy and security violation.
  // PRECONDITIONS: Portfolio belongs to 'other-user', request from 'test-user'.
  // EXPECTED: HTTP 403 or 404.
  // FAILURE IMPACT: Complete portfolio data leakage between users.
  // ══════════════════════════════════════════════════════════════════

  describe('Authorization: IDOR protection', () => {
    it('IT-012: should not allow accessing another user portfolio', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'other-portfolio',
        userId: 'other-user',
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio/other-portfolio/summary',
        headers: authHeaders('test-user'),
      });

      expect([403, 404]).toContain(res.statusCode);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // IT-008 / IT-009: Input sanitization (SQL injection / XSS)
  // WHAT: Malicious input in order fields must not cause server errors.
  // WHY: Financial applications are high-value targets for injection.
  // PRECONDITIONS: Authenticated request with malicious payloads.
  // EXPECTED: HTTP 400 (validation) or safe rejection, never 500.
  // FAILURE IMPACT: Database compromise or stored XSS in trade logs.
  // ══════════════════════════════════════════════════════════════════

  describe('Input validation', () => {
    it('IT-008: should reject SQL injection in symbol field without 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders(),
        payload: {
          portfolio_id: 'test-portfolio',
          symbol: "'; DROP TABLE orders; --",
          exchange: 'NSE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 5,
          price: 100,
        },
      });

      expect(res.statusCode).not.toBe(500);
    });

    it('IT-009: should reject XSS in string fields without 500', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders(),
        payload: {
          portfolio_id: 'test-portfolio',
          symbol: '<script>alert(1)</script>',
          exchange: 'NSE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 5,
          price: 100,
        },
      });

      expect(res.statusCode).not.toBe(500);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // IT-013: Abuse prevention — rapid-fire requests
  // WHAT: 50 concurrent requests must not cause server crashes.
  // WHY: Trading APIs experience burst traffic at market open/close.
  // PRECONDITIONS: 50 simultaneous GET requests.
  // EXPECTED: Zero 500-level responses.
  // FAILURE IMPACT: System crash during peak trading hours.
  // ══════════════════════════════════════════════════════════════════

  describe('Abuse prevention', () => {
    it('IT-013: should handle rapid-fire requests without crashing', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([]);

      const requests = Array.from({ length: 50 }, () =>
        app.inject({
          method: 'GET',
          url: '/api/portfolio',
          headers: authHeaders(),
        }),
      );

      const results = await Promise.all(requests);
      const serverErrors = results.filter(r => r.statusCode >= 500);
      expect(serverErrors).toHaveLength(0);
    });
  });

  describe('Health endpoint', () => {
    it('should be accessible without auth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/health',
      });

      expect([200, 404]).toContain(res.statusCode);
    });
  });
});
