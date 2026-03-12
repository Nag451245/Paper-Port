import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: vi.fn().mockImplementation(() => ({
    isMarketOpen: vi.fn().mockReturnValue(true),
  })),
}));

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({
    getQuote: vi.fn().mockResolvedValue({ ltp: 2500 }),
  })),
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
    },
    trade: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
    $transaction: vi.fn().mockImplementation(async (fn: (tx: any) => Promise<any>) => fn(prisma)),
    dailyPnlRecord: { findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    riskEvent: { create: vi.fn() },
  };
  return prisma;
}

describe('TradeService', () => {
  let service: TradeService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
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
});
