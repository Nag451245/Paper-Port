/**
 * Market movers: price gainers, price losers and volume gainers for NSE and BSE.
 *
 * NSE: the exchange's own lists (the same ones on nseindia.com → Top Gainers /
 * Volume Gainers). NSE often blocks servers outside India, so when it refuses,
 * the lists are computed from Upstox quotes over every listed share instead.
 *
 * BSE: bseindia.com refuses automated requests, so BSE lists are always
 * computed from Upstox quotes, and need an Upstox login.
 *
 * Volume gainers compare today's volume with the average of the previous five
 * sessions. NSE publishes that average; when computing, it comes from Upstox
 * daily candles for the day's most-traded shares, fetched once a day.
 */
import { createChildLogger } from '../lib/logger.js';
import { activeUpstoxToken } from '../lib/upstox-session.js';
import { getUpstox, type BatchQuote, type ListedShare, type UpstoxService } from './upstox.service.js';
import { istDateStr } from '../lib/ist.js';
import { MarketDataService, type MarketMover } from './market-data.service.js';

const log = createChildLogger('MarketMovers');

export type MoverExchange = 'NSE' | 'BSE';
export type MoverKind = 'gainers' | 'losers' | 'volume';

export interface MoverRow {
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  changePercent: number;
  volume: number;
  /** Average daily volume over the previous week (volume gainers only). */
  avgVolume?: number;
  /** Today's volume as a multiple of avgVolume. */
  volumeRatio?: number;
  open?: number;
  high?: number;
  low?: number;
  previousClose: number;
}

export interface MoversResult {
  exchange: MoverExchange;
  kind: MoverKind;
  group: string;
  source: 'nse' | 'upstox' | 'none';
  /** When the exchange/broker last updated the numbers (IST text from NSE, ISO from Upstox). */
  asOf: string | null;
  rows: MoverRow[];
  /** Why the list is empty or narrower than asked, in plain words. */
  note?: string;
}

/** Groups the user can pick, per exchange. NSE's ids are the ones its API uses. */
export const MOVER_GROUPS: Record<MoverExchange, { id: string; label: string }[]> = {
  NSE: [
    { id: 'allSec', label: 'All stocks' },
    { id: 'NIFTY', label: 'NIFTY 50' },
    { id: 'NIFTYNEXT50', label: 'NIFTY Next 50' },
    { id: 'BANKNIFTY', label: 'Bank NIFTY' },
    { id: 'FOSec', label: 'F&O stocks' },
  ],
  BSE: [
    { id: 'all', label: 'All stocks' },
    { id: 'A', label: 'Group A' },
  ],
};

const NSE_URL = {
  gainers: 'https://www.nseindia.com/api/live-analysis-variations?index=gainers',
  losers: 'https://www.nseindia.com/api/live-analysis-variations?index=loosers',
  volume: 'https://www.nseindia.com/api/live-analysis-volume-gainers',
} as const;

const TTL_MS = 60_000;
/** Shares below this price are left out of computed lists: penny-stock % moves swamp everything else. */
const MIN_PRICE = 5;
/** How many of the day's most-traded shares get a 1-week average looked up when computing volume gainers. */
const VOLUME_CANDIDATES = 60;

const num = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
const round = (v: number, dp = 2) => +v.toFixed(dp);

/** NSE "live-analysis-variations" rows → MoverRow. Exported for tests. */
export function parseNseVariations(body: any, group: string): { rows: MoverRow[]; asOf: string | null } {
  const block = body?.[group];
  const rows: MoverRow[] = (Array.isArray(block?.data) ? block.data : [])
    .filter((r: any) => r?.symbol && num(r.ltp) > 0)
    .map((r: any) => {
      const ltp = num(r.ltp);
      const prev = num(r.prev_price);
      return {
        symbol: String(r.symbol),
        name: String(r.symbol),
        ltp,
        change: prev > 0 ? round(ltp - prev) : 0,
        changePercent: round(num(r.perChange ?? r.net_price)),
        volume: num(r.trade_quantity),
        open: num(r.open_price), high: num(r.high_price), low: num(r.low_price),
        previousClose: prev,
      };
    });
  return { rows, asOf: block?.timestamp ?? null };
}

/** NSE "live-analysis-volume-gainers" → MoverRow. Exported for tests. */
export function parseNseVolume(body: any): { rows: MoverRow[]; asOf: string | null } {
  const rows: MoverRow[] = (Array.isArray(body?.data) ? body.data : [])
    .filter((r: any) => r?.symbol && num(r.ltp) > 0)
    .map((r: any) => {
      const ltp = num(r.ltp);
      const pct = num(r.pChange);
      const prev = pct > -100 ? ltp / (1 + pct / 100) : 0;
      return {
        symbol: String(r.symbol),
        name: String(r.companyName ?? r.symbol),
        ltp,
        change: round(ltp - prev),
        changePercent: round(pct),
        volume: num(r.volume),
        avgVolume: Math.round(num(r.week1AvgVolume)),
        volumeRatio: round(num(r.week1volChange)),
        previousClose: round(prev),
      };
    });
  return { rows, asOf: body?.timestamp ?? null };
}

/** Price movers from a set of quotes: biggest % rises (or falls) first. Exported for tests. */
export function rankPriceMovers(
  shares: ListedShare[], quotes: Map<string, BatchQuote>, kind: 'gainers' | 'losers', count: number,
): MoverRow[] {
  const rows = toRows(shares, quotes).filter((r) => r.ltp >= MIN_PRICE && r.volume > 0 && r.previousClose > 0);
  rows.sort((a, b) => (kind === 'gainers' ? b.changePercent - a.changePercent : a.changePercent - b.changePercent));
  return rows.filter((r) => (kind === 'gainers' ? r.changePercent > 0 : r.changePercent < 0)).slice(0, count);
}

function toRows(shares: ListedShare[], quotes: Map<string, BatchQuote>): MoverRow[] {
  const rows: MoverRow[] = [];
  for (const s of shares) {
    const q = quotes.get(s.key);
    if (!q) continue;
    rows.push({
      symbol: s.symbol, name: s.name, ltp: q.ltp, change: round(q.change),
      changePercent: q.previousClose > 0 ? round((q.change / q.previousClose) * 100) : 0,
      volume: q.volume, open: q.open, high: q.high, low: q.low, previousClose: round(q.previousClose),
    });
  }
  return rows;
}

/** Average of the last `n` completed sessions' volume before `today` (YYYY-MM-DD). Exported for tests. */
export function priorAverageVolume(bars: { timestamp: string; volume: number }[], today: string, n = 5): number {
  const prior = bars.filter((b) => b.timestamp.slice(0, 10) < today && b.volume > 0).slice(-n);
  return prior.length ? prior.reduce((s, b) => s + b.volume, 0) / prior.length : 0;
}

export class MarketMoversService {
  private cache = new Map<string, { at: number; value: MoversResult }>();
  private inflight = new Map<string, Promise<MoversResult>>();
  /** "BSE:RELIANCE" → average volume, for the IST day it was computed. */
  private avgVolume = new Map<string, number>();
  private avgVolumeDay = '';
  /** Raw responses / quote batches, shared by the lists built from them. */
  private sources = new Map<string, { at: number; value: Promise<any> }>();

  constructor(
    private readonly nseJson: (url: string) => Promise<any | null>,
    private readonly upstox: UpstoxService = getUpstox(),
    private readonly token: () => Promise<string | null> = () => activeUpstoxToken(),
  ) {}

  async get(exchange: MoverExchange, kind: MoverKind, group?: string, count = 25): Promise<MoversResult> {
    const groups = MOVER_GROUPS[exchange];
    const g = groups.some((x) => x.id === group) ? group! : groups[0].id;
    const key = `${exchange}:${kind}:${g}:${count}`;
    const hit = this.cache.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    let p = this.inflight.get(key);
    if (!p) {
      p = this.load(exchange, kind, g, count)
        .then((value) => {
          // Empty answers are kept briefly too, so a blocked source is not hammered.
          this.cache.set(key, { at: value.rows.length ? Date.now() : Date.now() - TTL_MS / 2, value });
          return value;
        })
        .finally(() => this.inflight.delete(key));
      this.inflight.set(key, p);
    }
    return p;
  }

  /**
   * Stocks for the bots and the Rust engine to scan: NSE price gainers and
   * losers (F&O stocks first, since they are liquid, then all stocks above
   * ₹20), plus volume gainers trading at 2x or more their weekly average,
   * filed under gainers or losers by which way the price moved.
   */
  async scannerMovers(count = 50): Promise<{ gainers: MarketMover[]; losers: MarketMover[] }> {
    const [foG, foL, allG, allL, vol] = await Promise.all([
      this.get('NSE', 'gainers', 'FOSec', count), this.get('NSE', 'losers', 'FOSec', count),
      this.get('NSE', 'gainers', 'allSec', count), this.get('NSE', 'losers', 'allSec', count),
      this.get('NSE', 'volume', 'allSec', count),
    ]);
    const tradeable = (r: MoverRow) => r.ltp >= 20;
    const surging = vol.rows.filter((r) => tradeable(r) && (r.volumeRatio ?? 0) >= 2);
    const pick = (lists: MoverRow[][]) => {
      const seen = new Map<string, MarketMover>();
      for (const r of lists.flat()) {
        if (!tradeable(r) || seen.has(r.symbol)) continue;
        seen.set(r.symbol, {
          symbol: r.symbol, name: r.name, ltp: r.ltp, change: r.change, changePercent: r.changePercent,
          volume: r.volume, open: r.open ?? 0, high: r.high ?? 0, low: r.low ?? 0, previousClose: r.previousClose,
        });
      }
      return [...seen.values()].slice(0, count);
    };
    return {
      gainers: pick([foG.rows, allG.rows, surging.filter((r) => r.changePercent >= 0)]),
      losers: pick([foL.rows, allL.rows, surging.filter((r) => r.changePercent < 0)]),
    };
  }

  /** Fetch once per TTL however many lists need the same source; failures are not kept. */
  private shared<T>(key: string, fetcher: () => Promise<T>): Promise<T> {
    const hit = this.sources.get(key);
    if (hit && Date.now() - hit.at < TTL_MS) return hit.value;
    const value = fetcher().catch((err) => { this.sources.delete(key); throw err; });
    this.sources.set(key, { at: Date.now(), value });
    return value;
  }

  private async load(exchange: MoverExchange, kind: MoverKind, group: string, count: number): Promise<MoversResult> {
    if (exchange === 'NSE') {
      const fromNse = await this.fromNse(kind, group, count);
      if (fromNse) return fromNse;
    }
    const computed = await this.fromUpstox(exchange, kind, group, count);
    if (computed) return computed;
    return {
      exchange, kind, group, source: 'none', asOf: null, rows: [],
      note: exchange === 'NSE'
        ? 'NSE is not answering this server right now, and no Upstox login is active to compute the list instead. Log in to Upstox in Settings → Broker.'
        : 'BSE does not allow automated access, so BSE lists are computed from Upstox quotes. Log in to Upstox in Settings → Broker to see them.',
    };
  }

  private async fromNse(kind: MoverKind, group: string, count: number): Promise<MoversResult | null> {
    const body = await this.shared(`nse:${kind}`, async () => {
      const b = await this.nseJson(NSE_URL[kind]);
      if (!b) throw new Error('NSE refused');
      return b;
    }).catch(() => null);
    if (!body) return null;
    const parsed = kind === 'volume' ? parseNseVolume(body) : parseNseVariations(body, group);
    if (!parsed.rows.length) return null;
    return {
      exchange: 'NSE', kind, group, source: 'nse', asOf: parsed.asOf, rows: parsed.rows.slice(0, count),
      // NSE publishes volume gainers across all stocks only.
      note: kind === 'volume' && group !== 'allSec' ? 'NSE publishes volume gainers for all stocks only.' : undefined,
    };
  }

  private async fromUpstox(exchange: MoverExchange, kind: MoverKind, group: string, count: number): Promise<MoversResult | null> {
    const token = await this.token();
    if (!token) return null;
    const maps = await this.upstox.instrumentMaps();
    if (!maps) return null;
    let shares = maps.listed[exchange];
    let note: string | undefined;
    if (exchange === 'BSE' && group === 'A') shares = shares.filter((s) => s.group === 'A');
    if (exchange === 'NSE' && group !== 'allSec') note = 'NSE is not answering, so this list is computed from Upstox across all NSE stocks (index groups need NSE).';

    let quotes: Map<string, BatchQuote>;
    try {
      // One quote sweep per exchange serves every list and group.
      const all = maps.listed[exchange];
      quotes = await this.shared(`upstox:${exchange}`, () => this.upstox.quotes(token, all.map((s) => s.key)));
    } catch (err) {
      log.warn({ err: (err as Error).message, exchange }, 'Upstox quotes for movers failed');
      return null;
    }
    if (!quotes.size) return null;
    const asOf = [...quotes.values()].map((q) => q.timestamp).filter(Boolean).sort().pop() ?? null;

    const rows = kind === 'volume'
      ? await this.volumeGainers(token, exchange, shares, quotes, count)
      : rankPriceMovers(shares, quotes, kind, count);
    return { exchange, kind, group, source: 'upstox', asOf, rows, note };
  }

  private async volumeGainers(
    token: string, exchange: MoverExchange, shares: ListedShare[], quotes: Map<string, BatchQuote>, count: number,
  ): Promise<MoverRow[]> {
    const today = istDateStr(new Date());
    if (this.avgVolumeDay !== today) { this.avgVolume.clear(); this.avgVolumeDay = today; }

    const candidates = toRows(shares, quotes)
      .filter((r) => r.ltp >= MIN_PRICE && r.volume > 0)
      .sort((a, b) => b.volume * b.ltp - a.volume * a.ltp)          // most traded by value
      .slice(0, VOLUME_CANDIDATES);

    const from = istDateStr(new Date(Date.now() - 14 * 86_400_000));
    const todo = candidates.filter((r) => !this.avgVolume.has(`${exchange}:${r.symbol}`));
    for (let i = 0; i < todo.length; i += 5) {
      await Promise.all(todo.slice(i, i + 5).map(async (r) => {
        const bars = await this.upstox.history(token, r.symbol, '1day', from, today, exchange).catch(() => []);
        this.avgVolume.set(`${exchange}:${r.symbol}`, priorAverageVolume(bars, today));
      }));
    }

    return candidates
      .map((r) => {
        const avg = this.avgVolume.get(`${exchange}:${r.symbol}`) ?? 0;
        return { ...r, avgVolume: Math.round(avg), volumeRatio: avg > 0 ? round(r.volume / avg) : 0 };
      })
      .filter((r) => r.volumeRatio > 0)
      .sort((a, b) => b.volumeRatio - a.volumeRatio)
      .slice(0, count);
  }
}

let shared: MarketMoversService | null = null;
/** One shared instance, so the page, the bots and the engine share one cache. */
export function getMarketMovers(market?: MarketDataService): MarketMoversService {
  if (!shared) {
    market ??= new MarketDataService();
    const m = market;
    shared = new MarketMoversService((url) => m.nseJson(url));
  }
  return shared;
}
