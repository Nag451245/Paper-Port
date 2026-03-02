import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TradeService, TradeError } from '../../src/services/trade.service.js';

function createMockPrisma() {
  return {
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
    },
    trade: {
      create: vi.fn(),
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
    },
  } as any;
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
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', userId: 'user1' });
      mockPrisma.order.create.mockResolvedValue({
        id: 'order-1',
        symbol: 'RELIANCE',
        side: 'BUY',
        orderType: 'MARKET',
        qty: 10,
        status: 'FILLED',
      });
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

    it('should create PENDING order for LIMIT type', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', userId: 'user1' });
      mockPrisma.order.create.mockResolvedValue({
        id: 'order-2',
        symbol: 'TCS',
        side: 'BUY',
        orderType: 'LIMIT',
        qty: 5,
        price: 3500,
        status: 'PENDING',
      });

      const result = await service.placeOrder('user1', {
        portfolioId: 'p1',
        symbol: 'TCS',
        side: 'BUY',
        orderType: 'LIMIT',
        qty: 5,
        price: 3500,
        instrumentToken: 'token-2',
      });

      expect(result.status).toBe('PENDING');
      expect(mockPrisma.position.create).not.toHaveBeenCalled();
    });

    it('should average up existing position on BUY', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', userId: 'user1', currentNav: 1000000 });
      mockPrisma.order.create.mockResolvedValue({
        id: 'order-3',
        status: 'FILLED',
        side: 'BUY',
        orderType: 'MARKET',
      });
      // findFirst calls: 1) SHORT check in placeOrder, 2) SHORT check in handleBuyFill, 3) LONG check in openLongPosition
      mockPrisma.position.findFirst
        .mockResolvedValueOnce(null)  // no SHORT to check margin
        .mockResolvedValueOnce(null)  // no SHORT to cover
        .mockResolvedValueOnce({      // existing LONG to average up
          id: 'pos-existing',
          qty: 10,
          avgEntryPrice: 2500,
          side: 'LONG',
          status: 'OPEN',
        });
      mockPrisma.position.update.mockResolvedValue({});
      mockPrisma.order.update.mockResolvedValue({});

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
      mockPrisma.order.findUnique.mockResolvedValue({
        id: 'order-1',
        status: 'PENDING',
        portfolio: { userId: 'user1' },
      });
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
        message: 'Only pending orders can be cancelled',
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
    it('should close position and create trade', async () => {
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
        portfolio: { userId: 'user1' },
      });
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
