import { describe, it, expect, vi, beforeEach } from 'vitest';

import { PerformanceMetricsService } from '../../src/services/performance-metrics.service.js';

function createMockPrisma() {
  return {
    portfolio: {
      findMany: vi.fn().mockResolvedValue([{
        id: 'port-1',
        initialCapital: 1_000_000,
        currentNav: 1_005_000,
      }]),
    },
    trade: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    aITradeSignal: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    order: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    dailyPnlRecord: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as any;
}

describe('PerformanceMetricsService', () => {
  let service: PerformanceMetricsService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    service = new PerformanceMetricsService(mockPrisma);
  });

  describe('computeDailyMetrics', () => {
    it('should return empty metrics when no trades', async () => {
      const metrics = await service.computeDailyMetrics('user-1');
      expect(metrics.tradesCount).toBe(0);
      expect(metrics.netPnl).toBe(0);
      expect(metrics.dailySharpe).toBe(0);
    });

    it('should compute win rate correctly', async () => {
      mockPrisma.trade.findMany.mockResolvedValue([
        { netPnl: 500, grossPnl: 500, entryPrice: 100, exitPrice: 105, entryTime: new Date(), exitTime: new Date(), strategyTag: 'orb', symbol: 'TCS', side: 'BUY', qty: 10 },
        { netPnl: -200, grossPnl: -200, entryPrice: 100, exitPrice: 98, entryTime: new Date(), exitTime: new Date(), strategyTag: 'orb', symbol: 'INFY', side: 'BUY', qty: 10 },
        { netPnl: 300, grossPnl: 300, entryPrice: 100, exitPrice: 103, entryTime: new Date(), exitTime: new Date(), strategyTag: 'mr', symbol: 'SBIN', side: 'BUY', qty: 10 },
      ]);

      const metrics = await service.computeDailyMetrics('user-1');
      expect(metrics.tradesCount).toBe(3);
      expect(metrics.winRate).toBeCloseTo(66.67, 1);
      expect(metrics.netPnl).toBe(600);
    });

    it('should compute avg win/loss ratio', async () => {
      mockPrisma.trade.findMany.mockResolvedValue([
        { netPnl: 600, grossPnl: 600, entryPrice: 100, exitPrice: 106, entryTime: new Date(), exitTime: new Date(), strategyTag: 'a', symbol: 'X', side: 'BUY', qty: 10 },
        { netPnl: -200, grossPnl: -200, entryPrice: 100, exitPrice: 98, entryTime: new Date(), exitTime: new Date(), strategyTag: 'a', symbol: 'Y', side: 'BUY', qty: 10 },
      ]);

      const metrics = await service.computeDailyMetrics('user-1');
      expect(metrics.avgWinLossRatio).toBe(3); // 600 / 200
    });

    it('should return empty metrics for unknown portfolio', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([]);
      const metrics = await service.computeDailyMetrics('unknown');
      expect(metrics.tradesCount).toBe(0);
    });
  });

  describe('getTargetProgress', () => {
    it('should report not on track with no history', async () => {
      const progress = await service.getTargetProgress('user-1');
      expect(progress.onTrack).toBe(false);
      expect(progress.projectedAnnualReturn).toBe(0);
    });

    it('should report on track with good daily returns', async () => {
      const days = Array.from({ length: 10 }, () => ({ netPnl: 6000, date: new Date() }));
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue(days);

      const progress = await service.getTargetProgress('user-1', 0.5);
      expect(progress.dailyReturnPct).toBeGreaterThan(0.5);
      expect(progress.onTrack).toBe(true);
    });

    it('should compute streak correctly', async () => {
      const days = [
        { netPnl: 500, date: new Date() },
        { netPnl: 300, date: new Date() },
        { netPnl: -100, date: new Date() },
      ];
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue(days);

      const progress = await service.getTargetProgress('user-1');
      expect(progress.streakType).toBe('winning');
      expect(progress.streakDays).toBe(2);
    });
  });
});
