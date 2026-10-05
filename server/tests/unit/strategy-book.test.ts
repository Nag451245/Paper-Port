import { describe, it, expect } from 'vitest';
import { buildStrategyCard, isDerivativeGroup } from '../../src/lib/strategy-book.js';
import { bsPrice, impliedVol, greeks } from '../../src/lib/option-greeks.js';

const now = new Date('2026-10-05T05:00:00Z');                    // 10:30 IST, the day before expiry
const expiry = new Date('2026-10-05T18:30:00Z');                 // 6 Oct, IST midnight
const pos = (id: string, symbol: string, side: string, entry: number, over: Record<string, unknown> = {}) => ({
  id, symbol, exchange: 'NFO', side, qty: 65, avgEntryPrice: entry, strategyTag: 'STRAT:Short Straddle · 05 Oct, 10:24:04',
  openedAt: now, marginBlocked: null, instrumentType: 'OPTIONS', underlying: 'NIFTY', expiry, strike: 22_550, optionType: symbol.slice(-2), ...over,
});
const straddle = [pos('c', 'NIFTY2026100622550CE', 'SHORT', 106, { marginBlocked: 168_000 }), pos('p', 'NIFTY2026100622550PE', 'SHORT', 94, { marginBlocked: 29_000 })];
const valued = new Map([['c', { price: 95, pnl: 715, priceSource: 'live' }], ['p', { price: 98, pnl: -260, priceSource: 'live' }]]);

describe('option maths', () => {
  it('recovers the volatility a price was made with, and put-call parity holds', () => {
    const o = { type: 'CE' as const, spot: 22_500, strike: 22_550, days: 1.2, sigma: 0.14 };
    expect(impliedVol(bsPrice(o), o)!).toBeCloseTo(0.14, 4);
    const call = bsPrice(o), put = bsPrice({ ...o, type: 'PE' });
    expect(call - put).toBeCloseTo(22_500 - 22_550 * Math.exp(-0.065 * 1.2 / 365), 4);
    expect(impliedVol(0.01, { type: 'CE', spot: 23_000, strike: 22_000, days: 1 })).toBeNull();   // below intrinsic value
  });

  it('gives Greeks with the expected signs and sizes', () => {
    const g = greeks({ type: 'CE', spot: 22_550, strike: 22_550, days: 1.2, sigma: 0.14 });
    expect(g.delta).toBeGreaterThan(0.45); expect(g.delta).toBeLessThan(0.6);
    expect(g.theta).toBeLessThan(0); expect(g.vega).toBeGreaterThan(0); expect(g.gamma).toBeGreaterThan(0);
    expect(greeks({ type: 'PE', spot: 22_550, strike: 22_550, days: 1.2, sigma: 0.14 }).delta).toBeLessThan(0);
  });
});

describe('strategy card', () => {
  it('describes a short straddle: payoff, Greeks and a plain reading', () => {
    const card = buildStrategyCard({ strategyTag: straddle[0].strategyTag, positions: straddle, valued, spot: 22_540, chargesPaid: 71, now });
    expect(card).toMatchObject({ owner: 'user', underlying: 'NIFTY', expiry: '2026-10-06', openPnl: 455, marginBlocked: 197_000 });
    expect(card.name).toBe('Short Straddle · 05 Oct, 10:24:04');
    // Most it can make is the premium taken in, less charges; the loss is open-ended.
    expect(card.payoff!.maxProfit).toBeCloseTo((106 + 94) * 65 - 71, 1);
    expect(card.payoff!.unlimitedLoss).toBe(true);
    expect(card.payoff!.breakevens).toHaveLength(2);
    // At the strike, held to expiry, it keeps everything; today it is worth less than that.
    const at = card.payoff!.curve.find((c) => c.spot === 22_550)!;
    expect(at.atExpiry).toBeCloseTo(card.payoff!.maxProfit, 1);
    expect(at.today).toBeLessThan(at.atExpiry);
    // Sold options: time helps, volatility hurts.
    expect(card.greeks!.theta).toBeGreaterThan(0);
    expect(card.greeks!.vega).toBeLessThan(0);
    expect(card.reading.join(' ')).toMatch(/Time is on your side/);
    expect(card.reading.join(' ')).toMatch(/not capped on the upside/);
  });

  it('shows what adding a bought call would do before it is placed', () => {
    const card = buildStrategyCard({
      strategyTag: straddle[0].strategyTag, positions: straddle, valued, spot: 22_540, now,
      extra: [{ type: 'CE', strike: 22_800, action: 'BUY', qty: 65, premium: 12 }],
    });
    expect(card.legs).toHaveLength(3);
    expect(card.legs[2]).toMatchObject({ proposed: true, side: 'LONG', positionId: null });
    expect(card.payoff!.unlimitedLoss).toBe(false);                 // the upside is now capped
    expect(card.openPnl).toBe(455);                                 // the open legs' P&L is unchanged
  });

  it('handles a leg added in a later week: the chart is read on the nearest expiry', () => {
    const same = buildStrategyCard({ strategyTag: straddle[0].strategyTag, positions: straddle, valued, spot: 22_540, now });
    const card = buildStrategyCard({
      strategyTag: straddle[0].strategyTag, positions: straddle, valued, spot: 22_540, now,
      extra: [{ type: 'CE', strike: 22_800, action: 'BUY', qty: 65, premium: 60, expiry: '2026-10-13' }],
    });
    expect(card.expiry).toBe('2026-10-06');                         // the nearest
    expect(card.expiries).toEqual(['2026-10-06', '2026-10-13']);
    expect(card.legs[2]).toMatchObject({ expiry: '2026-10-13', proposed: true });
    expect(card.legs[2].days!).toBeGreaterThan(card.legs[0].days! + 6.9);
    // The later call still has time value on the near expiry, so far above the
    // strikes the position does better than the bare straddle, by more than the
    // call's payoff alone would give.
    const far = (c: typeof card) => c.payoff!.curve[c.payoff!.curve.length - 1];
    const top = far(card).spot;
    expect(far(card).atExpiry).toBeGreaterThan(same.payoff!.curve.find((p) => p.spot === top)?.atExpiry ?? -Infinity);
    expect(far(card).atExpiry).toBeGreaterThan(-(top - 22_550) * 65 + (106 + 94) * 65 + ((top - 22_800) - 60) * 65);
    expect(card.payoff!.unlimitedLoss).toBe(false);                 // the bought call covers the sold one
    expect(card.payoff!.pop).toBeGreaterThan(0);
    expect(card.payoff!.pop).toBeLessThanOrEqual(1);
    expect(card.reading[0]).toMatch(/Legs expire on different dates/);
    // Same-week strategies are untouched by this path.
    expect(same.expiries).toEqual(['2026-10-06']);
    expect(same.reading[0]).toBe('Expires tomorrow.');
  });

  it('says so when there is no price for the underlying, instead of drawing a chart', () => {
    const card = buildStrategyCard({ strategyTag: 'BOT:condor', positions: straddle.map((p) => ({ ...p, strategyTag: 'BOT:condor' })), valued, spot: null, now });
    expect(card.owner).toBe('algo');
    expect(card.payoff).toBeNull();
    expect(card.note).toMatch(/No price for NIFTY/);
  });

  it('a group of shares is not a derivative strategy', () => {
    expect(isDerivativeGroup([pos('e', 'SBIN', 'SHORT', 964, { instrumentType: 'EQUITY', optionType: null, strike: null, expiry: null, exchange: 'NSE' })])).toBe(false);
    expect(isDerivativeGroup(straddle)).toBe(true);
  });
});
