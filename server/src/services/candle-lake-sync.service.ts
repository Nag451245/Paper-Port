/**
 * Fills the candle lake (lib/candle-lake.ts) for every stock in
 * engine/data/nse_universe.json:
 *
 *  - sync(): after the close, the last few sessions of 5-minute candles and
 *    the last two weeks of daily candles for every stock. Re-fetching a few
 *    days makes a missed night heal itself.
 *  - backfill(): overnight, walks each stock's 5-minute history backwards one
 *    28-day window at a time until the broker has no more (Upstox keeps
 *    intraday history from January 2022), and fetches each stock's daily
 *    history from 2015 once.
 *
 * Broker limits: one request at a time, at least CALL_GAP_MS apart (≤ 50 a
 * minute, inside Breeze's 100 a minute and Upstox's limits), and at most
 * DAILY_CALLS a day (Breeze allows 5,000). Nothing is written to Postgres.
 */
import fs from 'fs';
import { createChildLogger } from '../lib/logger.js';
import { istDateStr } from '../lib/ist.js';
import {
  lakeSize, readManifest, writeDaily, writeIntraday, writeManifest, intradayDays, type Manifest,
} from '../lib/candle-lake.js';
import { MarketDataService } from './market-data.service.js';

const log = createChildLogger('CandleLake');

export const LAKE_LIMITS = {
  callGapMs: 1_200,
  /** Breeze allows 5,000 history calls a day; Upstox far more (2,000 per 30 minutes). */
  // ICICI allows about 5,000 calls a day for everything. 4,000 here on its own
  // used the day up by mid-afternoon; the bridge now gives candles 1,500 in all.
  dailyCalls: { breeze: 900, upstox: 20_000 },
  windowDays: 28,
  /** Upstox's intraday history starts in January 2022. */
  intradayFloor: '2022-01-01',
  dailyFloor: '2015-01-01',
  /** Consecutive empty windows that mean "the broker has nothing older". */
  emptyWindowsToStop: 3,
};

const addDays = (day: string, n: number) =>
  new Date(Date.parse(`${day}T00:00:00Z`) + n * 86_400_000).toISOString().slice(0, 10);

export function loadUniverse(): string[] {
  const file = new URL('../../../engine/data/nse_universe.json', import.meta.url);
  try {
    const rows = JSON.parse(fs.readFileSync(file, 'utf8')) as { symbol: string }[];
    return rows.map((r) => r.symbol).filter(Boolean);
  } catch (err) {
    log.warn({ err: (err as Error).message }, 'Stock universe file unreadable');
    return [];
  }
}

type RawHistory = MarketDataService['rawHistory'];

export class CandleLakeSync {
  private busy = false;
  private callsDay = '';
  private calls = 0;
  private lastCall = 0;
  private lastSource: string | null = null;

  constructor(
    private readonly fetch: RawHistory = ((m) => m.rawHistory.bind(m))(new MarketDataService()),
    private readonly universe: () => string[] = loadUniverse,
    private readonly now: () => Date = () => new Date(),
    private readonly sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  ) {}

  /** One broker request, spaced and counted. Null when today's allowance is used up. */
  private async call(symbol: string, interval: string, from: string, to: string) {
    const day = istDateStr(this.now());
    if (day !== this.callsDay) { this.callsDay = day; this.calls = 0; }
    const cap = this.lastSource === 'upstox' ? LAKE_LIMITS.dailyCalls.upstox : LAKE_LIMITS.dailyCalls.breeze;
    if (this.calls >= cap) return null;
    const wait = this.lastCall + LAKE_LIMITS.callGapMs - Date.now();
    if (wait > 0) await this.sleep(wait);
    this.lastCall = Date.now();
    this.calls++;
    const r = await this.fetch(symbol, interval, from, to, 'NSE');
    if (r.source === 'upstox' || r.source === 'breeze') this.lastSource = r.source;
    return r;
  }

  private async exclusive<T>(job: () => Promise<T>): Promise<T | null> {
    if (this.busy) return null;
    this.busy = true;
    try { return await job(); } finally { this.busy = false; }
  }

  /** Recent sessions for every stock. Run after the close. */
  async sync(): Promise<{ symbols: number; candles: number; stoppedEarly: boolean } | null> {
    return this.exclusive(async () => {
      const today = istDateStr(this.now());
      const manifest = readManifest();
      let candles = 0, symbols = 0, stoppedEarly = false;
      for (const symbol of this.universe()) {
        const intraday = await this.call(symbol, '5minute', addDays(today, -5), today);
        if (!intraday) { stoppedEarly = true; break; }
        if (!intraday.brokerConnected) { stoppedEarly = true; log.warn('No broker logged in; candle sync skipped'); break; }
        candles += writeIntraday(symbol, intraday.bars);
        const daily = await this.call(symbol, '1day', addDays(today, -14), today);
        if (!daily) { stoppedEarly = true; break; }
        // Today's daily candle is only final after the close; sync runs after it.
        candles += writeDaily(symbol, daily.bars);
        manifest[symbol] = { ...manifest[symbol], lastSync: today };
        manifest[symbol].intradayFrom ??= intraday.bars[0]?.timestamp.slice(0, 10);
        symbols++;
      }
      writeManifest(manifest);
      log.info({ symbols, candles, stoppedEarly, sizeMB: +(lakeSize() / 1e6).toFixed(1) }, 'Candle lake synced');
      return { symbols, candles, stoppedEarly };
    });
  }

  /**
   * Fill older history, at most `budget` broker requests this run. Daily
   * history first (one request per stock), then 5-minute history backwards.
   */
  async backfill(budget = 1_000): Promise<{ requests: number; candles: number; remaining: number } | null> {
    return this.exclusive(async () => {
      const today = istDateStr(this.now());
      const manifest: Manifest = readManifest();
      const symbols = this.universe();
      let requests = 0, candles = 0;
      const save = () => writeManifest(manifest);

      for (const symbol of symbols) {
        if (requests >= budget) break;
        const cov = (manifest[symbol] ??= {});
        if (cov.dailyComplete) continue;
        const r = await this.call(symbol, '1day', LAKE_LIMITS.dailyFloor, addDays(today, -1));
        requests++;
        if (!r) break;
        if (r.bars.length) { candles += writeDaily(symbol, r.bars); cov.dailyComplete = true; }
      }
      save();

      for (const symbol of symbols) {
        const cov = (manifest[symbol] ??= {});
        while (!cov.intradayComplete && requests < budget) {
          const to = addDays(cov.intradayFrom ?? addDays(today, 1), -1);
          if (to < LAKE_LIMITS.intradayFloor) { cov.intradayComplete = true; break; }
          const fromCandidate = addDays(to, -(LAKE_LIMITS.windowDays - 1));
          const from = fromCandidate < LAKE_LIMITS.intradayFloor ? LAKE_LIMITS.intradayFloor : fromCandidate;
          const r = await this.call(symbol, '5minute', from, to);
          requests++;
          if (!r) { save(); return { requests, candles, remaining: this.remaining(manifest, symbols) }; }
          if (!r.brokerConnected) {
            log.warn('No broker logged in; candle backfill paused');
            save();
            return { requests, candles, remaining: this.remaining(manifest, symbols) };
          }
          if (r.bars.length) {
            candles += writeIntraday(symbol, r.bars);
            cov.emptyWindows = 0;
          } else {
            cov.emptyWindows = (cov.emptyWindows ?? 0) + 1;
            if (cov.emptyWindows >= LAKE_LIMITS.emptyWindowsToStop) cov.intradayComplete = true;
          }
          cov.intradayFrom = from;
        }
        if (requests >= budget) break;
      }
      save();
      const remaining = this.remaining(manifest, symbols);
      log.info({ requests, candles, remaining, sizeMB: +(lakeSize() / 1e6).toFixed(1) }, 'Candle lake backfill run');
      return { requests, candles, remaining };
    });
  }

  /** Stocks whose history is not yet complete. */
  private remaining(manifest: Manifest, symbols: string[]): number {
    return symbols.filter((s) => !manifest[s]?.dailyComplete || !manifest[s]?.intradayComplete).length;
  }

  /** A summary for the app: how much is stored and how far back. */
  status() {
    const manifest = readManifest();
    const symbols = this.universe();
    const covered = symbols.filter((s) => manifest[s]?.intradayFrom);
    const earliest = covered.map((s) => manifest[s].intradayFrom!).sort()[0] ?? null;
    return {
      stocks: symbols.length,
      withIntraday: covered.length,
      intradayComplete: symbols.filter((s) => manifest[s]?.intradayComplete).length,
      dailyComplete: symbols.filter((s) => manifest[s]?.dailyComplete).length,
      earliestIntraday: earliest,
      sizeBytes: lakeSize(),
      callsToday: this.callsDay === istDateStr(this.now()) ? this.calls : 0,
    };
  }

  /** Trading days of 5-minute data held for a stock in a range (for checks and tests). */
  days(symbol: string, from: string, to: string): number {
    return intradayDays(symbol, from, to).size;
  }
}

let shared: CandleLakeSync | null = null;
export function getCandleLakeSync(): CandleLakeSync {
  shared ??= new CandleLakeSync();
  return shared;
}
