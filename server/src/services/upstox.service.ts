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
  underlying_symbol?: string;
  expiry?: number;
  strike_price?: number;
}

export interface InstrumentMaps {
  equity: Map<string, string>;                 // "NSE:RELIANCE" -> key
  derivatives: Map<string, string>;            // "NIFTY|CE|2026-10-29|24000" -> key
}

/** Build lookup maps from master records. Exported for tests. */
export function buildMaps(records: MasterRecord[]): InstrumentMaps {
  const equity = new Map<string, string>();
  const derivatives = new Map<string, string>();
  for (const r of records) {
    if (!r.instrument_key || !r.segment) continue;
    if ((r.segment === 'NSE_EQ' || r.segment === 'BSE_EQ') && r.trading_symbol) {
      equity.set(`${r.segment.slice(0, 3)}:${r.trading_symbol.toUpperCase()}`, r.instrument_key);
    } else if (r.segment === 'NSE_FO' && r.underlying_symbol && r.expiry && r.instrument_type) {
      const kind = r.instrument_type === 'FUT' ? 'FUT' : r.instrument_type;    // CE / PE / FUT
      const strike = kind === 'FUT' ? '-' : String(Number(r.strike_price));
      derivatives.set(`${r.underlying_symbol.toUpperCase()}|${kind}|${formatBarTime(r.expiry, true)}|${strike}`, r.instrument_key);
    }
  }
  return { equity, derivatives };
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

const addDays = (date: string, days: number) =>
  new Date(Date.parse(`${date}T00:00:00Z`) + days * 86_400_000).toISOString().slice(0, 10);

export class UpstoxService {
  private maps: InstrumentMaps | null = null;
  private loadedAt = 0;
  private loading: Promise<InstrumentMaps | null> | null = null;

  constructor(private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init)) {}

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
            if (Array.isArray(json)) records.push(...json);
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
      throw new Error(`Upstox ${path.split('?')[0]}: ${msg}`);
    }
    return body.data;
  }

  /** Candles in the app's format, oldest first; [] when Upstox cannot serve the request. */
  async history(token: string, symbol: string, interval: string, from: string, to: string, exchange = 'NSE'): Promise<HistoricalBar[]> {
    const spec = upstoxInterval(interval);
    const maps = await this.instrumentMaps();
    const key = maps ? resolveKey(maps, symbol, exchange) : null;
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
      return [];
    }
    return [...byTime.values()].sort((a, b) => a.timestamp.localeCompare(b.timestamp));
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
      return null;
    }
  }
}

let shared: UpstoxService | null = null;
export const getUpstox = (): UpstoxService => (shared ??= new UpstoxService());
