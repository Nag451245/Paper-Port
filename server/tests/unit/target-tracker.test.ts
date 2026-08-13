import { describe, it, expect, vi, beforeEach } from 'vitest';
import { TargetTracker, type Aggression } from '../../src/services/target-tracker.service.js';
import { createMockPrisma, makePortfolio, makeTrade, makeDailyPnlRecord } from '../helpers/factories.js';

describe('TargetTracker', () => {
  let tracker: TargetTracker;
  let prisma: ReturnType<typeof createMockPrisma>;
  const userId = 'user-target';
  const portfolioId = 'portfolio-target';

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    tracker = new TargetTracker(prisma);
    prisma.portfolio.findMany.mockResolvedValue([
      makePortfolio({ id: portfolioId, userId }),
    ]);
  });

  // ── Target Lifecycle ───────────────────────────────────────────────

  describe('createTarget', () => {
    it('should deactivate existing targets before creating new one', async () => {
      prisma.tradingTarget.updateMany.mockResolvedValue({ count: 1 });
      prisma.tradingTarget.create.mockResolvedValue({
        id: 'target-1', userId, type: 'DAILY', capitalBase: 1_000_000,
        profitTargetPct: 0.5, maxLossPct: 0.3, instruments: 'ALL', status: 'ACTIVE',
      });

      await tracker.createTarget(userId, {
        type: 'DAILY',
        capitalBase: 1_000_000,
        profitTargetPct: 0.5,
      });

      expect(prisma.tradingTarget.updateMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { userId, status: 'ACTIVE' },
          data: { status: 'PAUSED' },
        }),
      );
      expect(prisma.tradingTarget.create).toHaveBeenCalled();
    });

    it('should default maxLossPct to 0.3 when not provided', async () => {
      prisma.tradingTarget.updateMany.mockResolvedValue({ count: 0 });
      prisma.tradingTarget.create.mockResolvedValue({});

      await tracker.createTarget(userId, {
        type: 'DAILY',
        capitalBase: 500_000,
        profitTargetPct: 1.0,
      });

      expect(prisma.tradingTarget.create).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ maxLossPct: 0.3 }),
        }),
      );
    });
  });

  // ── P&L Computation ────────────────────────────────────────────────

  describe('computeTodayPnl', () => {
    it('should sum netPnl of trades exited today (IST boundary)', async () => {
      const trades = [
        makeTrade({ portfolioId, netPnl: 1500 }),
        makeTrade({ portfolioId, netPnl: -400 }),
        makeTrade({ portfolioId, netPnl: 800 }),
      ];
      prisma.trade.findMany.mockResolvedValue(trades);

      const pnl = await tracker.computeTodayPnl(userId);
      expect(pnl).toBe(1900);
    });

    it('should return 0 when no trades today', async () => {
      prisma.trade.findMany.mockResolvedValue([]);
      const pnl = await tracker.computeTodayPnl(userId);
      expect(pnl).toBe(0);
    });

    it('should round to 2 decimal places', async () => {
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 1.333 }),
        makeTrade({ portfolioId, netPnl: 2.667 }),
      ]);

      const pnl = await tracker.computeTodayPnl(userId);
      expect(pnl).toBe(4);
    });
  });

  // ── Progress Update ────────────────────────────────────────────────

  describe('updateProgress', () => {
    it('should return null when no active target', async () => {
      prisma.tradingTarget.findFirst.mockResolvedValue(null);
      const result = await tracker.updateProgress(userId);
      expect(result).toBeNull();
    });

    it('should trigger LOSS_LIMIT when loss exceeds maxLossAbs', async () => {
      const target = {
        id: 'target-1', userId, type: 'DAILY', status: 'ACTIVE',
        capitalBase: 1_000_000, profitTargetPct: 0.5, maxLossPct: 0.3,
        consecutiveLossDays: 0, instruments: 'ALL', lastReviewDate: null,
      };
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -4000 }), // maxLossAbs = 1M * 0.3% = 3000
      ]);

      const result = await tracker.updateProgress(userId);
      expect(result!.status).toBe('LOSS_LIMIT');
      expect(result!.tradingAllowed).toBe(false);
    });

    it('should trigger TARGET_HIT when profit exceeds target', async () => {
      const target = {
        id: 'target-2', userId, type: 'DAILY', status: 'ACTIVE',
        capitalBase: 1_000_000, profitTargetPct: 0.5, maxLossPct: 0.3,
        consecutiveLossDays: 0, instruments: 'ALL', lastReviewDate: null,
      };
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 6000 }), // target = 1M * 0.5% = 5000
      ]);

      const result = await tracker.updateProgress(userId);
      expect(result!.status).toBe('TARGET_HIT');
      expect(result!.aggression).toBe('low');
    });

    it('should compute correct progressPct', async () => {
      const target = {
        id: 'target-3', userId, type: 'DAILY', status: 'ACTIVE',
        capitalBase: 1_000_000, profitTargetPct: 1.0, maxLossPct: 0.5,
        consecutiveLossDays: 0, instruments: 'ALL', lastReviewDate: null,
      };
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 5000 }), // target = 10,000 (1%)
      ]);

      const result = await tracker.updateProgress(userId);
      expect(result!.progressPct).toBe(50); // 5000/10000 * 100
    });
  });

  // ── Aggression Computation ─────────────────────────────────────────

  describe('Aggression levels', () => {
    it('should be "none" on LOSS_LIMIT status', async () => {
      const target = {
        id: 'target-a', userId, type: 'DAILY', status: 'LOSS_LIMIT',
        capitalBase: 1_000_000, profitTargetPct: 0.5, maxLossPct: 0.3,
        consecutiveLossDays: 0, instruments: 'ALL', lastReviewDate: null,
      };
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});
      prisma.trade.findMany.mockResolvedValue([]);

      const result = await tracker.updateProgress(userId);
      expect(result!.aggression).toBe('none');
    });

    it('should be "none" after 2+ consecutive loss days', async () => {
      const target = {
        id: 'target-b', userId, type: 'DAILY', status: 'ACTIVE',
        capitalBase: 1_000_000, profitTargetPct: 0.5, maxLossPct: 0.3,
        consecutiveLossDays: 2, instruments: 'ALL', lastReviewDate: null,
      };
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});
      prisma.trade.findMany.mockResolvedValue([]);

      const result = await tracker.updateProgress(userId);
      expect(result!.aggression).toBe('none');
    });

    it('should be "none" when loss approaches 70% of maxLoss', async () => {
      const target = {
        id: 'target-c', userId, type: 'DAILY', status: 'ACTIVE',
        capitalBase: 1_000_000, profitTargetPct: 0.5, maxLossPct: 1.0,
        consecutiveLossDays: 0, instruments: 'ALL', lastReviewDate: null,
      };
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});
      // maxLossAbs = 10,000. 70% = 7,000. Loss = -8,000
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -8000 }),
      ]);

      const result = await tracker.updateProgress(userId);
      expect(result!.aggression).toBe('none');
    });
  });

  // ── Trading Allowed ────────────────────────────────────────────────

  describe('isTradingAllowed', () => {
    it('should disallow trading when status is LOSS_LIMIT', async () => {
      const target = {
        id: 'target-d', userId, type: 'DAILY', status: 'LOSS_LIMIT',
        capitalBase: 1_000_000, profitTargetPct: 0.5, maxLossPct: 0.3,
        consecutiveLossDays: 0, instruments: 'ALL', lastReviewDate: null,
      };
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});
      prisma.trade.findMany.mockResolvedValue([]);

      const result = await tracker.updateProgress(userId);
      expect(result!.tradingAllowed).toBe(false);
      expect(result!.reason).toContain('loss limit');
    });

    it('should disallow trading when REVIEW_REQUIRED', async () => {
      const target = {
        id: 'target-e', userId, type: 'DAILY', status: 'REVIEW_REQUIRED',
        capitalBase: 1_000_000, profitTargetPct: 0.5, maxLossPct: 0.3,
        consecutiveLossDays: 3, instruments: 'ALL', lastReviewDate: null,
      };
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});
      prisma.trade.findMany.mockResolvedValue([]);

      const result = await tracker.updateProgress(userId);
      expect(result!.tradingAllowed).toBe(false);
      expect(result!.reason).toContain('Review required');
    });

    it('should disallow trading when PAUSED', async () => {
      const target = {
        id: 'target-f', userId, type: 'DAILY', status: 'PAUSED',
        capitalBase: 1_000_000, profitTargetPct: 0.5, maxLossPct: 0.3,
        consecutiveLossDays: 0, instruments: 'ALL', lastReviewDate: null,
      };
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});
      prisma.trade.findMany.mockResolvedValue([]);

      const result = await tracker.updateProgress(userId);
      expect(result!.tradingAllowed).toBe(false);
    });
  });

  // ── Daily P&L Recording ────────────────────────────────────────────

  describe('recordDailyPnl', () => {
    it('should upsert DailyPnlRecord with trade stats', async () => {
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 1500 }),
        makeTrade({ portfolioId, netPnl: -400 }),
        makeTrade({ portfolioId, netPnl: 800 }),
      ]);
      prisma.dailyPnlRecord.upsert.mockResolvedValue({});
      prisma.tradingTarget.findFirst.mockResolvedValue(null);

      await tracker.recordDailyPnl(userId);

      expect(prisma.dailyPnlRecord.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({
            tradeCount: 3,
            winCount: 2,
            lossCount: 1,
            status: 'PROFIT',
          }),
        }),
      );
    });

    it('should classify BREAKEVEN when |pnl| <= 10', async () => {
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 5 }),
        makeTrade({ portfolioId, netPnl: -3 }),
      ]);
      prisma.dailyPnlRecord.upsert.mockResolvedValue({});
      prisma.tradingTarget.findFirst.mockResolvedValue(null);

      await tracker.recordDailyPnl(userId);

      expect(prisma.dailyPnlRecord.upsert).toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ status: 'BREAKEVEN' }),
        }),
      );
    });

    it('should increment consecutive loss days on loss', async () => {
      const target = {
        id: 'target-g', consecutiveLossDays: 1, status: 'ACTIVE',
      };
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -500 }),
      ]);
      prisma.dailyPnlRecord.upsert.mockResolvedValue({});
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});

      await tracker.recordDailyPnl(userId);

      expect(prisma.tradingTarget.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            consecutiveLossDays: 2,
            status: 'REVIEW_REQUIRED',
          }),
        }),
      );
    });

    it('should reset consecutive loss days on profit', async () => {
      const target = {
        id: 'target-h', consecutiveLossDays: 3, status: 'REVIEW_REQUIRED',
      };
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 1000 }),
      ]);
      prisma.dailyPnlRecord.upsert.mockResolvedValue({});
      prisma.tradingTarget.findFirst.mockResolvedValue(target);
      prisma.tradingTarget.update.mockResolvedValue({});

      await tracker.recordDailyPnl(userId);

      expect(prisma.tradingTarget.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            consecutiveLossDays: 0,
          }),
        }),
      );
    });
  });

  // ── Pause / Resume ─────────────────────────────────────────────────

  describe('pauseTarget / resumeTarget', () => {
    it('should pause active targets', async () => {
      prisma.tradingTarget.updateMany.mockResolvedValue({ count: 1 });
      const result = await tracker.pauseTarget(userId);
      expect(result).toBe(true);
    });

    it('should return false when no active target to pause', async () => {
      prisma.tradingTarget.updateMany.mockResolvedValue({ count: 0 });
      const result = await tracker.pauseTarget(userId);
      expect(result).toBe(false);
    });

    it('should resume a paused target', async () => {
      prisma.tradingTarget.findFirst.mockResolvedValue({ id: 'target-resume' });
      prisma.tradingTarget.update.mockResolvedValue({});

      const result = await tracker.resumeTarget(userId);
      expect(result).toBe(true);
      expect(prisma.tradingTarget.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'ACTIVE' }),
        }),
      );
    });

    it('should return false when no pauseable target exists', async () => {
      prisma.tradingTarget.findFirst.mockResolvedValue(null);
      const result = await tracker.resumeTarget(userId);
      expect(result).toBe(false);
    });
  });
});
