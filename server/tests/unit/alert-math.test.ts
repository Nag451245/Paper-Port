import { describe, it, expect } from 'vitest';
import { ALERT_RULES, assess, atr, ewmaVol, regress, sessionFraction, stockStats } from '../../src/lib/alert-math.js';
import { day, history, normals } from '../helpers/price-history.js';

/** 12:22:30 IST, exactly half way through the session. */
const MIDDAY = new Date('2026-10-01T06:52:30Z');

describe('building blocks', () => {
  it('recovers a known β and α by least squares', () => {
    const x = normals(500, 3).map((v) => 0.01 * v);
    const e = normals(500, 5).map((v) => 0.002 * v);
    const { alpha, beta, residualSd } = regress(x.map((v, i) => 0.001 + 1.5 * v + e[i]), x);
    expect(beta).toBeCloseTo(1.5, 1);
    expect(alpha).toBeCloseTo(0.001, 3);
    expect(residualSd).toBeCloseTo(0.002, 3);
  });

  it('EWMA volatility settles on the size of recent moves', () => {
    expect(ewmaVol(Array.from({ length: 200 }, (_, i) => (i % 2 ? 0.02 : -0.02)))).toBeCloseTo(0.02, 3);
  });

  it('ATR counts gaps through the previous close', () => {
    const bars = Array.from({ length: 20 }, (_, i) => ({ timestamp: day(i), high: 102, low: 98, close: 100, volume: 1 }));
    expect(atr(bars)).toBeCloseTo(4, 6);
    bars[19] = { ...bars[19], high: 112, low: 108, close: 110 };       // gap up: true range 12
    expect(atr(bars)).toBeCloseTo((4 * 13 + 12) / 14, 6);
  });

  it('measures the session from 09:15 to 15:30 IST', () => {
    expect(sessionFraction(new Date('2026-10-01T03:45:00Z'))).toBe(0);
    expect(sessionFraction(MIDDAY)).toBeCloseTo(0.5, 6);
    expect(sessionFraction(new Date('2026-10-01T10:00:00Z'))).toBe(1);
  });

  it('pairs stock and market returns by date and estimates the market model', () => {
    const { market, stock } = history();
    const s = stockStats(stock, market)!;
    expect(s.beta).toBeGreaterThan(0.9);
    expect(s.beta).toBeLessThan(1.5);
    expect(s.residualSd).toBeGreaterThan(0.01);
    expect(s.residualSd).toBeLessThan(0.02);
    expect(stockStats(stock.slice(0, 30), market)).toBeNull();
  });
});

describe('assess', () => {
  const { market, stock } = history();
  const stats = stockStats(stock, market)!;
  const prevClose = stock[stock.length - 1].close;
  const marketReturn = 0.005;
  // Today: what the market explains, plus a 4σ stock-specific jump.
  const surge = Math.exp(stats.alpha + stats.beta * marketReturn + 4 * stats.residualSd);
  const base = { stats, prevClose, ltp: prevClose * surge, volume: 1_500_000, marketReturn, marketVol: 0.01, now: MIDDAY };

  it('passes a 4σ stock-specific move on 3× volume, with ATR-sized levels', () => {
    const a = assess(base);
    expect(a).toMatchObject({ pass: true, direction: 'BUY' });
    expect(a.idioZ).toBeCloseTo(4, 6);
    expect(a.relVolume).toBeCloseTo(3, 6);
    expect(a.ltp - a.stop).toBeCloseTo(ALERT_RULES.stopAtr * stats.atr, 6);
    expect((a.target - a.ltp) / (a.ltp - a.stop)).toBeCloseTo(2, 6);
  });

  it('does not count the part of the move the market explains', () => {
    // Same price, but the market rallied enough to explain most of it.
    const a = assess({ ...base, marketReturn: marketReturn + (3 * stats.residualSd) / stats.beta });
    expect(a.pass).toBe(false);
    expect(a.reason).toMatch(/only 1\.0σ/);
  });

  it.each([
    ['volume is ordinary', { volume: 500_000 }, /volume only 1\.0×/],
    ['the signal points the other way', { direction: 'SELL' as const }, /against the signal/],
    ['the market is crashing on a buy', { marketReturn: -0.03 }, /whole market/],
    ['the stock is a penny stock', { ltp: 15, prevClose: 15 / surge }, /price below/],
  ])('rejects when %s', (_label, change, reason) => {
    const a = assess({ ...base, ...change });
    expect(a.pass).toBe(false);
    expect(a.reason).toMatch(reason);
  });

  it('rejects thin stocks and stops too wide to be sensible', () => {
    expect(assess({ ...base, stats: { ...stats, avgTurnover: 1e6 } }).reason).toMatch(/thinly traded/);
    expect(assess({ ...base, stats: { ...stats, atr: base.ltp * 0.05 } }).reason).toMatch(/too volatile/);
  });

  it('takes the side of the move when no signal names one', () => {
    const down = assess({ ...base, ltp: prevClose / surge * Math.exp(2 * (stats.alpha + stats.beta * marketReturn)) });
    expect(down).toMatchObject({ pass: true, direction: 'SELL' });
    expect(down.stop).toBeGreaterThan(down.ltp);
  });
});
