import { describe, it, expect } from 'vitest';
import { minePatterns, benjaminiHochberg, upperTail } from '../../src/lib/pattern-miner.js';
import { allPatterns, featuresAt, buildContext, featureBit, CHECKPOINTS } from '../../src/lib/intraday-patterns.js';
import type { HistoricalBar } from '../../src/services/market-data.service.js';

/** Standard normals from mulberry32 (exact 32-bit integer arithmetic, no float precision loss). */
function rng(seed: number) {
  let a = seed >>> 0;
  const u = () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return (((t ^ (t >>> 14)) >>> 0) + 1) / 4294967297;
  };
  return () => Math.sqrt(-2 * Math.log(u())) * Math.cos(2 * Math.PI * u());
}

function weekdays(from: string, n: number): string[] {
  const out: string[] = [];
  for (let t = Date.parse(`${from}T00:00:00Z`); out.length < n; t += 86_400_000) {
    const d = new Date(t);
    if (d.getUTCDay() !== 0 && d.getUTCDay() !== 6) out.push(d.toISOString().slice(0, 10));
  }
  return out;
}

const hhmm = (k: number) => { const m = 9 * 60 + 15 + 5 * k; return `${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`; };

/**
 * Random-walk markets. With `planted`, a stock trading above its opening range
 * at 10:15 keeps drifting up for the rest of the day: a real, tradeable edge.
 */
function market(stocks: number, days: string[], planted: boolean, seed: number) {
  const data = new Map<string, { five: HistoricalBar[]; daily: HistoricalBar[] }>();
  ['NIFTY', ...Array.from({ length: stocks }, (_, i) => `S${i}`)].forEach((sym, idx) => {
    const z = rng(seed * 1_000_003 + idx * 7919);
    const five: HistoricalBar[] = [], daily: HistoricalBar[] = [];
    let p = 100;
    for (const day of days) {
      p *= 1 + 0.008 * z();
      const bars: HistoricalBar[] = [];
      let drift = 0;
      for (let k = 0; k < 75; k++) {
        if (k === 12 && planted && sym !== 'NIFTY') {
          const orHigh = Math.max(...bars.slice(0, 3).map((b) => b.high));
          drift = bars[11].close > orHigh ? 0.0004 : 0;   // ~2.5% over the rest of the day
        }
        const open = p;
        p *= 1 + 0.0015 * z() + drift;
        const high = Math.max(open, p) * (1 + 0.0005 * Math.abs(z())), low = Math.min(open, p) * (1 - 0.0005 * Math.abs(z()));
        bars.push({ timestamp: `${day} ${hhmm(k)}`, open, high, low, close: p, volume: 1000 + Math.round(200 * Math.abs(z())) });
      }
      five.push(...bars);
      daily.push({ timestamp: day, open: bars[0].open, high: Math.max(...bars.map((b) => b.high)), low: Math.min(...bars.map((b) => b.low)), close: p, volume: 75_000 });
    }
    data.set(sym, { five, daily });
  });
  return (symbol: string, interval: '5m' | '1d', from: string, to: string) =>
    (interval === '5m' ? data.get(symbol)!.five : data.get(symbol)!.daily)
      .filter((b) => b.timestamp.slice(0, 10) >= from && b.timestamp.slice(0, 10) <= to);
}

const DAYS = weekdays('2023-06-01', 420);          // ~2023-06 → 2025-01; train to 2024-08-31, test after
const OPTS = { from: '2023-06-01', to: '2025-12-31', trainEnd: '2024-08-31', minTrainDays: 60, minTrainTrades: 150, minTestDays: 20 };

describe('statistics', () => {
  it('normal tail and Benjamini–Hochberg behave as textbooks say', () => {
    expect(upperTail(0)).toBeCloseTo(0.5, 6);
    expect(upperTail(1.96)).toBeCloseTo(0.025, 3);
    expect(upperTail(-1.96)).toBeCloseTo(0.975, 3);
    // 4 tests: the 2 smallest pass at q = 0.05 (0.001 ≤ .0125, 0.02 ≤ .025, 0.04 > .0375)
    expect([...benjaminiHochberg([0.04, 0.001, 0.9, 0.02], 0.05)].sort()).toEqual([1, 3]);
  });

  it('searches 1,296 patterns: 162 condition sets × 4 times of day × 2 sides', () => {
    expect(allPatterns()).toHaveLength(1296);
  });
});

describe('features', () => {
  it('only uses completed candles and flags an opening-range breakout', () => {
    const read = market(1, weekdays('2024-01-01', 80), false, 3);
    const five = read('S0', '5m', '2024-01-01', '2024-12-31');
    const days = [...new Set(five.map((b) => b.timestamp.slice(0, 10)))];
    const sessions = days.slice(-11, -1).map((d) => five.filter((b) => b.timestamp.startsWith(d)));
    const today = five.filter((b) => b.timestamp.startsWith(days.at(-1)!)).map((b) => ({ ...b }));
    const ctx = buildContext(sessions, read('S0', '1d', '2024-01-01', days.at(-2)!))!;
    const k = CHECKPOINTS['10:15'];
    const before = featuresAt(today, k, ctx, [])!;
    today[k] = { ...today[k], close: 1e6, high: 1e6 };                 // a later candle must not matter
    expect(featuresAt(today, k, ctx, [])!.mask).toBe(before.mask);
    today[k - 1] = { ...today[k - 1], close: 1e6, high: 1e6 };         // the last completed one does
    expect(featuresAt(today, k, ctx, [])!.mask & featureBit('aboveOR')).toBeTruthy();
  });
});

describe('pattern search', () => {
  it('finds a planted edge and confirms it out of sample', () => {
    const report = minePatterns({ ...OPTS, symbols: Array.from({ length: 30 }, (_, i) => `S${i}`), read: market(30, DAYS, true, 11) });
    expect(report.promoted.length).toBeGreaterThan(0);
    // Buying earlier also catches part of the later rise, so other BUY patterns
    // can be real here too; but nothing on the SELL side, and the strongest
    // finding must be the planted one.
    expect(report.promoted.every((p) => p.side === 'BUY')).toBe(true);
    const best = [...report.promoted].sort((a, b) => b.train.t - a.train.t)[0];
    expect(best.checkpoint).toBe('10:15');
    expect(best.conditions).toContain('aboveOR');
  }, 120_000);

  it('promotes nothing from pure noise, however many patterns it tries', () => {
    const report = minePatterns({ ...OPTS, symbols: Array.from({ length: 30 }, (_, i) => `S${i}`), read: market(30, DAYS, false, 11) });
    expect(report.tested).toBe(1296);
    expect(report.promoted).toEqual([]);
  }, 120_000);
});
