import { CacheService } from '../lib/redis.js';
import { getPrisma } from '../lib/prisma.js';
import { createHash, createDecipheriv } from 'crypto';
import https from 'https';
import { env } from '../config.js';

const CACHE_TTL_QUOTE = 30;
const CACHE_TTL_HISTORY = 300;
const CACHE_TTL_SEARCH = 3600;
const CACHE_TTL_INDICES = 60;
const FETCH_TIMEOUT_MS = 10_000;

const POPULAR_NSE_STOCKS: [string, string][] = [
  ['RELIANCE', 'Reliance Industries Ltd'],
  ['TCS', 'Tata Consultancy Services Ltd'],
  ['HDFCBANK', 'HDFC Bank Ltd'],
  ['INFY', 'Infosys Ltd'],
  ['ICICIBANK', 'ICICI Bank Ltd'],
  ['HINDUNILVR', 'Hindustan Unilever Ltd'],
  ['SBIN', 'State Bank of India'],
  ['BHARTIARTL', 'Bharti Airtel Ltd'],
  ['KOTAKBANK', 'Kotak Mahindra Bank Ltd'],
  ['ITC', 'ITC Ltd'],
  ['LT', 'Larsen & Toubro Ltd'],
  ['AXISBANK', 'Axis Bank Ltd'],
  ['BAJFINANCE', 'Bajaj Finance Ltd'],
  ['WIPRO', 'Wipro Ltd'],
  ['HCLTECH', 'HCL Technologies Ltd'],
  ['MARUTI', 'Maruti Suzuki India Ltd'],
  ['TATAMOTORS', 'Tata Motors Ltd'],
  ['SUNPHARMA', 'Sun Pharmaceutical Industries Ltd'],
  ['TITAN', 'Titan Company Ltd'],
  ['ASIANPAINT', 'Asian Paints Ltd'],
  ['ADANIENT', 'Adani Enterprises Ltd'],
  ['TATASTEEL', 'Tata Steel Ltd'],
  ['NTPC', 'NTPC Ltd'],
  ['POWERGRID', 'Power Grid Corporation of India'],
  ['ONGC', 'Oil and Natural Gas Corporation'],
  ['JSWSTEEL', 'JSW Steel Ltd'],
  ['M&M', 'Mahindra & Mahindra Ltd'],
  ['BAJAJFINSV', 'Bajaj Finserv Ltd'],
  ['ULTRACEMCO', 'UltraTech Cement Ltd'],
  ['NESTLEIND', 'Nestle India Ltd'],
];

const POPULAR_MCX_COMMODITIES: [string, string, number][] = [
  ['GOLD', 'Gold (1 kg)', 62000],
  ['GOLDM', 'Gold Mini (100 gm)', 62000],
  ['GOLDPETAL', 'Gold Petal (1 gm)', 6200],
  ['SILVER', 'Silver (30 kg)', 74000],
  ['SILVERM', 'Silver Mini (5 kg)', 74000],
  ['CRUDEOIL', 'Crude Oil (100 barrels)', 5800],
  ['NATURALGAS', 'Natural Gas (1250 MMBtu)', 230],
  ['COPPER', 'Copper (2500 kg)', 780],
  ['ZINC', 'Zinc (5000 kg)', 250],
  ['LEAD', 'Lead (5000 kg)', 185],
  ['ALUMINIUM', 'Aluminium (5000 kg)', 210],
  ['NICKEL', 'Nickel (1500 kg)', 1650],
  ['COTTON', 'Cotton (25 bales)', 27000],
  ['MENTHAOIL', 'Mentha Oil (360 kg)', 950],
  ['CASTORSEED', 'Castor Seed (10 MT)', 5800],
];

const POPULAR_CDS_CURRENCIES: [string, string, number][] = [
  ['USDINR', 'US Dollar / Indian Rupee', 83.25],
  ['EURINR', 'Euro / Indian Rupee', 90.50],
  ['GBPINR', 'British Pound / Indian Rupee', 105.30],
  ['JPYINR', 'Japanese Yen / Indian Rupee', 0.556],
  ['AUDINR', 'Australian Dollar / Indian Rupee', 54.80],
  ['CADINR', 'Canadian Dollar / Indian Rupee', 61.50],
  ['CHFINR', 'Swiss Franc / Indian Rupee', 95.40],
  ['SGDINR', 'Singapore Dollar / Indian Rupee', 62.10],
  ['HKDINR', 'Hong Kong Dollar / Indian Rupee', 10.65],
  ['CNHINR', 'Chinese Yuan / Indian Rupee', 11.50],
];

// Yahoo Finance symbol mappings for special cases
const YAHOO_INDEX_MAP: Record<string, string> = {
  'NIFTY 50': '^NSEI',
  'NIFTY50': '^NSEI',
  'NIFTY': '^NSEI',
  'BANKNIFTY': '^NSEBANK',
  'NIFTYBANK': '^NSEBANK',
  'NIFTY BANK': '^NSEBANK',
  'SENSEX': '^BSESN',
  'INDIA VIX': '^INDIAVIX',
  'INDIAVIX': '^INDIAVIX',
};

function toYahooSymbol(symbol: string, exchange = 'NSE'): string {
  const upper = symbol.toUpperCase();
  if (YAHOO_INDEX_MAP[upper]) return YAHOO_INDEX_MAP[upper];
  if (upper.endsWith('.NS') || upper.endsWith('.BO') || upper.startsWith('^')) return upper;
  // M&M → M%26M on Yahoo
  const encoded = upper.replace('&', '%26');
  return exchange === 'BSE' ? `${encoded}.BO` : `${encoded}.NS`;
}

export interface MarketQuote {
  symbol: string;
  exchange: string;
  ltp: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bidPrice: number;
  askPrice: number;
  bidQty: number;
  askQty: number;
  timestamp: string;
}

export interface HistoricalBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export class MarketDataService {
  private cache: CacheService | null;
  private cookies: string = '';
  private cookieExpiry: number = 0;
  private cookieFetchPromise: Promise<void> | null = null;
  private activeNseRequests = 0;

  constructor(cache?: CacheService) {
    this.cache = cache ?? null;
  }

  // ── Yahoo Finance: primary data source (works from any server, no auth) ──

  private async fetchFromYahoo(symbol: string, exchange = 'NSE'): Promise<MarketQuote | null> {
    try {
      const yahooSym = toYahooSymbol(symbol, exchange);
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=1d`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (!res.ok) return null;

      const data = await res.json() as any;
      const result = data?.chart?.result?.[0];
      if (!result) return null;

      const meta = result.meta ?? {};
      const quote = result.indicators?.quote?.[0] ?? {};
      const len = quote.close?.length ?? 0;

      if (len === 0) return null;

      const lastIdx = len - 1;
      const ltp = meta.regularMarketPrice ?? quote.close?.[lastIdx] ?? 0;
      const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? 0;
      const open = quote.open?.[lastIdx] ?? meta.regularMarketDayOpen ?? 0;
      const high = quote.high?.[lastIdx] ?? meta.regularMarketDayHigh ?? 0;
      const low = quote.low?.[lastIdx] ?? meta.regularMarketDayLow ?? 0;
      const close = prevClose || ltp;
      const volume = quote.volume?.[lastIdx] ?? meta.regularMarketVolume ?? 0;
      const change = ltp - prevClose;
      const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;

      return {
        symbol,
        exchange,
        ltp,
        change: Number(change.toFixed(2)),
        changePercent: Number(changePercent.toFixed(2)),
        open,
        high,
        low,
        close,
        volume,
        bidPrice: 0,
        askPrice: 0,
        bidQty: 0,
        askQty: 0,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  private async fetchHistoryFromYahoo(
    symbol: string,
    interval: string,
    fromDate: string,
    toDate: string,
    exchange = 'NSE',
  ): Promise<HistoricalBar[]> {
    try {
      const yahooSym = toYahooSymbol(symbol, exchange);
      const yahooInterval = this.mapIntervalToYahoo(interval);

      const period1 = Math.floor(new Date(fromDate).getTime() / 1000);
      const period2 = Math.floor(new Date(toDate + 'T23:59:59Z').getTime() / 1000);

      const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=${yahooInterval}&period1=${period1}&period2=${period2}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (!res.ok) return [];

      const data = await res.json() as any;
      const result = data?.chart?.result?.[0];
      if (!result) return [];

      const timestamps: number[] = result.timestamp ?? [];
      const quote = result.indicators?.quote?.[0] ?? {};

      const bars: HistoricalBar[] = [];
      for (let i = 0; i < timestamps.length; i++) {
        const o = quote.open?.[i];
        const h = quote.high?.[i];
        const l = quote.low?.[i];
        const c = quote.close?.[i];
        const v = quote.volume?.[i] ?? 0;
        if (o == null || c == null) continue;
        bars.push({
          timestamp: new Date(timestamps[i] * 1000).toISOString().slice(0, 10),
          open: Number(o.toFixed(2)),
          high: Number((h ?? o).toFixed(2)),
          low: Number((l ?? o).toFixed(2)),
          close: Number(c.toFixed(2)),
          volume: v,
        });
      }

      return bars;
    } catch {
      return [];
    }
  }

  private mapIntervalToYahoo(interval: string): string {
    const map: Record<string, string> = {
      '1m': '1m', '1min': '1m', 'minute': '1m',
      '5m': '5m', '5min': '5m', '5minute': '5m',
      '15m': '15m', '15min': '15m', '15minute': '15m',
      '30m': '30m', '30min': '30m', '30minute': '30m',
      '1h': '1h', '60m': '1h', '60min': '1h',
      '1d': '1d', '1day': '1d', 'day': '1d', 'daily': '1d',
      '1wk': '1wk', 'week': '1wk', 'weekly': '1wk',
      '1mo': '1mo', 'month': '1mo', 'monthly': '1mo',
    };
    return map[interval.toLowerCase()] ?? '1d';
  }

  // ── Public API ──

  async getQuote(symbol: string, exchange = 'NSE'): Promise<MarketQuote> {
    const cacheKey = `quote:${exchange}:${symbol}`;

    if (this.cache) {
      const cached = await this.cache.get<MarketQuote>(cacheKey);
      if (cached && cached.ltp > 0) return cached;
    }

    if (exchange === 'MCX') {
      const quote = this.getMCXQuote(symbol);
      if (this.cache) await this.cache.set(cacheKey, quote, CACHE_TTL_QUOTE);
      return quote;
    }

    if (exchange === 'CDS') {
      const quote = this.getCDSQuote(symbol);
      if (this.cache) await this.cache.set(cacheKey, quote, CACHE_TTL_QUOTE);
      return quote;
    }

    // Primary: Yahoo Finance (works from any server, no auth needed)
    const yahooQuote = await this.fetchFromYahoo(symbol, exchange);
    if (yahooQuote && yahooQuote.ltp > 0) {
      if (this.cache) await this.cache.set(cacheKey, yahooQuote, CACHE_TTL_QUOTE);
      return yahooQuote;
    }

    // Fallback 1: NSE direct scraping
    const nseQuote = await this.fetchFromNSE(symbol);
    if (nseQuote && nseQuote.ltp > 0) {
      if (this.cache) await this.cache.set(cacheKey, nseQuote, CACHE_TTL_QUOTE);
      return nseQuote;
    }

    // Fallback 2: Breeze API
    try {
      const today = new Date().toISOString().split('T')[0];
      const weekAgo = new Date(Date.now() - 7 * 86400000).toISOString().split('T')[0];
      const bars = await this.fetchFromBreeze(symbol, '1day', weekAgo, today);
      if (bars.length > 0) {
        const latest = bars[bars.length - 1];
        const breezeQuote: MarketQuote = {
          symbol,
          exchange,
          ltp: latest.close,
          change: latest.close - latest.open,
          changePercent: latest.open > 0 ? ((latest.close - latest.open) / latest.open) * 100 : 0,
          open: latest.open,
          high: latest.high,
          low: latest.low,
          close: latest.close,
          volume: latest.volume,
          bidPrice: 0,
          askPrice: 0,
          bidQty: 0,
          askQty: 0,
          timestamp: latest.timestamp ?? new Date().toISOString(),
        };
        if (this.cache) await this.cache.set(cacheKey, breezeQuote, CACHE_TTL_QUOTE);
        return breezeQuote;
      }
    } catch { /* Breeze fallback failed */ }

    return nseQuote ?? this.emptyQuote(symbol, exchange);
  }

  async getHistory(
    symbol: string,
    interval: string,
    fromDate: string,
    toDate: string,
    userId?: string,
    exchange: string = 'NSE',
  ): Promise<HistoricalBar[]> {
    const cacheKey = `history:${exchange}:${symbol}:${interval}:${fromDate}:${toDate}`;

    if (this.cache) {
      const cached = await this.cache.get<HistoricalBar[]>(cacheKey);
      if (cached) return cached;
    }

    if (exchange === 'MCX' || exchange === 'CDS') {
      const bars = this.generateSimulatedHistory(symbol, exchange, fromDate, toDate);
      if (this.cache) await this.cache.set(cacheKey, bars, CACHE_TTL_HISTORY);
      return bars;
    }

    // Primary: Yahoo Finance
    const yahooBars = await this.fetchHistoryFromYahoo(symbol, interval, fromDate, toDate, exchange);
    if (yahooBars.length > 0) {
      if (this.cache) await this.cache.set(cacheKey, yahooBars, CACHE_TTL_HISTORY);
      return yahooBars;
    }

    // Fallback: Breeze API
    const bars = await this.fetchFromBreeze(symbol, interval, fromDate, toDate, userId, exchange);
    if (bars.length > 0 && this.cache) {
      await this.cache.set(cacheKey, bars, CACHE_TTL_HISTORY);
    }
    return bars;
  }

  async getTopMovers(count = 20): Promise<{ gainers: MarketMover[]; losers: MarketMover[] }> {
    const cacheKey = `market:top-movers:${count}`;
    if (this.cache) {
      const cached = await this.cache.get<{ gainers: MarketMover[]; losers: MarketMover[] }>(cacheKey);
      if (cached) return cached;
    }

    // Primary: Yahoo Finance batch quote for NIFTY 50 constituents
    const yahooResult = await this.fetchTopMoversFromYahoo(count);
    if (yahooResult.gainers.length > 0 || yahooResult.losers.length > 0) {
      if (this.cache) await this.cache.set(cacheKey, yahooResult, 60);
      return yahooResult;
    }

    // Fallback: NSE scraping
    try {
      const res = await this.nseFetch(
        'https://www.nseindia.com/api/equity-stockIndices?index=NIFTY%20500',
      );

      if (!res.ok) {
        await res.text().catch(() => {});
        return this.fallbackMovers(count);
      }

      const data = await res.json() as any;
      const stocks: any[] = data.data ?? [];

      if (stocks.length === 0) return this.fallbackMovers(count);

      const mapped: MarketMover[] = stocks
        .filter((s: any) => s.symbol && s.symbol !== 'NIFTY 500' && s.lastPrice > 0)
        .map((s: any) => ({
          symbol: s.symbol,
          name: s.meta?.companyName ?? s.symbol,
          ltp: s.lastPrice ?? 0,
          change: s.change ?? 0,
          changePercent: s.pChange ?? 0,
          volume: s.totalTradedVolume ?? 0,
          open: s.open ?? 0,
          high: s.dayHigh ?? 0,
          low: s.dayLow ?? 0,
          previousClose: s.previousClose ?? 0,
        }));

      const sorted = [...mapped].sort((a, b) => b.changePercent - a.changePercent);
      const gainers = sorted.slice(0, count);
      const losers = sorted.slice(-count).reverse();

      const result = { gainers, losers };
      if (this.cache) await this.cache.set(cacheKey, result, 60);
      return result;
    } catch {
      return this.fallbackMovers(count);
    }
  }

  private async fetchTopMoversFromYahoo(count: number): Promise<{ gainers: MarketMover[]; losers: MarketMover[] }> {
    const symbols = POPULAR_NSE_STOCKS.map(([code]) => code);
    const movers: MarketMover[] = [];

    // Fetch in batches of 8 to avoid overloading
    const batchSize = 8;
    for (let i = 0; i < symbols.length; i += batchSize) {
      const batch = symbols.slice(i, i + batchSize);
      const promises = batch.map(async (sym) => {
        try {
          const quote = await this.fetchFromYahoo(sym, 'NSE');
          if (quote && quote.ltp > 0) {
            const entry = POPULAR_NSE_STOCKS.find(([code]) => code === sym);
            movers.push({
              symbol: sym,
              name: entry?.[1] ?? sym,
              ltp: quote.ltp,
              change: quote.change,
              changePercent: quote.changePercent,
              volume: quote.volume,
              open: quote.open,
              high: quote.high,
              low: quote.low,
              previousClose: quote.close,
            });
          }
        } catch { /* skip */ }
      });
      await Promise.all(promises);
    }

    if (movers.length === 0) return { gainers: [], losers: [] };

    const sorted = [...movers].sort((a, b) => b.changePercent - a.changePercent);
    return {
      gainers: sorted.slice(0, count),
      losers: sorted.slice(-count).reverse(),
    };
  }

  async getIndices(): Promise<{ name: string; value: number; change: number; changePercent: number }[]> {
    const cacheKey = 'market:indices';

    if (this.cache) {
      const cached = await this.cache.get<any[]>(cacheKey);
      if (cached) return cached;
    }

    // Primary: Yahoo Finance for key indices
    const indexSymbols: [string, string][] = [
      ['^NSEI', 'NIFTY 50'],
      ['^NSEBANK', 'NIFTY BANK'],
      ['^BSESN', 'SENSEX'],
      ['^INDIAVIX', 'INDIA VIX'],
    ];

    const indices: { name: string; value: number; change: number; changePercent: number }[] = [];

    const promises = indexSymbols.map(async ([sym, name]) => {
      try {
        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=1d`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch(url, {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
          signal: ac.signal,
        });
        clearTimeout(timer);

        if (!res.ok) return;

        const data = await res.json() as any;
        const meta = data?.chart?.result?.[0]?.meta;
        if (!meta) return;

        const value = meta.regularMarketPrice ?? 0;
        const prevClose = meta.chartPreviousClose ?? 0;
        const change = value - prevClose;
        const changePercent = prevClose > 0 ? (change / prevClose) * 100 : 0;

        indices.push({
          name,
          value: Number(value.toFixed(2)),
          change: Number(change.toFixed(2)),
          changePercent: Number(changePercent.toFixed(2)),
        });
      } catch { /* skip */ }
    });

    await Promise.all(promises);

    if (indices.length > 0 && this.cache) {
      await this.cache.set(cacheKey, indices, CACHE_TTL_INDICES);
    }

    if (indices.length > 0) return indices;

    // Fallback: NSE direct
    try {
      const res = await this.nseFetch('https://www.nseindia.com/api/allIndices');
      if (!res.ok) { await res.text().catch(() => {}); return []; }
      const data = await res.json() as any;
      return (data.data ?? []).slice(0, 10).map((idx: any) => ({
        name: idx.index,
        value: idx.last,
        change: idx.variation,
        changePercent: idx.percentChange,
      }));
    } catch {
      return [];
    }
  }

  async getVIX(): Promise<{ value: number; change: number; changePercent: number }> {
    const cacheKey = 'market:vix';

    if (this.cache) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    try {
      const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5EINDIAVIX?interval=1d&range=1d`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (res.ok) {
        const data = await res.json() as any;
        const meta = data?.chart?.result?.[0]?.meta;
        if (meta?.regularMarketPrice) {
          const value = meta.regularMarketPrice;
          const prevClose = meta.chartPreviousClose ?? value;
          const result = {
            value: Number(value.toFixed(2)),
            change: Number((value - prevClose).toFixed(2)),
            changePercent: Number((prevClose > 0 ? ((value - prevClose) / prevClose) * 100 : 0).toFixed(2)),
          };
          if (this.cache) await this.cache.set(cacheKey, result, CACHE_TTL_INDICES);
          return result;
        }
      }
    } catch { /* Yahoo failed */ }

    // Fallback: NSE
    try {
      const res = await this.nseFetch('https://www.nseindia.com/api/allIndices');
      if (!res.ok) { await res.text().catch(() => {}); return { value: 0, change: 0, changePercent: 0 }; }
      const data = await res.json() as any;
      const vix = (data.data ?? []).find((idx: any) => idx.index === 'INDIA VIX');
      if (vix) {
        const result = { value: vix.last, change: vix.variation, changePercent: vix.percentChange };
        if (this.cache) await this.cache.set(cacheKey, result, CACHE_TTL_INDICES);
        return result;
      }
    } catch { /* NSE failed too */ }

    return { value: 0, change: 0, changePercent: 0 };
  }

  async getFIIDII() {
    const cacheKey = 'market:fii-dii';

    if (this.cache) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    return {
      date: new Date().toISOString().split('T')[0],
      fiiBuy: 0,
      fiiSell: 0,
      fiiNet: 0,
      diiBuy: 0,
      diiSell: 0,
      diiNet: 0,
    };
  }

  async getOptionsChain(symbol: string) {
    const cacheKey = `options:${symbol}`;
    if (this.cache) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    // Try Breeze API first (works reliably from server environments)
    try {
      const breezeResult = await this.fetchOptionsChainFromBreeze(symbol);
      if (breezeResult && breezeResult.strikes.length > 0) {
        if (this.cache) await this.cache.set(cacheKey, breezeResult, 120);
        return breezeResult;
      }
    } catch { /* Breeze unavailable, try NSE */ }

    // Fallback: NSE India scraping
    try {
      const url = `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol)}`;
      const res = await this.nseFetch(url);
      if (!res.ok) {
        await res.text().catch(() => {});
        const equityUrl = `https://www.nseindia.com/api/option-chain-equities?symbol=${encodeURIComponent(symbol)}`;
        const equityRes = await this.nseFetch(equityUrl);
        if (!equityRes.ok) {
          await equityRes.text().catch(() => {});
          return { symbol, strikes: [], expiry: '' };
        }
        const data = await equityRes.json() as any;
        return this.parseOptionsChain(symbol, data);
      }
      const data = await res.json() as any;
      const result = this.parseOptionsChain(symbol, data);

      if (result.strikes.length > 0 && this.cache) {
        await this.cache.set(cacheKey, result, 120);
      }
      return result;
    } catch {
      return { symbol, strikes: [], expiry: '' };
    }
  }

  async search(query: string, limit = 10, exchange?: string) {
    if (!query || query.length < 1) return [];

    const cacheKey = `search:${exchange ?? 'ALL'}:${query.toLowerCase()}`;

    if (this.cache) {
      const cached = await this.cache.get<any[]>(cacheKey);
      if (cached) return cached;
    }

    const q = query.toLowerCase();
    const results: any[] = [];

    if (!exchange || exchange === 'NSE' || exchange === 'BSE') {
      const nseResults = POPULAR_NSE_STOCKS
        .filter(([code, name]) => code.toLowerCase().includes(q) || name.toLowerCase().includes(q))
        .map(([code, name]) => ({
          stock_code: code, symbol: code, name, exchange: 'NSE', segment: 'equity', token: '',
        }));
      results.push(...nseResults);
    }

    if (!exchange || exchange === 'MCX') {
      const mcxResults = POPULAR_MCX_COMMODITIES
        .filter(([code, name]) => code.toLowerCase().includes(q) || name.toLowerCase().includes(q))
        .map(([code, name]) => ({
          stock_code: code, symbol: code, name, exchange: 'MCX', segment: 'commodity', token: '',
        }));
      results.push(...mcxResults);
    }

    if (!exchange || exchange === 'CDS') {
      const cdsResults = POPULAR_CDS_CURRENCIES
        .filter(([code, name]) => code.toLowerCase().includes(q) || name.toLowerCase().includes(q))
        .map(([code, name]) => ({
          stock_code: code, symbol: code, name, exchange: 'CDS', segment: 'currency', token: '',
        }));
      results.push(...cdsResults);
    }

    const sliced = results.slice(0, limit);

    if (sliced.length > 0 && this.cache) {
      await this.cache.set(cacheKey, sliced, CACHE_TTL_SEARCH);
    }

    return sliced;
  }

  async getIndicesForExchange(exchange: string): Promise<{ name: string; value: number; change: number; changePercent: number }[]> {
    if (exchange === 'MCX') {
      return [
        { name: 'MCX iCOMDEX Composite', value: 5890 + Math.random() * 50, change: (Math.random() - 0.45) * 30, changePercent: (Math.random() - 0.45) * 0.5 },
        { name: 'MCX iCOMDEX Bullion', value: 17200 + Math.random() * 100, change: (Math.random() - 0.45) * 80, changePercent: (Math.random() - 0.45) * 0.4 },
        { name: 'MCX iCOMDEX Metal', value: 8100 + Math.random() * 40, change: (Math.random() - 0.45) * 35, changePercent: (Math.random() - 0.45) * 0.5 },
        { name: 'MCX iCOMDEX Energy', value: 4200 + Math.random() * 30, change: (Math.random() - 0.45) * 25, changePercent: (Math.random() - 0.45) * 0.6 },
      ].map(i => ({ ...i, value: Number(i.value.toFixed(2)), change: Number(i.change.toFixed(2)), changePercent: Number(i.changePercent.toFixed(2)) }));
    }

    if (exchange === 'CDS') {
      return POPULAR_CDS_CURRENCIES.slice(0, 4).map(([code, _name, base]) => {
        const variation = (Math.random() - 0.48) * base * 0.003;
        return {
          name: code, value: Number((base + variation).toFixed(4)),
          change: Number(variation.toFixed(4)), changePercent: Number(((variation / base) * 100).toFixed(2)),
        };
      });
    }

    return this.getIndices();
  }

  // ── NSE direct scraping (fallback) ──

  private async ensureCookies(): Promise<void> {
    if (this.cookies && Date.now() < this.cookieExpiry) return;
    if (this.cookieFetchPromise) { await this.cookieFetchPromise; return; }
    this.cookieFetchPromise = (async () => {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 6000);
        const res = await fetch('https://www.nseindia.com', {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
            'Accept': 'text/html',
          },
          signal: ac.signal,
        });
        clearTimeout(timer);
        try {
          const reader = res.body?.getReader();
          if (reader) { while (!(await reader.read()).done) {} }
        } catch { /* drain */ }
        const setCookieHeaders = res.headers.getSetCookie?.() ?? [];
        if (setCookieHeaders.length > 0) {
          this.cookies = setCookieHeaders.map((c: string) => c.split(';')[0]).join('; ');
          this.cookieExpiry = Date.now() + 4 * 60 * 1000;
        }
      } catch { /* ignore */ }
      finally { this.cookieFetchPromise = null; }
    })();
    await this.cookieFetchPromise;
  }

  private async nseFetch(url: string): Promise<Response> {
    while (this.activeNseRequests >= 2) {
      await new Promise(r => setTimeout(r, 200));
    }
    this.activeNseRequests++;
    try {
      await this.ensureCookies();
      const headers: Record<string, string> = {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        'Accept': 'application/json',
        'Referer': 'https://www.nseindia.com/',
      };
      if (this.cookies) headers['Cookie'] = this.cookies;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
      const res = await fetch(url, { headers, redirect: 'follow', signal: ac.signal });
      clearTimeout(timer);
      return res;
    } catch (err) {
      throw err;
    } finally {
      this.activeNseRequests--;
    }
  }

  private async fetchFromNSE(symbol: string): Promise<MarketQuote | null> {
    try {
      const res = await this.nseFetch(`https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}`);
      if (!res.ok) { await res.text().catch(() => {}); return null; }
      const data = await res.json() as any;
      const priceInfo = data.priceInfo ?? {};

      return {
        symbol: data.info?.symbol ?? symbol,
        exchange: 'NSE',
        ltp: priceInfo.lastPrice ?? 0,
        change: priceInfo.change ?? 0,
        changePercent: priceInfo.pChange ?? 0,
        open: priceInfo.open ?? 0,
        high: priceInfo.intraDayHighLow?.max ?? 0,
        low: priceInfo.intraDayHighLow?.min ?? 0,
        close: priceInfo.previousClose ?? 0,
        volume: data.securityWiseDP?.quantityTraded ?? 0,
        bidPrice: 0,
        askPrice: 0,
        bidQty: 0,
        askQty: 0,
        timestamp: new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  // ── Breeze API (fallback) ──

  private breezeRequest(path: string, headers: Record<string, string>, body?: string): Promise<{ status: number; data: string }> {
    return new Promise((resolve, reject) => {
      const opts: https.RequestOptions = {
        hostname: 'api.icicidirect.com',
        path,
        method: 'GET',
        headers: { ...headers, ...(body ? { 'Content-Length': String(Buffer.byteLength(body)) } : {}) },
      };
      const req = https.request(opts, (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c: Buffer) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode ?? 0, data: Buffer.concat(chunks).toString() }));
      });
      req.on('error', reject);
      req.setTimeout(FETCH_TIMEOUT_MS, () => req.destroy(new Error('Timeout')));
      if (body) req.write(body);
      req.end();
    });
  }

  private async fetchFromBreeze(
    symbol: string,
    interval: string,
    fromDate: string,
    toDate: string,
    userId?: string,
    exchange: string = 'NSE',
  ): Promise<HistoricalBar[]> {
    const creds = await this.getAnyBreezeCredentials(userId);
    if (!creds) return [];

    const breezeInterval = this.mapInterval(interval);
    const from = `${fromDate}T07:00:00.000Z`;
    const to = `${toDate}T07:00:00.000Z`;

    const breezeExchange = exchange === 'MCX' ? 'MCX' : exchange === 'CDS' ? 'NSE' : 'NSE';
    const productType = exchange === 'MCX' ? 'Futures' : exchange === 'CDS' ? 'Currency' : 'Cash';

    try {
      const payload = JSON.stringify({
        interval: breezeInterval,
        from_date: from,
        to_date: to,
        stock_code: symbol,
        exchange_code: breezeExchange,
        product_type: productType,
      });

      const now = new Date();
      now.setMilliseconds(0);
      const timestamp = now.toISOString();
      const checksum = createHash('sha256').update(timestamp + payload + creds.secretKey).digest('hex');

      const res = await this.breezeRequest(
        '/breezeapi/api/v1/historicalcharts',
        {
          'Content-Type': 'application/json',
          'X-AppKey': creds.apiKey,
          'X-SessionToken': creds.sessionToken,
          'X-Timestamp': timestamp,
          'X-Checksum': `token ${checksum}`,
        },
        payload,
      );

      if (res.status !== 200) return [];

      const data = JSON.parse(res.data);
      if (data.Error) return [];

      const records = data.Success ?? data.data ?? data;
      if (!Array.isArray(records)) return [];

      return records.map((bar: any) => ({
        timestamp: (bar.datetime ?? bar.date ?? bar.timestamp ?? '').slice(0, 10),
        open: Number(bar.open) || 0,
        high: Number(bar.high) || 0,
        low: Number(bar.low) || 0,
        close: Number(bar.close) || 0,
        volume: Number(bar.volume) || 0,
      })).filter((b: HistoricalBar) => b.open > 0);
    } catch {
      return [];
    }
  }

  private async getAnyBreezeCredentials(userId?: string): Promise<{ apiKey: string; secretKey: string; sessionToken: string } | null> {
    try {
      const prisma = getPrisma();
      let credential: any = null;

      if (userId) {
        credential = await prisma.breezeCredential.findUnique({ where: { userId } });
      }

      if (!credential) {
        credential = await prisma.breezeCredential.findFirst({
          where: { sessionToken: { not: null } },
          orderBy: { updatedAt: 'desc' },
        });
      }

      if (!credential?.sessionToken) return null;

      if (credential.sessionExpiresAt && new Date(credential.sessionExpiresAt) < new Date()) {
        return null;
      }

      const key = createHash('sha256').update(env.ENCRYPTION_KEY || env.JWT_SECRET).digest();
      const decryptField = (encrypted: string) => {
        const [ivHex, data] = encrypted.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return decrypted;
      };

      let sessionToken = credential.sessionToken!;
      try {
        sessionToken = decryptField(sessionToken);
      } catch {
        // might be stored unencrypted from an older version
      }
      return {
        apiKey: decryptField(credential.encryptedApiKey),
        secretKey: decryptField(credential.encryptedSecret),
        sessionToken,
      };
    } catch {
      return null;
    }
  }

  private mapInterval(interval: string): string {
    const map: Record<string, string> = {
      '1d': 'day', '1day': 'day', 'day': 'day', 'daily': 'day',
      '1m': 'minute', '1min': 'minute', 'minute': 'minute',
      '5m': '5minute', '5min': '5minute', '5minute': '5minute',
      '15m': '15minute', '15min': '15minute', '15minute': '15minute',
      '30m': '30minute', '30min': '30minute', '30minute': '30minute',
    };
    return map[interval.toLowerCase()] ?? 'day';
  }

  // ── Helpers ──

  private generateSimulatedHistory(symbol: string, exchange: string, fromDate: string, toDate: string): HistoricalBar[] {
    const mcxEntry = POPULAR_MCX_COMMODITIES.find(([code]) => code === symbol.toUpperCase());
    const cdsEntry = POPULAR_CDS_CURRENCIES.find(([code]) => code === symbol.toUpperCase());
    const basePrice = exchange === 'MCX' ? (mcxEntry?.[2] ?? 1000) : (cdsEntry?.[2] ?? 83);

    const bars: HistoricalBar[] = [];
    const start = new Date(fromDate);
    const end = new Date(toDate);
    let currentPrice = basePrice;

    for (let d = new Date(start); d <= end; d.setDate(d.getDate() + 1)) {
      if (d.getDay() === 0 || (exchange !== 'MCX' && d.getDay() === 6)) continue;
      const dailyChange = (Math.random() - 0.48) * basePrice * 0.015;
      const open = currentPrice;
      const close = Number((open + dailyChange).toFixed(exchange === 'CDS' ? 4 : 2));
      const high = Number((Math.max(open, close) * (1 + Math.random() * 0.008)).toFixed(exchange === 'CDS' ? 4 : 2));
      const low = Number((Math.min(open, close) * (1 - Math.random() * 0.008)).toFixed(exchange === 'CDS' ? 4 : 2));
      bars.push({
        timestamp: d.toISOString().slice(0, 10),
        open, high, low, close,
        volume: Math.floor(Math.random() * (exchange === 'MCX' ? 50000 : 200000)) + 5000,
      });
      currentPrice = close;
    }
    return bars;
  }

  private async fetchOptionsChainFromBreeze(symbol: string) {
    const creds = await this.getAnyBreezeCredentials();
    if (!creds) return null;

    const expiry = this.getNextExpiry();
    const exchangeCode = 'NFO';
    const productType = 'options';

    const allStrikes: Map<number, any> = new Map();
    let spotPrice = 0;

    for (const right of ['call', 'put'] as const) {
      try {
        const payload = JSON.stringify({
          stock_code: symbol,
          exchange_code: exchangeCode,
          product_type: productType,
          expiry_date: expiry,
          right,
          strike_price: '',
        });

        const now = new Date();
        now.setMilliseconds(0);
        const timestamp = now.toISOString();
        const checksum = createHash('sha256')
          .update(timestamp + payload + creds.secretKey)
          .digest('hex');

        const res = await this.breezeRequest(
          '/breezeapi/api/v1/optionchain',
          {
            'Content-Type': 'application/json',
            'X-AppKey': creds.apiKey,
            'X-SessionToken': creds.sessionToken,
            'X-Timestamp': timestamp,
            'X-Checksum': `token ${checksum}`,
          },
          payload,
        );

        if (res.status !== 200) continue;

        const data = JSON.parse(res.data);
        if (data.Error || data.Status !== 200) continue;

        const records = data.Success ?? [];
        if (!Array.isArray(records)) continue;

        for (const rec of records) {
          const strike = Number(rec.strike_price) || 0;
          if (strike <= 0) continue;

          if (!spotPrice && rec.spot_price) {
            spotPrice = Number(rec.spot_price) || 0;
          }

          const existing = allStrikes.get(strike) ?? {
            strike,
            callOI: 0, callOIChange: 0, callVolume: 0, callIV: 0, callLTP: 0,
            callDelta: 0, callGamma: 0, callTheta: 0, callVega: 0,
            putOI: 0, putOIChange: 0, putVolume: 0, putIV: 0, putLTP: 0,
            putDelta: 0, putGamma: 0, putTheta: 0, putVega: 0,
          };

          const ltp = Number(rec.ltp) || 0;
          const oi = Number(rec.open_interest) || 0;
          const volume = Number(rec.total_quantity_traded) || 0;
          const iv = Number(rec.implied_volatility) || 0;
          const oiChange = Number(rec.change_oi) ?? 0;

          if (right === 'call') {
            existing.callOI = oi;
            existing.callOIChange = oiChange;
            existing.callVolume = volume;
            existing.callIV = iv;
            existing.callLTP = ltp;
          } else {
            existing.putOI = oi;
            existing.putOIChange = oiChange;
            existing.putVolume = volume;
            existing.putIV = iv;
            existing.putLTP = ltp;
          }

          allStrikes.set(strike, existing);
        }
      } catch { /* skip this right type */ }
    }

    if (allStrikes.size === 0) return null;

    const strikes = [...allStrikes.values()].sort((a, b) => a.strike - b.strike);

    const totalCallOI = strikes.reduce((s, st) => s + st.callOI, 0);
    const totalPutOI = strikes.reduce((s, st) => s + st.putOI, 0);
    const pcr = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;

    let maxPainStrike = 0, minPain = Infinity;
    for (const st of strikes) {
      let pain = 0;
      for (const s2 of strikes) {
        if (s2.strike < st.strike) pain += (st.strike - s2.strike) * s2.putOI;
        if (s2.strike > st.strike) pain += (s2.strike - st.strike) * s2.callOI;
      }
      if (pain < minPain) { minPain = pain; maxPainStrike = st.strike; }
    }

    return {
      symbol,
      expiry: expiry.slice(0, 10),
      underlyingValue: spotPrice,
      spotPrice,
      strikes,
      pcr,
      maxPain: maxPainStrike,
      totalCallOI,
      totalPutOI,
    };
  }

  private getNextExpiry(): string {
    const now = new Date();
    const day = now.getDay();
    let daysUntilThursday = (4 - day + 7) % 7;
    if (daysUntilThursday === 0) {
      const hours = now.getHours();
      if (hours >= 15) daysUntilThursday = 7;
    }
    const expiry = new Date(now);
    expiry.setDate(expiry.getDate() + daysUntilThursday);
    const y = expiry.getFullYear();
    const m = String(expiry.getMonth() + 1).padStart(2, '0');
    const d = String(expiry.getDate()).padStart(2, '0');
    return `${y}-${m}-${d}T06:00:00.000Z`;
  }

  private parseOptionsChain(symbol: string, data: any) {
    const records = data?.records ?? data?.filtered ?? {};
    const allData = records?.data ?? [];
    const expiry = records?.expiryDates?.[0] ?? '';
    const underlyingValue = records?.underlyingValue ?? 0;

    const nearestExpiry = allData.filter((d: any) => d.expiryDate === expiry);
    const strikes = nearestExpiry.map((d: any) => ({
      strike: d.strikePrice,
      callOI: d.CE?.openInterest ?? 0,
      callOIChange: d.CE?.changeinOpenInterest ?? 0,
      callLTP: d.CE?.lastPrice ?? 0,
      callIV: d.CE?.impliedVolatility ?? 0,
      putOI: d.PE?.openInterest ?? 0,
      putOIChange: d.PE?.changeinOpenInterest ?? 0,
      putLTP: d.PE?.lastPrice ?? 0,
      putIV: d.PE?.impliedVolatility ?? 0,
    }));

    const totalCallOI = strikes.reduce((s: number, st: any) => s + st.callOI, 0);
    const totalPutOI = strikes.reduce((s: number, st: any) => s + st.putOI, 0);
    const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 0;

    let maxPainStrike = 0, minPain = Infinity;
    for (const st of strikes) {
      let pain = 0;
      for (const s2 of strikes) {
        if (s2.strike < st.strike) pain += (st.strike - s2.strike) * s2.putOI;
        if (s2.strike > st.strike) pain += (s2.strike - st.strike) * s2.callOI;
      }
      if (pain < minPain) { minPain = pain; maxPainStrike = st.strike; }
    }

    return {
      symbol, expiry, underlyingValue,
      strikes, pcr: Math.round(pcr * 100) / 100,
      maxPain: maxPainStrike,
      totalCallOI, totalPutOI,
    };
  }

  private getMCXQuote(symbol: string): MarketQuote {
    const entry = POPULAR_MCX_COMMODITIES.find(([code]) => code === symbol.toUpperCase());
    const basePrice = entry?.[2] ?? 1000;
    const variation = (Math.random() - 0.48) * basePrice * 0.02;
    const ltp = Number((basePrice + variation).toFixed(2));
    const change = Number(variation.toFixed(2));
    const changePercent = Number(((variation / basePrice) * 100).toFixed(2));
    return {
      symbol, exchange: 'MCX', ltp, change, changePercent,
      open: Number((basePrice + (Math.random() - 0.5) * basePrice * 0.01).toFixed(2)),
      high: Number((ltp * 1.008).toFixed(2)),
      low: Number((ltp * 0.992).toFixed(2)),
      close: basePrice, volume: Math.floor(Math.random() * 50000) + 5000,
      bidPrice: Number((ltp - 0.5).toFixed(2)), askPrice: Number((ltp + 0.5).toFixed(2)),
      bidQty: Math.floor(Math.random() * 100) + 10, askQty: Math.floor(Math.random() * 100) + 10,
      timestamp: new Date().toISOString(),
    };
  }

  private getCDSQuote(symbol: string): MarketQuote {
    const entry = POPULAR_CDS_CURRENCIES.find(([code]) => code === symbol.toUpperCase());
    const basePrice = entry?.[2] ?? 83;
    const variation = (Math.random() - 0.48) * basePrice * 0.005;
    const ltp = Number((basePrice + variation).toFixed(4));
    const change = Number(variation.toFixed(4));
    const changePercent = Number(((variation / basePrice) * 100).toFixed(2));
    return {
      symbol, exchange: 'CDS', ltp, change, changePercent,
      open: Number((basePrice + (Math.random() - 0.5) * basePrice * 0.003).toFixed(4)),
      high: Number((ltp * 1.003).toFixed(4)),
      low: Number((ltp * 0.997).toFixed(4)),
      close: basePrice, volume: Math.floor(Math.random() * 200000) + 50000,
      bidPrice: Number((ltp - 0.0025).toFixed(4)), askPrice: Number((ltp + 0.0025).toFixed(4)),
      bidQty: Math.floor(Math.random() * 500) + 50, askQty: Math.floor(Math.random() * 500) + 50,
      timestamp: new Date().toISOString(),
    };
  }

  private emptyQuote(symbol: string, exchange: string): MarketQuote {
    return {
      symbol, exchange, ltp: 0, change: 0, changePercent: 0,
      open: 0, high: 0, low: 0, close: 0, volume: 0,
      bidPrice: 0, askPrice: 0, bidQty: 0, askQty: 0,
      timestamp: new Date().toISOString(),
    };
  }

  private fallbackMovers(_count: number): { gainers: MarketMover[]; losers: MarketMover[] } {
    return { gainers: [], losers: [] };
  }
}

export interface MarketMover {
  symbol: string;
  name: string;
  ltp: number;
  change: number;
  changePercent: number;
  volume: number;
  open: number;
  high: number;
  low: number;
  previousClose: number;
}
