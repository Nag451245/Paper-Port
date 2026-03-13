import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mockPrisma: any;

vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: vi.fn().mockImplementation(() => ({
    isMarketOpen: vi.fn().mockReturnValue(true),
    getMarketPhase: vi.fn().mockReturnValue('MARKET_HOURS'),
    getPhaseConfig: vi.fn().mockReturnValue({ pingIntervalMs: 60000, botTickMs: 120000, scanIntervalMs: 180000, label: 'Market Hours' }),
    getHolidayName: vi.fn().mockReturnValue(null),
    getNextMarketOpen: vi.fn().mockReturnValue({ date: new Date().toISOString(), label: 'Today' }),
    isHoliday: vi.fn().mockReturnValue(false),
    isWeekend: vi.fn().mockReturnValue(false),
    getStatus: vi.fn().mockReturnValue({ phase: 'MARKET_HOURS', phaseLabel: 'Market Hours', isOpen: true, isHoliday: false, holidayName: null, isWeekend: false, nextOpen: { date: '', label: '' }, upcomingHolidays: [], timestamp: new Date().toISOString() }),
    getUpcomingHolidays: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    breezeCredential: { findUnique: vi.fn(), upsert: vi.fn() },
    portfolio: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    position: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    order: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    trade: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    watchlist: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    watchlistItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    $disconnect: vi.fn(),
    $transaction: vi.fn().mockImplementation(async (fn: any) => fn(mock)),
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
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

describe('Trade Routes Integration', () => {
  describe('POST /api/trades/orders', () => {
    it('should place a market order', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', userId: 'test-user', currentNav: 1000000, initialCapital: 1000000 });
      mockPrisma.order.create.mockResolvedValue({
        id: 'o1', symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET', qty: 10, status: 'PENDING',
      });
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'o1', symbol: 'RELIANCE', status: 'PENDING', qty: 10, filledQty: 0 })
        .mockResolvedValueOnce({ id: 'o1', symbol: 'RELIANCE', status: 'SUBMITTED', qty: 10, filledQty: 0, avgFillPrice: null })
        .mockResolvedValueOnce({ id: 'o1', symbol: 'RELIANCE', status: 'SUBMITTED', qty: 10, filledQty: 0 })
        .mockResolvedValue({ id: 'o1', symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET', qty: 10, status: 'FILLED' });
      mockPrisma.position.findFirst.mockResolvedValue(null);
      mockPrisma.position.create.mockResolvedValue({ id: 'pos1' });
      mockPrisma.order.update.mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders(),
        payload: {
          portfolio_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          symbol: 'RELIANCE',
          side: 'BUY',
          order_type: 'MARKET',
          qty: 10,
          price: 2500,
          instrument_token: 'tok1',
        },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().status).toBe('FILLED');
    });

    it('should return 400 for missing required fields', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        headers: authHeaders(),
        payload: { symbol: 'RELIANCE' },
      });

      expect(res.statusCode).toBe(400);
    });

    it('should return 401 without auth', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/orders',
        payload: {
          portfolio_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
          symbol: 'RELIANCE',
          side: 'BUY',
          qty: 10,
        },
      });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('GET /api/trades/orders', () => {
    it('should list orders for user', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.order.findMany.mockResolvedValue([
        { id: 'o1', symbol: 'RELIANCE', status: 'FILLED' },
      ]);
      mockPrisma.order.count.mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/api/trades/orders',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().orders).toHaveLength(1);
    });
  });

  describe('DELETE /api/trades/orders/:id', () => {
    it('should cancel a pending order', async () => {
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'o1', status: 'PENDING', portfolio: { userId: 'test-user' } })
        .mockResolvedValueOnce({ id: 'o1', symbol: 'RELIANCE', status: 'PENDING' })
        .mockResolvedValue({ id: 'o1', status: 'CANCELLED' });
      mockPrisma.order.update.mockResolvedValue({ id: 'o1', status: 'CANCELLED' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/trades/orders/o1',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('CANCELLED');
    });

    it('should return 400 for non-pending order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'o1', status: 'FILLED', portfolio: { userId: 'test-user' },
      });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/trades/orders/o1',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/trades/positions', () => {
    it('should list open positions', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.position.findMany.mockResolvedValue([
        { id: 'pos1', symbol: 'RELIANCE', qty: 10, status: 'OPEN' },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/trades/positions',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    });
  });

  describe('POST /api/trades/positions/:id/close', () => {
    it('should close a position and return trade', async () => {
      mockPrisma.position.findUnique.mockResolvedValue({
        id: 'pos1', portfolioId: 'p1', symbol: 'RELIANCE', exchange: 'NSE',
        qty: 10, avgEntryPrice: 2500, side: 'LONG', status: 'OPEN',
        openedAt: new Date(), strategyTag: null, realizedPnl: 0,
        portfolio: { userId: 'test-user' },
      });
      mockPrisma.position.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.order.create.mockResolvedValue({ id: 'exit-order-1', status: 'PENDING' });
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'exit-order-1', status: 'PENDING', qty: 10, filledQty: 0 })
        .mockResolvedValueOnce({ id: 'exit-order-1', status: 'SUBMITTED', qty: 10, filledQty: 0 })
        .mockResolvedValueOnce({ id: 'exit-order-1', status: 'SUBMITTED', qty: 10, filledQty: 0 });
      mockPrisma.order.update.mockResolvedValue({});
      mockPrisma.trade.create.mockResolvedValue({
        id: 't1', grossPnl: 5000, netPnl: 4950,
      });
      mockPrisma.position.update.mockResolvedValue({});
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', currentNav: 1000000 });
      mockPrisma.portfolio.update.mockResolvedValue({});

      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/positions/pos1/close',
        headers: authHeaders(),
        payload: { exit_price: 3000 },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().success).toBe(true);
      expect(res.json().pnl).toBeDefined();
    });

    it('should return 400 for missing exit_price', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/trades/positions/pos1/close',
        headers: authHeaders(),
        payload: {},
      });

      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/trades/trades', () => {
    it('should list completed trades', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.trade.findMany.mockResolvedValue([
        { id: 't1', symbol: 'RELIANCE', netPnl: 4950 },
      ]);
      mockPrisma.trade.count.mockResolvedValue(1);

      const res = await app.inject({
        method: 'GET',
        url: '/api/trades/trades',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().trades).toHaveLength(1);
    });
  });
});
