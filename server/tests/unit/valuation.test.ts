import { describe, it, expect, vi } from 'vitest';
import { ValuationService, lastSessionClose } from '../../src/services/valuation.service.js';
import { RiskService } from '../../src/services/risk.service.js';

// Sunday 4 Oct 2026, 21:50 IST: the market closed on Friday at 15:30.
const NOW = new Date('2026-10-04T16:20:00Z');
const FRIDAY_CLOSE = new Date('2026-10-02T10:00:00Z');

function db(positions: any[], portfolio = { id: 'pf', userId: 'u1', initialCapital: 1_000_000, currentNav: 600_000 }) {
  return {
    portfolio: { findMany: vi.fn(async () => [portfolio]) },
    position: {
      findMany: vi.fn(async () => positions),
      update: vi.fn(async ({ where, data }: any) => Object.assign(positions.find((p) => p.id === where.id), data)),
    },
    trade: { findMany: vi.fn(async () => []) },
  } as any;
}
const long = (id: string, symbol: string, qty: number, entry: number, extra: object = {}) =>
  ({ id, portfolioId: 'pf', symbol, exchange: 'NSE', side: 'LONG', status: 'OPEN', qty, avgEntryPrice: entry, ...extra });

describe('one valuation for every page', () => {
  it('knows when the market last closed', () => {
    expect(lastSessionClose(NOW).toISOString()).toBe(FRIDAY_CLOSE.toISOString());
    expect(lastSessionClose(new Date('2026-10-06T05:00:00Z')).toISOString()).toBe('2026-10-05T10:00:00.000Z');   // Tuesday morning → Monday's close
  });

  it('adds up capital, cash, capital in use, open P&L and net worth', async () => {
    const positions = [long('a', 'AAA', 100, 1000), long('b', 'BBB', 100, 3000)];
    const quote = vi.fn(async (s: string) => ({ ltp: s === 'AAA' ? 1100 : 2900 }));
    const v = await new ValuationService(db(positions), quote, () => false, () => NOW).forUser('u1');
    expect(v).toMatchObject({
      capital: 1_000_000, cash: 600_000, capitalInUse: 400_000, openPnl: 0,
      netWorth: 1_000_000, totalPnl: 0, marketValue: 400_000, unpriced: 0,
    });
  });

  it('after the close, the price saved on the position is used: the same figure on every refresh, with no lookups', async () => {
    const positions = [long('a', 'AAA', 100, 1000)];
    const quote = vi.fn(async () => ({ ltp: 1100 }));
    const svc = new ValuationService(db(positions), quote, () => false, () => NOW);

    const first = await svc.forUser('u1');
    expect(first.openPnl).toBe(10_000);
    expect(positions[0].lastPrice).toBe(1100);                  // saved for next time

    quote.mockResolvedValue({ ltp: 1093 });                    // another source would now say something else
    const second = await svc.forUser('u1');
    const third = await svc.forUser('u1');
    expect([second.openPnl, third.openPnl]).toEqual([10_000, 10_000]);
    expect(quote).toHaveBeenCalledTimes(1);
  });

  it('a price lookup that fails falls back to the saved price, so the profit does not jump', async () => {
    const positions = [
      long('a', 'AAA', 100, 1000, { lastPrice: 1100, lastPriceAt: new Date('2026-09-30T10:00:00Z') }),   // saved before the last close
      long('b', 'BBB', 100, 3000),
    ];
    const quote = vi.fn(async (s: string) => { if (s === 'AAA') throw new Error('timeout'); return { ltp: 3050 }; });
    const v = await new ValuationService(db(positions), quote, () => false, () => NOW).forUser('u1');
    expect(v.positions.map((p) => [p.symbol, p.price, p.priceSource])).toEqual([['AAA', 1100, 'saved'], ['BBB', 3050, 'live']]);
    expect(v.openPnl).toBe(15_000);
    expect(v.unpriced).toBe(0);
  });

  it('a position with no price at all is valued at its entry and counted as unpriced, never dropped', async () => {
    const v = await new ValuationService(db([long('a', 'AAA', 100, 1000)]), async () => { throw new Error('down'); }, () => false, () => NOW).forUser('u1');
    expect(v).toMatchObject({ openPnl: 0, capitalInUse: 100_000, netWorth: 700_000, unpriced: 1 });
  });

  it('a sold option counts its margin as capital in use', async () => {
    const short = { id: 's', portfolioId: 'pf', symbol: 'NIFTY2026100622400PE', exchange: 'NFO', side: 'SHORT', status: 'OPEN', qty: 65, avgEntryPrice: 100, marginBlocked: 167_440 };
    const v = await new ValuationService(db([short]), async () => ({ ltp: 60 }), () => false, () => NOW).forUser('u1');
    expect(v.capitalInUse).toBe(167_440);
    expect(v.openPnl).toBe(40 * 65);
  });
});

describe('the Risk page uses the same valuation', () => {
  const positions = [long('a', 'AAA', 100, 1000, { lastPrice: 1100, lastPriceAt: NOW }), long('b', 'BBB', 100, 3000, { lastPrice: 2900, lastPriceAt: NOW })];

  it('exposure is the open positions at current prices; capital in use and free cash match the Dashboard', async () => {
    const prisma = db(positions);
    const risk = new RiskService(prisma);
    risk.livePrices = () => ({ AAA: 1100, BBB: 2900 });
    const v = await risk.valuation('u1');
    const [daily, margin] = [await risk.getDailyRiskSummary('u1'), await risk.getMarginUtilization('u1')];
    expect(daily.totalExposure).toBe(v.marketValue);
    expect(daily.openPositions).toBe(2);
    expect(margin.totalMarginUsed).toBe(v.capitalInUse);
    expect(margin.totalMarginAvailable).toBe(v.cash);
    expect(margin.utilizationPct).toBe(40);                     // ₹4,00,000 of ₹10,00,000
    expect(margin.positions.map((p) => p.symbol)).toEqual(['BBB', 'AAA']);   // every position, largest first
  });

  it('Value at Risk comes from the positions\' own price history, not assumed volatilities', async () => {
    const risk = new RiskService(db(positions));
    risk.livePrices = () => ({ AAA: 1100, BBB: 2900 });           // prices from the feed: no lookups, whatever the time
    // 100 trading days: AAA falls 2% every tenth day and is flat otherwise; BBB never moves.
    risk.dailyCloses = async (symbol) => {
      let close = 1000;
      return Array.from({ length: 101 }, (_, i) => {
        if (symbol === 'AAA' && i > 0 && i % 10 === 0) close *= 0.98;
        return { day: new Date(Date.UTC(2026, 0, 1 + i)).toISOString().slice(0, 10), close };
      });
    };
    const out = await risk.getPortfolioVaR('u1');
    // AAA is worth ₹1,10,000: a 2% fall is ₹2,200, and it happens on 10% of days.
    expect(out.var95).toBeCloseTo(2_200, 0);
    expect(out.var99).toBeCloseTo(2_200, 0);
    expect(out.expectedShortfall).toBeCloseTo(2_200, 0);
    expect(out.portfolioValue).toBe((await risk.valuation('u1')).netWorth);
    expect(out.days).toBe(100);
    expect(out.basis).toMatch(/actual price moves of the last 100 trading days/);
  });

  it('says so when there is not enough history, and returns no made-up figure', async () => {
    const risk = new RiskService(db(positions));
    risk.livePrices = () => ({ AAA: 1100, BBB: 2900 });           // prices from the feed: no lookups, whatever the time
    risk.dailyCloses = async () => [];
    const out = await risk.getPortfolioVaR('u1');
    expect(out.var95).toBe(0);
    expect(out.excluded).toBe(2);
    expect(out.basis).toMatch(/Not enough price history/);
  });
});
