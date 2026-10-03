/**
 * Upstox as a market-data source: quotes and candles for NSE/BSE stocks, the
 * main indices, and NSE futures and options.
 *
 * Upstox names instruments by key ("NSE_EQ|INE002A01018", "NSE_FO|36708"), not
 * by symbol, so the published instrument master is downloaded once a day and
 * turned into symbol -> key maps. Docs: https://upstox.com/developer/api-documentation
 */
import { gunzipSync } from 'zlib';
import { createChildLogger } from '../lib/logger.js';
import { isDerivativeSymbol, parseInstrumentSymbol } from '../lib/instrument.js';
import { istDateStr } from '../lib/ist.js';
import { formatBarTime, isDailyInterval } from '../lib/bar-time.js';
import type { HistoricalBar, MarketQuote } from './market-data.service.js';

const log = createChildLogger('Upstox');

const API = 'https://api.upstox.com';
const MASTER_URL = (exchange: string) => `https://assets.upstox.com/market-quote/instruments/exchange/${exchange}.json.gz`;
const USED_SEGMENTS = new Set(['NSE_EQ', 'NSE_FO', 'BSE_EQ', 'BSE_FO']);
const MASTER_TTL_MS = 24 * 60 * 60 * 1000;

/** Index keys are fixed; the app's index names map onto them. */
const INDEX_KEYS: Record<string, string> = {
  'NIFTY': 'NSE_INDEX|Nifty 50',
  'NIFTY 50': 'NSE_INDEX|Nifty 50',
  'NIFTY50': 'NSE_INDEX|Nifty 50',
  'BANKNIFTY': 'NSE_INDEX|Nifty Bank',
  'NIFTY BANK': 'NSE_INDEX|Nifty Bank',
  'FINNIFTY': 'NSE_INDEX|Nifty Fin Service',
  'MIDCPNIFTY': 'NSE_INDEX|NIFTY MID SELECT',
  'INDIA VIX': 'NSE_INDEX|India VIX',
  'INDIAVIX': 'NSE_INDEX|India VIX',
  'SENSEX': 'BSE_INDEX|SENSEX',
};

interface MasterRecord {
  segment?: string;
  instrument_type?: string;
  instrument_key?: string;
  trading_symbol?: string;
  name?: string;
  underlying_symbol?: string;
  expiry?: number;
  strike_price?: number;
  lot_size?: number;
}

export interface InstrumentMaps {
  equity: Map<string, string>;                 // "NSE:RELIANCE" -> key
  derivatives: Map<string, string>;            // "NIFTY|CE|2026-10-29|24000" -> key
  optionExpiries: Map<string, Set<string>>;    // "NIFTY" -> {"2026-10-29", ...}
  lotSizes: Map<string, number>;               // "NIFTY" -> 75
  /** Ordinary listed shares per exchange, the universe market movers are ranked from. */
  listed: Record<'NSE' | 'BSE', ListedShare[]>;
}

export interface ListedShare { key: string; symbol: string; name: string; group: string }

/**
 * Which series/groups count as ordinary shares. NSE: EQ and BE (trade-to-trade).
 * BSE groups A, B, T, X, XT, M, MT, Z; leaves out F (debt), G (govt securities) and the like.
 */
const LISTED_TYPES: Record<'NSE' | 'BSE', Set<string>> = {
  NSE: new Set(['EQ', 'BE']),
  BSE: new Set(['A', 'B', 'T', 'X', 'XT', 'M', 'MT', 'Z']),
};

/** Build lookup maps from master records. Exported for tests. */
export function buildMaps(records: MasterRecord[]): InstrumentMaps {
  const equity = new Map<string, string>();
  const derivatives = new Map<string, string>();
  const optionExpiries = new Map<string, Set<string>>();
  const lotSizes = new Map<string, number>();
  const listed: InstrumentMaps['listed'] = { NSE: [], BSE: [] };
  for (const r of records) {
    if (!r.instrument_key || !r.segment) continue;
    if ((r.segment === 'NSE_EQ' || r.segment === 'BSE_EQ') && r.trading_symbol) {
      const ex = r.segment.slice(0, 3) as 'NSE' | 'BSE';
      equity.set(`${ex}:${r.trading_symbol.toUpperCase()}`, r.instrument_key);
      if (r.instrument_type && LISTED_TYPES[ex].has(r.instrument_type)) {
        listed[ex].push({ key: r.instrument_key, symbol: r.trading_symbol.toUpperCase(), name: r.name ?? r.trading_symbol, group: r.instrument_type });
      }
    } else if (r.segment === 'BSE_FO' && r.underlying_symbol && r.expiry && (r.instrument_type === 'CE' || r.instrument_type === 'PE')) {
      // BSE index options (SENSEX, BANKEX): expiry dates and lot sizes only.
      const u = r.underlying_symbol.toUpperCase();
      if (!optionExpiries.has(u)) optionExpiries.set(u, new Set());
      optionExpiries.get(u)!.add(formatBarTime(r.expiry, true));
      if (r.lot_size && r.lot_size > 0) lotSizes.set(u, r.lot_size);
    } else if (r.segment === 'NSE_FO' && r.underlying_symbol && r.expiry && r.instrument_type) {
      const kind = r.instrument_type === 'FUT' ? 'FUT' : r.instrument_type;    // CE / PE / FUT
      const strike = kind === 'FUT' ? '-' : String(Number(r.strike_price));
      const u = r.underlying_symbol.toUpperCase();
      const expiry = formatBarTime(r.expiry, true);
      derivatives.set(`${u}|${kind}|${expiry}|${strike}`, r.instrument_key);
      if (kind !== 'FUT') {
        if (!optionExpiries.has(u)) optionExpiries.set(u, new Set());
        optionExpiries.get(u)!.add(expiry);
      }
      if (r.lot_size && r.lot_size > 0) lotSizes.set(u, r.lot_size);
    }
  }
  return { equity, derivatives, optionExpiries, lotSizes, listed };
}

/** The Upstox key for an app symbol, or null when Upstox cannot serve it (MCX, unknown). */
export function resolveKey(maps: InstrumentMaps, symbol: string, exchange = 'NSE'): string | null {
  const s = symbol.trim().toUpperCase();
  if (INDEX_KEYS[s]) return INDEX_KEYS[s];
  if (isDerivativeSymbol(s)) {
    const spec = parseInstrumentSymbol(s);
    if (spec.exchange !== 'NFO' || !spec.expiry) return null;
    const kind = spec.instrumentType === 'FUTURES' ? 'FUT' : spec.optionType;
    const strike = kind === 'FUT' ? '-' : String(spec.strike);
    return maps.derivatives.get(`${spec.underlying}|${kind}|${istDateStr(spec.expiry)}|${strike}`) ?? null;
  }
  const ex = exchange.toUpperCase() === 'BSE' ? 'BSE' : exchange.toUpperCase() === 'NSE' ? 'NSE' : null;
  return ex ? maps.equity.get(`${ex}:${s}`) ?? null : null;
}

/** Upstox interval for an app interval, with the longest range one request may cover. */
export function upstoxInterval(interval: string): { unit: string; n: number; windowDays: number } | null {
  const i = interval.toLowerCase();
  if (isDailyInterval(i)) return { unit: 'days', n: 1, windowDays: 3600 };
  if (['1m', '1min', 'minute', '1minute'].includes(i)) return { unit: 'minutes', n: 1, windowDays: 28 };
  if (['5m', '5min', '5minute'].includes(i)) return { unit: 'minutes', n: 5, windowDays: 28 };
  if (['15m', '15min', '15minute'].includes(i)) return { unit: 'minutes', n: 15, windowDays: 28 };
  if (['30m', '30min', '30minute'].includes(i)) return { unit: 'minutes', n: 30, windowDays: 85 };
  if (['1h', '1hour', '60m', '60min', 'hour'].includes(i)) return { unit: 'hours', n: 1, windowDays: 85 };
  return null;
}

/** Upstox refused the access token: expired, revoked, or used from an unlisted IP. */
export class UpstoxAuthError extends Error {}

export interface BatchQuote {
  ltp: number; change: number; previousClose: number;
  open: number; high: number; low: number; volume: number; timestamp: string | null;
}

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export class UpstoxService {
  private maps: InstrumentMaps | null = null;
  private loadedAt = 0;
  private loading: Promise<InstrumentMaps | null> | null = null;

  /** Called once per rejected token, so the app can stop presenting Upstox as connected. */
  onAuthFailure: ((token: string) => void) | null = null;

  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

  private authFailed(token: string, err: unknown): void {
    if (err instanceof UpstoxAuthError) this.onAuthFailure?.(token);
  }

  async instrumentMaps(): Promise<InstrumentMaps | null> {
    if (this.maps && Date.now() - this.loadedAt < MASTER_TTL_MS) return this.maps;
    if (!this.loading) {
      this.loading = (async () => {
        try {
          const records: MasterRecord[] = [];
          for (const exchange of ['NSE', 'BSE']) {
            const res = await this.fetchImpl(MASTER_URL(exchange), { signal: AbortSignal.timeout(60_000) });
            if (!res.ok) throw new Error(`${exchange} instrument master HTTP ${res.status}`);
            const json = JSON.parse(gunzipSync(Buffer.from(await res.arrayBuffer())).toString('utf8'));
            // Keep only what buildMaps uses (cash and F&O); the commodity, currency
            // and index rows are about a third of the file. Each file is parsed and
            // filtered before the next is fetched, so both are never in memory at once.
            if (Array.isArray(json)) for (const r of json) if (USED_SEGMENTS.has(r?.segment)) records.push(r);
          }
          this.maps = buildMaps(records);
          this.loadedAt = Date.now();
          log.info({ equities: this.maps.equity.size, derivatives: this.maps.derivatives.size }, 'Upstox instrument master loaded');
        } catch (err) {
          log.warn({ err: (err as Error).message }, 'Upstox instrument master unavailable');
        } finally {
          this.loading = null;
        }
        return this.maps;
      })();
    }
    return this.loading;
  }

  private async get(path: string, token: string): Promise<any> {
    const res = await this.fetchImpl(`${API}${path}`, {
      headers: { Accept: 'application/json', Authorization: `Bearer ${token}` },
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null) as any;
    if (!res.ok || body?.status !== 'success') {
      const msg = body?.errors?.[0]?.message ?? `HTTP ${res.status}`;
      const text = `Upstox ${path.split('?')[0]}: ${msg}`;
      throw res.status === 401 ? new UpstoxAuthError(text) : new Error(text);
    }
    return body.data;
  }

  /** Candles in the app's format, oldest first; [] when Upstox cannot serve the request. */
  async history(token: string, symbol: string, interval: string, from: string, to: string, exchange = 'NSE'): Promise<HistoricalBar[]> {
    const spec = upstoxInterval(interval);
    const maps = await this.instrumentMaps();
    const key = maps ? resolveKey(maps, symbol, exchange) : null;
    // A contract missing from today's instrument file has expired: Upstox keeps
    // those under a separate API (Upstox Plus only).
    if (!key && maps && spec && isDerivativeSymbol(symbol)) return this.expiredHistory(token, maps, symbol, interval, from, to);
    if (!spec || !key) return [];

    const daily = isDailyInterval(interval);
    const byTime = new Map<string, HistoricalBar>();
    try {
      for (let start = from; start <= to; start = addDays(start, spec.windowDays)) {
        const end = addDays(start, spec.windowDays - 1) < to ? addDays(start, spec.windowDays - 1) : to;
        const data = await this.get(
          `/v3/historical-candle/${encodeURIComponent(key)}/${spec.unit}/${spec.n}/${end}/${start}`, token,
        );
        for (const c of (data?.candles ?? []) as any[]) {
          const [ts, open, high, low, close, volume] = c;
          if (!(Number(open) > 0)) continue;
          const timestamp = formatBarTime(Date.parse(ts), daily);
          byTime.set(timestamp, { timestamp, open: +open, high: +high, low: +low, close: +close, volume: Number(volume) || 0 });
        }
      }
    } catch (err) {
      // A gap mid-series would be served as if complete; return nothing instead.
      log.warn({ symbol, interval, err: (err as Error).message }, 'Upstox history failed');
      this.authFailed(token, err);
      return [];
    }
    return [...byTime.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
  }

  /** Upcoming option expiries for an underlying, from the public instrument file (no login needed). */
  async expiries(symbol: string): Promise<string[]> {
    const maps = await this.instrumentMaps();
    const today = formatBarTime(Date.now(), true);
    return [...(maps?.optionExpiries.get(symbol.trim().toUpperCase()) ?? [])].filter((e) => e >= today).sort();
  }

  /** Current F&O lot sizes by underlying, from the public instrument file (no login needed). */
  async lotSizes(): Promise<Record<string, number>> {
    const maps = await this.instrumentMaps();
    return maps ? Object.fromEntries(maps.lotSizes) : {};
  }

  /**
   * Candles for an expired futures or options contract (for backtests).
   * Finds the contract in Upstox's expired list for that expiry, then pages
   * through its history. Upstox serves these to Upstox Plus subscribers only.
   */
  private async expiredHistory(
    token: string, maps: InstrumentMaps, symbol: string, interval: string, from: string, to: string,
  ): Promise<HistoricalBar[]> {
    const EXPIRED_INTERVALS: Record<string, string> = {
      '1minute': '1minute', '1m': '1minute', 'minute': '1minute',
      '5minute': '5minute', '5m': '5minute', '15minute': '15minute', '15m': '15minute',
      '30minute': '30minute', '30m': '30minute',
    };
    const daily = isDailyInterval(interval);
    const upInterval = daily ? 'day' : EXPIRED_INTERVALS[interval.toLowerCase()];
    const spec = parseInstrumentSymbol(symbol);
    const underlyingKey = resolveKey(maps, spec.underlying);
    if (!upInterval || !underlyingKey || !spec.expiry || spec.exchange !== 'NFO') return [];
    const expiry = istDateStr(spec.expiry);
    const kind = spec.instrumentType === 'FUTURES' ? 'future' : 'option';
    try {
      const contracts = await this.get(
        `/v2/expired-instruments/${kind}/contract?instrument_key=${encodeURIComponent(underlyingKey)}&expiry_date=${expiry}`, token,
      ) as any[];
      const match = (contracts ?? []).find((c) => kind === 'future'
        || (c.instrument_type === spec.optionType && Number(c.strike_price) === spec.strike));
      if (!match?.instrument_key) return [];

      const windowDays = daily ? 3600 : 28;
      const end = expiry < to ? expiry : to;
      const byTime = new Map<string, HistoricalBar>();
      for (let start = from; start <= end; start = addDays(start, windowDays)) {
        const stop = addDays(start, windowDays - 1) < end ? addDays(start, windowDays - 1) : end;
        const data = await this.get(
          `/v2/expired-instruments/historical-candle/${encodeURIComponent(match.instrument_key)}/${upInterval}/${stop}/${start}`, token,
        );
        for (const c of (data?.candles ?? []) as any[]) {
          const [ts, open, high, low, close, volume] = c;
          if (!(Number(open) > 0)) continue;
          const timestamp = formatBarTime(Date.parse(ts), daily);
          byTime.set(timestamp, { timestamp, open: +open, high: +high, low: +low, close: +close, volume: Number(volume) || 0 });
        }
      }
      return [...byTime.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
    } catch (err) {
      const msg = (err as Error).message;
      log.warn({ symbol, err: msg }, /Plus/i.test(msg)
        ? 'Expired-contract history needs an Upstox Plus subscription'
        : 'Upstox expired-contract history failed');
      this.authFailed(token, err);
      return [];
    }
  }

  /** The Upstox account the token belongs to (its user_id), or null if Upstox refuses the token. */
  async profileUserId(token: string): Promise<string | null> {
    try {
      const data = await this.get('/v2/user/profile', token);
      return data?.user_id ? String(data.user_id) : null;
    } catch {
      return null;
    }
  }

  /** The option chain for an index or stock and one expiry (nearest upcoming when not given). */
  async optionChain(token: string, symbol: string, expiry?: string) {
    const maps = await this.instrumentMaps();
    const u = symbol.trim().toUpperCase();
    const key = maps ? resolveKey(maps, u) : null;
    const expiries = [...(maps?.optionExpiries.get(u) ?? [])].sort();
    const today = formatBarTime(Date.now(), true);
    const target = expiry || expiries.find((e) => e >= today);
    if (!maps || !key || !target) return null;
    try {
      const rows = await this.get(
        `/v2/option/chain?instrument_key=${encodeURIComponent(key)}&expiry_date=${target}`, token,
      );
      if (!Array.isArray(rows) || rows.length === 0) return null;
      return mapOptionChain(u, target, expiries.filter((e) => e >= today), maps.lotSizes.get(u) ?? 0, rows);
    } catch (err) {
      log.warn({ symbol: u, expiry: target, err: (err as Error).message }, 'Upstox option chain failed');
      this.authFailed(token, err);
      return null;
    }
  }

  /**
   * Last price, day change and volume for many instruments at once (Upstox
   * allows 500 keys per request). Keyed by instrument key; missing keys had no quote.
   */
  async quotes(token: string, keys: string[]): Promise<Map<string, BatchQuote>> {
    const out = new Map<string, BatchQuote>();
    for (let i = 0; i < keys.length; i += 500) {
      const chunk = keys.slice(i, i + 500);
      try {
        const data = await this.get(`/v2/market-quote/quotes?instrument_key=${encodeURIComponent(chunk.join(','))}`, token);
        for (const q of Object.values(data ?? {}) as any[]) {
          const ltp = Number(q?.last_price);
          if (!q?.instrument_token || !(ltp > 0)) continue;
          const change = Number(q.net_change) || 0;
          out.set(q.instrument_token, {
            ltp, change, previousClose: ltp - change,
            open: Number(q.ohlc?.open) || 0, high: Number(q.ohlc?.high) || 0, low: Number(q.ohlc?.low) || 0,
            volume: Number(q.volume) || 0,
            timestamp: q.timestamp ?? null,
          });
        }
      } catch (err) {
        this.authFailed(token, err);
        if (err instanceof UpstoxAuthError) throw err;
        log.warn({ err: (err as Error).message }, 'Upstox batch quote failed');
      }
    }
    return out;
  }

  async quote(token: string, symbol: string, exchange = 'NSE'): Promise<MarketQuote | null> {
    const maps = await this.instrumentMaps();
    const key = maps ? resolveKey(maps, symbol, exchange) : null;
    if (!key) return null;
    try {
      const data = await this.get(`/v2/market-quote/quotes?instrument_key=${encodeURIComponent(key)}`, token);
      const q = Object.values(data ?? {})[0] as any;
      const ltp = Number(q?.last_price);
      if (!(ltp > 0)) return null;
      const change = Number(q.net_change) || 0;
      const prevClose = ltp - change;
      return {
        symbol, exchange,
        ltp: +ltp.toFixed(2),
        change: +change.toFixed(2),
        changePercent: prevClose > 0 ? +((change / prevClose) * 100).toFixed(2) : 0,
        open: Number(q.ohlc?.open) || 0,
        high: Number(q.ohlc?.high) || 0,
        low: Number(q.ohlc?.low) || 0,
        close: +prevClose.toFixed(2),
        volume: Number(q.volume) || 0,
        bidPrice: Number(q.depth?.buy?.[0]?.price) || 0,
        askPrice: Number(q.depth?.sell?.[0]?.price) || 0,
        bidQty: Number(q.depth?.buy?.[0]?.quantity) || 0,
        askQty: Number(q.depth?.sell?.[0]?.quantity) || 0,
        timestamp: q.timestamp ?? new Date().toISOString(),
      };
    } catch (err) {
      log.warn({ symbol, err: (err as Error).message }, 'Upstox quote failed');
      this.authFailed(token, err);
      return null;
    }
  }
}

/** Upstox option chain in the app's option-chain shape (the same one the Breeze bridge returns). */
export function mapOptionChain(symbol: string, expiry: string, expiries: string[], lotSize: number, rows: any[]) {
  const side = (o: any) => {
    const m = o?.market_data ?? {};
    const g = o?.option_greeks ?? {};
    const n = (v: unknown) => Number(v) || 0;
    return {
      OI: n(m.oi), OIChange: n(m.oi) - n(m.prev_oi), Volume: n(m.volume),
      IV: n(g.iv), LTP: n(m.ltp), NetChange: +(n(m.ltp) - n(m.close_price)).toFixed(2),
      BidPrice: n(m.bid_price), AskPrice: n(m.ask_price),
      Delta: n(g.delta), Gamma: n(g.gamma), Theta: n(g.theta), Vega: n(g.vega),
    };
  };
  const strikes = rows
    .map((r) => {
      const c = side(r.call_options), p = side(r.put_options);
      return {
        strike: Number(r.strike_price),
        callOI: c.OI, callOIChange: c.OIChange, callVolume: c.Volume, callIV: c.IV, callLTP: c.LTP, callNetChange: c.NetChange,
        callBidPrice: c.BidPrice, callAskPrice: c.AskPrice, callDelta: c.Delta, callGamma: c.Gamma, callTheta: c.Theta, callVega: c.Vega,
        putOI: p.OI, putOIChange: p.OIChange, putVolume: p.Volume, putIV: p.IV, putLTP: p.LTP, putNetChange: p.NetChange,
        putBidPrice: p.BidPrice, putAskPrice: p.AskPrice, putDelta: p.Delta, putGamma: p.Gamma, putTheta: p.Theta, putVega: p.Vega,
      };
    })
    .filter((s) => s.strike > 0)
    .sort((a, b) => a.strike - b.strike);

  const spot = Number(rows.find((r) => Number(r.underlying_spot_price) > 0)?.underlying_spot_price) || 0;
  const totalCallOI = strikes.reduce((t, s) => t + s.callOI, 0);
  const totalPutOI = strikes.reduce((t, s) => t + s.putOI, 0);
  // Max pain: the expiry price at which option writers pay out least. Calls
  // below the price and puts above it finish in the money.
  let maxPain = 0, least = Infinity;
  for (const at of strikes) {
    let pay = 0;
    for (const k of strikes) {
      if (k.strike < at.strike) pay += (at.strike - k.strike) * k.callOI;
      if (k.strike > at.strike) pay += (k.strike - at.strike) * k.putOI;
    }
    if (pay < least) { least = pay; maxPain = at.strike; }
  }
  return {
    symbol: symbol.toUpperCase(), expiry, underlyingValue: spot, spotPrice: spot, strikes,
    pcr: totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0,
    maxPain, totalCallOI, totalPutOI, expiries, lotSize, source: 'upstox',
  };
}

let shared: UpstoxService | null = null;
export const getUpstox = (): UpstoxService => (shared ??= new UpstoxService());
