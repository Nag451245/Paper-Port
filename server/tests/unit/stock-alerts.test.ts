import { describe, it, expect, vi, beforeEach } from 'vitest';
import { StockAlertService, ALERT_LIMITS } from '../../src/services/stock-alerts.service.js';
import { stockStats } from '../../src/lib/alert-math.js';
import { history } from '../helpers/price-history.js';

const { market, stock } = history();
const stats = stockStats(stock, market)!;
const prev = stock[stock.length - 1].close;
const niftyPrev = market[market.length - 1].close;
const MARKET_R = 0.005;
/** Price with a stock-specific move of `z` residual standard deviations today. */
const priceAt = (z: number) => prev * Math.exp(stats.alpha + stats.beta * MARKET_R + z * stats.residualSd);

const quote = (ltp: number, prevClose: number, volume: number) => ({ ltp, change: ltp - prevClose, volume }) as any;
const QUOTES: Record<string, any> = {
  NIFTY: quote(niftyPrev * Math.exp(MARKET_R), niftyPrev, 0),
  SURGE: quote(priceAt(4), prev, 1_500_000),
  DROP: quote(priceAt(-3), prev, 2_000_000),
  QUIET: quote(priceAt(0.5), prev, 1_500_000),
  LATER: quote(priceAt(5), prev, 3_000_000),
};

const at = (hhmm: string) => new Date(`2026-10-01T${hhmm}:00+05:30`);

function setup() {
  let now = at('12:00');
  const rows: any[] = [];
  const prisma = {
    user: { findMany: vi.fn().mockResolvedValue([{ id: 'u1' }]) },
    stockAlert: {
      findMany: vi.fn(async ({ where }: any) => rows
        .filter((r) => r.userId === where.userId && r.day === where.day)
        .sort((a, b) => b.createdAt - a.createdAt)),
      create: vi.fn(async ({ data }: any) => { rows.push({ ...data, createdAt: now }); }),
    },
  } as any;
  const sent: string[] = [];
  const marketData = {
    getHistory: vi.fn(async (symbol: string) => (symbol === 'NIFTY' ? market : stock)),
    getQuote: vi.fn(async (symbol: string) => QUOTES[symbol]),
  };
  const svc = new StockAlertService(prisma, {
    market: marketData as any,
    telegram: { notifyUser: vi.fn(async (_u: string, title: string, msg: string) => { sent.push(`${title}\n${msg}`); return true; }) },
    movers: async () => ({ gainers: [{ symbol: 'SURGE' } as any, { symbol: 'QUIET' } as any], losers: [{ symbol: 'DROP' } as any] }),
    now: () => now,
  });
  return { svc, rows, sent, marketData, setNow: (d: Date) => { now = d; } };
}

describe('StockAlertService', () => {
  let t: ReturnType<typeof setup>;
  beforeEach(() => { t = setup(); });

  it('sends one digest with only the stocks that pass, strongest first, and records them', async () => {
    t.svc.offer('SURGE', 'BUY', 'rust-engine');
    t.svc.offer('QUIET', 'BUY', 'composite');
    const res = await t.svc.run();
    expect(res.picks.map((p) => p.symbol)).toEqual(['SURGE', 'DROP']);
    expect(t.sent).toHaveLength(1);
    expect(t.sent[0]).toMatch(/📊 2 stock alerts/);
    expect(t.sent[0]).toMatch(/BUY SURGE[\s\S]*4\.0σ beyond what NIFTY explains[\s\S]*Flagged by: Rust engine, NSE movers list/);
    expect(t.sent[0]).toMatch(/SELL DROP/);
    expect(t.sent[0]).not.toMatch(/QUIET/);
    expect(t.rows.map((r) => r.symbol)).toEqual(['SURGE', 'DROP']);
  });

  it('never repeats a stock the same day, and keeps a gap between messages', async () => {
    await t.svc.run();
    t.setNow(at('12:05'));
    t.svc.offer('LATER', 'BUY', 'rust-engine');
    await t.svc.run();
    expect(t.sent).toHaveLength(1);                      // too soon after the last message

    t.setNow(at('12:40'));
    t.svc.offer('LATER', 'BUY', 'rust-engine');
    await t.svc.run();
    expect(t.sent).toHaveLength(2);
    expect(t.sent[1]).toMatch(/LATER/);
    expect(t.sent[1]).not.toMatch(/SURGE|DROP/);         // already sent today

    t.setNow(at('13:30'));
    await t.svc.run();
    expect(t.sent).toHaveLength(2);                      // nothing new: stays quiet
  });

  it('stops at the daily limit', async () => {
    for (let i = 0; i < ALERT_LIMITS.maxPerDay; i++) {
      t.rows.push({ userId: 'u1', symbol: `OLD${i}`, day: '2026-10-01', createdAt: at('09:40') });
    }
    await t.svc.run();
    expect(t.sent).toHaveLength(0);
  });

  it('rejects a signal whose side disagrees with the move', async () => {
    t.svc.offer('SURGE', 'SELL', 'rust-engine');
    const res = await t.svc.run();
    expect(res.picks.map((p) => p.symbol)).toEqual(['DROP']);
  });

  it('stays silent in the first 15 minutes and the last 10', async () => {
    for (const time of ['09:20', '15:25']) {
      t.setNow(at(time));
      await t.svc.run();
    }
    expect(t.sent).toHaveLength(0);
    expect(t.marketData.getQuote).not.toHaveBeenCalled();
  });

  it('ignores indices, F&O contracts and signals without a side', async () => {
    t.svc.offer('NIFTY', 'BUY', 'rust-engine');
    t.svc.offer('NIFTY2026102924000CE', 'BUY', 'rust-engine');
    t.svc.offer('LATER', 'NEUTRAL', 'volume_anomaly');
    const res = await t.svc.run();
    expect(res.picks.map((p) => p.symbol)).toEqual(['SURGE', 'DROP']);
  });
});
