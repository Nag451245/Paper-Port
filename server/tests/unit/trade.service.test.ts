import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: vi.fn().mockImplementation(function () { return {
    isMarketOpen: vi.fn().mockReturnValue(true),
  }; }),
}));

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(function () { return {
    getQuote: vi.fn().mockResolvedValue({ ltp: 2500 }),
  }; }),
}));

import { TradeService, TradeError } from '../../src/services/trade.service.js';

function createMockPrisma() {
  const prisma: any = {
    portfolio: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
    },
    order: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      count: vi.fn(),
    },
    position: {
      create: vi.fn(),
      findFirst: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      update: vi.fn(),
      updateMany: vi.fn(),
      count: vi.fn(),
    },
    trade: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(prisma)),
    dailyPnlRecord: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), findMany: vi.fn() },
    riskEvent: { create: vi.fn() },
    // The risk gate now fails CLOSED, so the models it reads must be mocked or
    // every order is rejected. Previously the gate swallowed the resulting
    // TypeError and let the order through — these tests passed *because* the
    // safety check was broken.
    tradingTarget: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn(), updateMany: vi.fn() },
    strategyParam: { findFirst: vi.fn(), findMany: vi.fn(), upsert: vi.fn() },
  };
  return prisma;
}

/**
 * Give the risk gate enough to evaluate cleanly and allow the order.
 * No active trading target => enforceTargetRisk returns allowed early;
 * empty positions/trades => preTradeCheck finds no violations.
 */
function allowRiskChecks(prisma: any): void {
  prisma.tradingTarget.findFirst.mockResolvedValue(null);
  prisma.position.count.mockResolvedValue(0);
  prisma.position.findMany.mockResolvedValue([]);
  prisma.portfolio.findMany.mockResolvedValue([
    { id: 'p1', userId: 'user1', initialCapital: 1_000_000, currentNav: 1_000_000, isDefault: true },
  ]);
  prisma.trade.findMany.mockResolvedValue([]);
  prisma.dailyPnlRecord.findMany.mockResolvedValue([]);
  prisma.riskEvent.create.mockResolvedValue({});
  prisma.strategyParam.findFirst.mockResolvedValue(null);
}

describe('TradeService', () => {
  let service: TradeService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    allowRiskChecks(mockPrisma);
    service = new TradeService(mockPrisma);
  });

  describe('placeOrder', () => {
    it('should place a MARKET buy order and create position', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', userId: 'user1', currentNav: 1000000, initialCapital: 1000000 });
      mockPrisma.order.create.mockResolvedValue({
        id: 'order-1',
        symbol: 'RELIANCE',
        side: 'BUY',
        orderType: 'MARKET',
        qty: 10,
        status: 'PENDING',
      });
      // OMS calls findUnique multiple times during state transitions:
      // 1. submitOrder → transition reads current state (PENDING)
      // 2. recordFill reads order for qty info (SUBMITTED)
      // 3. recordFill → transition reads current state (SUBMITTED)
      // 4. final re-read after all OMS transitions (FILLED)
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-1', symbol: 'RELIANCE', status: 'PENDING', qty: 10, filledQty: 0 })
        .mockResolvedValueOnce({ id: 'order-1', symbol: 'RELIANCE', status: 'SUBMITTED', qty: 10, filledQty: 0, avgFillPrice: null })
        .mockResolvedValueOnce({ id: 'order-1', symbol: 'RELIANCE', status: 'SUBMITTED', qty: 10, filledQty: 0 })
        .mockResolvedValue({ id: 'order-1', symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET', qty: 10, status: 'FILLED' });
      mockPrisma.position.findFirst.mockResolvedValue(null);
      mockPrisma.position.create.mockResolvedValue({
        id: 'pos-1',
        symbol: 'RELIANCE',
        qty: 10,
        avgEntryPrice: 2500,
      });
      mockPrisma.order.update.mockResolvedValue({});

      const result = await service.placeOrder('user1', {
        portfolioId: 'p1',
        symbol: 'RELIANCE',
        side: 'BUY',
        orderType: 'MARKET',
        qty: 10,
        price: 2500,
        instrumentToken: 'token-1',
      });

      expect(result.id).toBe('order-1');
      expect(result.status).toBe('FILLED');
      expect(mockPrisma.position.create).toHaveBeenCalled();
    });

    it('adds capital automatically (₹50,000 steps) when an order placed by the user needs it, but never for a bot', async () => {
      const short = { id: 'p1', userId: 'user1', currentNav: 10_000, initialCapital: 1_000_000, autoTopUp: true };
      mockPrisma.portfolio.findUnique.mockResolvedValue(short);
      mockPrisma.portfolio.update.mockResolvedValue({});
      (mockPrisma as any).notification = { create: vi.fn().mockResolvedValue({}) };
      mockPrisma.order.create.mockResolvedValue({ id: 'order-9', symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET', qty: 10, status: 'PENDING' });
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-9', symbol: 'RELIANCE', status: 'PENDING', qty: 10, filledQty: 0 })
        .mockResolvedValueOnce({ id: 'order-9', symbol: 'RELIANCE', status: 'SUBMITTED', qty: 10, filledQty: 0, avgFillPrice: null })
        .mockResolvedValueOnce({ id: 'order-9', symbol: 'RELIANCE', status: 'SUBMITTED', qty: 10, filledQty: 0 })
        .mockResolvedValue({ id: 'order-9', symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET', qty: 10, status: 'FILLED' });
      mockPrisma.position.findFirst.mockResolvedValue(null);
      mockPrisma.position.create.mockResolvedValue({ id: 'pos-9', symbol: 'RELIANCE', qty: 10, avgEntryPrice: 2500 });
      mockPrisma.order.update.mockResolvedValue({});
      const order = { portfolioId: 'p1', symbol: 'RELIANCE', side: 'BUY' as const, orderType: 'MARKET' as const, qty: 10, price: 2500, instrumentToken: 't' };

      // ~₹25,000 needed, ₹10,000 in cash: ₹50,000 is added to capital and cash alike.
      await service.placeOrder('user1', order);
      expect(mockPrisma.portfolio.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { initialCapital: { increment: 50_000 }, currentNav: { increment: 50_000 }, autoToppedUp: { increment: 50_000 } },
      });

      mockPrisma.portfolio.update.mockClear();
      await expect(service.placeOrder('user1', { ...order, strategyTag: 'BOT:momentum' })).rejects.toThrow(/Insufficient capital/);
      mockPrisma.portfolio.findUnique.mockResolvedValue({ ...short, autoTopUp: false });
      await expect(service.placeOrder('user1', order)).rejects.toThrow(/Insufficient capital.*Raise the capital/);
      expect(mockPrisma.portfolio.update).not.toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ autoToppedUp: expect.anything() }) }));
    });

    it('should throw 404 for non-existent portfolio', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue(null);

      await expect(
        service.placeOrder('user1', {
          portfolioId: 'nonexistent',
          symbol: 'RELIANCE',
          side: 'BUY',
          orderType: 'MARKET',
          qty: 10,
          instrumentToken: 'token-1',
        }),
      ).rejects.toThrow(TradeError);
    });

    it('should create SUBMITTED order for LIMIT type', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', userId: 'user1', currentNav: 1000000, initialCapital: 1000000 });
      mockPrisma.order.create.mockResolvedValue({
        id: 'order-2',
        symbol: 'TCS',
        side: 'BUY',
        orderType: 'LIMIT',
        qty: 5,
        price: 3500,
        status: 'PENDING',
      });
      mockPrisma.order.update.mockResolvedValue({});
      // OMS submitOrder reads current state (PENDING), then final re-read returns SUBMITTED
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-2', symbol: 'TCS', status: 'PENDING', qty: 5, filledQty: 0 })
        .mockResolvedValue({ id: 'order-2', symbol: 'TCS', side: 'BUY', orderType: 'LIMIT', qty: 5, price: 3500, status: 'SUBMITTED' });
      mockPrisma.position.findFirst.mockResolvedValue(null);

      const result = await service.placeOrder('user1', {
        portfolioId: 'p1',
        symbol: 'TCS',
        side: 'BUY',
        orderType: 'LIMIT',
        qty: 5,
        price: 3500,
        instrumentToken: 'token-2',
      });

      expect(result.status).toBe('SUBMITTED');
      expect(mockPrisma.position.create).not.toHaveBeenCalled();
    });

    it('should average up existing position on BUY', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', userId: 'user1', currentNav: 1000000, initialCapital: 1000000 });
      mockPrisma.order.create.mockResolvedValue({
        id: 'order-3',
        symbol: 'RELIANCE',
        status: 'PENDING',
        side: 'BUY',
        orderType: 'MARKET',
        qty: 10,
      });
      mockPrisma.position.findFirst
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce(null)
        .mockResolvedValueOnce({
          id: 'pos-existing',
          qty: 10,
          avgEntryPrice: 2500,
          side: 'LONG',
          status: 'OPEN',
        });
      mockPrisma.position.update.mockResolvedValue({});
      mockPrisma.order.update.mockResolvedValue({});
      // OMS state transitions: PENDING→SUBMITTED, then recordFill reads + SUBMITTED→FILLED, then final re-read
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-3', symbol: 'RELIANCE', status: 'PENDING', qty: 10, filledQty: 0 })
        .mockResolvedValueOnce({ id: 'order-3', symbol: 'RELIANCE', status: 'SUBMITTED', qty: 10, filledQty: 0, avgFillPrice: null })
        .mockResolvedValueOnce({ id: 'order-3', symbol: 'RELIANCE', status: 'SUBMITTED', qty: 10, filledQty: 0 })
        .mockResolvedValue({ id: 'order-3', status: 'FILLED', side: 'BUY', orderType: 'MARKET' });

      await service.placeOrder('user1', {
        portfolioId: 'p1',
        symbol: 'RELIANCE',
        side: 'BUY',
        orderType: 'MARKET',
        qty: 10,
        price: 2600,
        instrumentToken: 'token-1',
      });

      expect(mockPrisma.position.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pos-existing' },
          data: expect.objectContaining({ qty: 20 }),
        }),
      );
      const updateCall = mockPrisma.position.update.mock.calls[0][0];
      expect(updateCall.data.avgEntryPrice).toBeGreaterThanOrEqual(2540);
      expect(updateCall.data.avgEntryPrice).toBeLessThanOrEqual(2570);
    });
  });

  describe('cancelOrder', () => {
    it('should cancel a pending order', async () => {
      // cancelOrder reads order, OMS.transition reads order, then final re-read
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-1', status: 'PENDING', portfolio: { userId: 'user1' } })
        .mockResolvedValueOnce({ id: 'order-1', symbol: 'RELIANCE', status: 'PENDING' })
        .mockResolvedValue({ id: 'order-1', status: 'CANCELLED' });
      mockPrisma.order.update.mockResolvedValue({ id: 'order-1', status: 'CANCELLED' });

      const result = await service.cancelOrder('order-1', 'user1');

      expect(result.status).toBe('CANCELLED');
    });

    it('should throw 400 for non-pending order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        status: 'FILLED',
        portfolio: { userId: 'user1' },
      });

      await expect(service.cancelOrder('order-1', 'user1')).rejects.toMatchObject({
        statusCode: 400,
        message: 'Only pending/submitted orders can be cancelled',
      });
    });

    it('should throw 404 for non-existent order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);

      await expect(service.cancelOrder('nonexistent', 'user1')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('listOrders', () => {
    it('should return paginated orders for user', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.order.findMany.mockResolvedValue([
        { id: 'o1', symbol: 'RELIANCE' },
        { id: 'o2', symbol: 'TCS' },
      ]);
      mockPrisma.order.count.mockResolvedValue(2);

      const result = await service.listOrders('user1', { page: 1, limit: 10 });

      expect(result.orders).toHaveLength(2);
      expect(result.total).toBe(2);
    });

    it('should filter by status', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.order.findMany.mockResolvedValue([]);
      mockPrisma.order.count.mockResolvedValue(0);

      await service.listOrders('user1', { status: 'PENDING' });

      const findManyCall = mockPrisma.order.findMany.mock.calls[0][0];
      expect(findManyCall.where.status).toBe('PENDING');
    });
  });

  describe('listPositions', () => {
    it('should return open positions for user portfolios', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.position.findMany.mockResolvedValue([
        { id: 'pos-1', symbol: 'RELIANCE', status: 'OPEN' },
      ]);

      const result = await service.listPositions('user1');

      expect(result).toHaveLength(1);
      expect(mockPrisma.position.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { portfolioId: { in: ['p1'] }, status: 'OPEN' },
        }),
      );
    });
  });

  describe('closePosition', () => {
    it('should close position, create exit order, and create trade', async () => {
      mockPrisma.position.findUnique.mockResolvedValue({
        id: 'pos-1',
        portfolioId: 'p1',
        symbol: 'RELIANCE',
        exchange: 'NSE',
        qty: 10,
        avgEntryPrice: 2500,
        side: 'LONG',
        status: 'OPEN',
        openedAt: new Date(),
        strategyTag: null,
        realizedPnl: 0,
        portfolio: { userId: 'user1' },
      });
      mockPrisma.position.updateMany.mockResolvedValue({ count: 1 });
      mockPrisma.order.create.mockResolvedValue({ id: 'exit-order-1', status: 'PENDING' });
      // OMS transitions for exit order: PENDING → SUBMITTED → FILLED
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'exit-order-1', status: 'PENDING', qty: 10, filledQty: 0 })
        .mockResolvedValueOnce({ id: 'exit-order-1', status: 'SUBMITTED', qty: 10, filledQty: 0 })
        .mockResolvedValueOnce({ id: 'exit-order-1', status: 'SUBMITTED', qty: 10, filledQty: 0 });
      mockPrisma.order.update.mockResolvedValue({});
      mockPrisma.trade.create.mockResolvedValue({
        id: 'trade-1',
        grossPnl: 5000,
        netPnl: 4950,
      });
      mockPrisma.position.update.mockResolvedValue({});
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', currentNav: 1000000 });
      mockPrisma.portfolio.update.mockResolvedValue({});

      const result = await service.closePosition('pos-1', 'user1', 3000);

      expect(result.id).toBe('trade-1');
      expect(mockPrisma.order.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ side: 'SELL', orderType: 'MARKET', status: 'PENDING' }),
        }),
      );
      expect(mockPrisma.trade.create).toHaveBeenCalled();
      expect(mockPrisma.position.update).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { id: 'pos-1' },
          data: expect.objectContaining({ status: 'CLOSED' }),
        }),
      );
    });

    it('should throw 400 for already closed position', async () => {
      mockPrisma.position.findUnique.mockResolvedValue({
        id: 'pos-1',
        status: 'CLOSED',
        portfolio: { userId: 'user1' },
      });

      await expect(service.closePosition('pos-1', 'user1', 3000)).rejects.toMatchObject({
        statusCode: 400,
        message: 'Position is already closed',
      });
    });
  });

  describe('F&O order placement', () => {
    it('should pass F&O fields (expiry, strike, optionType) to broker input', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', userId: 'user1', currentNav: 1000000, initialCapital: 1000000 });
      mockPrisma.order.create.mockResolvedValue({
        id: 'order-fno',
        symbol: 'NIFTY2503022000CE',
        side: 'BUY',
        orderType: 'MARKET',
        qty: 50,
        status: 'PENDING',
      });
      mockPrisma.order.findUnique
        .mockResolvedValueOnce({ id: 'order-fno', symbol: 'NIFTY2503022000CE', status: 'PENDING', qty: 50, filledQty: 0 })
        .mockResolvedValueOnce({ id: 'order-fno', symbol: 'NIFTY2503022000CE', status: 'SUBMITTED', qty: 50, filledQty: 0, avgFillPrice: null })
        .mockResolvedValueOnce({ id: 'order-fno', symbol: 'NIFTY2503022000CE', status: 'SUBMITTED', qty: 50, filledQty: 0 })
        .mockResolvedValue({ id: 'order-fno', symbol: 'NIFTY2503022000CE', side: 'BUY', orderType: 'MARKET', qty: 50, status: 'FILLED' });
      mockPrisma.position.findFirst.mockResolvedValue(null);
      mockPrisma.position.create.mockResolvedValue({
        id: 'pos-fno',
        symbol: 'NIFTY2503022000CE',
        qty: 50,
        avgEntryPrice: 200,
      });
      mockPrisma.order.update.mockResolvedValue({});

      const result = await service.placeOrder('user1', {
        portfolioId: 'p1',
        symbol: 'NIFTY2503022000CE',
        side: 'BUY',
        orderType: 'MARKET',
        qty: 50,
        price: 200,
        instrumentToken: 'nifty-token',
        exchange: 'NFO',
        expiry: '2025-03-27',
        strike: 22000,
        optionType: 'CE',
      });

      expect(result.status).toBeDefined();
      expect(mockPrisma.order.create).toHaveBeenCalled();
    });
  });

  describe('listTrades', () => {
    it('should return paginated trades', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.trade.findMany.mockResolvedValue([{ id: 't1', symbol: 'RELIANCE' }]);
      mockPrisma.trade.count.mockResolvedValue(1);

      const result = await service.listTrades('user1');

      expect(result.trades).toHaveLength(1);
      expect(result.total).toBe(1);
    });

    it('should filter by date range and symbol', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.trade.findMany.mockResolvedValue([]);
      mockPrisma.trade.count.mockResolvedValue(0);

      await service.listTrades('user1', {
        symbol: 'TCS',
        fromDate: '2025-01-01',
        toDate: '2025-12-31',
      });

      const findCall = mockPrisma.trade.findMany.mock.calls[0][0];
      expect(findCall.where.symbol).toBe('TCS');
      expect(findCall.where.exitTime.gte).toEqual(new Date('2025-01-01'));
      const expectedEnd = new Date('2025-12-31');
      expectedEnd.setHours(23, 59, 59, 999);
      expect(findCall.where.exitTime.lte).toEqual(expectedEnd);
    });
  });

  // ══════════════════════════════════════════════════════════════════════
  // Risk gate must FAIL CLOSED, and must actually run on market orders.
  //
  // Both of these were broken together: the gate caught infrastructure errors
  // and logged 'non-blocking', and it skipped preTradeCheck whenever
  // `input.price` was absent — which is every MARKET order a bot places. So a
  // bot could place unlimited unchecked market orders, and a transient DB fault
  // disabled every limit at once. The suite passed throughout.
  // ══════════════════════════════════════════════════════════════════════
  describe('risk gate', () => {
    // The risk gate holds the bots' rules, so these are orders placed by a bot.
    const marketOrder = {
      portfolioId: 'p1', symbol: 'RELIANCE', side: 'BUY',
      orderType: 'MARKET', qty: 10, instrumentToken: 'RELIANCE', strategyTag: 'AI_BOT',
    } as any;

    it('does not apply bot rules to an order the user places', async () => {
      const preTrade = vi.spyOn((service as any).riskService, 'preTradeCheck')
        .mockResolvedValue({ allowed: false, violations: ['Bot trading paused'], warnings: [] });
      const target = vi.spyOn((service as any).riskService, 'enforceTargetRisk');
      await service.placeOrder('user1', { ...marketOrder, strategyTag: undefined }).catch((err: Error) => {
        expect(err.message).not.toMatch(/Risk check failed|Risk gate|rejected for safety/);
      });
      expect(preTrade).not.toHaveBeenCalled();
      expect(target).not.toHaveBeenCalled();
    });

    beforeEach(() => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1', userId: 'user1', currentNav: 1_000_000, initialCapital: 1_000_000,
      });
    });

    it('REJECTS the order when the risk layer throws, instead of trading unchecked', async () => {
      // Simulate an infrastructure fault inside RiskService
      mockPrisma.portfolio.findMany.mockRejectedValue(new Error('db connection lost'));

      await expect(service.placeOrder('user1', marketOrder)).rejects.toThrow(TradeError);
      await expect(service.placeOrder('user1', marketOrder)).rejects.toThrow(/rejected for safety/i);
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
    });

    it('rejects with 503 so the caller can distinguish "unknown" from "denied"', async () => {
      mockPrisma.portfolio.findMany.mockRejectedValue(new Error('db connection lost'));

      await service.placeOrder('user1', marketOrder).catch((err: TradeError) => {
        expect(err.statusCode).toBe(503);
      });
      expect.assertions(1);
    });

    it('risk-checks a MARKET order using the live quote, not a skipped zero price', async () => {
      // The bug: bots pass price: undefined on MARKET orders, so estPrice was 0
      // and `if (estPrice > 0)` skipped position/concentration/fat-finger limits.
      // A 10-lot order at the mocked LTP of 2500 must be evaluated at 25,000.
      let seenPrice: number | undefined;
      let seenQty: number | undefined;
      mockPrisma.position.count.mockImplementation(async () => { return 0; });

      const riskModule = await import('../../src/services/risk.service.js');
      const spy = vi.spyOn(riskModule.RiskService.prototype, 'preTradeCheck')
        .mockImplementation(async (_u: string, _s: string, _side: string, qty: number, price: number) => {
          seenPrice = price;
          seenQty = qty;
          return { allowed: true, violations: [], warnings: [] } as any;
        });

      mockPrisma.order.create.mockResolvedValue({ id: 'o1', symbol: 'RELIANCE', qty: 10, status: 'PENDING' });
      mockPrisma.order.findUnique.mockResolvedValue({ id: 'o1', status: 'FILLED', qty: 10, filledQty: 10 });
      mockPrisma.order.update.mockResolvedValue({});
      mockPrisma.position.findFirst.mockResolvedValue(null);
      mockPrisma.position.create.mockResolvedValue({ id: 'pos1' });
      mockPrisma.portfolio.update.mockResolvedValue({});

      await service.placeOrder('user1', marketOrder).catch(() => { /* downstream mocks are incomplete; the gate is what matters */ });

      expect(spy).toHaveBeenCalled();
      expect(seenPrice).toBe(2500);
      expect(seenQty).toBe(10);
      spy.mockRestore();
    });

    it('blocks the order when the position-limit check reports a violation', async () => {
      const riskModule = await import('../../src/services/risk.service.js');
      const spy = vi.spyOn(riskModule.RiskService.prototype, 'preTradeCheck')
        .mockResolvedValue({ allowed: false, violations: ['Order value exceeds Rs 500,000'], warnings: [] } as any);

      await expect(service.placeOrder('user1', marketOrder)).rejects.toThrow(/Risk check failed/);
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
      spy.mockRestore();
    });

    it('rejects rather than guessing when the symbol cannot be priced', async () => {
      const mdModule = await import('../../src/services/market-data.service.js');
      const svc = new TradeService(mockPrisma as any);
      (svc as any).marketData = { getQuote: vi.fn().mockResolvedValue({ ltp: 0 }) };

      await expect(svc.placeOrder('user1', marketOrder)).rejects.toThrow(/unable to fetch current price/i);
      expect(mockPrisma.order.create).not.toHaveBeenCalled();
      expect(mdModule).toBeDefined();
    });
  });
});
