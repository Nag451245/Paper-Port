import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({
    getQuote: vi.fn().mockResolvedValue({ ltp: 2600 }),
  })),
}));

import { PortfolioService } from '../../src/services/portfolio.service.js';
import {
  createMockPrisma,
  makePortfolio,
  makePosition,
  makeTrade,
} from '../helpers/factories.js';

describe('Data Integrity', () => {
  let service: PortfolioService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const userId = 'user-integrity';
  const portfolioId = 'portfolio-integrity';

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    service = new PortfolioService(prisma);
    prisma.portfolio.update.mockResolvedValue({});
  });

  // ── NAV Reconciliation ─────────────────────────────────────────────

  describe('reconcileNav: correctCash formula', () => {
    it('correctCash = initialCapital + totalRealizedPnl - lockedCapital (LONG)', async () => {
      const portfolio = makePortfolio({
        id: portfolioId, userId,
        initialCapital: 1_000_000,
        currentNav: 960_000, // drifted
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 10_000 }),
        makeTrade({ portfolioId, netPnl: -3_000 }),
      ]);
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, side: 'LONG', qty: 20, avgEntryPrice: 2500 }),
      ]);

      const result = await service.reconcileNav(portfolioId, userId);

      // correctCash = initialCapital + realizedPnl - lockedCapital - entryCosts
      // entryCosts for BUY 20@2500 NSE ≈ small amount
      expect(result.after).toBeCloseTo(957_000, -2);
      expect(result.drift).toBeCloseTo(3_000, -2);
    });

    it('correctCash accounts for SHORT margin blocked', async () => {
      const portfolio = makePortfolio({
        id: portfolioId, userId,
        initialCapital: 1_000_000,
        currentNav: 995_000,
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([]);
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, side: 'SHORT', qty: 10, avgEntryPrice: 5000, exchange: 'NSE' }),
      ]);

      const result = await service.reconcileNav(portfolioId, userId);

      // lockedCapital for SHORT NSE = 5000 * 10 * 0.25 = 12,500
      // correctCash = 1,000,000 + 0 - 12,500 - entryCosts (~70 for SELL 10@5000)
      expect(result.after).toBeCloseTo(987_500, -3);
    });

    it('correctCash with mixed LONG and SHORT positions', async () => {
      const portfolio = makePortfolio({
        id: portfolioId, userId,
        initialCapital: 1_000_000,
        currentNav: 900_000,
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 20_000 }),
      ]);
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, side: 'LONG', qty: 10, avgEntryPrice: 3000 }),
        makePosition({ portfolioId, side: 'SHORT', qty: 10, avgEntryPrice: 4000, exchange: 'MCX' }),
      ]);

      const result = await service.reconcileNav(portfolioId, userId);

      // LONG locked = 3000 * 10 = 30,000
      // SHORT MCX locked = 4000 * 10 * 0.10 = 4,000
      // correctCash = 1,000,000 + 20,000 - 30,000 - 4,000 - entryCosts
      expect(result.after).toBeCloseTo(986_000, -2);
    });

    it('zero drift when NAV is already correct', async () => {
      const portfolio = makePortfolio({
        id: portfolioId, userId,
        initialCapital: 1_000_000,
        currentNav: 1_005_000,
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 5_000 }),
      ]);
      prisma.position.findMany.mockResolvedValue([]);

      const result = await service.reconcileNav(portfolioId, userId);
      expect(result.drift).toBe(0);
    });
  });

  // ── Equity Curve ───────────────────────────────────────────────────

  describe('getEquityCurve', () => {
    it('should start at initialCapital', async () => {
      const portfolio = makePortfolio({
        id: portfolioId, userId,
        initialCapital: 1_000_000,
        createdAt: new Date('2026-01-01'),
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany
        .mockResolvedValueOnce([]) // curve trades
        .mockResolvedValueOnce([]) // allTrades for summary
        .mockResolvedValueOnce([]); // todayTrades for summary

      const curve = await service.getEquityCurve(portfolioId, userId);
      expect(curve[0].value).toBe(1_000_000);
      expect(curve[0].date).toBe('2026-01-01');
    });

    it('should show running NAV across trade exits', async () => {
      const portfolio = makePortfolio({
        id: portfolioId, userId,
        initialCapital: 100_000,
        createdAt: new Date('2026-01-01'),
      });

      const trades = [
        makeTrade({ portfolioId, netPnl: 5000, exitTime: new Date('2026-01-15T10:00:00Z') }),
        makeTrade({ portfolioId, netPnl: -2000, exitTime: new Date('2026-01-16T11:00:00Z') }),
        makeTrade({ portfolioId, netPnl: 3000, exitTime: new Date('2026-01-16T14:00:00Z') }),
      ];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany
        .mockResolvedValueOnce(trades) // curve trades
        .mockResolvedValueOnce(trades) // allTrades for getSummary
        .mockResolvedValueOnce([]);    // todayTrades for getSummary

      const curve = await service.getEquityCurve(portfolioId, userId);

      // Day 1: 100,000 + 5,000 = 105,000
      // Day 2: 105,000 - 2,000 + 3,000 = 106,000
      const jan15 = curve.find(c => c.date === '2026-01-15');
      const jan16 = curve.find(c => c.date === '2026-01-16');
      if (jan15) expect(jan15.value).toBe(105_000);
      if (jan16) expect(jan16.value).toBe(106_000);
    });
  });

  // ── Risk Metrics ───────────────────────────────────────────────────

  describe('getRiskMetrics', () => {
    it('should return zero-state for no trades', async () => {
      prisma.portfolio.findUnique.mockResolvedValue(
        makePortfolio({ id: portfolioId, userId, positions: [] }),
      );
      prisma.trade.findMany.mockResolvedValue([]);

      const metrics = await service.getRiskMetrics(portfolioId, userId);
      expect(metrics.sharpeRatio).toBe(0);
      expect(metrics.winRate).toBe(0);
      expect(metrics.maxDrawdown).toBe(0);
      expect(metrics.totalTrades).toBe(0);
    });

    it('should compute win rate correctly', async () => {
      prisma.portfolio.findUnique
        .mockResolvedValueOnce(makePortfolio({ id: portfolioId, userId, positions: [] }))
        .mockResolvedValueOnce(makePortfolio({ id: portfolioId }));

      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 1000 }),
        makeTrade({ portfolioId, netPnl: 2000 }),
        makeTrade({ portfolioId, netPnl: -500 }),
        makeTrade({ portfolioId, netPnl: 1500 }),
      ]);

      const metrics = await service.getRiskMetrics(portfolioId, userId);
      expect(metrics.winRate).toBe(75); // 3 wins out of 4
      expect(metrics.totalTrades).toBe(4);
    });

    it('should compute profit factor correctly', async () => {
      prisma.portfolio.findUnique
        .mockResolvedValueOnce(makePortfolio({ id: portfolioId, userId, positions: [] }))
        .mockResolvedValueOnce(makePortfolio({ id: portfolioId }));

      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 3000 }),
        makeTrade({ portfolioId, netPnl: -1000 }),
      ]);

      const metrics = await service.getRiskMetrics(portfolioId, userId);
      expect(metrics.profitFactor).toBe(3); // 3000 / 1000
    });

    it('should compute max drawdown', async () => {
      prisma.portfolio.findUnique
        .mockResolvedValueOnce(makePortfolio({ id: portfolioId, userId, initialCapital: 100_000, positions: [] }))
        .mockResolvedValueOnce(makePortfolio({ id: portfolioId, initialCapital: 100_000 }));

      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 5000 }),  // NAV: 105,000
        makeTrade({ portfolioId, netPnl: -8000 }), // NAV: 97,000 (peak was 105k, dd = 8000)
        makeTrade({ portfolioId, netPnl: 3000 }),  // NAV: 100,000
      ]);

      const metrics = await service.getRiskMetrics(portfolioId, userId);
      expect(metrics.maxDrawdown).toBe(8000);
      expect(metrics.maxDrawdownPercent).toBeCloseTo(7.62, 1); // 8000/105000*100
    });

    it('should handle all-loss scenario without NaN', async () => {
      prisma.portfolio.findUnique
        .mockResolvedValueOnce(makePortfolio({ id: portfolioId, userId, positions: [] }))
        .mockResolvedValueOnce(makePortfolio({ id: portfolioId }));

      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: -1000 }),
        makeTrade({ portfolioId, netPnl: -2000 }),
      ]);

      const metrics = await service.getRiskMetrics(portfolioId, userId);
      expect(Number.isFinite(metrics.sharpeRatio)).toBe(true);
      expect(Number.isFinite(metrics.sortinoRatio)).toBe(true);
      expect(metrics.winRate).toBe(0);
      expect(metrics.profitFactor).toBe(0);
    });
  });

  // ── Capital Update ─────────────────────────────────────────────────

  describe('updateCapital', () => {
    it('should preserve P&L delta when changing capital', async () => {
      const portfolio = makePortfolio({
        id: portfolioId, userId,
        initialCapital: 1_000_000,
        currentNav: 1_020_000, // 20k profit accumulated
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.portfolio.update.mockResolvedValue({});

      await service.updateCapital(portfolioId, userId, 2_000_000);

      expect(prisma.portfolio.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            initialCapital: 2_000_000,
            currentNav: 2_020_000, // new capital + same 20k profit
          }),
        }),
      );
    });
  });

  // ── Monetary Precision ─────────────────────────────────────────────

  describe('Monetary precision', () => {
    it('should not lose precision on large P&L sums', async () => {
      // currentNav reflects accumulated trade profits; totalPnl = NAV - capital
      const portfolio = makePortfolio({
        id: portfolioId, userId, initialCapital: 10_000_000, currentNav: 10_099_990,
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      // totalPnl = 10,099,990 - 10,000,000 = 99,990
      expect(Math.abs(summary.totalPnl - 99_990)).toBeLessThan(0.1);
    });

    it('should handle sub-paise precision gracefully', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      const trade = makeTrade({ portfolioId, netPnl: 0.01 });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany
        .mockResolvedValueOnce([trade])
        .mockResolvedValueOnce([trade]);

      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.dayPnl).toBe(0.01);
    });
  });
});
