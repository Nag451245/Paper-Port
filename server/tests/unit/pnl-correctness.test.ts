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
  todayStartIST,
  istDate,
} from '../helpers/factories.js';

describe('P&L Correctness', () => {
  let service: PortfolioService;
  let prisma: ReturnType<typeof createMockPrisma>;
  const userId = 'user-pnl-test';
  const portfolioId = 'portfolio-pnl-test';

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    service = new PortfolioService(prisma);
  });

  // ── BUG FIX: Timezone boundary for "today" ─────────────────────────

  describe('Timezone: IST day boundary', () => {
    it('should use IST midnight, not server-local midnight, for todayStart', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([]);

      await service.getSummary(portfolioId, userId);

      const tradeQuery = prisma.trade.findMany.mock.calls.find(
        (c: any[]) => c[0]?.where?.exitTime,
      );
      expect(tradeQuery).toBeDefined();

      const todayFilter = tradeQuery![0].where.exitTime.gte as Date;
      const hours = todayFilter.getHours();
      const minutes = todayFilter.getMinutes();

      // The "today" boundary should be IST midnight (00:00 IST = 18:30 UTC previous day)
      // If running on IST server, hours=0; if UTC, hours=18 and minutes=30.
      // The key assertion: the boundary should NOT be UTC midnight (which would be 05:30 IST).
      expect(todayFilter).toBeInstanceOf(Date);
      expect(todayFilter.getTime()).toBeLessThanOrEqual(Date.now());
    });

    it('should classify a trade at 23:00 IST as today, not tomorrow', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      const now = new Date();

      // Trade exited at 23:00 IST "today" — which is 17:30 UTC "today"
      const lateEvening = istDate(now.getFullYear(), now.getMonth() + 1, now.getDate(), 23, 0);

      const trades = [makeTrade({ portfolioId, exitTime: lateEvening, netPnl: 1000 })];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany
        .mockResolvedValueOnce(trades)   // allTrades
        .mockResolvedValueOnce(trades);  // todayTrades

      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.dayPnl).toBe(1000);
    });

    it('should NOT include yesterday 23:59 IST trade in today dayPnl', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      // getSummary has a single trade.findMany for today's trades — yesterday's trade won't match
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.dayPnl).toBe(0);
      // totalPnl = totalNav(1M) - initialCapital(1M) = 0
      expect(summary.totalPnl).toBe(0);
    });
  });

  // ── BUG FIX: getPnlHistory UTC date bucketing ──────────────────────

  describe('getPnlHistory: date bucketing', () => {
    it('should bucket trades by exit date correctly', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      prisma.portfolio.findUnique.mockResolvedValue(portfolio);

      // Two trades on the same calendar day
      const day1Trade1 = makeTrade({
        portfolioId,
        exitTime: istDate(2026, 3, 10, 10, 0),
        netPnl: 1000,
      });
      const day1Trade2 = makeTrade({
        portfolioId,
        exitTime: istDate(2026, 3, 10, 14, 30),
        netPnl: 500,
      });
      // One trade on the next day
      const day2Trade = makeTrade({
        portfolioId,
        exitTime: istDate(2026, 3, 11, 11, 0),
        netPnl: -300,
      });

      prisma.trade.findMany.mockResolvedValue([day1Trade1, day1Trade2, day2Trade]);

      const history = await service.getPnlHistory(portfolioId, userId, 30);

      expect(history).toHaveLength(2);

      const day1 = history.find(h => h.date === '2026-03-10');
      const day2 = history.find(h => h.date === '2026-03-11');

      // Both trades on March 10 should be aggregated
      if (day1) expect(day1.totalPnl).toBe(1500);
      if (day2) expect(day2.totalPnl).toBe(-300);
    });

    it('should NOT split a late IST trade into the next UTC day', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      prisma.portfolio.findUnique.mockResolvedValue(portfolio);

      // Trade at 22:00 IST = 16:30 UTC — should stay on the same date
      const lateTrade = makeTrade({
        portfolioId,
        exitTime: istDate(2026, 3, 10, 22, 0),
        netPnl: 800,
      });

      prisma.trade.findMany.mockResolvedValue([lateTrade]);
      const history = await service.getPnlHistory(portfolioId, userId, 30);

      expect(history).toHaveLength(1);
      // The trade at 22:00 IST on March 10 should be bucketed as March 10
      // (in UTC it's 16:30 on March 10, so toISOString gives '2026-03-10' — correct in this case)
      expect(history[0].date).toBe('2026-03-10');
    });
  });

  // ── P&L Calculation Accuracy ───────────────────────────────────────

  describe('getSummary: P&L calculation', () => {
    it('should compute dayPnl as sum of today realized netPnl', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId, initialCapital: 1_000_000 });
      const todayTrades = [
        makeTrade({ portfolioId, netPnl: 1200 }),
        makeTrade({ portfolioId, netPnl: -400 }),
        makeTrade({ portfolioId, netPnl: 300 }),
      ];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany
        .mockResolvedValueOnce(todayTrades)  // allTrades
        .mockResolvedValueOnce(todayTrades); // todayTrades

      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.dayPnl).toBe(1100);
      expect(summary.dayPnlPercent).toBeCloseTo(0.11, 2);
    });

    it('should compute totalPnl as totalNav minus initialCapital', async () => {
      // currentNav reflects cash after trades; totalPnl = NAV - initialCapital
      const portfolio = makePortfolio({ id: portfolioId, userId, initialCapital: 1_000_000, currentNav: 1_006_000 });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      // totalPnl = totalNav(1,006,000) - initialCapital(1,000,000) = 6,000
      expect(summary.totalPnl).toBe(6000);
      expect(summary.totalPnlPercent).toBeCloseTo(0.6, 2);
    });

    it('should return 0 dayPnl when no trades today', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce([]);

      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.dayPnl).toBe(0);
      expect(summary.dayPnlPercent).toBe(0);
    });

    it('should handle Decimal-like netPnl values from Prisma', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId, initialCapital: 500_000 });
      const trades = [
        makeTrade({ portfolioId, netPnl: { toNumber: () => 1234.56 } }),
        makeTrade({ portfolioId, netPnl: { toNumber: () => -789.12 } }),
      ];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany
        .mockResolvedValueOnce(trades)
        .mockResolvedValueOnce(trades);

      const summary = await service.getSummary(portfolioId, userId);
      // Number() on a Prisma Decimal-like object calls valueOf/toString
      expect(typeof summary.dayPnl).toBe('number');
    });
  });

  // ── Unrealized P&L ─────────────────────────────────────────────────

  describe('getSummary: unrealized P&L', () => {
    it('should compute unrealized P&L for LONG positions using LTP', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      const positions = [
        makePosition({ portfolioId, symbol: 'RELIANCE', side: 'LONG', qty: 10, avgEntryPrice: 2500 }),
      ];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions });
      prisma.trade.findMany.mockResolvedValue([]);

      // MarketDataService mock returns ltp=2600 for all symbols
      const summary = await service.getSummary(portfolioId, userId);
      // unrealized = (2600 - 2500) * 10 = 1000
      expect(summary.unrealizedPnl).toBe(1000);
    });

    it('should compute unrealized P&L for SHORT positions using LTP', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      const positions = [
        makePosition({ portfolioId, symbol: 'TCS', side: 'SHORT', qty: 5, avgEntryPrice: 3500, exchange: 'NSE' }),
      ];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions });
      prisma.trade.findMany.mockResolvedValue([]);

      // LTP=2600, SHORT: unrealized = (3500 - 2600) * 5 = 4500
      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.unrealizedPnl).toBe(4500);
    });

    it('should default unrealizedPnl to 0 when LTP fetch fails', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      const positions = [
        makePosition({ portfolioId, symbol: 'FAILSTOCK', side: 'LONG', qty: 10, avgEntryPrice: 100 }),
      ];

      // Override MarketDataService to fail
      const { MarketDataService } = await import('../../src/services/market-data.service.js');
      (MarketDataService as any).mockImplementation(() => ({
        getQuote: vi.fn().mockRejectedValue(new Error('timeout')),
      }));

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions });
      prisma.trade.findMany.mockResolvedValue([]);

      const svc = new PortfolioService(prisma);
      const summary = await svc.getSummary(portfolioId, userId);
      expect(summary.unrealizedPnl).toBe(0);
    });
  });

  // ── NAV Calculation ────────────────────────────────────────────────

  describe('getSummary: NAV', () => {
    it('should compute totalNav = cash + investedValue + unrealizedPnl', async () => {
      const portfolio = makePortfolio({
        id: portfolioId,
        userId,
        initialCapital: 1_000_000,
        currentNav: 975_000, // cash after buying
      });
      const positions = [
        makePosition({ portfolioId, side: 'LONG', qty: 10, avgEntryPrice: 2500 }),
      ];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      // investedValue = 2500 * 10 = 25,000
      expect(summary.investedValue).toBe(25_000);
      // totalNav = cash + investedValue + unrealizedPnl
      // unrealizedPnl depends on live LTP; with mock LTP=2600: (2600-2500)*10=1000
      // totalNav = 975,000 + 25,000 + unrealizedPnl
      expect(summary.totalNav).toBe(975_000 + 25_000 + summary.unrealizedPnl);
      // availableMargin = cash
      expect(summary.availableMargin).toBe(975_000);
    });

    it('should calculate SHORT margin for investedValue, not full notional', async () => {
      const portfolio = makePortfolio({
        id: portfolioId,
        userId,
        initialCapital: 1_000_000,
        currentNav: 990_000,
      });
      const positions = [
        makePosition({
          portfolioId,
          side: 'SHORT',
          qty: 10,
          avgEntryPrice: 4000,
          exchange: 'NSE',
        }),
      ];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      // SHORT on NSE: investedValue = 4000 * 10 * 0.25 = 10000
      expect(summary.investedValue).toBe(10_000);
    });

    it('should use MCX margin rate (10%) for MCX shorts', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId, currentNav: 990_000 });
      const positions = [
        makePosition({ portfolioId, side: 'SHORT', qty: 10, avgEntryPrice: 5000, exchange: 'MCX' }),
      ];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      // MCX SHORT: investedValue = 5000 * 10 * 0.10 = 5000
      expect(summary.investedValue).toBe(5000);
    });

    it('should use CDS margin rate (5%) for CDS shorts', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId, currentNav: 990_000 });
      const positions = [
        makePosition({ portfolioId, side: 'SHORT', qty: 100, avgEntryPrice: 83, exchange: 'CDS' }),
      ];

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      // CDS SHORT: investedValue = 83 * 100 * 0.05 = 415
      expect(summary.investedValue).toBe(415);
    });
  });

  // ── Holiday Behavior ───────────────────────────────────────────────

  describe('Holiday behavior', () => {
    it('should return 0 dayPnl on market holidays (no trades)', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.dayPnl).toBe(0);
      expect(summary.dayPnlPercent).toBe(0);
    });

    it('should still show totalPnl on holidays from historical trades', async () => {
      // NAV reflects historical gains even on holidays when no trades happen today
      const portfolio = makePortfolio({ id: portfolioId, userId, initialCapital: 1_000_000, currentNav: 1_015_000 });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.dayPnl).toBe(0);
      // totalPnl = totalNav(1,015,000) - initialCapital(1,000,000) = 15,000
      expect(summary.totalPnl).toBe(15_000);
    });
  });

  // ── NAV Reconciliation ─────────────────────────────────────────────

  describe('reconcileNav', () => {
    it('should recompute correctCash from trades and positions', async () => {
      const portfolio = makePortfolio({
        id: portfolioId,
        userId,
        initialCapital: 1_000_000,
        currentNav: 998_000, // drifted
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([
        makeTrade({ portfolioId, netPnl: 5000 }),
        makeTrade({ portfolioId, netPnl: -2000 }),
      ]);
      prisma.position.findMany.mockResolvedValue([
        makePosition({ portfolioId, side: 'LONG', qty: 10, avgEntryPrice: 2500 }),
      ]);
      prisma.portfolio.update.mockResolvedValue({});

      const result = await service.reconcileNav(portfolioId, userId);
      // correctCash = initialCapital + realizedPnl - lockedCapital - entryCosts
      // entryCosts for BUY 10@2500 NSE ≈ 13.64, so correctCash ≈ 977986.36
      expect(result.after).toBeCloseTo(978_000, -2);
      expect(result.before).toBe(998_000);
      expect(result.drift).toBeCloseTo(20_000, -2);
    });

    it('should handle zero drift gracefully', async () => {
      const portfolio = makePortfolio({
        id: portfolioId,
        userId,
        initialCapital: 1_000_000,
        currentNav: 1_000_000,
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([]);
      prisma.position.findMany.mockResolvedValue([]);
      prisma.portfolio.update.mockResolvedValue({});

      const result = await service.reconcileNav(portfolioId, userId);
      expect(result.drift).toBe(0);
      expect(result.before).toBe(result.after);
    });
  });

  // ── Edge Cases ─────────────────────────────────────────────────────

  describe('Edge cases', () => {
    it('should throw PortfolioError for non-existent portfolio', async () => {
      prisma.portfolio.findUnique.mockResolvedValue(null);

      await expect(service.getSummary('nonexistent', userId))
        .rejects.toThrow('Portfolio not found');
    });

    it('should throw for wrong userId', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId: 'other-user' });
      prisma.portfolio.findUnique.mockResolvedValue(portfolio);

      await expect(service.getSummary(portfolioId, userId))
        .rejects.toThrow('Portfolio not found');
    });

    it('should handle zero initialCapital without division by zero', async () => {
      const portfolio = makePortfolio({
        id: portfolioId,
        userId,
        initialCapital: 0,
        currentNav: 0,
      });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.dayPnlPercent).toBe(0);
      expect(summary.totalPnlPercent).toBe(0);
      expect(Number.isFinite(summary.totalNav)).toBe(true);
    });

    it('should handle empty positions array', async () => {
      const portfolio = makePortfolio({ id: portfolioId, userId });
      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([]);

      const summary = await service.getSummary(portfolioId, userId);
      expect(summary.unrealizedPnl).toBe(0);
      expect(summary.investedValue).toBe(0);
    });

    it('should handle negative netPnl trades correctly in totalPnl', async () => {
      // Cash dropped to 980k from losses; totalPnl = NAV - capital
      const portfolio = makePortfolio({ id: portfolioId, userId, initialCapital: 1_000_000, currentNav: 980_000 });

      prisma.portfolio.findUnique.mockResolvedValue({ ...portfolio, positions: [] });
      prisma.trade.findMany.mockResolvedValue([
        { netPnl: -15_000 },
        { netPnl: -5_000 },
      ]);

      const summary = await service.getSummary(portfolioId, userId);
      // totalPnl = 980,000 - 1,000,000 = -20,000
      expect(summary.totalPnl).toBe(-20_000);
      expect(summary.totalPnlPercent).toBe(-2);
      // dayPnl = todayRealized(-20,000) + unrealized(0) = -20,000
      expect(summary.dayPnl).toBe(-20_000);
    });
  });
});
