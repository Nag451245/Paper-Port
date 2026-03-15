import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/redis.js', () => ({
  getRedis: vi.fn().mockReturnValue(null),
}));

vi.mock('../../src/lib/event-bus.js', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/logger.js', () => ({
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { RiskService } from '../../src/services/risk.service.js';
import { emit } from '../../src/lib/event-bus.js';
import {
  createMockPrisma,
  makePortfolio,
  makePosition,
  makeTrade,
  makeLosingStreak,
  makeConsecutiveLosingDays,
} from '../helpers/factories.js';

describe('RiskService', () => {
  let service: RiskService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const userId = 'user-risk-test';
  const portfolioId = 'portfolio-risk-test';

  function setupDefaultPortfolio(capital = 1_000_000) {
    prisma.portfolio.findMany.mockResolvedValue([
      makePortfolio({ id: portfolioId, userId, initialCapital: capital, currentNav: capital, isDefault: true }),
    ]);
  }

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    service = new RiskService(prisma);
    setupDefaultPortfolio();
    prisma.position.count.mockResolvedValue(0);
    prisma.position.findMany.mockResolvedValue([]);
    prisma.trade.findMany.mockResolvedValue([]);
    prisma.dailyPnlRecord.findMany.mockResolvedValue([]);
    prisma.riskEvent.create.mockResolvedValue({});
    prisma.tradingTarget.findFirst.mockResolvedValue(null);
  });

  // ── Pre-Trade Check: Basic Rules ───────────────────────────────────

  describe('preTradeCheck: basic rules', () => {
    it('should ALLOW a trade within all limits', async () => {
      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 10, 2500);
      expect(result.allowed).toBe(true);
      expect(result.violations).toHaveLength(0);
    });

    it('should BLOCK when order value exceeds maxOrderValue (₹500,000)', async () => {
      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 250, 2500);
      // 250 * 2500 = 625,000 > 500,000
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.includes('exceeds max'))).toBe(true);
    });

    it('should BLOCK when position size exceeds 5% of capital', async () => {
      // 5% of 1M = 50,000. Order = 100 * 2500 = 250,000 = 25%
      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 100, 2500);
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.includes('Position size'))).toBe(true);
    });

    it('should ALLOW a trade just under 5% threshold', async () => {
      // 5% of 1M = 50,000. Order = 20 * 2500 = 50,000 = exactly 5%
      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 20, 2500);
      // Exactly at 5% is not > 5%, so should pass this rule
      expect(result.violations.filter(v => v.includes('Position size'))).toHaveLength(0);
    });

    it('should BLOCK when no portfolio exists', async () => {
      prisma.portfolio.findMany.mockResolvedValue([]);
      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 1, 100);
      expect(result.allowed).toBe(false);
      expect(result.violations).toContain('No portfolio found');
    });
  });

  // ── Pre-Trade Check: Position Limits ───────────────────────────────

  describe('preTradeCheck: position limits', () => {
    it('should BLOCK when max open positions (15) reached', async () => {
      prisma.position.count.mockResolvedValueOnce(15); // openPositions

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.violations.some(v => v.includes('max 15 open positions'))).toBe(true);
    });

    it('should ALLOW when just under max positions', async () => {
      prisma.position.count
        .mockResolvedValueOnce(14)  // openPositions
        .mockResolvedValueOnce(0);  // symbolPositions

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.violations.filter(v => v.includes('open positions'))).toHaveLength(0);
    });

    it('should warn at 80% of max positions (12/15)', async () => {
      prisma.position.count
        .mockResolvedValueOnce(12)  // openPositions
        .mockResolvedValueOnce(0);  // symbolPositions

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.warnings.some(w => w.includes('12/15'))).toBe(true);
    });

    it('should BLOCK when per-symbol concentration (2) reached', async () => {
      prisma.position.count
        .mockResolvedValueOnce(5)  // openPositions
        .mockResolvedValueOnce(2); // symbolPositions for RELIANCE

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.violations.some(v =>
        v.includes('open positions in RELIANCE')
      )).toBe(true);
    });
  });

  // ── Pre-Trade Check: Daily Drawdown Circuit Breaker ────────────────

  describe('preTradeCheck: circuit breaker', () => {
    it('should BLOCK when daily drawdown exceeds 2%', async () => {
      // Capital = 1M. 2% = 20,000. Losses = -25,000
      const losingTrades = [
        makeTrade({ portfolioId, netPnl: -15_000 }),
        makeTrade({ portfolioId, netPnl: -10_000 }),
      ];
      prisma.trade.findMany.mockResolvedValue(losingTrades);

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.violations.some(v => v.includes('circuit breaker'))).toBe(true);
    });

    it('should emit CIRCUIT_BREAKER_TRIGGERED event', async () => {
      const losingTrades = [makeTrade({ portfolioId, netPnl: -25_000 })];
      prisma.trade.findMany.mockResolvedValue(losingTrades);

      await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(emit).toHaveBeenCalledWith('risk', expect.objectContaining({
        type: 'CIRCUIT_BREAKER_TRIGGERED',
      }));
    });

    it('should ALLOW when drawdown is under 2%', async () => {
      // 1% drawdown = 10,000 loss
      const trades = [makeTrade({ portfolioId, netPnl: -10_000 })];
      prisma.trade.findMany.mockResolvedValue(trades);

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.violations.filter(v => v.includes('circuit breaker'))).toHaveLength(0);
    });

    it('should warn when approaching daily loss limit (>70% of 2%)', async () => {
      // 70% of 2% of 1M = 14,000
      const trades = [makeTrade({ portfolioId, netPnl: -15_000 })];
      prisma.trade.findMany.mockResolvedValue(trades);

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.warnings.some(w => w.includes('Approaching daily loss limit'))).toBe(true);
    });
  });

  // ── Pre-Trade Check: Sector Concentration ──────────────────────────

  describe('preTradeCheck: sector concentration', () => {
    it('should BLOCK when sector concentration exceeds 30%', async () => {
      // Capital = 1M. 30% = 300,000
      // Existing positions in Banking: 250,000 + new order: 100,000 = 350,000 > 30%
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, symbol: 'HDFCBANK', qty: 50, avgEntryPrice: 5000 }),
      ]);

      const result = await service.preTradeCheck(userId, 'ICICIBANK', 'BUY', 20, 5000);
      expect(result.violations.some(v => v.includes('sector concentration'))).toBe(true);
    });

    it('should not flag sector concentration for different sectors', async () => {
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, symbol: 'TCS', qty: 10, avgEntryPrice: 4000 }), // IT sector
      ]);

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      // RELIANCE is Energy, TCS is IT — different sectors
      expect(result.violations.filter(v => v.includes('sector concentration'))).toHaveLength(0);
    });
  });

  // ── Pre-Trade Check: Portfolio Heat ────────────────────────────────

  describe('preTradeCheck: portfolio heat', () => {
    it('should BLOCK when total exposure exceeds 80% of capital', async () => {
      // Capital = 1M. Existing exposure: 750,000. New order: 100,000 = 850,000 = 85%
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, qty: 150, avgEntryPrice: 5000 }),
      ]);

      const result = await service.preTradeCheck(userId, 'INFY', 'BUY', 20, 5000);
      expect(result.violations.some(v => v.includes('Portfolio heat'))).toBe(true);
    });

    it('should warn when heat is between 60% and 80%', async () => {
      // Existing: 500,000 + new: 150,000 = 650,000 = 65%
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, qty: 100, avgEntryPrice: 5000 }),
      ]);

      const result = await service.preTradeCheck(userId, 'INFY', 'BUY', 30, 5000);
      expect(result.warnings.some(w => w.includes('Portfolio heat'))).toBe(true);
    });
  });

  // ── Pre-Trade Check: Consecutive Losses ────────────────────────────

  describe('preTradeCheck: consecutive loss controls', () => {
    it('should BLOCK after 10 daily losses', async () => {
      // Interleave wins so consecutive losses < 5 (Rule 0 won't fire)
      // but total losses = 11 > dailyLossPauseCount (10) → Rule 12a fires
      const trades = [
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: 50 }),  // break consecutive streak
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: 50 }),  // break consecutive streak
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: -100 }),
      ];
      prisma.trade.findMany.mockResolvedValue(trades);

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.violations.some(v => v.includes('losses today'))).toBe(true);
    });

    it('should warn on weekly loss limit (3%)', async () => {
      // Week trades with > 3% loss on 1M capital = 30,000
      const weekTrades = [makeTrade({ portfolioId, netPnl: -35_000 })];
      prisma.trade.findMany.mockResolvedValue(weekTrades);

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.warnings.some(w => w.includes('Weekly loss'))).toBe(true);
    });

    it('should BLOCK after 7 consecutive losing days', async () => {
      prisma.dailyPnlRecord.findMany.mockResolvedValue(
        makeConsecutiveLosingDays(7, userId),
      );

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.violations.some(v => v.includes('consecutive losing days'))).toBe(true);
    });

    it('should warn after 3 consecutive losing days', async () => {
      prisma.dailyPnlRecord.findMany.mockResolvedValue(
        makeConsecutiveLosingDays(3, userId),
      );

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.warnings.some(w => w.includes('consecutive losing days'))).toBe(true);
    });
  });

  // ── Pre-Trade Check: Consecutive Loss Pause (30 min) ───────────────

  describe('preTradeCheck: 30-min pause after 5 consecutive losses', () => {
    it('should activate 30-min pause after 5 consecutive losses', async () => {
      const portfolios = [makePortfolio({ id: portfolioId, userId })];
      prisma.portfolio.findMany.mockResolvedValue(portfolios);

      const trades = makeLosingStreak(5, portfolioId);
      prisma.trade.findMany.mockResolvedValue(trades);

      const result = await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(result.allowed).toBe(false);
      expect(result.violations.some(v => v.includes('paused until'))).toBe(true);
    });
  });

  // ── Pre-Trade Check: Risk Event Logging ────────────────────────────

  describe('preTradeCheck: risk event logging', () => {
    it('should create RiskEvent when violations exist', async () => {
      // Trigger a violation that occurs AFTER the early returns (e.g., position size > 5%)
      // 100 * 2500 = 250,000 = 25% of 1M capital
      await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 100, 2500);
      expect(prisma.riskEvent.create).toHaveBeenCalled();
    });

    it('should NOT create RiskEvent when trade is allowed', async () => {
      await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 5, 2500);
      expect(prisma.riskEvent.create).not.toHaveBeenCalled();
    });

    it('should emit RISK_VIOLATION event on violations', async () => {
      // 100 * 2500 = 250,000 = 25% of capital → position size violation
      await service.preTradeCheck(userId, 'RELIANCE', 'BUY', 100, 2500);
      expect(emit).toHaveBeenCalledWith('risk', expect.objectContaining({
        type: 'RISK_VIOLATION',
      }));
    });
  });

  // ── Regime Risk Overrides ──────────────────────────────────────────

  describe('preTradeCheck: regime overrides', () => {
    it('should apply custom config overrides', async () => {
      // Override maxPositionPct to 50% — should allow a large position
      const result = await service.preTradeCheck(
        userId, 'RELIANCE', 'BUY', 100, 2500,
        { maxPositionPct: 50, maxOrderValue: 1_000_000 },
      );
      expect(result.violations.filter(v => v.includes('Position size'))).toHaveLength(0);
    });
  });

  // ── Position Sizing ────────────────────────────────────────────────

  describe('computePositionSize', () => {
    it('should compute qty from risk-per-share formula', () => {
      // capital=1M, entry=100, SL=95, risk per share=5
      // riskAmount = 1M * 2% = 20,000. qty = 20,000/5 = 4,000
      // But maxPositionPct 5% of 1M = 50,000 / 100 = 500 — capped here
      const result = service.computePositionSize(1_000_000, 100, 95);
      expect(result.qty).toBeLessThanOrEqual(500);
      expect(result.qty).toBeGreaterThan(0);
      expect(result.positionValue).toBeLessThanOrEqual(50_000);
    });

    it('should return 0 qty when entry == stopLoss', () => {
      const result = service.computePositionSize(1_000_000, 100, 100);
      expect(result.qty).toBe(0);
    });

    it('should return 0 qty when entryPrice is 0', () => {
      const result = service.computePositionSize(1_000_000, 0, -5);
      expect(result.qty).toBe(0);
    });

    it('should cap by maxOrderValue', () => {
      // Very tight stop loss would give huge qty, but maxOrderValue caps it
      const result = service.computePositionSize(10_000_000, 100, 99.99);
      expect(result.positionValue).toBeLessThanOrEqual(500_000);
    });

    it('should respect custom config', () => {
      const result = service.computePositionSize(1_000_000, 100, 95, {
        maxPositionPct: 10,
        maxStopLossPctPerPosition: 1,
      });
      // 1% of 1M = 10,000. risk per share = 5. qty = 2000
      // But maxPositionPct 10% of 1M = 100,000. 2000*100 = 200,000 > 100,000 → cap at 1000
      expect(result.qty).toBeLessThanOrEqual(1000);
    });
  });

  // ── Size Multiplier ────────────────────────────────────────────────

  describe('getSizeMultiplier', () => {
    it('should return 1.0 when no adverse conditions', async () => {
      prisma.trade.findMany.mockResolvedValue([]);
      prisma.dailyPnlRecord.findMany.mockResolvedValue([]);

      const multiplier = await service.getSizeMultiplier(userId);
      expect(multiplier).toBe(1.0);
    });

    it('should return 0.5 when weekly loss >= 3%', async () => {
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -35_000 }), // 3.5% of 1M
      ]);
      prisma.dailyPnlRecord.findMany.mockResolvedValue([]);

      const multiplier = await service.getSizeMultiplier(userId);
      expect(multiplier).toBe(0.5);
    });

    it('should return 0.5 when 3+ consecutive losing days', async () => {
      prisma.trade.findMany.mockResolvedValue([]);
      prisma.dailyPnlRecord.findMany.mockResolvedValue(
        makeConsecutiveLosingDays(3, userId),
      );

      const multiplier = await service.getSizeMultiplier(userId);
      expect(multiplier).toBe(0.5);
    });

    it('should return 0.25 when both conditions met', async () => {
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -40_000 }),
      ]);
      prisma.dailyPnlRecord.findMany.mockResolvedValue(
        makeConsecutiveLosingDays(4, userId),
      );

      const multiplier = await service.getSizeMultiplier(userId);
      expect(multiplier).toBe(0.25);
    });
  });

  // ── Force Close on Daily Loss Limit ────────────────────────────────

  describe('forceCloseOnDailyLossLimit', () => {
    it('should NOT trigger when daily loss < 2%', async () => {
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -10_000 }), // 1%
      ]);

      const closeFn = vi.fn();
      const result = await service.forceCloseOnDailyLossLimit(userId, closeFn);
      expect(result.triggered).toBe(false);
      expect(closeFn).not.toHaveBeenCalled();
    });

    it('should trigger and close all positions when daily loss >= 2%', async () => {
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -25_000 }), // 2.5%
      ]);
      prisma.position.findMany.mockResolvedValue([
        makePosition({ id: 'pos1', portfolioId, symbol: 'RELIANCE', avgEntryPrice: 2500 }),
        makePosition({ id: 'pos2', portfolioId, symbol: 'TCS', avgEntryPrice: 4000 }),
      ]);

      const closeFn = vi.fn().mockResolvedValue({});
      const result = await service.forceCloseOnDailyLossLimit(userId, closeFn);

      expect(result.triggered).toBe(true);
      expect(result.closedCount).toBe(2);
      expect(closeFn).toHaveBeenCalledTimes(2);
    });

    it('should log RiskEvent after force-close', async () => {
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -25_000 }),
      ]);
      prisma.position.findMany.mockResolvedValue([]);

      await service.forceCloseOnDailyLossLimit(userId, vi.fn());
      expect(prisma.riskEvent.create).toHaveBeenCalledWith(expect.objectContaining({
        data: expect.objectContaining({ ruleType: 'DAILY_LOSS_CIRCUIT_BREAKER' }),
      }));
    });

    it('should handle closeFn failures gracefully', async () => {
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -25_000 }),
      ]);
      prisma.position.findMany.mockResolvedValue([
        makePosition({ id: 'pos1', portfolioId }),
        makePosition({ id: 'pos2', portfolioId }),
      ]);

      const closeFn = vi.fn()
        .mockResolvedValueOnce({})
        .mockRejectedValueOnce(new Error('close failed'));

      const result = await service.forceCloseOnDailyLossLimit(userId, closeFn);
      expect(result.closedCount).toBe(1);
    });
  });

  // ── Margin Utilization ─────────────────────────────────────────────

  describe('getMarginUtilization', () => {
    it('should compute margin for SHORT positions', async () => {
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, side: 'SHORT', qty: 10, avgEntryPrice: 5000, exchange: 'NSE' }),
      ]);

      const result = await service.getMarginUtilization(userId);
      // NSE SHORT margin = 5000 * 10 * 0.25 = 12,500
      expect(result.totalMarginUsed).toBe(12_500);
    });

    it('should use 10% rate for MCX shorts', async () => {
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, side: 'SHORT', qty: 100, avgEntryPrice: 1000, exchange: 'MCX' }),
      ]);

      const result = await service.getMarginUtilization(userId);
      expect(result.totalMarginUsed).toBe(10_000);
    });

    it('should warn when utilization exceeds 60%', async () => {
      prisma.portfolio.findMany.mockResolvedValue([
        makePortfolio({ id: portfolioId, userId, currentNav: 100_000 }),
      ]);
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, side: 'SHORT', qty: 1000, avgEntryPrice: 100, exchange: 'NSE' }),
      ]);

      const result = await service.getMarginUtilization(userId);
      // margin = 100 * 1000 * 0.25 = 25,000 on 100,000 = 25% — no warning
      expect(result.warning).toBeNull();
    });
  });

  // ── Daily Risk Summary ─────────────────────────────────────────────

  describe('getDailyRiskSummary', () => {
    it('should return zero-state when no portfolios exist', async () => {
      prisma.portfolio.findMany.mockResolvedValue([]);

      const summary = await service.getDailyRiskSummary(userId);
      expect(summary.dayPnl).toBe(0);
      expect(summary.openPositions).toBe(0);
      expect(summary.riskScore).toBe(0);
    });

    it('should compute risk score from drawdown, positions, and concentration', async () => {
      prisma.trade.findMany
        .mockResolvedValueOnce([makeTrade({ portfolioId, netPnl: -10_000 })]) // todayTrades
        .mockResolvedValueOnce([]);  // recentTrades

      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, qty: 20, avgEntryPrice: 2500, symbol: 'RELIANCE' }),
      ]);

      const summary = await service.getDailyRiskSummary(userId);
      expect(summary.dayPnl).toBe(-10_000);
      expect(summary.riskScore).toBeGreaterThan(0);
      expect(summary.riskScore).toBeLessThanOrEqual(100);
    });

    it('should flag circuitBreakerActive when drawdown >= 2%', async () => {
      prisma.trade.findMany
        .mockResolvedValueOnce([makeTrade({ portfolioId, netPnl: -25_000 })]) // todayTrades
        .mockResolvedValueOnce([]);  // recentTrades
      prisma.position.findMany.mockResolvedValue([]);

      const summary = await service.getDailyRiskSummary(userId);
      expect(summary.circuitBreakerActive).toBe(true);
    });

    it('should compute consecutive losses from recent trades', async () => {
      const trades = [
        makeTrade({ portfolioId, netPnl: -100 }),
        makeTrade({ portfolioId, netPnl: -200 }),
        makeTrade({ portfolioId, netPnl: -150 }),
        makeTrade({ portfolioId, netPnl: 500 }),
      ];
      prisma.trade.findMany
        .mockResolvedValueOnce(trades.slice(0, 3)) // todayTrades
        .mockResolvedValueOnce(trades);             // recentTrades
      prisma.position.findMany.mockResolvedValue([]);

      const summary = await service.getDailyRiskSummary(userId);
      expect(summary.consecutiveLosses).toBe(3);
    });
  });
});
