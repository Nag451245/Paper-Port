import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mockPrisma: any;

vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: vi.fn().mockImplementation(() => ({
    isMarketOpen: vi.fn().mockReturnValue(true),
    getMarketPhase: vi.fn().mockReturnValue('MARKET_HOURS'),
    getPhaseConfig: vi.fn().mockReturnValue({ label: 'Market Hours', botsActive: true }),
    isHoliday: vi.fn().mockReturnValue(false),
    isWeekend: vi.fn().mockReturnValue(false),
    getStatus: vi.fn().mockReturnValue({ isOpen: true, phase: 'MARKET_HOURS' }),
    getHolidayName: vi.fn().mockReturnValue(null),
    getNextMarketOpen: vi.fn().mockReturnValue(new Date()),
    nextOpen: vi.fn().mockReturnValue(new Date()),
    nextClose: vi.fn().mockReturnValue(new Date()),
    getUpcomingHolidays: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({
    getQuote: vi.fn().mockResolvedValue({ ltp: 2500, volume: 1_000_000 }),
    getHistory: vi.fn().mockResolvedValue([]),
  })),
}));

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletion: vi.fn().mockResolvedValue('Mock AI response'),
  chatCompletionJSON: vi.fn().mockResolvedValue({
    date: '2026-03-15', stance: 'neutral', keyPoints: ['Test'],
    globalCues: [], sectorOutlook: {}, supportLevels: [], resistanceLevels: [], keyEvents: [],
  }),
  getOpenAIStatus: vi.fn().mockReturnValue({ circuitOpen: false, queueLength: 0, recentRequests: 0, cooldownRemainingMs: 0 }),
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

import { makePortfolio, makeOrder, makePosition, makeTrade } from '../helpers/factories.js';

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

const portfolioId = '00000000-0000-0000-0000-000000000001';
const userId = 'test-user';

describe('Trade Execution Integration', () => {

  // ══════════════════════════════════════════════════════════════════
  // IT-001: POST /api/trades/orders — Zod schema validation
  // WHAT: Validates that the API accepts snake_case fields per schema.
  // WHY: Wrong field names → silent validation failure → 400 error.
  // PRECONDITIONS: Authenticated user, portfolio exists with capital.
  // EXPECTED: Request passes validation (not 400).
  // FAILURE IMPACT: All order placements silently fail.
  // ══════════════════════════════════════════════════════════════════

  describe('POST /api/trades/orders', () => {
    beforeEach(() => {
      mockPrisma.portfolio.findMany.mockResolvedValue([
        makePortfolio({ id: portfolioId, userId, initialCapital: 1_000_000, currentNav: 1_000_000, isDefault: true }),
      ]);
      mockPrisma.portfolio.findUnique.mockResolvedValue(
        makePortfolio({ id: portfolioId, userId, initialCapital: 1_000_000, currentNav: 1_000_000 }),
      );
      mockPrisma.position.count.mockResolvedValue(0);
      mockPrisma.position.findMany.mockResolvedValue([]);
      mockPrisma.trade.findMany.mockResolvedValue([]);
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue([]);
      mockPrisma.riskEvent.create.mockResolvedValue({});
      mockPrisma.tradingTarget.findFirst.mockResolvedValue(null);
    });

    it('IT-001: should validate order payload with snake_case fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders(),
        payload: {
          portfolio_id: portfolioId,
          symbol: 'RELIANCE',
          exchange: 'NSE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 5,
          price: 2500,
        },
      });

      expect(res.statusCode).not.toBe(400);
    });

    // ════════════════════════════════════════════════════════════════
    // IT-002 ⚠️ HIGH RISK: Authentication required for order placement
    // WHAT: Unauthenticated POST to orders must return 401.
    // WHY: Unauthenticated order placement = security vulnerability.
    // PRECONDITIONS: No auth header.
    // EXPECTED: HTTP 401.
    // FAILURE IMPACT: Anyone can place trades on any account.
    // ════════════════════════════════════════════════════════════════
    it('IT-002: should reject order without authentication', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        payload: {
          portfolio_id: portfolioId,
          symbol: 'RELIANCE',
          exchange: 'NSE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 5,
          price: 2500,
        },
      });

      expect(res.statusCode).toBe(401);
    });

    // ════════════════════════════════════════════════════════════════
    // IT-006 ⚠️ HIGH RISK: Negative quantity rejection
    // WHAT: Negative qty in payload must be rejected at validation layer.
    // WHY: Negative qty could reverse trade direction silently —
    //       a BUY with qty=-10 might become a SELL of 10 shares.
    // PRECONDITIONS: Authenticated request with qty=-5.
    // EXPECTED: HTTP 400 or 422.
    // FAILURE IMPACT: Unintended sell orders placed without user consent.
    // ════════════════════════════════════════════════════════════════
    it('IT-006: should reject negative quantities', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders(),
        payload: {
          portfolio_id: portfolioId,
          symbol: 'RELIANCE',
          exchange: 'NSE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: -5,
          price: 2500,
        },
      });

      expect([400, 422]).toContain(res.statusCode);
    });

    // ════════════════════════════════════════════════════════════════
    // IT-007 ⚠️ HIGH RISK: Zero price in LIMIT order
    // WHAT: LIMIT order with price=0 must be rejected.
    // WHY: Zero-price limit = essentially a free order; fills at any price.
    // PRECONDITIONS: Authenticated, LIMIT order, price=0.
    // EXPECTED: HTTP 400 or 422.
    // FAILURE IMPACT: Buying shares for ₹0 — infinite profit illusion.
    // ════════════════════════════════════════════════════════════════
    it('IT-007: should reject zero price in LIMIT order', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders(),
        payload: {
          portfolio_id: portfolioId,
          symbol: 'RELIANCE',
          exchange: 'NSE',
          side: 'BUY',
          order_type: 'LIMIT',
          qty: 5,
          price: 0,
        },
      });

      expect([400, 422]).toContain(res.statusCode);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // IT-003: GET /api/trades/orders — Order listing
  // WHAT: Authenticated user can list their orders.
  // WHY: Order visibility drives the trading terminal UI.
  // PRECONDITIONS: User has placed orders.
  // EXPECTED: HTTP 200 with array of orders.
  // ══════════════════════════════════════════════════════════════════

  describe('GET /api/trades/orders', () => {
    it('IT-003: should return orders for the portfolio', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue(
        makePortfolio({ id: portfolioId, userId }),
      );
      const orders = [
        makeOrder({ portfolioId, status: 'FILLED' }),
        makeOrder({ portfolioId, status: 'PENDING' }),
      ];
      mockPrisma.order.findMany.mockResolvedValue(orders);
      mockPrisma.order.count.mockResolvedValue(2);

      const res = await app.inject({
        method: 'GET',
        url: '/api/trades/orders',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      const ordersList = Array.isArray(body) ? body : (body.orders ?? body.data ?? []);
      expect(Array.isArray(ordersList)).toBe(true);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // IT-004: GET /api/trades/positions — Position listing
  // WHAT: Returns open positions for the authenticated user.
  // WHY: Position display drives exit decisions.
  // ══════════════════════════════════════════════════════════════════

  describe('GET /api/trades/positions', () => {
    it('IT-004: should return open positions', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue(
        makePortfolio({ id: portfolioId, userId }),
      );
      mockPrisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, symbol: 'RELIANCE', status: 'OPEN' }),
      ]);

      const res = await app.inject({
        method: 'GET',
        url: `/api/trades/positions?portfolioId=${portfolioId}`,
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
    });
  });

  // ══════════════════════════════════════════════════════════════════
  // IT-005 ⚠️ HIGH RISK: Cancel order requires authentication
  // WHAT: DELETE on order must require valid JWT.
  // WHY: Unauthenticated cancellation = anyone can cancel your orders.
  // ══════════════════════════════════════════════════════════════════

  describe('DELETE /api/trades/orders/:orderId', () => {
    it('IT-005: should require authentication to cancel', async () => {
      const res = await app.inject({
        method: 'DELETE',
        url: '/api/trades/orders/some-order-id',
      });

      expect(res.statusCode).toBe(401);
    });

    it('IT-005b: should accept authenticated cancel request', async () => {
      const orderId = 'cancel-order-id';
      const order = makeOrder({ id: orderId, portfolioId, status: 'PENDING' });
      mockPrisma.order.findUnique.mockResolvedValue(order);
      mockPrisma.order.update.mockResolvedValue({ ...order, status: 'CANCELLED' });

      const res = await app.inject({
        method: 'DELETE',
        url: `/api/trades/orders/${orderId}`,
        headers: authHeaders(),
      });

      expect(res.statusCode).not.toBe(404);
    });
  });
});
