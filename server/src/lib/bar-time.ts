/** Candle timestamp conventions shared by every market-data source. */

const IST_OFFSET_MS = 330 * 60_000;

/**
 * The one timestamp format every source returns: 'YYYY-MM-DD' for daily bars,
 * Indian time 'YYYY-MM-DD HH:MM:SS' for intraday (the format Breeze uses).
 * Mixing formats is what made a leg's candles miss the underlying's.
 */
export function formatBarTime(instantMs: number, daily: boolean): string {
  const ist = new Date(instantMs + IST_OFFSET_MS).toISOString();
  return daily ? ist.slice(0, 10) : ist.slice(0, 19).replace('T', ' ');
}

/** A bar timestamp as an instant. A time with no zone is Indian time — never the host's zone. */
export function barInstant(ts: string): number {
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(ts)) return Date.parse(ts);
  if (ts.length <= 10) return Date.parse(`${ts}T00:00:00+05:30`);
  return Date.parse(`${ts.slice(0, 19).replace(' ', 'T')}+05:30`);
}

export function isDailyInterval(interval: string): boolean {
  const i = interval.toLowerCase();
  return i.includes('day') || i === 'daily' || i === '1d' || i === 'd';
}
