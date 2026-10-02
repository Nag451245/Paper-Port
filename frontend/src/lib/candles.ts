/**
 * Chart timeframes for the trading terminal. Breeze serves 1-minute, 5-minute,
 * 30-minute and daily candles; the other sizes are built from those here, so
 * every timeframe works from the same data whichever source answered.
 */
import { barTime } from '@/lib/replay-engine';

export type Timeframe = '1m' | '5m' | '15m' | '1h' | '1D' | '1W' | '1M';

interface TimeframeSpec {
  value: Timeframe;
  label: string;
  /** What to ask the server for. */
  interval: '1minute' | '5minute' | '30minute' | '1day';
  /** How far back to load. Kept inside what the backup source (Yahoo) can serve too. */
  days: number;
  /** Intraday bucket in minutes, or a calendar grouping. */
  minutes?: number;
  group?: 'day' | 'week' | 'month';
}

export const TIMEFRAMES: TimeframeSpec[] = [
  { value: '1m', label: '1m', interval: '1minute', days: 4, minutes: 1 },
  { value: '5m', label: '5m', interval: '5minute', days: 12, minutes: 5 },
  { value: '15m', label: '15m', interval: '5minute', days: 35, minutes: 15 },
  { value: '1h', label: '1h', interval: '30minute', days: 55, minutes: 60 },
  { value: '1D', label: '1D', interval: '1day', days: 365, group: 'day' },
  { value: '1W', label: '1W', interval: '1day', days: 3 * 365, group: 'week' },
  { value: '1M', label: '1M', interval: '1day', days: 10 * 365, group: 'month' },
];

export const timeframeSpec = (tf: Timeframe): TimeframeSpec => TIMEFRAMES.find((t) => t.value === tf) ?? TIMEFRAMES[4];
export const isIntraday = (tf: Timeframe) => timeframeSpec(tf).minutes !== undefined;

export interface RawBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

/** A chart point: intraday times are seconds (shifted so the axis reads Indian time), the rest are dates. */
export interface ChartBar {
  time: number | string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

const IST_MS = 330 * 60_000;
const SESSION = { NSE: { open: 9 * 60 + 15, close: 15 * 60 + 30 }, MCX: { open: 9 * 60, close: 23 * 60 + 30 } };
const session = (exchange: string) => (exchange.toUpperCase() === 'MCX' ? SESSION.MCX : SESSION.NSE);

/** The bucket a moment falls in, as its chart time. */
export function bucketTime(instantMs: number, tf: Timeframe, exchange = 'NSE'): number | string {
  const spec = timeframeSpec(tf);
  const ist = new Date(instantMs + IST_MS);
  const date = ist.toISOString().slice(0, 10);
  if (spec.minutes !== undefined) {
    const open = session(exchange).open;
    const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
    // Buckets start at the session open: hourly NSE candles are 09:15-10:15, not 09:00-10:00.
    const start = open + Math.floor((mins - open) / spec.minutes) * spec.minutes;
    return Date.parse(`${date}T00:00:00Z`) / 1000 + start * 60;
  }
  if (spec.group === 'week') {
    const monday = new Date(Date.parse(`${date}T00:00:00Z`) - ((ist.getUTCDay() + 6) % 7) * 86_400_000);
    return monday.toISOString().slice(0, 10);
  }
  if (spec.group === 'month') return `${date.slice(0, 7)}-01`;
  return date;
}

/** Group raw candles into the timeframe's candles: first open, highest high, lowest low, last close. */
export function aggregate(bars: RawBar[], tf: Timeframe, exchange = 'NSE'): ChartBar[] {
  const out: ChartBar[] = [];
  const sorted = [...bars].sort((a, b) => barTime(a.timestamp) - barTime(b.timestamp));
  for (const b of sorted) {
    if (!(b.open > 0)) continue;
    const time = bucketTime(barTime(b.timestamp), tf, exchange);
    const last = out[out.length - 1];
    if (last && last.time === time) {
      last.high = Math.max(last.high, b.high);
      last.low = Math.min(last.low, b.low);
      last.close = b.close;
      last.volume += b.volume || 0;
    } else {
      out.push({ time, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume || 0 });
    }
  }
  return out;
}

/**
 * Fold a live price into the chart's last candle. Returns the candle to draw, or
 * null when the tick should not touch the chart: outside market hours, or a new
 * day the history has not reached yet (that candle arrives with the next reload,
 * so a holiday never grows a fake candle from a stale price).
 */
export function applyTick(last: ChartBar | undefined, ltp: number, nowMs: number, tf: Timeframe, exchange = 'NSE'): ChartBar | null {
  if (!last || !(ltp > 0)) return null;
  const ist = new Date(nowMs + IST_MS);
  const mins = ist.getUTCHours() * 60 + ist.getUTCMinutes();
  const { open, close } = session(exchange);
  if (mins < open || mins >= close) return null;

  const time = bucketTime(nowMs, tf, exchange);
  if (time === last.time) {
    return { ...last, high: Math.max(last.high, ltp), low: Math.min(last.low, ltp), close: ltp };
  }
  // A new intraday candle, but only within the day the chart already shows.
  if (typeof time === 'number' && typeof last.time === 'number' && time > last.time
      && Math.floor(time / 86_400) === Math.floor(last.time / 86_400)) {
    return { time, open: ltp, high: ltp, low: ltp, close: ltp, volume: 0 };
  }
  return null;
}
