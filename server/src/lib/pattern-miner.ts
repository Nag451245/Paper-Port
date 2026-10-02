/**
 * Searches the candle lake for intraday patterns that made money after costs,
 * with the guards that stop luck from passing as skill:
 *
 *  1. Patterns are found on the TRAIN period only (default 2022–2024).
 *  2. ~1,300 patterns are tried, so many look good by chance. The
 *     Benjamini–Hochberg procedure keeps the expected share of false
 *     discoveries among the survivors at 5%.
 *  3. Stocks move together, so 30 trades on one day are not 30 independent
 *     results. Each DAY is one observation: the average net return of that
 *     pattern's trades that day. All statistics are over days.
 *  4. Survivors must then hold on the TEST period (default 2025 onward), which
 *     the search never saw, at a Bonferroni-corrected level.
 *  5. What passes is only "promoted" to the live shadow book, which is the
 *     third, live, test. Nothing here trades.
 *
 * Trades are settled exactly like shadow trades (lib/shadow-math.ts), so the
 * research and the live record measure the same thing.
 * Caveat: the stock list is today's, so stocks that were delisted since 2022
 * are missing (survivorship); results are an upper bound.
 */
import type { HistoricalBar } from '../services/market-data.service.js';
import { settle } from './shadow-math.js';
import {
  CHECKPOINTS, allPatterns, buildContext, byDay, checkpointInstant, featuresAt, patternMask,
  type Checkpoint, type PatternSpec,
} from './intraday-patterns.js';

export interface MinerOptions {
  symbols: string[];
  read: (symbol: string, interval: '5m' | '1d', from: string, to: string) => HistoricalBar[];
  from?: string;
  to: string;
  trainEnd?: string;
  q?: number;
  minTrainDays?: number;
  minTrainTrades?: number;
  minTestDays?: number;
  onProgress?: (done: number, total: number) => void;
}

export interface PeriodStats { days: number; trades: number; meanNetPct: number; t: number; p: number }
export interface PatternResult extends PatternSpec { train: PeriodStats; test: PeriodStats; bhPass: boolean; promoted: boolean }
export interface MinerReport {
  generatedAt: string;
  period: { from: string; trainEnd: string; to: string };
  stocks: number;
  events: number;
  tested: number;
  bhSurvivors: number;
  promoted: PatternResult[];
  results: PatternResult[];
  caveats: string[];
}

/** Standard normal upper tail, P(Z > z) (Abramowitz–Stegun 26.2.17). */
export function upperTail(z: number): number {
  if (z < 0) return 1 - upperTail(-z);
  const t = 1 / (1 + 0.2316419 * z);
  const d = Math.exp(-z * z / 2) / Math.sqrt(2 * Math.PI);
  return d * t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
}

/** Indices of hypotheses that pass Benjamini–Hochberg at level q. */
export function benjaminiHochberg(pValues: number[], q: number): Set<number> {
  const order = pValues.map((p, i) => [p, i] as const).sort((a, b) => a[0] - b[0]);
  const m = pValues.length;
  let cut = -1;
  order.forEach(([p], rank) => { if (p <= ((rank + 1) / m) * q) cut = rank; });
  return new Set(order.slice(0, cut + 1).map(([, i]) => i));
}

function stats(dayMeans: number[], trades: number): PeriodStats {
  const n = dayMeans.length;
  if (n < 2) return { days: n, trades, meanNetPct: n ? dayMeans[0] * 100 : 0, t: 0, p: 1 };
  const mean = dayMeans.reduce((s, x) => s + x, 0) / n;
  const sd = Math.sqrt(dayMeans.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1));
  const t = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  return { days: n, trades, meanNetPct: mean * 100, t, p: upperTail(t) };
}

export function minePatterns(o: MinerOptions): MinerReport {
  const from = o.from ?? '2022-01-01', trainEnd = o.trainEnd ?? '2024-12-31';
  const q = o.q ?? 0.05, minTrainDays = o.minTrainDays ?? 100, minTrainTrades = o.minTrainTrades ?? 300, minTestDays = o.minTestDays ?? 30;
  const cps = Object.keys(CHECKPOINTS) as Checkpoint[];

  // ── 1. events: one per stock, day and checkpoint ──
  const niftyDays = byDay(o.read('NIFTY', '5m', from, o.to));
  const dayIndex = new Map<string, number>(), dayNames: string[] = [];
  const ev = { day: [] as number[], cp: [] as number[], mask: [] as number[], buy: [] as number[], sell: [] as number[] };
  let stocks = 0;
  o.symbols.forEach((symbol, si) => {
    o.onProgress?.(si, o.symbols.length);
    const days = byDay(o.read(symbol, '5m', from, o.to));
    const daily = o.read(symbol, '1d', '2015-01-01', o.to);
    const names = [...days.keys()].sort();
    if (names.length < 20 || daily.length < 60) return;
    stocks++;
    let p = 0;
    for (let i = 10; i < names.length; i++) {
      const day = names[i], today = days.get(day)!;
      if (today.length < 60) continue;                                  // half sessions and broken days
      while (p < daily.length && daily[p].timestamp.slice(0, 10) < day) p++;
      const ctx = buildContext(names.slice(i - 10, i).map((d) => days.get(d)!), daily.slice(Math.max(0, p - 60), p));
      if (!ctx) continue;
      if (!dayIndex.has(day)) { dayIndex.set(day, dayNames.length); dayNames.push(day); }
      const nifty = niftyDays.get(day) ?? [];
      cps.forEach((cp, ci) => {
        const k = CHECKPOINTS[cp];
        const f = featuresAt(today, k, ctx, nifty);
        if (!f) return;
        const signalAt = checkpointInstant(today, k);
        const out = (['BUY', 'SELL'] as const).map((side) => {
          const s = settle({ side, signalAt, stopDist: f.atr, targetDist: 10 * f.atr }, today, true);
          return s.status === 'CLOSED' ? s.netReturn : NaN;
        });
        if (out.some((x) => Number.isNaN(x))) return;
        ev.day.push(dayIndex.get(day)!); ev.cp.push(ci); ev.mask.push(f.mask); ev.buy.push(out[0]); ev.sell.push(out[1]);
      });
    }
  });

  // ── 2. every pattern, averaged per day, train and test kept apart ──
  const isTrain = dayNames.map((d) => d <= trainEnd);
  const sum = new Float64Array(dayNames.length), cnt = new Int32Array(dayNames.length);
  const results: PatternResult[] = allPatterns().map((pat) => {
    sum.fill(0); cnt.fill(0);
    const pm = patternMask(pat), ci = cps.indexOf(pat.checkpoint), ret = pat.side === 'BUY' ? ev.buy : ev.sell;
    for (let i = 0; i < ev.mask.length; i++) {
      if (ev.cp[i] === ci && (ev.mask[i] & pm) === pm) { sum[ev.day[i]] += ret[i]; cnt[ev.day[i]]++; }
    }
    const train: number[] = [], test: number[] = [];
    let trainTrades = 0, testTrades = 0;
    for (let d = 0; d < dayNames.length; d++) {
      if (!cnt[d]) continue;
      if (isTrain[d]) { train.push(sum[d] / cnt[d]); trainTrades += cnt[d]; } else { test.push(sum[d] / cnt[d]); testTrades += cnt[d]; }
    }
    return { ...pat, train: stats(train, trainTrades), test: stats(test, testTrades), bhPass: false, promoted: false };
  });

  // ── 3. false-discovery control on the training results ──
  const eligible = (r: PatternResult) => r.train.days >= minTrainDays && r.train.trades >= minTrainTrades;
  const pass = benjaminiHochberg(results.map((r) => (eligible(r) ? r.train.p : 1)), q);
  results.forEach((r, i) => { r.bhPass = pass.has(i); });
  const survivors = results.filter((r) => r.bhPass);

  // ── 4. out-of-sample confirmation ──
  const alpha = survivors.length ? 0.05 / survivors.length : 0;
  for (const r of survivors) r.promoted = r.test.days >= minTestDays && r.test.meanNetPct > 0 && r.test.p < alpha;

  return {
    generatedAt: new Date().toISOString(),
    period: { from, trainEnd, to: o.to },
    stocks,
    events: ev.mask.length,
    tested: results.length,
    bhSurvivors: survivors.length,
    promoted: results.filter((r) => r.promoted),
    results,
    caveats: [
      "Today's stock list: stocks delisted since the start are missing, which flatters results.",
      'Promotion only sends a pattern to the live shadow book; it still has to prove itself there.',
    ],
  };
}
