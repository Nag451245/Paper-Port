/**
 * Intraday pattern vocabulary, shared by the pattern search (pattern-miner.ts)
 * and the live pattern scanner, so research and live trading compute every
 * condition the same way.
 *
 * A pattern = a time of day (checkpoint) + a side + one or two conditions.
 * At a checkpoint only candles that have CLOSED are used; the trade enters at
 * the next candle's open and is settled exactly like a shadow trade
 * (lib/shadow-math.ts): stop at 1× the stock's daily ATR, no profit target,
 * out at 15:15, after costs.
 */
import type { HistoricalBar } from '../services/market-data.service.js';
import { barInstant } from './bar-time.js';

/** Checkpoints: name → number of completed 5-minute candles that day. */
export const CHECKPOINTS = { '09:30': 3, '10:15': 12, '11:15': 24, '13:15': 48 } as const;
export type Checkpoint = keyof typeof CHECKPOINTS;

/** Each family's conditions are mutually exclusive; a pattern uses at most one per family. */
export const FAMILIES: Record<string, string[]> = {
  gap: ['gapUp', 'gapDown'],
  move: ['upFromOpen', 'downFromOpen'],
  openingRange: ['aboveOR', 'belowOR'],
  vwap: ['aboveVWAP', 'belowVWAP'],
  volume: ['rvolHigh', 'rvolLow'],
  trend: ['aboveDMA50', 'belowDMA50'],
  market: ['niftyUp', 'niftyDown'],
  prevDay: ['abovePDH', 'belowPDL'],
  extreme: ['atDayHigh', 'atDayLow'],
};
export const FEATURES = Object.values(FAMILIES).flat();
export const featureBit = (f: string) => 1 << FEATURES.indexOf(f);

/** A stock's history before today, from which the day's thresholds come. */
export interface Context {
  /** Daily candles before today, oldest first (≥ 50 for the trend condition). */
  daily: HistoricalBar[];
  /** Cumulative volume after k candles, averaged over the previous 10 sessions (index k − 1). */
  avgCumVolume: number[];
  prevHigh: number;
  prevLow: number;
  prevClose: number;
}

/** Wilder ATR(14) of daily candles, in price. */
export function dailyAtr(daily: HistoricalBar[]): number {
  if (daily.length < 15) return 0;
  const tr = daily.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - daily[i].close), Math.abs(b.low - daily[i].close)));
  let a = tr.slice(0, 14).reduce((s, x) => s + x, 0) / 14;
  for (const t of tr.slice(14)) a = (a * 13 + t) / 14;
  return a;
}

/** Context from earlier sessions' 5-minute candles (grouped by day, oldest first) and daily candles. */
export function buildContext(prevSessions: HistoricalBar[][], daily: HistoricalBar[]): Context | null {
  const last = prevSessions[prevSessions.length - 1];
  if (!last?.length || daily.length < 50) return null;
  const recent = prevSessions.slice(-10).filter((s) => s.length >= 60);
  // Running volume totals per session, averaged position by position.
  const avgCumVolume = new Array<number>(75).fill(0);
  for (const s of recent) {
    let run = 0;
    for (let k = 0; k < 75; k++) { run += s[k]?.volume ?? 0; avgCumVolume[k] += run / recent.length; }
  }
  return {
    daily, avgCumVolume,
    prevHigh: Math.max(...last.map((b) => b.high)),
    prevLow: Math.min(...last.map((b) => b.low)),
    prevClose: last[last.length - 1].close,
  };
}

/**
 * Which conditions hold after `k` completed candles today. `nifty` is NIFTY's
 * 5-minute candles today (may be empty: the market conditions are then unset).
 * Returns a bitmask over FEATURES plus the daily ATR used to size the stop.
 */
export function featuresAt(today: HistoricalBar[], k: number, ctx: Context, nifty: HistoricalBar[]): { mask: number; atr: number } | null {
  if (today.length < k || k < 3) return null;
  const bars = today.slice(0, k);
  const atr = dailyAtr(ctx.daily);
  if (!(atr > 0) || !(ctx.prevClose > 0)) return null;
  const atrPct = atr / ctx.prevClose;
  const open = bars[0].open, c = bars[k - 1].close;
  let mask = 0;
  const set = (f: string, on: boolean) => { if (on) mask |= featureBit(f); };

  const gap = open / ctx.prevClose - 1;
  set('gapUp', gap > 0.5 * atrPct);
  set('gapDown', gap < -0.5 * atrPct);
  const move = c / open - 1;
  set('upFromOpen', move > 0.5 * atrPct);
  set('downFromOpen', move < -0.5 * atrPct);
  const orHigh = Math.max(...bars.slice(0, 3).map((b) => b.high)), orLow = Math.min(...bars.slice(0, 3).map((b) => b.low));
  set('aboveOR', k > 3 && c > orHigh);
  set('belowOR', k > 3 && c < orLow);
  let pv = 0, vol = 0;
  for (const b of bars) { pv += ((b.high + b.low + b.close) / 3) * b.volume; vol += b.volume; }
  if (vol > 0) { set('aboveVWAP', c > pv / vol); set('belowVWAP', c < pv / vol); }
  const avg = ctx.avgCumVolume[k - 1];
  if (avg > 0) { set('rvolHigh', vol / avg > 2); set('rvolLow', vol / avg < 0.5); }
  const sma50 = ctx.daily.slice(-50).reduce((s, b) => s + b.close, 0) / 50;
  set('aboveDMA50', ctx.prevClose > sma50);
  set('belowDMA50', ctx.prevClose < sma50);
  if (nifty.length >= k) {
    const nm = nifty[k - 1].close / nifty[0].open - 1;
    set('niftyUp', nm > 0.003);
    set('niftyDown', nm < -0.003);
  }
  set('abovePDH', c > ctx.prevHigh);
  set('belowPDL', c < ctx.prevLow);
  const hi = Math.max(...bars.map((b) => b.high)), lo = Math.min(...bars.map((b) => b.low));
  set('atDayHigh', c >= hi * 0.999);
  set('atDayLow', c <= lo * 1.001);
  return { mask, atr };
}

export interface PatternSpec {
  id: string;
  checkpoint: Checkpoint;
  side: 'BUY' | 'SELL';
  conditions: string[];
}

/** Every pattern searched: 18 single conditions + pairs from different families, × 4 checkpoints × 2 sides. */
export function allPatterns(): PatternSpec[] {
  const conds: string[][] = FEATURES.map((f) => [f]);
  const fams = Object.values(FAMILIES);
  for (let i = 0; i < fams.length; i++) for (let j = i + 1; j < fams.length; j++) {
    for (const a of fams[i]) for (const b of fams[j]) conds.push([a, b]);
  }
  const out: PatternSpec[] = [];
  for (const checkpoint of Object.keys(CHECKPOINTS) as Checkpoint[]) {
    for (const side of ['BUY', 'SELL'] as const) {
      for (const conditions of conds) out.push({ id: `${checkpoint}-${side}-${conditions.join('+')}`, checkpoint, side, conditions });
    }
  }
  return out;
}

export const patternMask = (p: Pick<PatternSpec, 'conditions'>) => p.conditions.reduce((m, f) => m | featureBit(f), 0);

/** The instant a checkpoint's last candle closes, on the day of `today[0]`. */
export function checkpointInstant(today: HistoricalBar[], k: number): Date {
  return new Date(barInstant(today[k - 1].timestamp) + 5 * 60_000);
}

/** Group 5-minute candles by IST day, oldest first. */
export function byDay(bars: HistoricalBar[]): Map<string, HistoricalBar[]> {
  const m = new Map<string, HistoricalBar[]>();
  for (const b of bars) {
    const d = b.timestamp.slice(0, 10);
    if (!m.has(d)) m.set(d, []);
    m.get(d)!.push(b);
  }
  return m;
}
