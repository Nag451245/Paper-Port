import { describe, it, expect } from 'vitest';
import { buildIdeas, fitOf, type ChainRow } from '../../src/lib/strategy-ideas.js';
import { bsPrice } from '../../src/lib/option-greeks.js';
import { fnoRatesOn } from '../../src/lib/fno-charges.js';

const SPOT = 22_500, DAYS = 6;
const rates = fnoRatesOn('2026-10-05', { underlying: 'NIFTY' });

/** A chain priced by Black-Scholes at one volatility, with a 1-rupee bid-ask spread and open interest. */
const chain = (iv: number, over: (r: ChainRow) => Partial<ChainRow> = () => ({})): ChainRow[] =>
  Array.from({ length: 41 }, (_, i) => {
    const strike = 21_500 + i * 50;
    const c = bsPrice({ type: 'CE', spot: SPOT, strike, days: DAYS, sigma: iv });
    const p = bsPrice({ type: 'PE', spot: SPOT, strike, days: DAYS, sigma: iv });
    const row: ChainRow = {
      strike, callLTP: +c.toFixed(2), putLTP: +p.toFixed(2), callIV: iv * 100, putIV: iv * 100, callOI: 100_000, putOI: 100_000,
      callBidPrice: +Math.max(0.05, c - 0.5).toFixed(2), callAskPrice: +(c + 0.5).toFixed(2),
      putBidPrice: +Math.max(0.05, p - 0.5).toFixed(2), putAskPrice: +(p + 0.5).toFixed(2),
    };
    return { ...row, ...over(row) };
  });

/** Daily closes that drift by `daily` each day with a small zig-zag (realised volatility about 10%). */
const closes = (daily: number) => Array.from({ length: 80 }, (_, i) => 22_000 * Math.exp(daily * i + (i % 2 ? 0.0063 : -0.0063)));
const base = { symbol: 'NIFTY', spot: SPOT, qty: 65, days: DAYS, rates };

describe('market fit', () => {
  it('selling suits expensive options, buying suits cheap ones, and neither fights the trend', () => {
    expect(fitOf('iron_condor', 'expensive', 'sideways')).toBe('with');
    expect(fitOf('iron_condor', 'cheap', 'sideways')).toBe('against');
    expect(fitOf('bull_put', 'expensive', 'up')).toBe('with');
    expect(fitOf('bull_put', 'expensive', 'down')).toBe('against');
    expect(fitOf('bull_call', 'cheap', 'up')).toBe('with');
    expect(fitOf('bull_call', 'cheap', 'sideways')).toBe('against');
    expect(fitOf('bear_put', 'expensive', 'down')).toBe('against');
  });
});

describe('strategy ideas', () => {
  it('offers defined-risk premium selling when options are expensive and the market is going sideways', () => {
    const r = buildIdeas({ ...base, strikes: chain(0.20), closes: closes(0), rv20: 0.10, vixPercentile: 60, netWorth: 1_000_000 });
    expect(r.read).toMatchObject({ verdict: 'expensive', trend: 'sideways' });
    expect(r.ideas.length).toBeGreaterThan(0);
    const top = r.ideas[0];
    expect(top.kind).toBe('credit');
    expect(top.fit).toBe('with');
    for (const i of r.ideas) {
      // Every idea is defined-risk, profitable on expectation after charges, and sells at the bid / buys at the ask.
      expect(i.maxLoss).toBeLessThan(0);
      expect(Number.isFinite(i.maxLoss)).toBe(true);
      expect(i.expectedPnl).toBeGreaterThan(0);
      expect(i.margin).toBeGreaterThan(0);
      expect(i.legs.filter((l) => l.action === 'SELL').every((l) => l.priced === 'bid')).toBe(true);
      expect(i.legs.filter((l) => l.action === 'BUY').every((l) => l.priced === 'ask')).toBe(true);
      expect(i.legs.every((l) => l.qty === 65)).toBe(true);
      // Sold options are always covered by a bought one of the same type further out.
      for (const s of i.legs.filter((l) => l.action === 'SELL')) {
        expect(i.legs.some((l) => l.action === 'BUY' && l.type === s.type && (s.type === 'CE' ? l.strike > s.strike : l.strike < s.strike))).toBe(true);
      }
      expect(i.warnings.join(' ')).toMatch(/% of your net worth/);
    }
    // One idea per kind of strategy, not five variants of the same thing.
    expect(new Set(r.ideas.map((i) => i.family)).size).toBe(r.ideas.length);
  });

  it('offers nothing to sell when options are cheap, and says why', () => {
    const r = buildIdeas({ ...base, strikes: chain(0.08), closes: closes(0), rv20: 0.12 });
    expect(r.read.verdict).toBe('cheap');
    expect(r.ideas.filter((i) => i.kind === 'credit')).toHaveLength(0);
    expect(r.ideas).toHaveLength(0);                                    // sideways, so no debit spread either
    expect(r.message).toMatch(/Nothing clears the checks/);
    expect(Object.keys(r.rejected).length).toBeGreaterThan(0);
    for (const n of r.nearMisses) expect(n.blocked).toBeTruthy();
  });

  it('prefers a bullish debit spread when options are cheap and the market is trending up', () => {
    const r = buildIdeas({ ...base, strikes: chain(0.08), closes: closes(0.004), rv20: 0.12 });
    expect(r.read).toMatchObject({ verdict: 'cheap', trend: 'up' });
    expect(r.ideas.every((i) => i.family === 'bull_call')).toBe(true);
  });

  it('respects the loss limit the user sets', () => {
    const open = buildIdeas({ ...base, strikes: chain(0.20), closes: closes(0), rv20: 0.10 });
    const worst = Math.min(...open.ideas.map((i) => Math.abs(i.maxLoss)));
    const capped = buildIdeas({ ...base, strikes: chain(0.20), closes: closes(0), rv20: 0.10, maxLoss: worst });
    expect(capped.ideas.every((i) => Math.abs(i.maxLoss) <= worst)).toBe(true);
    expect(buildIdeas({ ...base, strikes: chain(0.20), closes: closes(0), rv20: 0.10, maxLoss: 100 }).ideas).toHaveLength(0);
  });

  it('will not build on legs that barely trade', () => {
    const wide = chain(0.20, (r) => ({ callAskPrice: r.callLTP + 25, putAskPrice: r.putLTP + 25 }));     // very wide bid-ask
    const r = buildIdeas({ ...base, strikes: wide, closes: closes(0), rv20: 0.10 });
    expect(r.ideas).toHaveLength(0);
    expect(r.rejected['a leg is too thinly traded']).toBeGreaterThan(0);
  });

  it('says so when the chain cannot support a strategy', () => {
    expect(buildIdeas({ ...base, strikes: chain(0.20).slice(0, 3), closes: closes(0), rv20: 0.10 }).message).toMatch(/too few strikes/);
    const noIv = chain(0.20, () => ({ callIV: 0, putIV: 0 }));
    expect(buildIdeas({ ...base, strikes: noIv, closes: closes(0), rv20: 0.10 }).message).toMatch(/no implied volatility/);
  });
});
