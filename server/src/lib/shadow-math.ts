/**
 * How a shadow trade is filled and closed, and when a strategy counts as proven.
 * Pure functions, so the rules can be read and tested in one place.
 *
 * Fill rules (deliberately conservative, so a strategy cannot look better than
 * it would have traded):
 *  - Entry at the OPEN of the first 5-minute candle that starts at or after the
 *    signal; never at the signal's own (already printed) price.
 *  - Stop and target keep the signal's distances, re-anchored on that entry.
 *  - A candle that touches both stop and target counts as the stop.
 *  - A gap through the stop fills at the open (worse than the stop).
 *  - Anything still open at 15:15 IST exits at that candle's open (intraday
 *    square-off, as the live bots do).
 *  - Costs: INTRADAY_COST of the entry value per round trip.
 */
import { barInstant } from './bar-time.js';

/**
 * Round-trip intraday cost as a fraction of the trade value: STT 0.025% on the
 * sell side, exchange + SEBI + GST ≈ 0.01%, stamp 0.003%, brokerage ≈ 0.02%,
 * and about 0.05% slippage each side on liquid stocks.
 */
export const INTRADAY_COST = 0.0015;

/** Evidence needed before a strategy counts as proven (or disproven). */
export const EVIDENCE_RULE = {
  minTrades: 100,
  /** About 10 strategies are tested at once; a stricter bar than 2 keeps luck out. */
  minT: 2.5,
} as const;

export interface Bar { timestamp: string; open: number; high: number; low: number; close: number }

export interface OpenShadow {
  side: 'BUY' | 'SELL';
  signalAt: Date;
  stopDist: number;
  targetDist: number;
}

export type Settlement =
  | { status: 'OPEN'; entryAt?: Date; entry?: number }
  | { status: 'CLOSED'; entryAt: Date; entry: number; exitAt: Date; exitPrice: number; exitReason: 'target' | 'stop' | 'session-end'; rMultiple: number; netReturn: number }
  | { status: 'VOID'; exitReason: 'no-data' };

const SQUARE_OFF_MIN = 15 * 60 + 15;
const istMinute = (ms: number) => Math.floor((((ms + 330 * 60_000) % 86_400_000) + 86_400_000) % 86_400_000 / 60_000);

/**
 * Settle one trade against the day's 5-minute candles (oldest first).
 * `dayOver` says the session has ended, so a trade with no candles is void.
 */
export function settle(t: OpenShadow, bars: Bar[], dayOver: boolean): Settlement {
  const after = bars.filter((b) => barInstant(b.timestamp) >= t.signalAt.getTime());
  const first = after[0];
  if (!first || istMinute(barInstant(first.timestamp)) >= SQUARE_OFF_MIN) {
    return dayOver ? { status: 'VOID', exitReason: 'no-data' } : { status: 'OPEN' };
  }
  const sign = t.side === 'BUY' ? 1 : -1;
  const entry = first.open;
  const entryAt = new Date(barInstant(first.timestamp));
  const stop = entry - sign * t.stopDist;
  const target = entry + sign * t.targetDist;

  const close = (exitAt: number, exitPrice: number, exitReason: 'target' | 'stop' | 'session-end'): Settlement => {
    const gross = sign * (exitPrice - entry);
    const cost = INTRADAY_COST * entry;
    return {
      status: 'CLOSED', entryAt, entry, exitAt: new Date(exitAt), exitPrice, exitReason,
      rMultiple: (gross - cost) / t.stopDist,
      netReturn: (gross - cost) / entry,
    };
  };

  for (const b of after) {
    const at = barInstant(b.timestamp);
    if (b !== first && istMinute(at) >= SQUARE_OFF_MIN) return close(at, b.open, 'session-end');
    if (b !== first) {
      // A gap beyond a level fills at the open.
      if (sign * (b.open - stop) <= 0) return close(at, b.open, 'stop');
      if (sign * (b.open - target) >= 0) return close(at, b.open, 'target');
    }
    const hitStop = sign > 0 ? b.low <= stop : b.high >= stop;
    const hitTarget = sign > 0 ? b.high >= target : b.low <= target;
    if (hitStop) return close(at, stop, 'stop');            // both in one candle: assume the stop came first
    if (hitTarget) return close(at, target, 'target');
  }
  if (dayOver) {
    const last = after[after.length - 1];
    return close(barInstant(last.timestamp), last.close, 'session-end');
  }
  return { status: 'OPEN', entryAt, entry };
}

export interface StrategyEvidence {
  strategy: string;
  trades: number;
  winRate: number;
  avgR: number;
  tStat: number;
  avgNetReturnPct: number;
  verdict: 'proven' | 'disproven' | 'unproven';
}

/** Per-trade results (R, net return) → the strategy's verdict. */
export function evidenceFor(strategy: string, results: { r: number; net: number }[]): StrategyEvidence {
  const n = results.length;
  const rs = results.map((x) => x.r);
  const mean = n ? rs.reduce((s, x) => s + x, 0) / n : 0;
  const sd = n > 1 ? Math.sqrt(rs.reduce((s, x) => s + (x - mean) ** 2, 0) / (n - 1)) : 0;
  const tStat = sd > 0 ? mean / (sd / Math.sqrt(n)) : 0;
  const enough = n >= EVIDENCE_RULE.minTrades;
  return {
    strategy,
    trades: n,
    winRate: n ? results.filter((x) => x.r > 0).length / n : 0,
    avgR: mean,
    tStat,
    avgNetReturnPct: n ? (results.reduce((s, x) => s + x.net, 0) / n) * 100 : 0,
    verdict: enough && tStat >= EVIDENCE_RULE.minT ? 'proven' : enough && tStat <= -2 ? 'disproven' : 'unproven',
  };
}
