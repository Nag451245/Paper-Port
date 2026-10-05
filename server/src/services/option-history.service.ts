/**
 * Past prices of index option contracts, for the options backtester and the
 * options Replay.
 *
 * Source: the connected broker — ICICI Breeze, else Upstox — as 5-minute
 * candles, one contract per request (expired contracts: Breeze, or Upstox Plus). Each contract is fetched once and kept as a gzipped
 * JSON file, so a second backtest over the same period makes no requests:
 *   <MARKET_DATA_DIR>/options/<UNDERLYING>/<YYYY-MM-DD expiry>/<STRIKE><CE|PE>.json.gz
 *   <MARKET_DATA_DIR>/options/<UNDERLYING>/expiries.json   expiry dates found so far
 *   <MARKET_DATA_DIR>/options/budget.json                  requests made today
 *
 * Expiry dates: SEBI and the exchanges moved them several times (NIFTY
 * weekly Thursday → Tuesday in Sep 2025, BANKNIFTY/FINNIFTY/MIDCPNIFTY weeklies
 * stopped in Nov 2024, SENSEX Friday → Tuesday → Thursday), and holidays
 * shift them a day or two. The rules below are only the first guess; a date
 * counts as an expiry only once ICICI has candles for a contract expiring
 * that day. Other weekdays of the week are tried when the guess is wrong.
 */
import fs from 'fs';
import path from 'path';
import zlib from 'zlib';
import { lakeDir } from '../lib/candle-lake.js';
import { barInstant } from '../lib/bar-time.js';
import { istDateStr } from '../lib/ist.js';
import { createChildLogger } from '../lib/logger.js';
import type { HistoricalBar, MarketDataService } from './market-data.service.js';

const log = createChildLogger('OptionHistory');

/** Strike spacing used to pick strikes around the money. */
export const STRIKE_STEP: Record<string, number> = {
  NIFTY: 50, BANKNIFTY: 100, FINNIFTY: 50, MIDCPNIFTY: 25, SENSEX: 100, BANKEX: 100,
};
export const OPTION_UNDERLYINGS = Object.keys(STRIKE_STEP);

/** [epoch seconds (bar start), open, high, low, close, volume] */
export type OptBar = [number, number, number, number, number, number];

interface ContractFile {
  from: string;
  to: string;
  fetchedAt: number;
  bars: OptBar[];
}

interface ExpiryFile {
  /** week (Monday date) or month (YYYY-MM) → the expiry date found, or null when that period has none */
  checked: Record<string, string | null>;
}

type Market = Pick<MarketDataService, 'optionContractHistory' | 'getHistory'>;

const DAY = 86_400_000;
const addDays = (d: string, n: number) => new Date(Date.parse(`${d}T00:00:00Z`) + n * DAY).toISOString().slice(0, 10);
const weekday = (d: string) => new Date(`${d}T00:00:00Z`).getUTCDay();          // 0 Sun … 6 Sat
const mondayOf = (d: string) => addDays(d, -((weekday(d) + 6) % 7));
const daysInMonth = (ym: string) => new Date(Date.UTC(Number(ym.slice(0, 4)), Number(ym.slice(5, 7)), 0)).getUTCDate();

/** Expiry weekdays in force on `day` (1 Mon … 5 Fri); weekly null = no weekly contracts then. */
export function expiryRule(underlying: string, day: string): { weekly: number | null; monthly: number } {
  const u = underlying.toUpperCase();
  const late25 = day >= '2025-09-01';
  switch (u) {
    case 'NIFTY': return late25 ? { weekly: 2, monthly: 2 } : { weekly: 4, monthly: 4 };
    case 'BANKNIFTY':
      if (day < '2023-09-04') return { weekly: 4, monthly: 4 };
      if (day <= '2024-11-13') return { weekly: 3, monthly: day < '2024-03-01' ? 4 : 3 };
      if (day < '2025-01-01') return { weekly: null, monthly: 3 };
      return { weekly: null, monthly: late25 ? 2 : 4 };
    case 'FINNIFTY':
      if (day <= '2024-11-19') return { weekly: 2, monthly: 2 };
      if (day < '2025-01-01') return { weekly: null, monthly: 2 };
      return { weekly: null, monthly: late25 ? 2 : 4 };
    case 'MIDCPNIFTY':
      if (day <= '2024-11-18') return { weekly: 1, monthly: 1 };
      if (day < '2025-01-01') return { weekly: null, monthly: 1 };
      return { weekly: null, monthly: late25 ? 2 : 4 };
    case 'SENSEX':
      if (day < '2025-01-01') return { weekly: 5, monthly: 5 };
      return late25 ? { weekly: 4, monthly: 4 } : { weekly: 2, monthly: 2 };
    case 'BANKEX':
      if (day <= '2024-11-18') return { weekly: 1, monthly: 1 };
      return { weekly: null, monthly: day < '2025-01-01' ? 1 : late25 ? 4 : 2 };
    default: return { weekly: null, monthly: late25 ? 2 : 4 };
  }
}

/** Last given weekday (1 Mon … 5 Fri) of a month. */
function lastWeekdayOfMonth(ym: string, wd: number): string {
  let d = `${ym}-${String(daysInMonth(ym)).padStart(2, '0')}`;
  while (weekday(d) !== wd) d = addDays(d, -1);
  return d;
}

/**
 * The periods to look in and the first-guess date for each: one per week
 * (weekly contracts) or one per month (monthly), with the other weekdays of
 * the same week as fallbacks, most likely first (a holiday moves an expiry earlier).
 */
export function expiryCandidates(underlying: string, from: string, to: string, kind: 'weekly' | 'monthly'): { key: string; tries: string[] }[] {
  const out: { key: string; tries: string[] }[] = [];
  const order = (guess: string) => {
    const mon = mondayOf(guess);
    const week = [0, 1, 2, 3, 4].map((i) => addDays(mon, i));
    return [guess, ...week.filter((d) => d < guess).reverse(), ...week.filter((d) => d > guess)];
  };
  if (kind === 'monthly') {
    for (let ym = from.slice(0, 7); ym <= to.slice(0, 7);) {
      const guess = lastWeekdayOfMonth(ym, expiryRule(underlying, `${ym}-15`).monthly);
      out.push({ key: ym, tries: order(guess) });
      const [y, m] = ym.split('-').map(Number);
      ym = m === 12 ? `${y + 1}-01` : `${y}-${String(m + 1).padStart(2, '0')}`;
    }
    return out;
  }
  for (let mon = mondayOf(from); mon <= to; mon = addDays(mon, 7)) {
    const rule = expiryRule(underlying, mon);
    if (rule.weekly != null) {
      out.push({ key: mon, tries: order(addDays(mon, rule.weekly - 1)) });
    } else {
      // Only monthly contracts then: the week holding the month's expiry.
      const ym = addDays(mon, 4).slice(0, 7);
      const monthly = lastWeekdayOfMonth(ym, rule.monthly);
      if (mondayOf(monthly) === mon) out.push({ key: mon, tries: order(monthly) });
    }
  }
  return out;
}

const gz = (o: unknown) => zlib.gzipSync(Buffer.from(JSON.stringify(o)));
const ungz = <T>(file: string): T | null => {
  try { return JSON.parse(zlib.gunzipSync(fs.readFileSync(file)).toString()) as T; } catch { return null; }
};
const writeAtomic = (file: string, data: Buffer | string) => {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, file);
};

export const toOptBar = (b: HistoricalBar): OptBar =>
  [Math.round(barInstant(b.timestamp) / 1000), b.open, b.high, b.low, b.close, b.volume];
/** IST calendar day of a bar. */
export const barDay = (t: number) => new Date(t * 1000 + 330 * 60_000).toISOString().slice(0, 10);
/** IST minute of day of a bar (09:15 = 555). */
export const barMinute = (t: number) => Math.floor(((t * 1000 + 330 * 60_000) % DAY) / 60_000);

export class OptionHistoryError extends Error {}

export class OptionHistory {
  private lastCall = 0;

  constructor(
    private readonly market: Market,
    private readonly dir = path.join(lakeDir(), 'options'),
    private readonly now: () => Date = () => new Date(),
    private readonly paceMs = 700,
    private readonly dailyBudget = Number(process.env.OPTION_HISTORY_DAILY_CALLS) || 600,   // shares ICICI's 1,500-a-day candle budget with the candle store
  ) {}

  private contractPath(u: string, expiry: string, strike: number, type: 'CE' | 'PE') {
    return path.join(this.dir, u, expiry, `${strike}${type}.json.gz`);
  }

  /** Requests made to ICICI today and how many remain. */
  budget(): { used: number; limit: number; day: string } {
    const day = istDateStr(this.now());
    const b = (() => { try { return JSON.parse(fs.readFileSync(path.join(this.dir, 'budget.json'), 'utf8')); } catch { return null; } })();
    return { used: b?.day === day ? Number(b.used) || 0 : 0, limit: this.dailyBudget, day };
  }

  private async spend(): Promise<void> {
    const b = this.budget();
    if (b.used >= b.limit) {
      throw new OptionHistoryError(`Today's limit of ${b.limit} ICICI history requests is used up; the rest loads tomorrow (what is already saved works now).`);
    }
    const wait = this.lastCall + this.paceMs - Date.now();
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    this.lastCall = Date.now();
    writeAtomic(path.join(this.dir, 'budget.json'), JSON.stringify({ day: b.day, used: b.used + 1 }));
  }

  /**
   * 5-minute candles of one contract between `from` and `to` (IST days,
   * inclusive), from the store or ICICI. `fresh` = fetched now; `error` = ICICI
   * could not be asked (nothing is cached then).
   */
  async contract(u: string, expiry: string, strike: number, type: 'CE' | 'PE', from: string, to: string): Promise<{ bars: OptBar[]; fresh: boolean; error?: string }> {
    const U = u.toUpperCase();
    const today = istDateStr(this.now());
    const until = [to, expiry, today].sort()[0];
    const file = this.contractPath(U, expiry, strike, type);
    const have = ungz<ContractFile>(file);
    const slice = (bars: OptBar[]) => bars.filter((b) => { const d = barDay(b[0]); return d >= from && d <= until; });

    const live = until >= today;                                       // today's candles still forming
    const covered = have && have.from <= from && have.to >= until && (!live || Date.now() - have.fetchedAt < 5 * 60_000);
    if (covered) return { bars: slice(have!.bars), fresh: false };

    // Fetch from the earlier of what is asked and what is held, up to expiry
    // (or today), so one request serves later backtests of the same contract.
    const fetchFrom = have ? [from, have.from].sort()[0] : from;
    const fetchTo = [expiry, today].sort()[0];
    try { await this.spend(); } catch (err) { return { bars: have ? slice(have.bars) : [], fresh: false, error: (err as Error).message }; }
    const res = await this.market.optionContractHistory(U, expiry, strike, type, fetchFrom, fetchTo, '5minute');
    if (res.error) {
      // A request that never reached ICICI (not connected, bridge down) does not count.
      const b = this.budget();
      writeAtomic(path.join(this.dir, 'budget.json'), JSON.stringify({ day: b.day, used: Math.max(0, b.used - 1) }));
      log.warn({ contract: `${U} ${expiry} ${strike}${type}`, error: res.error }, 'Option history not fetched');
      return { bars: have ? slice(have.bars) : [], fresh: false, error: res.error };
    }
    const byTime = new Map<number, OptBar>();
    for (const b of have?.bars ?? []) byTime.set(b[0], b);
    for (const b of res.bars.map(toOptBar)) byTime.set(b[0], b);
    const bars = [...byTime.values()].sort((a, b) => a[0] - b[0]);
    writeAtomic(file, gz({ from: fetchFrom, to: fetchTo, fetchedAt: Date.now(), bars } satisfies ContractFile));
    return { bars: slice(bars), fresh: true };
  }

  /** Daily closes of the underlying index, oldest first. */
  async dailyCloses(u: string, from: string, to: string): Promise<{ day: string; close: number }[]> {
    const bars = await this.market.getHistory(u.toUpperCase(), '1day', from, to).catch(() => []);
    return bars.map((b) => ({ day: b.timestamp.slice(0, 10), close: b.close })).filter((b) => b.close > 0);
  }

  /** ATM strike near `day`: the last daily close before it, rounded to the strike step. */
  async atmBefore(u: string, day: string): Promise<number | null> {
    const closes = await this.dailyCloses(u, addDays(day, -12), addDays(day, -1));
    const c = closes[closes.length - 1]?.close;
    const step = STRIKE_STEP[u.toUpperCase()] ?? 50;
    return c ? Math.round(c / step) * step : null;
  }

  private expiryFile(u: string) { return path.join(this.dir, u.toUpperCase(), 'expiries.json'); }
  private readExpiries(u: string): ExpiryFile {
    try { return JSON.parse(fs.readFileSync(this.expiryFile(u), 'utf8')); } catch { return { checked: {} }; }
  }

  /** Expiry dates already confirmed, oldest first (no requests). */
  knownExpiries(u: string): string[] {
    return [...new Set(Object.values(this.readExpiries(u).checked).filter((d): d is string => !!d))].sort();
  }

  /**
   * Expiry dates between `from` and `to` (past only), confirmed against ICICI's
   * data. Periods it could not check (ICICI offline, budget) are listed in
   * `unchecked` and retried next time.
   */
  async expiries(u: string, from: string, to: string, kind: 'weekly' | 'monthly'): Promise<{ expiries: string[]; unchecked: string[]; error?: string }> {
    const U = u.toUpperCase();
    const today = istDateStr(this.now());
    const store = this.readExpiries(U);
    const found = new Set<string>(), unchecked: string[] = [];
    let error: string | undefined;
    for (const { key, tries } of expiryCandidates(U, from, to, kind)) {
      const k = `${kind}:${key}`;
      if (k in store.checked) { const d = store.checked[k]; if (d && d >= from && d <= to) found.add(d); continue; }
      if (tries[0] > today) continue;
      if (error) { unchecked.push(key); continue; }
      let result: string | null = null, failed = false;
      for (const day of tries.filter((d) => d <= today)) {
        const strike = await this.atmBefore(U, day);
        if (!strike) { failed = true; error = `No daily prices for ${U} before ${day}`; break; }
        const r = await this.contract(U, day, strike, 'CE', addDays(day, -14), day);
        if (r.error) { failed = true; error = r.error; break; }
        if (r.bars.some((b) => barDay(b[0]) === day)) { result = day; break; }
      }
      if (failed) { unchecked.push(key); continue; }
      store.checked[k] = result;
      writeAtomic(this.expiryFile(U), JSON.stringify(store));
      if (result && result >= from && result <= to) found.add(result);
    }
    return { expiries: [...found].sort(), unchecked, error };
  }

  /** The index's own 5-minute candles for one day (empty when no source has them). */
  async indexBars(u: string, day: string): Promise<OptBar[]> {
    const bars = await this.market.getHistory(u.toUpperCase(), '5minute', day, day).catch(() => [] as HistoricalBar[]);
    return bars.map(toOptBar).filter((b) => barDay(b[0]) === day);
  }

  /**
   * Index level at an IST minute on `day`: from the index's own 5-minute
   * candles, or else from put-call parity at `strike` (K + call − put).
   */
  async spotAt(u: string, day: string, minute: number, parity?: { strike: number; ce: OptBar[]; pe: OptBar[] }): Promise<number | null> {
    const idx = await this.market.getHistory(u.toUpperCase(), '5minute', day, day).catch(() => [] as HistoricalBar[]);
    const at = idx.map(toOptBar).filter((b) => barDay(b[0]) === day && barMinute(b[0]) >= minute)[0];
    if (at) return at[1];
    if (!parity) return null;
    const pick = (bars: OptBar[]) => bars.filter((b) => barDay(b[0]) === day && barMinute(b[0]) >= minute)[0];
    const c = pick(parity.ce), p = pick(parity.pe);
    return c && p ? parity.strike + c[1] - p[1] : null;
  }

  /** What the store holds for an underlying: expiries and days with saved contracts. */
  coverage(u: string): { expiries: string[]; savedExpiries: { expiry: string; contracts: number }[] } {
    const U = u.toUpperCase();
    const base = path.join(this.dir, U);
    let saved: { expiry: string; contracts: number }[] = [];
    try {
      saved = fs.readdirSync(base).filter((d) => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort()
        .map((expiry) => ({ expiry, contracts: fs.readdirSync(path.join(base, expiry)).filter((f) => f.endsWith('.json.gz')).length }))
        .filter((e) => e.contracts > 0);
    } catch { /* nothing saved yet */ }
    return { expiries: this.knownExpiries(U), savedExpiries: saved };
  }
}
