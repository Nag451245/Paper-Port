/**
 * F&O expiry dates, taken from the brokers' and the exchange's own contract
 * lists, so rule changes (SEBI moving NIFTY weekly expiry to Tuesday in 2025,
 * dropping BANKNIFTY weeklies in 2024) and holiday shifts (an expiry moved to
 * Monday because Tuesday is a holiday) flow in without a code change.
 *
 * Sources, in order:
 *  1. Upstox's public instrument file — every listed contract on NSE and BSE,
 *     refreshed daily, no login needed.
 *  2. The connected broker / NSE via MarketDataService.getAvailableExpiries
 *     (Upstox login, ICICI Breeze, NSE option chain).
 *  3. Only if both fail: today's published rules (NIFTY weekly Tuesday, SENSEX
 *     weekly Thursday, everything else the month's last Tuesday), moved back
 *     over weekends and exchange holidays. Logged, because rules go stale.
 */
import { createChildLogger } from '../lib/logger.js';
import { istDateStr } from '../lib/ist.js';
import { getUpstox } from './upstox.service.js';
import { MarketCalendar } from './market-calendar.js';
import type { MarketDataService } from './market-data.service.js';

const log = createChildLogger('ExpiryCalendar');

const TTL_MS = 6 * 60 * 60_000;
/** Underlyings kept warm for code that needs an answer without waiting (features, prompts). */
export const KEY_UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'BANKEX'] as const;
const BSE_UNDERLYINGS = new Set(['SENSEX', 'BANKEX']);
/** Contracts expire at the close: until 15:30 IST, today's expiry is still "next". */
const CLOSE_MIN = 15 * 60 + 30;

export type ExpirySource = 'upstox-instruments' | 'broker' | 'rules';
interface Entry { dates: string[]; source: ExpirySource; at: number }

const addDays = (day: string, n: number) => new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);
const weekday = (day: string) => new Date(`${day}T00:00:00Z`).getUTCDay();
const istMinutes = (now: Date) => Math.floor((((now.getTime() + 330 * 60_000) % 86_400_000) + 86_400_000) % 86_400_000 / 60_000);

/**
 * Expiry dates by the current published rules, from `from` onwards, each moved
 * back to the previous trading day when it falls on a holiday. Exported for tests.
 */
export function ruleExpiries(underlying: string, from: string, isHoliday: (day: string) => boolean, count = 6): string[] {
  const u = underlying.toUpperCase();
  const shift = (day: string) => {
    let d = day;
    while (weekday(d) === 0 || weekday(d) === 6 || isHoliday(d)) d = addDays(d, -1);
    return d;
  };
  const out: string[] = [];
  if (u === 'NIFTY' || u === 'SENSEX') {
    const target = u === 'NIFTY' ? 2 : 4;                                  // Tuesday / Thursday
    let d = addDays(from, -7);
    while (weekday(d) !== target) d = addDays(d, 1);
    for (; out.length < count; d = addDays(d, 7)) { const e = shift(d); if (e >= from) out.push(e); }
    return out;
  }
  let [y, m] = from.slice(0, 7).split('-').map(Number);
  while (out.length < count) {
    let d = new Date(Date.UTC(y, m, 0)).toISOString().slice(0, 10);       // last day of month m
    while (weekday(d) !== 2) d = addDays(d, -1);                           // last Tuesday
    const e = shift(d);
    if (e >= from) out.push(e);
    m++; if (m > 12) { m = 1; y++; }
  }
  return out;
}

export class ExpiryCalendar {
  private cache = new Map<string, Entry>();
  private calendar = new MarketCalendar();

  constructor(
    private readonly market?: Pick<MarketDataService, 'getAvailableExpiries'>,
    private readonly instrumentExpiries: (u: string) => Promise<string[]> = (u) => getUpstox().expiries(u),
    private readonly now: () => Date = () => new Date(),
  ) {}

  private isHoliday = (day: string, u: string) =>
    this.calendar.isHoliday(new Date(`${day}T12:00:00Z`), BSE_UNDERLYINGS.has(u) ? 'BSE' : 'NSE');

  /** Upcoming expiry dates (YYYY-MM-DD, soonest first) and where they came from. */
  async expiries(underlying: string): Promise<{ dates: string[]; source: ExpirySource }> {
    const u = underlying.trim().toUpperCase();
    const hit = this.cache.get(u);
    if (hit && Date.now() - hit.at < TTL_MS) return { dates: this.upcoming(hit.dates), source: hit.source };

    let dates: string[] = [], source: ExpirySource = 'upstox-instruments';
    try { dates = await this.instrumentExpiries(u); } catch { /* fall through */ }
    if (!dates.length) {
      try {
        const market = this.market ?? new (await import('./market-data.service.js')).MarketDataService();
        const r = await market.getAvailableExpiries(u);
        dates = (r.expiries ?? []).map((e) => String(e).slice(0, 10)).filter((e) => /^\d{4}-\d{2}-\d{2}$/.test(e));
        source = 'broker';
      } catch { /* fall through */ }
    }
    if (!dates.length) {
      dates = ruleExpiries(u, istDateStr(this.now()), (d) => this.isHoliday(d, u));
      source = 'rules';
      log.warn({ underlying: u }, 'No broker or exchange expiry list; using the published rules');
    }
    dates = [...new Set(dates)].sort();
    this.cache.set(u, { dates, source, at: Date.now() });
    return { dates: this.upcoming(dates), source };
  }

  /** Dates still to come; today's counts until the 15:30 IST close. */
  private upcoming(dates: string[]): string[] {
    const now = this.now(), today = istDateStr(now);
    const closed = istMinutes(now) >= CLOSE_MIN;
    return dates.filter((d) => d > today || (d === today && !closed));
  }

  async nextExpiry(underlying: string): Promise<string | null> {
    return (await this.expiries(underlying)).dates[0] ?? null;
  }

  /** Load the key underlyings, so the synchronous answers below are broker-based. */
  async warm(): Promise<void> {
    this.cache.clear();                                                    // always re-read the lists
    await Promise.all(KEY_UNDERLYINGS.map((u) => this.expiries(u).catch(() => null)));
  }

  /** Synchronous next expiry from what is loaded (rules until warm() has run). */
  nextExpirySync(underlying = 'NIFTY'): string {
    const u = underlying.toUpperCase();
    const hit = this.cache.get(u);
    const dates = hit ? this.upcoming(hit.dates) : [];
    if (dates.length) return dates[0];
    void this.expiries(u).catch(() => null);                               // load for next time
    return ruleExpiries(u, istDateStr(this.now()), (d) => this.isHoliday(d, u))
      .find((d) => this.upcoming([d]).length) ?? istDateStr(this.now());
  }

  /** Is today an expiry day for this underlying (NIFTY: the weekly market-wide expiry)? */
  isExpiryDaySync(underlying = 'NIFTY'): boolean {
    return this.nextExpirySync(underlying) === istDateStr(this.now());
  }

  /** Calendar days from today to the next expiry (0 on expiry day). */
  daysToExpirySync(underlying = 'NIFTY'): number {
    const next = this.nextExpirySync(underlying), today = istDateStr(this.now());
    return Math.max(0, Math.round((Date.parse(`${next}T00:00:00Z`) - Date.parse(`${today}T00:00:00Z`)) / 86_400_000));
  }

  /** Plain-language summary for the AI assistant's background knowledge. */
  async summary(): Promise<string> {
    const lines = await Promise.all(KEY_UNDERLYINGS.map(async (u) => {
      const { dates, source } = await this.expiries(u).catch(() => ({ dates: [] as string[], source: 'rules' as ExpirySource }));
      return dates.length ? `${u}: next ${dates.slice(0, 3).join(', ')}${source === 'rules' ? ' (estimated)' : ''}` : null;
    }));
    return lines.filter(Boolean).join('; ');
  }
}

let shared: ExpiryCalendar | null = null;
export function getExpiryCalendar(): ExpiryCalendar {
  shared ??= new ExpiryCalendar();
  return shared;
}
