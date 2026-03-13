import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/event-bus.js', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/services/target-tracker.service.js', () => ({
  TargetTracker: vi.fn().mockImplementation(() => ({
    getActiveTarget: vi.fn().mockResolvedValue(null),
  })),
}));

import { RiskService } from '../../src/services/risk.service.js';

function createMockPrisma() {
  return {
    portfolio: {
      findMany: vi.fn().mockResolvedValue([{
        id: 'port-1',
        initialCapital: 1_000_000,
        currentNav: 1_000_000,
        isDefault: true,
      }]),
    },
    position: {
      count: vi.fn().mockResolvedValue(0),
      findMany: vi.fn().mockResolvedValue([]),
    },
    trade: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    order: {
      findMany: vi.fn().mockResolvedValue([]),
    },
    riskEvent: {
      create: vi.fn().mockResolvedValue({}),
    },
    dailyPnlRecord: {
      findMany: vi.fn().mockResolvedValue([]),
    },
  } as any;
}

describe('RiskService', () => {
  let riskService: RiskService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    riskService = new RiskService(mockPrisma);
  });

  describe('computePositionSize', () => {
    it('should compute correct position size from risk budget', () => {
      const result = riskService.computePositionSize(1_000_000, 500, 495);
      expect(result.qty).toBeGreaterThan(0);
      expect(result.riskPct).toBeLessThanOrEqual(2.0);
      expect(result.positionValue).toBeLessThanOrEqual(50_000); // 5% of 1M
    });

    it('should return zero qty for invalid inputs', () => {
      const result = riskService.computePositionSize(1_000_000, 500, 500);
      expect(result.qty).toBe(0);
    });

    it('should cap position at maxPositionPct', () => {
      // Very tight stop = large qty, but capped at 5% of capital
      const result = riskService.computePositionSize(1_000_000, 100, 99.99);
      expect(result.positionValue).toBeLessThanOrEqual(50_000);
    });

    it('should respect maxOrderValue', () => {
      const result = riskService.computePositionSize(100_000_000, 10, 9);
      expect(result.positionValue).toBeLessThanOrEqual(500_000);
    });
  });

  describe('preTradeCheck — circuit breakers', () => {
    it('should block trades after 5+ consecutive losses (30-min pause)', async () => {
      // Rule 0: checkConsecutiveLossPause triggers first when 5+ consecutive losses
      const losses = Array.from({ length: 6 }, () => ({
        netPnl: -100,
        exitTime: new Date(),
      }));
      mockPrisma.trade.findMany.mockResolvedValue(losses);

      const result = await riskService.preTradeCheck('user-1', 'TCS', 'BUY', 10, 100);
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v: string) =>
        v.includes('Trading paused') || v.includes('consecutive losses')
      )).toBe(true);
    });

    it('should allow trades with no losses', async () => {
      mockPrisma.trade.findMany.mockResolvedValue([]);
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue([]);

      const result = await riskService.preTradeCheck('user-1', 'TCS', 'BUY', 1, 100);
      expect(result.allowed).toBe(true);
    });

    it('should allow trades with 2 non-consecutive losses', async () => {
      const trades = [
        { netPnl: -100, exitTime: new Date() },
        { netPnl: 200, exitTime: new Date() }, // breaks consecutive streak
        { netPnl: -50, exitTime: new Date() },
      ];
      mockPrisma.trade.findMany.mockResolvedValue(trades);
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue([]);

      const result = await riskService.preTradeCheck('user-2', 'INFY', 'BUY', 1, 100);
      expect(result.allowed).toBe(true);
    });

    it('should block after consecutive losing days', async () => {
      const losingDays = Array.from({ length: 8 }, () => ({ netPnl: -500 }));
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue(losingDays);
      mockPrisma.trade.findMany.mockResolvedValue([]);

      const result = await riskService.preTradeCheck('user-3', 'TCS', 'BUY', 1, 100);
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v: string) => v.includes('consecutive losing days'))).toBe(true);
    });
  });

  describe('preTradeCheck — daily drawdown', () => {
    it('should block at 2% drawdown on 1M capital', async () => {
      // 2% of 1M = 20,000
      const trades = [{ netPnl: -25000, exitTime: new Date() }];
      mockPrisma.trade.findMany.mockResolvedValue(trades);
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue([]);

      const result = await riskService.preTradeCheck('user-1', 'TCS', 'BUY', 1, 100);
      expect(result.allowed).toBe(false);
      expect(result.violations.some((v: string) => v.includes('Daily loss'))).toBe(true);
    });
  });

  describe('getSizeMultiplier', () => {
    it('should return 1.0 when no losses', async () => {
      mockPrisma.trade.findMany.mockResolvedValue([]);
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue([]);

      const mult = await riskService.getSizeMultiplier('user-1');
      expect(mult).toBe(1.0);
    });

    it('should return 0.5 after weekly loss limit hit', async () => {
      // 3% of 1M = 30000
      const trades = [{ netPnl: -35000 }];
      mockPrisma.trade.findMany.mockResolvedValue(trades);
      mockPrisma.dailyPnlRecord.findMany.mockResolvedValue([]);

      const mult = await riskService.getSizeMultiplier('user-1');
      expect(mult).toBeLessThanOrEqual(0.5);
    });
  });

  describe('forceCloseOnDailyLossLimit', () => {
    it('should not trigger when below limit', async () => {
      mockPrisma.trade.findMany.mockResolvedValue([]);
      const closeFn = vi.fn();

      const result = await riskService.forceCloseOnDailyLossLimit('user-1', closeFn);
      expect(result.triggered).toBe(false);
      expect(closeFn).not.toHaveBeenCalled();
    });

    it('should force-close all positions when limit breached', async () => {
      mockPrisma.trade.findMany.mockResolvedValue([{ netPnl: -25000 }]);
      mockPrisma.position.findMany.mockResolvedValue([
        { id: 'pos-1', symbol: 'TCS', avgEntryPrice: 100 },
        { id: 'pos-2', symbol: 'INFY', avgEntryPrice: 200 },
      ]);
      const closeFn = vi.fn().mockResolvedValue({});

      const result = await riskService.forceCloseOnDailyLossLimit('user-1', closeFn);
      expect(result.triggered).toBe(true);
      expect(result.closedCount).toBe(2);
      expect(closeFn).toHaveBeenCalledTimes(2);
    });
  });

  describe('getDailyRiskSummary', () => {
    it('should return empty summary for unknown user', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([]);

      const summary = await riskService.getDailyRiskSummary('unknown');
      expect(summary.dayPnl).toBe(0);
      expect(summary.openPositions).toBe(0);
      expect(summary.riskScore).toBe(0);
    });
  });
});
