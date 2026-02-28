import { describe, it, expect, vi, beforeEach } from 'vitest';
import { PortfolioService, PortfolioError } from '../../src/services/portfolio.service.js';

function createMockPrisma() {
  return {
    portfolio: {
      findMany: vi.fn(),
      findUnique: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
    },
    position: {
      findMany: vi.fn(),
    },
    trade: {
      findMany: vi.fn(),
    },
  } as any;
}

describe('PortfolioService', () => {
  let service: PortfolioService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    service = new PortfolioService(mockPrisma);
  });

  describe('list', () => {
    it('should return portfolios for user', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([
        { id: 'p1', name: 'Default', userId: 'user1' },
        { id: 'p2', name: 'Aggressive', userId: 'user1' },
      ]);

      const result = await service.list('user1');

      expect(result).toHaveLength(2);
      expect(mockPrisma.portfolio.findMany).toHaveBeenCalledWith({
        where: { userId: 'user1' },
        orderBy: { createdAt: 'desc' },
      });
    });
  });

  describe('create', () => {
    it('should create a portfolio with correct initial values', async () => {
      mockPrisma.portfolio.create.mockResolvedValue({
        id: 'new-p',
        name: 'Test Portfolio',
        initialCapital: 500000,
        currentNav: 500000,
      });

      const result = await service.create('user1', 'Test Portfolio', 500000);

      expect(result.name).toBe('Test Portfolio');
      expect(mockPrisma.portfolio.create).toHaveBeenCalledWith({
        data: {
          userId: 'user1',
          name: 'Test Portfolio',
          initialCapital: 500000,
          currentNav: 500000,
        },
      });
    });
  });

  describe('getById', () => {
    it('should return portfolio if owned by user', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1',
        userId: 'user1',
        name: 'Default',
        positions: [],
      });

      const result = await service.getById('p1', 'user1');

      expect(result.id).toBe('p1');
    });

    it('should throw 404 if portfolio not found', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue(null);

      await expect(service.getById('nonexistent', 'user1')).rejects.toThrow(PortfolioError);
      await expect(service.getById('nonexistent', 'user1')).rejects.toMatchObject({ statusCode: 404 });
    });

    it('should throw 404 if portfolio belongs to another user', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1',
        userId: 'other-user',
        name: 'Other Portfolio',
      });

      await expect(service.getById('p1', 'user1')).rejects.toThrow(PortfolioError);
    });
  });

  describe('getSummary', () => {
    it('should calculate summary from positions', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1',
        userId: 'user1',
        initialCapital: 1000000,
        currentNav: 1050000,
        positions: [],
      });
      mockPrisma.position.findMany.mockResolvedValue([
        { avgEntryPrice: 2500, qty: 10, unrealizedPnl: 5000 },
        { avgEntryPrice: 1500, qty: 20, unrealizedPnl: -2000 },
      ]);

      const summary = await service.getSummary('p1', 'user1');

      expect(summary.totalNav).toBe(1050000);
      expect(summary.totalPnl).toBe(50000);
      expect(summary.totalPnlPercent).toBe(5);
      expect(summary.investedValue).toBe(55000);
      expect(summary.dayPnl).toBe(3000);
    });
  });

  describe('getRiskMetrics', () => {
    it('should return zero metrics when no trades', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1',
        userId: 'user1',
        positions: [],
      });
      mockPrisma.trade.findMany.mockResolvedValue([]);

      const metrics = await service.getRiskMetrics('p1', 'user1');

      expect(metrics.totalTrades).toBe(0);
      expect(metrics.winRate).toBe(0);
      expect(metrics.sharpeRatio).toBe(0);
    });

    it('should calculate win rate from trades', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1',
        userId: 'user1',
        initialCapital: 1000000,
        positions: [],
      });
      mockPrisma.trade.findMany.mockResolvedValue([
        { netPnl: 1000 },
        { netPnl: 2000 },
        { netPnl: -500 },
        { netPnl: 1500 },
      ]);

      const metrics = await service.getRiskMetrics('p1', 'user1');

      expect(metrics.totalTrades).toBe(4);
      expect(metrics.winRate).toBe(75);
      expect(metrics.avgWin).toBeGreaterThan(0);
      expect(metrics.avgLoss).toBeGreaterThan(0);
    });
  });

  describe('updateCapital', () => {
    it('should update initial and current NAV', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1',
        userId: 'user1',
        positions: [],
      });
      mockPrisma.portfolio.update.mockResolvedValue({
        id: 'p1',
        initialCapital: 2000000,
        currentNav: 2000000,
      });

      const result = await service.updateCapital('p1', 'user1', 2000000);

      expect(mockPrisma.portfolio.update).toHaveBeenCalledWith({
        where: { id: 'p1' },
        data: { initialCapital: 2000000, currentNav: 2000000 },
      });
    });
  });
});
