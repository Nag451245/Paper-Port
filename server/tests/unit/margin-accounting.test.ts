import { describe, it, expect, beforeEach } from 'vitest';
import { TradeService } from '../../src/services/trade.service.js';
import { nakedOptionMargin, spreadMargin, exposureMargin, futuresMargin, capitalBlocked } from '../../src/lib/margin.js';

/** A tiny in-memory database: just what the fill code reads and writes. */
function memoryDb(startCash: number) {
  const positions: any[] = [];
  const trades: any[] = [];
  const portfolio = { id: 'pf', userId: 'u1', currentNav: startCash, initialCapital: startCash };
  let n = 0;
  const match = (p: any, where: any) => Object.entries(where).every(([k, v]) => {
    if (v && typeof v === 'object' && !(v instanceof Date) && 'in' in (v as any)) return (v as any).in.includes(p[k]);
    if (v instanceof Date) return p[k] instanceof Date && p[k].getTime() === v.getTime();
    return p[k] === v;
  });
  const apply = (row: any, data: any) => {
    for (const [k, v] of Object.entries(data)) {
      if (v && typeof v === 'object' && !(v instanceof Date) && 'increment' in (v as any)) row[k] = Number(row[k] ?? 0) + (v as any).increment;
      else row[k] = v;
    }
    return row;
  };
  const db: any = {
    position: {
      findFirst: async ({ where }: any) => positions.find((p) => match(p, where)) ?? null,
      findMany: async ({ where }: any) => positions.filter((p) => match(p, where)),
      create: async ({ data }: any) => { const row = { id: `pos${++n}`, status: 'OPEN', openedAt: new Date(), ...data }; positions.push(row); return row; },
      update: async ({ where, data }: any) => apply(positions.find((p) => p.id === where.id), data),
    },
    portfolio: {
      findUnique: async () => portfolio,
      update: async ({ data }: any) => apply(portfolio, data),
    },
    order: { update: async () => ({}) },
    trade: { create: async ({ data }: any) => { trades.push(data); return data; } },
  };
  return { db, positions, trades, portfolio };
}

const SPOT = 22_400, LOT = 65;
const opt = (strike: number, type: 'CE' | 'PE', side: 'BUY' | 'SELL', qty = LOT) => ({
  portfolioId: 'pf', symbol: `NIFTY20261006${strike}${type}`, side, orderType: 'MARKET' as const, qty,
  instrumentToken: 't', exchange: 'NFO' as const, strike, optionType: type, expiry: '2026-10-06', underlyingSpot: SPOT,
});
const noCost = { brokerage: 0, stt: 0, exchangeCharges: 0, gst: 0, sebiCharges: 0, stampDuty: 0, totalCost: 0 };

describe('margin rules (lib/margin.ts)', () => {
  const atm = { underlying: 'NIFTY', exchange: 'NFO', optionType: 'PE' as const, strike: 22_400, qty: LOT, spot: SPOT };

  it('a sold index option at the money blocks about 11.5% of the contract value', () => {
    expect(nakedOptionMargin(atm)).toBeCloseTo(0.115 * SPOT * LOT, 0);          // ≈ ₹1.67 lakh a lot
    // Further out of the money costs less, but never under 6%.
    expect(nakedOptionMargin({ ...atm, strike: 22_000 })).toBeCloseTo((0.115 * SPOT - 400) * LOT, 0);
    expect(nakedOptionMargin({ ...atm, strike: 20_000 })).toBeCloseTo(0.06 * SPOT * LOT, 0);
    // A stock option is dearer.
    expect(nakedOptionMargin({ ...atm, underlying: 'RELIANCE' })).toBeCloseTo(0.20 * SPOT * LOT, 0);
  });

  it('a protected sale blocks the most the pair can lose plus exposure margin', () => {
    expect(spreadMargin(atm, 22_200)).toBeCloseTo(200 * LOT + 0.02 * SPOT * LOT, 0);   // ≈ ₹42,000
    expect(spreadMargin(atm, 10_000)).toBe(nakedOptionMargin(atm));                    // protection too far away: no benefit
    expect(exposureMargin(atm)).toBeCloseTo(0.02 * SPOT * LOT, 0);
  });

  it('futures block 12% (index) or 20% (stock) of contract value, not the whole of it', () => {
    expect(futuresMargin(22_500, LOT, 'NFO', 'NIFTY')).toBeCloseTo(0.12 * 22_500 * LOT, 0);
    expect(futuresMargin(1_200, 500, 'NFO', 'RELIANCE')).toBeCloseTo(0.20 * 1_200 * 500, 0);
  });

  it('positions from before margins were stored keep the old rule', () => {
    expect(capitalBlocked({ side: 'SHORT', qty: 65, avgEntryPrice: 100, exchange: 'NFO' })).toBe(100 * 65 * 0.25);
    expect(capitalBlocked({ side: 'SHORT', qty: 65, avgEntryPrice: 100, exchange: 'NFO', marginBlocked: 167_440 })).toBe(167_440);
    expect(capitalBlocked({ side: 'LONG', qty: 10, avgEntryPrice: 500 })).toBe(5_000);
  });
});

describe('margin through a whole trade', () => {
  let m: ReturnType<typeof memoryDb>;
  let svc: any;
  beforeEach(() => { m = memoryDb(1_000_000); svc = new TradeService(m.db); });
  const sell = (input: any, price: number, qty = input.qty) => svc.handleSellFill('o', input, price, noCost, qty, m.db);
  const buy = (input: any, price: number, qty = input.qty) => svc.handleBuyFill('o', input, price, noCost, qty, m.db);

  it('selling an option alone blocks the unprotected margin and gives it all back on closing', async () => {
    await sell(opt(22_400, 'PE', 'SELL'), 100);
    const naked = 0.115 * SPOT * LOT;
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000 - naked, 2);
    expect(Number(m.positions[0].marginBlocked)).toBeCloseTo(naked, 2);

    await buy(opt(22_400, 'PE', 'BUY'), 60);                                    // bought back ₹40 lower
    expect(m.positions[0].status).toBe('CLOSED');
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000 + 40 * LOT, 2);
  });

  it('covering half releases half the margin', async () => {
    await sell(opt(22_400, 'PE', 'SELL', 130), 100);
    const blocked = Number(m.positions[0].marginBlocked);
    await buy(opt(22_400, 'PE', 'BUY', 65), 100, 65);
    expect(Number(m.positions[0].marginBlocked)).toBeCloseTo(blocked / 2, 2);
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000 - blocked / 2, 2);
  });

  it('a spread blocks far less; selling the protection first raises the margin to the unprotected figure', async () => {
    await buy(opt(22_200, 'PE', 'BUY'), 50);                                    // protection, paid in full
    await sell(opt(22_400, 'PE', 'SELL'), 100);
    const spread = 200 * LOT + 0.02 * SPOT * LOT;
    const short = m.positions.find((p) => p.side === 'SHORT');
    expect(Number(short.marginBlocked)).toBeCloseTo(spread, 2);
    expect(short.marginLinkId).toBe(m.positions.find((p) => p.side === 'LONG').id);
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000 - 50 * LOT - spread, 2);

    await sell(opt(22_200, 'PE', 'SELL'), 50);                                  // the protection is sold
    const naked = 0.115 * SPOT * LOT;
    expect(Number(short.marginBlocked)).toBeCloseTo(naked, 2);
    expect(short.marginLinkId).toBeNull();
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000 - naked, 2);

    await buy(opt(22_400, 'PE', 'BUY'), 100);                                   // flat: every rupee is back
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000, 2);
  });

  it('a straddle charges the second leg only exposure margin, until the first leg is closed', async () => {
    await sell(opt(22_400, 'CE', 'SELL'), 150);
    await sell(opt(22_400, 'PE', 'SELL'), 100);
    const [call, put] = m.positions;
    expect(Number(put.marginBlocked)).toBeCloseTo(0.02 * SPOT * LOT, 2);
    expect(put.marginLinkId).toBe(call.id);
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000 - (0.115 + 0.02) * SPOT * LOT, 2);   // ≈ ₹1.97 lakh for the pair

    await buy(opt(22_400, 'CE', 'BUY'), 150);
    expect(Number(put.marginBlocked)).toBeCloseTo(0.115 * SPOT * LOT, 2);
    await buy(opt(22_400, 'PE', 'BUY'), 100);
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000, 2);
  });

  it('a future is bought on margin and returns the margin plus the gain', async () => {
    const fut = (side: 'BUY' | 'SELL') => ({ portfolioId: 'pf', symbol: 'NIFTY20261027FUT', side, orderType: 'MARKET' as const, qty: LOT, instrumentToken: 't', exchange: 'NFO' as const });
    await buy(fut('BUY'), 22_500);
    const margin = 0.12 * 22_500 * LOT;
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000 - margin, 2);           // not the ₹14.6 lakh contract value
    await sell(fut('SELL'), 22_600);
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000 + 100 * LOT, 2);
  });

  it('a short opened before margins were stored is released by the old rule, so no cash appears or vanishes', async () => {
    m.positions.push({ id: 'old', portfolioId: 'pf', symbol: 'NIFTY2026100622400PE', side: 'SHORT', status: 'OPEN', qty: LOT, avgEntryPrice: 100, exchange: 'NFO', openedAt: new Date() });
    m.portfolio.currentNav = 1_000_000 - 100 * LOT * 0.25;                       // what the old rule had blocked
    await buy(opt(22_400, 'PE', 'BUY'), 100);
    expect(m.portfolio.currentNav).toBeCloseTo(1_000_000, 2);
  });
});
