import { accountScoped, bridgeAccountKey, bridgeFetch, credentialAccount } from '../lib/bridge.js';
import { ownBrokerRequired } from '../lib/broker-access.js';
import { CacheService, getRedis } from '../lib/redis.js';
import { getPrisma } from '../lib/prisma.js';
import { createHash, createDecipheriv } from 'crypto';
import https from 'https';
import { createRequire } from 'module';
import { env } from '../config.js';
import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
import { istDateStr, istDaysAgo, istMidnight } from '../lib/ist.js';
import { latestFiiDii } from '../lib/fii-dii.js';
import { parseInstrumentSymbol, isDerivativeSymbol, type InstrumentSpec, buildOptionSymbol } from '../lib/instrument.js';
import { getUpstox } from './upstox.service.js';
import { getMarketMovers } from './market-movers.service.js';
import { lakeInterval, readBars as readLakeBars } from '../lib/candle-lake.js';
import { getExpiryCalendar } from './expiry-calendar.service.js';
import { activeUpstoxToken } from '../lib/upstox-session.js';
import { cleanCredential } from '../lib/credential-text.js';

const log = createChildLogger('MarketData');

const require = createRequire(import.meta.url);

let BreezeConnect: any = null;
function getBreezeConnectClass(): any {
  if (!BreezeConnect) {
    try {
      const mod = require('breezeconnect');
      BreezeConnect = mod.BreezeConnect || mod.default || mod;
    } catch (err: any) {
      console.log(`[Breeze] Failed to load breezeconnect module: ${err.message}`);
    }
  }
  return BreezeConnect;
}

const CACHE_TTL_QUOTE_MARKET_OPEN = 60;
const CACHE_TTL_QUOTE_MARKET_CLOSED = 3600;
const CACHE_TTL_HISTORY_INTRADAY = 30;
const CACHE_TTL_HISTORY = 300;
const CACHE_TTL_OPTION_CHAIN = 15;
const CACHE_TTL_SEARCH = 3600;
const CACHE_TTL_INDICES = 60;
const FETCH_TIMEOUT_MS = 10_000;
const BREEZE_TIMEOUT_MS = 20_000;

function isIndianMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const timeInMinutes = hours * 60 + minutes;
  return timeInMinutes >= 555 && timeInMinutes <= 930;
}

function getQuoteCacheTTL(): number {
  return isIndianMarketOpen() ? CACHE_TTL_QUOTE_MARKET_OPEN : CACHE_TTL_QUOTE_MARKET_CLOSED;
}
const BREEZE_BRIDGE_URL = env.BREEZE_BRIDGE_URL;

// Moved to lib/breeze-symbols.ts so the ORDER path can use it too — it used to
// live here unexported, so BreezeAdapter sent raw NSE symbols as stock_code.
import { BREEZE_STOCK_CODES } from '../lib/breeze-symbols.js';

/**
 * Parse an F&O option symbol: NIFTY2026031024800CE → underlying NIFTY,
 * expiry 2026-03-10, strike 24800, type CE.
 *
 * Delegates to lib/instrument.ts so the system has exactly one symbol grammar.
 * Returns null rather than throwing for anything that is not a well-formed
 * option, because callers here use null to mean "not an option" — including for
 * malformed dates, which the shared parser rejects outright.
 */
function parseOptionSymbol(symbol: string): { underlying: string; expiry: string; strike: number; type: 'CE' | 'PE' } | null {
  try {
    const spec = parseInstrumentSymbol(symbol);
    if (spec.instrumentType !== 'OPTIONS' || !spec.expiry || spec.strike === null || !spec.optionType) {
      return null;
    }
    return {
      underlying: spec.underlying,
      expiry: istDateStr(spec.expiry),
      strike: spec.strike,
      type: spec.optionType,
    };
  } catch {
    return null;
  }
}

// Cache a live BreezeConnect instance to avoid re-exchanging session on every call
let breezeInstance: any = null;
let breezeInstanceExpiry = 0;
let breezeInitPromise: Promise<any> | null = null;

const POPULAR_NSE_STOCKS: [string, string][] = [
  // NIFTY 50
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
  ['DRREDDY', 'Dr. Reddys Laboratories Ltd'],
  ['DIVISLAB', 'Divis Laboratories Ltd'],
  ['CIPLA', 'Cipla Ltd'],
  ['TECHM', 'Tech Mahindra Ltd'],
  ['EICHERMOT', 'Eicher Motors Ltd'],
  ['APOLLOHOSP', 'Apollo Hospitals Enterprise Ltd'],
  ['BPCL', 'Bharat Petroleum Corporation Ltd'],
  ['GRASIM', 'Grasim Industries Ltd'],
  ['HEROMOTOCO', 'Hero MotoCorp Ltd'],
  ['INDUSINDBK', 'IndusInd Bank Ltd'],
  ['COALINDIA', 'Coal India Ltd'],
  ['BRITANNIA', 'Britannia Industries Ltd'],
  ['SHRIRAMFIN', 'Shriram Finance Ltd'],
  ['TATACONSUM', 'Tata Consumer Products Ltd'],
  ['HINDALCO', 'Hindalco Industries Ltd'],
  ['ADANIPORTS', 'Adani Ports and Special Economic Zone Ltd'],
  ['SBILIFE', 'SBI Life Insurance Company Ltd'],
  ['HDFCLIFE', 'HDFC Life Insurance Company Ltd'],
  ['BAJAJ-AUTO', 'Bajaj Auto Ltd'],
  // NIFTY Next 50 / Mid-cap
  ['BANKBARODA', 'Bank of Baroda'],
  ['PNB', 'Punjab National Bank'],
  ['CANBK', 'Canara Bank'],
  ['IDFCFIRSTB', 'IDFC First Bank Ltd'],
  ['FEDERALBNK', 'Federal Bank Ltd'],
  ['BANDHANBNK', 'Bandhan Bank Ltd'],
  ['AUBANK', 'AU Small Finance Bank'],
  ['TRENT', 'Trent Ltd'],
  ['ZOMATO', 'Zomato Ltd'],
  ['JIOFIN', 'Jio Financial Services Ltd'],
  ['DMART', 'Avenue Supermarts Ltd (DMart)'],
  ['PIDILITIND', 'Pidilite Industries Ltd'],
  ['GODREJCP', 'Godrej Consumer Products Ltd'],
  ['DABUR', 'Dabur India Ltd'],
  ['MARICO', 'Marico Ltd'],
  ['COLPAL', 'Colgate-Palmolive India Ltd'],
  ['HAVELLS', 'Havells India Ltd'],
  ['VOLTAS', 'Voltas Ltd'],
  ['SIEMENS', 'Siemens Ltd'],
  ['ABB', 'ABB India Ltd'],
  ['BHEL', 'Bharat Heavy Electricals Ltd'],
  ['HAL', 'Hindustan Aeronautics Ltd'],
  ['BEL', 'Bharat Electronics Ltd'],
  ['IRCTC', 'Indian Railway Catering and Tourism Corporation'],
  ['INDIANB', 'Indian Bank'],
  ['IOC', 'Indian Oil Corporation Ltd'],
  ['GAIL', 'GAIL India Ltd'],
  ['SAIL', 'Steel Authority of India Ltd'],
  ['VEDL', 'Vedanta Ltd'],
  ['JINDALSTEL', 'Jindal Steel & Power Ltd'],
  ['NMDC', 'NMDC Ltd'],
  ['TATAPOWER', 'Tata Power Company Ltd'],
  ['ADANIGREEN', 'Adani Green Energy Ltd'],
  ['ADANIENSOL', 'Adani Energy Solutions Ltd'],
  ['DLF', 'DLF Ltd'],
  ['GODREJPROP', 'Godrej Properties Ltd'],
  ['OBEROIRLTY', 'Oberoi Realty Ltd'],
  ['PRESTIGE', 'Prestige Estates Projects Ltd'],
  ['LODHA', 'Macrotech Developers Ltd (Lodha)'],
  ['PIIND', 'PI Industries Ltd'],
  ['UPL', 'UPL Ltd'],
  ['SRF', 'SRF Ltd'],
  ['BERGEPAINT', 'Berger Paints India Ltd'],
  ['ICICIGI', 'ICICI Lombard General Insurance'],
  ['ICICIPRULI', 'ICICI Prudential Life Insurance'],
  ['MAXHEALTH', 'Max Healthcare Institute Ltd'],
  ['LICI', 'Life Insurance Corporation of India'],
  ['MUTHOOTFIN', 'Muthoot Finance Ltd'],
  ['CHOLAFIN', 'Cholamandalam Investment and Finance'],
  ['MANAPPURAM', 'Manappuram Finance Ltd'],
  ['LTIM', 'LTIMindtree Ltd'],
  ['PERSISTENT', 'Persistent Systems Ltd'],
  ['COFORGE', 'Coforge Ltd'],
  ['MPHASIS', 'Mphasis Ltd'],
  ['LTTS', 'L&T Technology Services Ltd'],
  ['TATAELXSI', 'Tata Elxsi Ltd'],
  ['POLYCAB', 'Polycab India Ltd'],
  ['PAGEIND', 'Page Industries Ltd'],
  ['TORNTPHARM', 'Torrent Pharmaceuticals Ltd'],
  ['LUPIN', 'Lupin Ltd'],
  ['AUROPHARMA', 'Aurobindo Pharma Ltd'],
  ['BIOCON', 'Biocon Ltd'],
  ['ALKEM', 'Alkem Laboratories Ltd'],
  ['LAURUSLABS', 'Laurus Labs Ltd'],
  ['IPCALAB', 'IPCA Laboratories Ltd'],
  // Small-cap popular
  ['DEEPAKNTR', 'Deepak Nitrite Ltd'],
  ['ATUL', 'Atul Ltd'],
  ['TATACOMM', 'Tata Communications Ltd'],
  ['CUMMINSIND', 'Cummins India Ltd'],
  ['CROMPTON', 'Crompton Greaves Consumer Electricals'],
  ['BATAINDIA', 'Bata India Ltd'],
  ['JUBLFOOD', 'Jubilant Foodworks Ltd'],
  ['MFSL', 'Max Financial Services Ltd'],
  ['INDHOTEL', 'Indian Hotels Company Ltd'],
  ['MOTHERSON', 'Samvardhana Motherson International'],
  ['EXIDEIND', 'Exide Industries Ltd'],
  ['ESCORTS', 'Escorts Kubota Ltd'],
  ['MRF', 'MRF Ltd'],
  ['BALKRISIND', 'Balkrishna Industries Ltd'],
  ['SYNGENE', 'Syngene International Ltd'],
  ['AFFLE', 'Affle India Ltd'],
  ['ROUTE', 'Route Mobile Ltd'],
  ['KPITTECH', 'KPIT Technologies Ltd'],
  ['SONACOMS', 'Sona BLW Precision Forgings Ltd'],
  ['PVRINOX', 'PVR INOX Ltd'],
  ['ZYDUSLIFE', 'Zydus Lifesciences Ltd'],
  ['ABCAPITAL', 'Aditya Birla Capital Ltd'],
  ['CANFINHOME', 'Can Fin Homes Ltd'],
  ['RBLBANK', 'RBL Bank Ltd'],
  ['ASTRAL', 'Astral Ltd'],
  ['SUPREMEIND', 'Supreme Industries Ltd'],
  ['CLEAN', 'Clean Science and Technology Ltd'],
  ['NAUKRI', 'Info Edge India Ltd (Naukri)'],
  ['PAYTM', 'One97 Communications Ltd (Paytm)'],
  ['POLICYBZR', 'PB Fintech Ltd (PolicyBazaar)'],
  ['DELHIVERY', 'Delhivery Ltd'],
  ['KAYNES', 'Kaynes Technology India Ltd'],
  ['CDSL', 'Central Depository Services India Ltd'],
  ['BSE', 'BSE Ltd'],
  ['MCX', 'Multi Commodity Exchange of India Ltd'],
  ['IDEA', 'Vodafone Idea Ltd'],
  ['YESBANK', 'Yes Bank Ltd'],
  ['TATACHEM', 'Tata Chemicals Ltd'],
  ['PETRONET', 'Petronet LNG Ltd'],
  ['IGL', 'Indraprastha Gas Ltd'],
  ['MGL', 'Mahanagar Gas Ltd'],
  ['CONCOR', 'Container Corporation of India Ltd'],
  ['IRFC', 'Indian Railway Finance Corporation Ltd'],
  ['PFC', 'Power Finance Corporation Ltd'],
  ['RECLTD', 'REC Ltd'],
  ['NHPC', 'NHPC Ltd'],
  ['SJVN', 'SJVN Ltd'],
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

// Shared with the Upstox source; re-exported so existing imports keep working.
export { formatBarTime, barInstant, isDailyInterval } from '../lib/bar-time.js';
import { formatBarTime, barInstant, isDailyInterval } from '../lib/bar-time.js';

/**
 * Candles in one trading session: NSE/NFO 09:15-15:30, MCX 09:00-23:30.
 * The Rust backtest needs this to annualise intraday returns correctly.
 */
export function barsPerSession(interval: string, exchange = 'NSE'): number {
  const i = interval.toLowerCase();
  const mcx = exchange.toUpperCase() === 'MCX';
  if (isDailyInterval(i)) return 1;
  if (i.startsWith('30')) return mcx ? 29 : 13;
  if (i.startsWith('15')) return mcx ? 58 : 25;
  if (i.startsWith('5')) return mcx ? 174 : 75;
  if (i.startsWith('1h') || i.startsWith('60')) return mcx ? 15 : 7;
  if (i.startsWith('1m') || i === 'minute') return mcx ? 870 : 375;
  return 1;
}

/**
 * True when bars reach both ends of [fromDate, lastDay], allowing for weekends
 * and holidays at the edges. A series that starts late or stops early is partial.
 */
export function coversRange(bars: HistoricalBar[], fromDate: string, lastDay: string, slackDays = 5): boolean {
  if (bars.length === 0) return false;
  const day = (s: string) => new Date(s.slice(0, 10) + 'T00:00:00Z').getTime();
  const slack = slackDays * 86400000;
  return day(bars[0].timestamp) <= day(fromDate) + slack
    && day(bars[bars.length - 1].timestamp) >= day(lastDay) - slack;
}

export class MarketDataService {
  private cache: CacheService | null;
  private cookies: string = '';
  private cookieExpiry: number = 0;
  private cookieFetchPromise: Promise<void> | null = null;
  private activeNseRequests = 0;

  constructor(cache?: CacheService) {
    // Prices fetched with one account's broker login are not handed to another.
    if (cache) {
      this.cache = accountScoped(cache);
    } else {
      const redis = getRedis();
      this.cache = redis ? accountScoped(new CacheService(redis)) : null;
    }
  }

  // ── Breeze Bridge: live quote from broker (real-time LTP) ──

  private async fetchLiveFromBreezeBridge(symbol: string, exchange = 'NSE'): Promise<MarketQuote | null> {
    try {
      const bridgeActive = await this.ensureBreezeBridgeSession();
      if (!bridgeActive) return null;

      const url = `${BREEZE_BRIDGE_URL}/quote/${encodeURIComponent(symbol)}?exchange=${encodeURIComponent(exchange)}`;
      const res = await bridgeFetch(url, { signal: AbortSignal.timeout(5000) });
      if (!res.ok) return null;

      const data = await res.json() as any;
      const ltp = Number(data.ltp ?? data.last_price ?? data.close ?? 0);
      if (ltp <= 0) return null;

      return {
        symbol,
        exchange,
        ltp,
        change: Number(data.change ?? 0),
        changePercent: Number(data.change_percent ?? data.changePercent ?? 0),
        open: Number(data.open ?? 0),
        high: Number(data.high ?? 0),
        low: Number(data.low ?? 0),
        close: Number(data.close ?? ltp),
        volume: Number(data.volume ?? 0),
        bidPrice: Number(data.bid ?? data.best_bid ?? 0),
        askPrice: Number(data.ask ?? data.best_ask ?? 0),
        bidQty: Number(data.bid_qty ?? 0),
        askQty: Number(data.ask_qty ?? 0),
        timestamp: data.timestamp ?? new Date().toISOString(),
      };
    } catch {
      return null;
    }
  }

  // ── Yahoo Finance: fallback data source ──

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
      if (!yahooInterval) return [];

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
          // Intraday bars used to be cut to their date, so a day's 75 five-minute
          // bars all carried the same timestamp.
          timestamp: formatBarTime(timestamps[i] * 1000, isDailyInterval(interval)),
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

  // null for an interval Yahoo has no name for. It used to fall back to daily,
  // so a request for 1-minute candles silently came back as daily ones.
  private mapIntervalToYahoo(interval: string): string | null {
    const map: Record<string, string> = {
      '1m': '1m', '1min': '1m', 'minute': '1m', '1minute': '1m',
      '5m': '5m', '5min': '5m', '5minute': '5m',
      '15m': '15m', '15min': '15m', '15minute': '15m',
      '30m': '30m', '30min': '30m', '30minute': '30m',
      '1h': '1h', '60m': '1h', '60min': '1h', '1hour': '1h',
      '1d': '1d', '1day': '1d', 'day': '1d', 'daily': '1d',
      '1wk': '1wk', 'week': '1wk', 'weekly': '1wk',
      '1mo': '1mo', 'month': '1mo', 'monthly': '1mo',
    };
    return map[interval.toLowerCase()] ?? null;
  }

  // ── Public API ──

  async getQuote(symbol: string, exchange = 'NSE'): Promise<MarketQuote> {
    // Quotes are cached per source: after switching to Upstox, a price fetched
    // earlier from Breeze or Yahoo must not be served for the rest of its TTL.
    const viaUpstox = exchange !== 'MCX' && exchange !== 'CDS' && !!(await this.upstoxToken());
    const cacheKey = `quote:${viaUpstox ? 'upstox:' : ''}${exchange}:${symbol}`;

    if (this.cache) {
      const cached = await this.cache.get<MarketQuote>(cacheKey);
      if (cached && cached.ltp > 0) return cached;
    }

    // The user's chosen broker comes first when it is Upstox (Breeze is below).
    if (viaUpstox) {
      const upstoxQuote = await this.fetchQuoteFromUpstox(symbol, exchange);
      if (upstoxQuote) {
        if (this.cache) await this.cache.set(cacheKey, upstoxQuote, getQuoteCacheTTL());
        return upstoxQuote;
      }
    }

    // F&O option symbol detection (e.g. NIFTY20260310248000CE)
    const optionInfo = parseOptionSymbol(symbol);
    if (optionInfo || exchange === 'NFO') {
      const fnoQuote = await this.fetchFnOQuote(symbol, optionInfo);
      if (fnoQuote && fnoQuote.ltp > 0) {
        if (this.cache) await this.cache.set(cacheKey, fnoQuote, getQuoteCacheTTL());
        return fnoQuote;
      }
      return fnoQuote ?? this.emptyQuote(symbol, exchange);
    }

    if (exchange === 'MCX') {
      const quote = await this.getMCXQuote(symbol);
      if (this.cache) await this.cache.set(cacheKey, quote, getQuoteCacheTTL());
      return quote;
    }

    if (exchange === 'CDS') {
      const quote = await this.getCDSQuote(symbol);
      if (this.cache) await this.cache.set(cacheKey, quote, getQuoteCacheTTL());
      return quote;
    }

    // PRIMARY: Breeze Bridge live quote (real-time LTP from broker)
    const breezeQuote = await this.fetchLiveFromBreezeBridge(symbol, exchange);
    if (breezeQuote && breezeQuote.ltp > 0) {
      if (this.cache) await this.cache.set(cacheKey, breezeQuote, getQuoteCacheTTL());
      return breezeQuote;
    }

    // Fallback 1: NSE direct scraping (real-time during market hours)
    const nseQuote = await this.fetchFromNSE(symbol);
    if (nseQuote && nseQuote.ltp > 0) {
      if (this.cache) await this.cache.set(cacheKey, nseQuote, getQuoteCacheTTL());
      return nseQuote;
    }

    // Fallback 2: Yahoo Finance (may return daily close, not live LTP)
    const yahooQuote = await this.fetchFromYahoo(symbol, exchange);
    if (yahooQuote && yahooQuote.ltp > 0) {
      if (this.cache) await this.cache.set(cacheKey, yahooQuote, getQuoteCacheTTL());
      return yahooQuote;
    }

    // Fallback 3: Breeze historical (last bar close)
    try {
      const today = istDateStr();
      const weekAgo = istDaysAgo(7);
      const bars = await this.fetchFromBreeze(symbol, '1day', weekAgo, today);
      if (bars.length > 0) {
        const latest = bars[bars.length - 1];
        const historicalQuote: MarketQuote = {
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
        if (this.cache) await this.cache.set(cacheKey, historicalQuote, getQuoteCacheTTL());
        return historicalQuote;
      }
    } catch { /* Breeze historical fallback failed */ }

    return nseQuote ?? this.emptyQuote(symbol, exchange);
  }

  async getMarketDepth(symbol: string, exchange = 'NSE'): Promise<{
    symbol: string;
    bids: Array<{ price: number; qty: number; orders: number }>;
    asks: Array<{ price: number; qty: number; orders: number }>;
    totalBidQty: number;
    totalAskQty: number;
    imbalanceRatio: number;
  }> {
    const cacheKey = `depth:${exchange}:${symbol}`;
    if (this.cache) {
      const cached = await this.cache.get(cacheKey);
      if (cached) return cached as any;
    }

    let bids: Array<{ price: number; qty: number; orders: number }> = [];
    let asks: Array<{ price: number; qty: number; orders: number }> = [];

    // Try NSE trade info API for market depth
    try {
      const nseUrl = `https://www.nseindia.com/api/quote-equity?symbol=${encodeURIComponent(symbol)}&section=trade_info`;
      const cookies = await this.ensureNseCookies();
      const res = await fetch(nseUrl, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
          'Accept': 'application/json',
          'Cookie': cookies,
        },
        signal: AbortSignal.timeout(8000),
      });

      if (res.ok) {
        const data = await res.json() as any;
        const marketDeptOrderBook = data?.marketDeptOrderBook;

        if (marketDeptOrderBook) {
          const bidData = marketDeptOrderBook.bid ?? [];
          const askData = marketDeptOrderBook.ask ?? [];

          bids = bidData.map((b: any) => ({
            price: Number(b.price ?? 0),
            qty: Number(b.quantity ?? 0),
            orders: Number(b.noOrders ?? b.orders ?? 0),
          })).filter((b: any) => b.price > 0);

          asks = askData.map((a: any) => ({
            price: Number(a.price ?? 0),
            qty: Number(a.quantity ?? 0),
            orders: Number(a.noOrders ?? a.orders ?? 0),
          })).filter((a: any) => a.price > 0);
        }
      }
    } catch { /* fallback below */ }

    // Fallback: Try Breeze bridge
    if (bids.length === 0 && asks.length === 0) {
      try {
        const bridgeUrl = BREEZE_BRIDGE_URL;
        const res = await bridgeFetch(`${bridgeUrl}/quote/${encodeURIComponent(symbol)}?exchange=${exchange}`, {
          signal: AbortSignal.timeout(5000),
        });
        if (res.ok) {
          const data = await res.json() as any;
          if (data.ltp > 0) {
            const ltp = data.ltp;
            const tickSize = ltp > 1000 ? 0.05 : 0.05;
            for (let i = 0; i < 5; i++) {
              bids.push({ price: Number((ltp - tickSize * (i + 1)).toFixed(2)), qty: 0, orders: 0 });
              asks.push({ price: Number((ltp + tickSize * (i + 1)).toFixed(2)), qty: 0, orders: 0 });
            }
          }
        }
      } catch {}
    }

    const totalBidQty = bids.reduce((s, b) => s + b.qty, 0);
    const totalAskQty = asks.reduce((s, a) => s + a.qty, 0);
    const imbalanceRatio = totalAskQty > 0 ? Number((totalBidQty / totalAskQty).toFixed(3)) : 0;

    const result = { symbol, bids, asks, totalBidQty, totalAskQty, imbalanceRatio };

    if (this.cache) await this.cache.set(cacheKey, result, 5);
    return result;
  }

  private async ensureNseCookies(): Promise<string> {
    const cacheKey = 'nse_cookies';
    if (this.cache) {
      const cached = await this.cache.get<string>(cacheKey);
      if (cached) return cached;
    }
    try {
      const res = await fetch('https://www.nseindia.com', {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: AbortSignal.timeout(5000),
      });
      const cookies = res.headers.get('set-cookie') ?? '';
      if (this.cache && cookies) await this.cache.set(cacheKey, cookies, 300);
      return cookies;
    } catch { return ''; }
  }

  async getHistory(
    symbol: string,
    interval: string,
    fromDate: string,
    toDate: string,
    userId?: string,
    exchange: string = 'NSE',
  ): Promise<HistoricalBar[]> {
    // A futures or option contract is named by its canonical symbol
    // (NIFTY20261029FUT, NIFTY2026102924000CE). Its bars live under that symbol
    // and its own exchange, so they never mix with the underlying's cash bars.
    let contract: InstrumentSpec | null = null;
    if (isDerivativeSymbol(symbol)) {
      try {
        contract = parseInstrumentSymbol(symbol, exchange === 'NSE' ? undefined : exchange);
      } catch (err) {
        log.warn({ symbol, err: (err as Error).message }, 'Unreadable contract symbol, no history');
        return [];
      }
      exchange = contract.exchange;
    }

    const daily = isDailyInterval(interval);
    const ttl = daily ? CACHE_TTL_HISTORY : CACHE_TTL_HISTORY_INTRADAY;
    const cacheKey = `history:${exchange}:${symbol}:${interval}:${fromDate}:${toDate}`;

    if (this.cache) {
      const cached = await this.cache.get<HistoricalBar[]>(cacheKey);
      if (cached) return cached;
    }

    // The last day that can have data: not after today, and not after expiry.
    const today = istDateStr();
    const lastDay = [toDate.slice(0, 10), today, contract?.expiry ? istDateStr(contract.expiry) : '9999-12-31']
      .sort()[0];

    // The candle lake (lib/candle-lake.ts) keeps years of NSE stock candles as
    // files, filled nightly. Past ranges it covers are served from disk, with
    // no database or broker call.
    const fromLake = !contract && exchange === 'NSE' && lastDay < today ? lakeInterval(interval) : null;
    if (fromLake) {
      try {
        const bars = readLakeBars(symbol, fromLake, fromDate.slice(0, 10), lastDay);
        if (coversRange(bars, fromDate, lastDay)) {
          if (this.cache) await this.cache.set(cacheKey, bars, ttl);
          return bars;
        }
      } catch { /* lake missing or unreadable: fall through */ }
    }

    // The candle store is only trusted when it covers the whole range. It used
    // to be served whenever it held 5 or more bars, so a 3-year backtest could
    // silently run on the 10 days some earlier request happened to save — and
    // intraday bars saved an hour ago were served as today's latest.
    if (daily || lastDay < today) {
      try {
        const prisma = getPrisma();
        const stored = await prisma.candleStore.findMany({
          where: {
            symbol, exchange, interval,
            timestamp: { gte: new Date(barInstant(fromDate)), lte: new Date(barInstant(`${lastDay} 23:59:59`)) },
          },
          orderBy: { timestamp: 'asc' },
        });
        // Keyed by the formatted time, so a day saved twice (older versions saved
        // daily bars at UTC midnight, this one at IST midnight) appears once.
        const byTime = new Map<string, HistoricalBar>();
        for (const c of stored as any[]) {
          const timestamp = formatBarTime(c.timestamp.getTime(), daily);
          byTime.set(timestamp, {
            timestamp, open: Number(c.open), high: Number(c.high),
            low: Number(c.low), close: Number(c.close), volume: Number(c.volume),
          });
        }
        const bars = [...byTime.values()];
        // Older versions saved Breeze's Indian-time intraday bars as if they were
        // the host's time; on a UTC server they sit 5.5h late, outside NSE hours.
        // Such a range is refetched rather than served shifted.
        const misplaced = !daily && exchange !== 'MCX' && bars.some((b) => {
          const hhmm = b.timestamp.slice(11, 16);
          return hhmm < '09:00' || hhmm > '15:35';
        });
        if (!misplaced && coversRange(bars, fromDate, lastDay)) {
          if (this.cache) await this.cache.set(cacheKey, bars, ttl);
          return bars;
        }
      } catch { /* DB not available, continue to live fetch */ }
    }

    // MCX and CDS used to be intercepted here and served a Math.random() random
    // walk from `generateSimulatedHistory` — so Breeze was never even asked, and
    // any commodity backtest was fitted to noise. They now take the same path as
    // everything else. An empty result is the honest answer when there is no
    // data; fabricated bars are not.
    let bars = await this.fetchHistoryFromUpstox(symbol, interval, fromDate, toDate, userId, exchange);
    if (bars.length === 0) bars = await this.fetchFromBreeze(symbol, interval, fromDate, toDate, userId, exchange, contract);
    if (bars.length > 0) {
      const clean = this.validateCandles(bars, symbol, interval, !!contract);
      if (this.cache) await this.cache.set(cacheKey, clean, ttl);
      this.backfillCandleStore(symbol, exchange, interval, clean).catch(err => log.warn({ err, symbol }, 'Failed to backfill candle store'));
      return clean;
    }

    // Yahoo has no Indian futures or options. Asked for a contract it would
    // answer with something else, so a contract with no Breeze data has none.
    if (contract) return [];

    const yahooBars = await this.fetchHistoryFromYahoo(symbol, interval, fromDate, toDate, exchange);
    if (yahooBars.length > 0) {
      const clean = this.validateCandles(yahooBars, symbol, interval, false);
      if (this.cache) await this.cache.set(cacheKey, clean, ttl);
      this.backfillCandleStore(symbol, exchange, interval, clean).catch(err => log.warn({ err, symbol }, 'Failed to backfill candle store'));
      return clean;
    }
    return [];
  }

  private validateCandles(bars: HistoricalBar[], symbol: string, interval: string, isContract: boolean): HistoricalBar[] {
    if (bars.length < 2) return bars;

    const issues: string[] = [];

    // Two earlier steps are gone, because both changed the data a backtest runs on:
    //  - Dropping closes more than 3σ from the series MEAN deleted real bars from
    //    any stock that trended (a doubling puts the late bars past 3σ) and most
    //    of an option's life. Price levels are not stationary; that test assumes
    //    they are.
    //  - "Interpolating" 1-2 missing bars invented a Saturday and a Sunday bar in
    //    every week of daily data (Fri->Mon looks like two missing days), and two
    //    fake bars between every real 15-minute bar. Weekends, holidays and nights
    //    are not missing data.
    // What remains removes only an isolated bad print: one bar far from BOTH
    // neighbours while the neighbours agree. Options can genuinely jump like
    // that, so contracts are left untouched.
    let cleaned = bars;
    if (!isContract && bars.length >= 3) {
      cleaned = bars.filter((b, i) => {
        if (i === 0 || i === bars.length - 1) return true;
        const prev = bars[i - 1].close, next = bars[i + 1].close;
        if (!(prev > 0 && next > 0)) return true;
        const neighboursAgree = Math.abs(next - prev) / prev < 0.05;
        const spike = Math.abs(b.close - prev) / prev > 0.2 && Math.abs(b.close - next) / next > 0.2;
        return !(neighboursAgree && spike);
      });
      if (cleaned.length < bars.length) {
        issues.push(`removed ${bars.length - cleaned.length} isolated bad print(s)`);
      }
    }

    // Flag overnight gaps >10% for corporate-action review (flag only, never edit)
    for (let i = 1; i < cleaned.length; i++) {
      const prevClose = cleaned[i - 1].close;
      if (prevClose > 0) {
        const gapPct = Math.abs(cleaned[i].open - prevClose) / prevClose * 100;
        if (gapPct > 10) {
          issues.push(`large overnight gap ${gapPct.toFixed(1)}% at ${cleaned[i].timestamp} — possible corporate action`);
        }
      }
    }

    if (issues.length > 0) {
      log.warn({ symbol, interval, issueCount: issues.length, sample: issues.slice(0, 5) }, 'Data quality: processed');
      emit('market-data', {
        type: 'DATA_QUALITY_REPORT', symbol, interval,
        issues: issues.slice(0, 10),
        barCount: cleaned.length,
        lastTimestamp: cleaned[cleaned.length - 1]?.timestamp ?? new Date().toISOString(),
      }).catch(err => log.warn({ err, symbol }, 'Failed to emit DATA_QUALITY_REPORT'));
    }

    return cleaned;
  }

  /**
   * Check if data is fresh enough for live trading (not stale during market hours).
   */
  isDataFresh(timestamp: string | Date, maxAgeMs = 5 * 60 * 1000): boolean {
    const now = Date.now();
    const dataTime = new Date(timestamp).getTime();
    const age = now - dataTime;

    // Only enforce during Indian market hours (9:15-15:30 IST = 3:45-10:00 UTC)
    const utcHour = new Date().getUTCHours();
    const utcMin = new Date().getUTCMinutes();
    const utcMins = utcHour * 60 + utcMin;
    const marketOpen = 3 * 60 + 45;
    const marketClose = 10 * 60;
    const isMarketHours = utcMins >= marketOpen && utcMins <= marketClose;

    if (isMarketHours && age > maxAgeMs) {
      log.warn({ age: Math.round(age / 1000), maxAgeSec: maxAgeMs / 1000 }, 'Stale data detected during market hours');
      return false;
    }
    return true;
  }

  /**
   * Keep completed daily candles in Postgres for quick reuse. Intraday candles
   * are NOT stored here any more: writing each one as its own upsert, on every
   * fetch the bots make, hammered the database. Intraday history lives in the
   * candle lake (files) instead. One batched insert per call; existing rows are
   * left alone.
   */
  private async backfillCandleStore(symbol: string, exchange: string, interval: string, bars: HistoricalBar[]): Promise<void> {
    if (!isDailyInterval(interval)) return;
    const today = istDateStr();
    const records = bars
      .filter(b => b.timestamp && b.close > 0 && b.timestamp.slice(0, 10) < today)
      .map(b => ({
        symbol, exchange, interval,
        timestamp: new Date(barInstant(b.timestamp)),
        open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume ?? 0,
      }));
    if (records.length === 0) return;
    try {
      await getPrisma().candleStore.createMany({ data: records, skipDuplicates: true });
    } catch (err) {
      log.debug({ err: (err as Error).message, symbol }, 'Candle store write skipped');
    }
  }

  /**
   * Candles straight from a broker (Upstox, then ICICI Breeze; Yahoo only for
   * daily), bypassing every cache and the candle store. Used by the candle lake
   * sync. `brokerConnected` says whether a broker could have answered, so an
   * empty result can be told apart from "nobody logged in".
   */
  async rawHistory(symbol: string, interval: string, fromDate: string, toDate: string, exchange = 'NSE'): Promise<{
    bars: HistoricalBar[]; source: 'upstox' | 'breeze' | 'yahoo' | null; brokerConnected: boolean;
  }> {
    const upstox = !!(await this.upstoxToken());
    if (upstox) {
      const bars = await this.fetchHistoryFromUpstox(symbol, interval, fromDate, toDate, undefined, exchange).catch(() => []);
      if (bars.length) return { bars, source: 'upstox', brokerConnected: true };
    }
    const breeze = await this.ensureBreezeBridgeSession().catch(() => false);
    if (breeze) {
      const bars = await this.fetchFromBreeze(symbol, interval, fromDate, toDate, undefined, exchange).catch(() => []);
      if (bars.length) return { bars, source: 'breeze', brokerConnected: true };
    }
    if (isDailyInterval(interval)) {
      const bars = await this.fetchHistoryFromYahoo(symbol, interval, fromDate, toDate, exchange).catch(() => []);
      if (bars.length) return { bars, source: 'yahoo', brokerConnected: upstox || breeze };
    }
    return { bars: [], source: null, brokerConnected: upstox || breeze };
  }

  async getTopMovers(count = 20): Promise<{ gainers: MarketMover[]; losers: MarketMover[] }> {
    const cacheKey = `market:top-movers:${count}`;
    if (this.cache) {
      const cached = await this.cache.get<{ gainers: MarketMover[]; losers: MarketMover[] }>(cacheKey);
      if (cached) return cached;
    }

    // Primary: the exchange's own gainer / loser / volume-gainer lists (or the
    // same computed from Upstox quotes when NSE refuses this server).
    try {
      const lists = await getMarketMovers(this).scannerMovers(count);
      if (lists.gainers.length > 0 || lists.losers.length > 0) {
        if (this.cache) await this.cache.set(cacheKey, lists, 60);
        return lists;
      }
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Exchange movers unavailable; falling back to Yahoo');
    }

    // Next: Yahoo Finance batch quote for NIFTY 50 constituents
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
        await res.text().catch(() => { /* drain response */ });
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

    const indices: { name: string; value: number; change: number; changePercent: number }[] = [];

    // ── Primary: Breeze Bridge (live broker data) ──
    const bridgeActive = await this.ensureBreezeBridgeSession();
    if (bridgeActive) {
      try {
        const res = await bridgeFetch(`${BREEZE_BRIDGE_URL}/indices`, {
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        });
        if (res.ok) {
          const data = await res.json() as any;
          const breezeIndices = data?.indices ?? [];
          for (const idx of breezeIndices) {
            if (idx.name && idx.value > 0) {
              indices.push({
                name: idx.name,
                value: Number(Number(idx.value).toFixed(2)),
                change: Number(Number(idx.change ?? 0).toFixed(2)),
                changePercent: Number(Number(idx.changePercent ?? 0).toFixed(2)),
              });
            }
          }
          if (indices.length > 0) {
            log.info(`Indices from Breeze: ${indices.map(i => i.name).join(', ')}`);
          }
        }
      } catch { /* Breeze bridge unavailable */ }
    }

    // ── Fallback: Yahoo Finance for any missing indices ──
    const expectedIndices: [string, string][] = [
      ['^NSEI', 'NIFTY 50'],
      ['^NSEBANK', 'NIFTY BANK'],
      ['^BSESN', 'SENSEX'],
      ['^INDIAVIX', 'INDIA VIX'],
    ];

    const fetchedNames = new Set(indices.map(i => i.name));
    const missingFromYahoo = expectedIndices.filter(([, name]) => !fetchedNames.has(name));

    if (missingFromYahoo.length > 0) {
      const yahooPromises = missingFromYahoo.map(async ([sym, name]) => {
        try {
          const encoded = encodeURIComponent(sym);
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encoded}?interval=1d&range=1d`;
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

      await Promise.all(yahooPromises);
    }

    // ── Fallback: BSE API specifically for SENSEX ──
    if (!indices.some(i => i.name === 'SENSEX')) {
      try {
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT_MS);
        const res = await fetch('https://api.bseindia.com/BseIndiaAPI/api/GetSensexData/w?code=16', {
          headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', Accept: 'application/json' },
          signal: ac.signal,
        });
        clearTimeout(timer);
        if (res.ok) {
          const bseData = await res.json() as any;
          const currentVal = parseFloat(bseData?.CurrValue ?? bseData?.ltp ?? '0');
          const prevClose = parseFloat(bseData?.PrevClose ?? bseData?.prevclose ?? '0');
          if (currentVal > 0) {
            const change = prevClose > 0 ? currentVal - prevClose : 0;
            const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
            indices.push({
              name: 'SENSEX',
              value: Number(currentVal.toFixed(2)),
              change: Number(change.toFixed(2)),
              changePercent: Number(changePct.toFixed(2)),
            });
          }
        }
      } catch { /* BSE fallback failed */ }
    }

    if (indices.length > 0 && this.cache) {
      await this.cache.set(cacheKey, indices, CACHE_TTL_INDICES);
    }

    if (indices.length > 0) return indices;

    // ── Last resort: NSE allIndices ──
    try {
      const res = await this.nseFetch('https://www.nseindia.com/api/allIndices');
      if (!res.ok) { await res.text().catch(() => { /* drain */ }); return []; }
      const data = await res.json() as any;
      return (data.data ?? []).slice(0, 10).map((idx: any) => ({
        name: idx.index === 'S&P BSE SENSEX' ? 'SENSEX' : idx.index,
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
      if (!res.ok) { await res.text().catch(() => { /* drain */ }); return { value: 0, change: 0, changePercent: 0 }; }
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

  /** FII/DII net flows (₹ crore) from NSE; the last saved day when NSE does not answer; zeros only when nothing is known. */
  async getFIIDII() {
    const cacheKey = 'market:fii-dii';
    if (this.cache) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }
    const day = await latestFiiDii((url) => this.nseJson(url));
    if (!day) {
      return { date: istDateStr(), fiiBuy: 0, fiiSell: 0, fiiNet: 0, diiBuy: 0, diiSell: 0, diiNet: 0, unavailable: true };
    }
    // Callers do arithmetic on these: a source without DII (NSDL) reads as 0 here, flagged.
    const result = { ...day, diiBuy: day.diiBuy ?? 0, diiSell: day.diiSell ?? 0, diiNet: day.diiNet ?? 0, diiMissing: day.diiNet == null };
    if (this.cache) await this.cache.set(cacheKey, result, day.stale ? 60 : 600);
    return result;
  }

  async getAvailableExpiries(symbol: string): Promise<{ expiries: string[]; sessionError?: boolean; message?: string }> {
    const cacheKey = `expiries:${symbol}`;
    if (this.cache) {
      const cached = await this.cache.get<string[]>(cacheKey);
      if (cached) return { expiries: cached };
    }

    // The user's chosen broker first, when it is Upstox: its instrument file
    // lists every listed contract, so no extra API call is needed.
    if (await this.upstoxToken()) {
      const upstoxExpiries = await getUpstox().expiries(symbol);
      if (upstoxExpiries.length > 0) {
        if (this.cache) await this.cache.set(cacheKey, upstoxExpiries, 3600);
        return { expiries: upstoxExpiries };
      }
    }

    // Source 1: Python Breeze Bridge (official SDK — most reliable)
    const bridgeActive = await this.ensureBreezeBridgeSession();
    if (bridgeActive) {
      try {
        const bridgeUrl = `${BREEZE_BRIDGE_URL}/expiries/${encodeURIComponent(symbol)}`;
        const ac = new AbortController();
        const timer = setTimeout(() => ac.abort(), 15_000);
        const res = await fetch(bridgeUrl, { signal: ac.signal });
        clearTimeout(timer);
        if (res.ok) {
          const data = await res.json() as any;
          if (data.expiries && data.expiries.length > 0) {
            console.log(`[Expiries] ${symbol} → Breeze Python Bridge: ${data.expiries.join(', ')}`);
            if (this.cache) await this.cache.set(cacheKey, data.expiries, 3600);
            return { expiries: data.expiries };
          }
        }
      } catch (err) {
        console.log(`[Expiries] ${symbol} → Breeze Python Bridge error: ${err}`);
      }

      // Bridge returned no expiries — try getting them from the full option chain
      try {
        const chainResult = await this.fetchFromBreezeBridge(symbol);
        if (chainResult?.expiries?.length > 0) {
          console.log(`[Expiries] ${symbol} → extracted from Bridge chain: ${chainResult.expiries.join(', ')}`);
          if (this.cache) await this.cache.set(cacheKey, chainResult.expiries, 3600);
          return { expiries: chainResult.expiries };
        }
      } catch { /* fall through */ }
    }

    // Fallback: NSE India - authoritative source with ALL expiry dates
    try {
      const fmtD = (d: Date) => {
        const y = d.getFullYear();
        const m = String(d.getMonth() + 1).padStart(2, '0');
        const dd = String(d.getDate()).padStart(2, '0');
        return `${y}-${m}-${dd}`;
      };
      const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX'].includes(symbol.toUpperCase());
      const nseUrl = isIndex
        ? `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol.toUpperCase())}`
        : `https://www.nseindia.com/api/option-chain-equities?symbol=${encodeURIComponent(symbol.toUpperCase())}`;
      const res = await this.nseFetch(nseUrl);
      if (res.ok) {
        const data = await res.json() as any;
        const records = data?.records ?? data?.filtered ?? {};
        const raw: string[] = records?.expiryDates ?? [];
        const now = istMidnight();

        const expiries = raw
          .map((d: string) => {
            const parsed = new Date(d);
            return isNaN(parsed.getTime()) ? '' : fmtD(parsed);
          })
          .filter(d => d && new Date(d) >= now)
          .sort();

        if (expiries.length > 0) {
          if (this.cache) await this.cache.set(cacheKey, expiries, 3600);
          return { expiries };
        }
      }
    } catch { /* NSE may be blocked from cloud servers */ }

    // Last resort: Upstox's public instrument file needs no login, so it can
    // list expiries even when no broker is connected.
    const listed = await getUpstox().expiries(symbol).catch(() => [] as string[]);
    if (listed.length > 0) {
      if (this.cache) await this.cache.set(cacheKey, listed, 3600);
      return { expiries: listed };
    }

    return { expiries: [], sessionError: true, message: 'No option data source is connected. Connect ICICI Breeze or Upstox in Settings → Broker.' };
  }

  async getOptionsChain(symbol: string, expiry?: string) {
    // Cached per source, like quotes, so switching broker takes effect at once.
    const upstoxToken = await this.upstoxToken();
    const cacheKey = `options:${upstoxToken ? 'upstox:' : ''}${symbol}${expiry ? `:${expiry}` : ''}`;
    if (this.cache) {
      const cached = await this.cache.get<any>(cacheKey);
      if (cached) return cached;
    }

    // The user's chosen broker first, when it is Upstox.
    if (upstoxToken) {
      const chain = await getUpstox().optionChain(upstoxToken, symbol, expiry);
      if (chain && chain.strikes.length > 0) {
        console.log(`[OptionChain] ${symbol} expiry=${chain.expiry} → Upstox (${chain.strikes.length} strikes)`);
        if (this.cache) await this.cache.set(cacheKey, chain, 10);
        return chain;
      }
    }

    // Primary: Python Breeze Bridge (official Python SDK — most reliable)
    const bridgeActive = await this.ensureBreezeBridgeSession();
    if (bridgeActive) {
      try {
        const bridgeResult = await this.fetchFromBreezeBridge(symbol, expiry);
        if (bridgeResult && bridgeResult.strikes && bridgeResult.strikes.length > 0) {
          console.log(`[OptionChain] ${symbol} expiry=${expiry ?? 'nearest'} → Breeze Python Bridge (${bridgeResult.strikes.length} strikes)`);
          if (this.cache) await this.cache.set(cacheKey, bridgeResult, 10);
          return bridgeResult;
        }
        console.log(`[OptionChain] ${symbol} expiry=${expiry ?? 'nearest'} → Bridge returned 0 strikes, trying fallbacks`);
      } catch (err) {
        console.log(`[OptionChain] ${symbol} → Breeze Python Bridge error: ${err}`);
      }
    }

    // Fallback 1: NSE India
    try {
      const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX'].includes(symbol.toUpperCase());
      const url = isIndex
        ? `https://www.nseindia.com/api/option-chain-indices?symbol=${encodeURIComponent(symbol.toUpperCase())}`
        : `https://www.nseindia.com/api/option-chain-equities?symbol=${encodeURIComponent(symbol.toUpperCase())}`;
      const res = await this.nseFetch(url);
      if (res.ok) {
        const data = await res.json() as any;
        const result = this.parseOptionsChain(symbol, data, expiry);
        if (result.strikes.length > 0) {
          console.log(`[OptionChain] ${symbol} expiry=${expiry ?? 'nearest'} → NSE India (${result.strikes.length} strikes)`);
          if (this.cache) await this.cache.set(cacheKey, result, 60);
          return result;
        }
      }
    } catch { /* NSE blocked from cloud */ }

    // Fallback 2: NiftyTrader
    try {
      const niftyTraderResult = await this.fetchOptionsChainFromNiftyTrader(symbol, expiry);
      if (niftyTraderResult && niftyTraderResult.strikes && niftyTraderResult.strikes.length > 0) {
        console.log(`[OptionChain] ${symbol} expiry=${expiry ?? 'nearest'} → NiftyTrader (${niftyTraderResult.strikes.length} strikes)`);
        if (this.cache) await this.cache.set(cacheKey, niftyTraderResult, 60);
        return niftyTraderResult;
      }
    } catch { /* NiftyTrader unavailable */ }

    // All sources exhausted
    if (bridgeActive) {
      console.log(`[OptionChain] ${symbol} → Bridge active but all sources returned 0 strikes`);
      return { symbol, strikes: [], expiry: expiry ?? '', expiries: [] };
    }
    console.log(`[OptionChain] ${symbol} → No Breeze bridge session, no fallback`);
    return { symbol, strikes: [], expiry: expiry ?? '', expiries: [], sessionError: true,
      message: 'No option data source is connected. Connect ICICI Breeze or Upstox in Settings → Broker.' };
  }

  private async fetchOptionsChainFromNiftyTrader(symbol: string, expiry?: string) {
    const sym = symbol.toUpperCase().replace(/\s+/g, '').toLowerCase();
    let url = `https://webapi.niftytrader.in/webapi/option/option-chain-data?symbol=${encodeURIComponent(sym)}`;
    if (expiry) url += `&expiry_date=${encodeURIComponent(expiry)}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 15000);
    try {
      const res = await fetch(url, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: ac.signal,
      });
      clearTimeout(timer);
      if (!res.ok) return null;

      const json = await res.json() as any;
      if (json.result !== 1 || !json.resultData?.opDatas?.length) return null;

      const rows = json.resultData.opDatas as any[];
      const spotPrice = Number(rows[0]?.index_close) || 0;
      const expiry = rows[0]?.expiry_date
        ? rows[0].expiry_date.split('T')[0]
        : '';

      const strikes = rows.map((r: any) => ({
        strike: Number(r.strike_price) || 0,
        callOI: Number(r.calls_oi) || 0,
        callOIChange: Number(r.calls_change_oi) || 0,
        callVolume: Number(r.calls_volume) || 0,
        callIV: Number(r.calls_iv) || 0,
        callLTP: Number(r.calls_ltp) || 0,
        callNetChange: Number(r.calls_net_change) || 0,
        callBidPrice: Number(r.calls_bid_price) || 0,
        callAskPrice: Number(r.calls_ask_price) || 0,
        callDelta: Number(r.call_delta) || 0,
        callGamma: Number(r.call_gamma) || 0,
        callTheta: Number(r.call_theta) || 0,
        callVega: Number(r.call_vega) || 0,
        callBuildup: r.calls_builtup ?? '',
        putOI: Number(r.puts_oi) || 0,
        putOIChange: Number(r.puts_change_oi) || 0,
        putVolume: Number(r.puts_volume) || 0,
        putIV: Number(r.puts_iv) || 0,
        putLTP: Number(r.puts_ltp) || 0,
        putNetChange: Number(r.puts_net_change) || 0,
        putBidPrice: Number(r.puts_bid_price) || 0,
        putAskPrice: Number(r.puts_ask_price) || 0,
        putDelta: Number(r.put_delta) || 0,
        putGamma: Number(r.put_gamma) || 0,
        putTheta: Number(r.put_theta) || 0,
        putVega: Number(r.put_vega) || 0,
        putBuildup: r.puts_builtup ?? '',
      })).filter((s: any) => s.strike > 0)
        .sort((a: any, b: any) => a.strike - b.strike);

      const totalCallOI = strikes.reduce((s: number, st: any) => s + st.callOI, 0);
      const totalPutOI = strikes.reduce((s: number, st: any) => s + st.putOI, 0);
      const pcr = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;

      let maxPainStrike = 0, minPain = Infinity;
      for (const st of strikes) {
        let pain = 0;
        for (const s2 of strikes) {
          if (s2.strike < st.strike) pain += (st.strike - s2.strike) * s2.callOI;
          if (s2.strike > st.strike) pain += (s2.strike - st.strike) * s2.putOI;
        }
        if (pain < minPain) { minPain = pain; maxPainStrike = st.strike; }
      }

      const uniqueExpiries = [...new Set(rows.map((r: any) => r.expiry_date ? r.expiry_date.split('T')[0] : '').filter(Boolean))].sort();

      return {
        symbol: symbol.toUpperCase(),
        expiry,
        underlyingValue: spotPrice,
        spotPrice,
        strikes,
        pcr,
        maxPain: maxPainStrike,
        totalCallOI,
        totalPutOI,
        expiries: uniqueExpiries,
        source: 'niftytrader',
      };
    } catch {
      clearTimeout(timer);
      return null;
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
    const qNorm = q.replace(/[-\s]/g, '');
    const existingSymbols = new Set<string>();
    const results: any[] = [];

    const fuzzyMatch = (code: string, name: string) => {
      const cNorm = code.toLowerCase().replace(/[-\s]/g, '');
      const nNorm = name.toLowerCase().replace(/[-\s]/g, '');
      return cNorm.includes(qNorm) || nNorm.includes(qNorm)
        || code.toLowerCase().includes(q) || name.toLowerCase().includes(q);
    };

    const addResult = (r: any) => {
      if (!existingSymbols.has(r.symbol)) {
        results.push(r);
        existingSymbols.add(r.symbol);
      }
    };

    // MCX and CDS only come from local lists
    if (!exchange || exchange === 'MCX') {
      POPULAR_MCX_COMMODITIES
        .filter(([code, name]) => fuzzyMatch(code, name))
        .forEach(([code, name]) => addResult({
          stock_code: code, symbol: code, name, exchange: 'MCX', segment: 'commodity', token: '',
        }));
    }

    if (!exchange || exchange === 'CDS') {
      POPULAR_CDS_CURRENCIES
        .filter(([code, name]) => fuzzyMatch(code, name))
        .forEach(([code, name]) => addResult({
          stock_code: code, symbol: code, name, exchange: 'CDS', segment: 'currency', token: '',
        }));
    }

    // For NSE/BSE: instant local results + parallel dynamic search for ALL listed stocks
    if (!exchange || exchange === 'NSE' || exchange === 'BSE') {
      // Instant: check the popular list for sub-millisecond response
      POPULAR_NSE_STOCKS
        .filter(([code, name]) => fuzzyMatch(code, name))
        .forEach(([code, name]) => addResult({
          stock_code: code, symbol: code, name, exchange: 'NSE', segment: 'equity', token: '',
        }));

      // Dynamic: query Yahoo Finance + NSE for ALL 2000+ NSE / 5000+ BSE stocks
      const dynamicResults = await this.searchAllExchanges(query, limit);
      for (const dr of dynamicResults) addResult(dr);
    }

    const sliced = results.slice(0, limit);

    if (sliced.length > 0 && this.cache) {
      await this.cache.set(cacheKey, sliced, CACHE_TTL_SEARCH);
    }

    return sliced;
  }

  private async searchAllExchanges(query: string, limit: number): Promise<any[]> {
    // Run Yahoo Finance and NSE search in parallel for speed
    const [yahooResults, nseResults] = await Promise.all([
      this.searchViaYahoo(query, limit),
      this.searchViaNSE(query, limit),
    ]);

    // Merge: prefer NSE results (authoritative symbol names), then Yahoo
    const merged: any[] = [];
    const seen = new Set<string>();

    for (const r of nseResults) {
      if (!seen.has(r.symbol)) { merged.push(r); seen.add(r.symbol); }
    }
    for (const r of yahooResults) {
      if (!seen.has(r.symbol)) { merged.push(r); seen.add(r.symbol); }
    }

    return merged.slice(0, limit);
  }

  private async searchViaYahoo(query: string, limit: number): Promise<any[]> {
    try {
      const url = `https://query1.finance.yahoo.com/v1/finance/search?q=${encodeURIComponent(query)}&quotesCount=${Math.min(limit + 5, 20)}&newsCount=0&listsCount=0&quotesQueryId=tss_match_phrase_query`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 5000);
      const res = await fetch(url, {
        headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36' },
        signal: ac.signal,
      });
      clearTimeout(timer);

      if (!res.ok) return [];
      const data = await res.json() as any;
      const quotes = data?.quotes ?? [];

      return quotes
        .filter((q: any) => {
          const exch = (q.exchange ?? '').toUpperCase();
          return exch === 'NSI' || exch === 'NSE' || exch === 'BSE' || exch === 'BOM'
            || (q.symbol ?? '').endsWith('.NS') || (q.symbol ?? '').endsWith('.BO');
        })
        .map((q: any) => {
          let symbol = q.symbol ?? '';
          symbol = symbol.replace(/\.(NS|BO)$/, '');
          const exchange = (q.exchange ?? '').toUpperCase() === 'BOM' || (q.symbol ?? '').endsWith('.BO') ? 'BSE' : 'NSE';
          return {
            stock_code: symbol,
            symbol,
            name: q.longname ?? q.shortname ?? symbol,
            exchange,
            segment: q.quoteType === 'EQUITY' ? 'equity' : (q.quoteType ?? 'equity').toLowerCase(),
            token: '',
          };
        })
        .slice(0, limit);
    } catch {
      return [];
    }
  }

  private async searchViaNSE(query: string, limit: number): Promise<any[]> {
    try {
      const url = `https://www.nseindia.com/api/search/autocomplete?q=${encodeURIComponent(query)}`;
      const res = await this.nseFetch(url);
      if (!res.ok) {
        await res.text().catch(() => {});
        return [];
      }

      const data = await res.json() as any;
      const results: any[] = [];

      for (const item of (data?.symbols ?? [])) {
        const symbol = (item.symbol ?? '').toUpperCase();
        if (!symbol) continue;
        results.push({
          stock_code: symbol,
          symbol,
          name: item.symbol_info ?? item.company_name ?? symbol,
          exchange: 'NSE',
          segment: 'equity',
          token: '',
        });
        if (results.length >= limit) break;
      }

      return results;
    } catch {
      return [];
    }
  }

  async getIndicesForExchange(exchange: string): Promise<{ name: string; value: number; change: number; changePercent: number }[]> {
    // MCX iCOMDEX index values were generated with Math.random() on every call —
    // a number that moved when you refreshed and tracked nothing. There is no
    // index feed wired up, so report none rather than invent four.
    if (exchange === 'MCX') {
      return [];
    }

    // Same as MCX above: these were a hardcoded base price plus Math.random()
    // jitter, presented as live currency levels. No feed, so report none.
    if (exchange === 'CDS') {
      return [];
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

  /** GET one of NSE's JSON APIs with the site's cookies; null when NSE refuses or fails. */
  async nseJson(url: string): Promise<any | null> {
    try {
      const res = await this.nseFetch(url);
      if (!res.ok) {
        await res.text().catch(() => { /* drain */ });
        return null;
      }
      return await res.json();
    } catch {
      return null;
    }
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
      if (!res.ok) { await res.text().catch(() => { /* drain */ }); return null; }
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

  private async getBreezeSDK(): Promise<any> {
    if (breezeInstance && Date.now() < breezeInstanceExpiry) {
      return breezeInstance;
    }

    // Prevent concurrent generateSession calls which each download a huge security
    // master file and parse it synchronously, blocking the event loop
    if (breezeInitPromise) return breezeInitPromise;

    breezeInitPromise = this._initBreezeSDK();
    try {
      return await breezeInitPromise;
    } finally {
      breezeInitPromise = null;
    }
  }

  private async _initBreezeSDK(): Promise<any> {
    const creds = await this.getAnyBreezeCredentials();
    if (!creds) return null;

    try {
      const BreezeClass = getBreezeConnectClass();
      if (!BreezeClass) {
        console.log('[Breeze SDK] breezeconnect module not available');
        return null;
      }
      const breeze = new BreezeClass({ appKey: creds.apiKey });

      // Monkey-patch: skip the heavy getStockScriptList() which downloads a multi-MB
      // security master ZIP and parses it synchronously, blocking the event loop for 30-60s.
      // We don't need it — we build our own option chain requests.
      breeze.getStockScriptList = async function () { /* no-op */ };

      await breeze.generateSession(creds.secretKey, creds.sessionToken);

      if (!breeze.apiSession) {
        console.log('[Breeze SDK] generateSession succeeded but no apiSession');
        return null;
      }

      console.log(`[Breeze SDK] Session initialized, apiSession length: ${breeze.apiSession.length}`);
      breezeInstance = breeze;
      breezeInstanceExpiry = Date.now() + 30 * 60 * 1000;
      return breeze;
    } catch (err: any) {
      console.log(`[Breeze SDK] generateSession failed: ${err?.message ?? err}`);
      return null;
    }
  }

  // ── Upstox: used only when a user has made it the active broker ──

  private async upstoxToken(userId?: string): Promise<string | null> {
    // The account's own Upstox login; never another account's.
    return activeUpstoxToken(userId ?? await credentialAccount());
  }

  private async fetchQuoteFromUpstox(symbol: string, exchange: string): Promise<MarketQuote | null> {
    const token = await this.upstoxToken();
    return token ? getUpstox().quote(token, symbol, exchange) : null;
  }

  private async fetchHistoryFromUpstox(
    symbol: string, interval: string, fromDate: string, toDate: string, userId: string | undefined, exchange: string,
  ): Promise<HistoricalBar[]> {
    if (exchange === 'MCX' || exchange === 'CDS') return [];
    const token = await this.upstoxToken(userId);
    return token ? getUpstox().history(token, symbol, interval, fromDate, toDate, exchange) : [];
  }

  /**
   * Candles for one option contract (expired ones too) from whichever broker
   * is connected: ICICI Breeze first, then Upstox. Tells "the contract had no
   * trades" (bars: []) apart from "could not fetch" (error set), so callers
   * can cache the first and retry the second.
   */
  async optionContractHistory(
    underlying: string, expiry: string, strike: number, type: 'CE' | 'PE',
    fromDate: string, toDate: string, interval = '5minute', userId?: string,
  ): Promise<{ bars: HistoricalBar[]; error?: string }> {
    const breeze = await this.breezeOptionHistory(underlying, expiry, strike, type, fromDate, toDate, interval);
    if (!breeze.error) return breeze;
    const token = await this.upstoxToken(userId);
    if (!token) {
      return { bars: [], error: `${breeze.error}. Connect ICICI Breeze or log in with Upstox in Settings.` };
    }
    try {
      const bars = await getUpstox().history(token, buildOptionSymbol(underlying, expiry, strike, type), interval, fromDate, toDate,
        ['SENSEX', 'BANKEX'].includes(underlying.toUpperCase()) ? 'BFO' : 'NFO');
      if (bars.length) return { bars };
    } catch { /* reported below */ }
    // Upstox answers "nothing" for a failure as well as for no trades, so an
    // empty answer is never treated as "this contract did not trade".
    return {
      bars: [],
      error: 'Upstox returned no prices for this contract. Contracts that have already expired need an Upstox Plus plan; ICICI Breeze serves them without one.',
    };
  }

  /** One option contract straight from ICICI Breeze. */
  async breezeOptionHistory(
    underlying: string, expiry: string, strike: number, type: 'CE' | 'PE',
    fromDate: string, toDate: string, interval = '5minute',
  ): Promise<{ bars: HistoricalBar[]; error?: string }> {
    if (!(await this.ensureBreezeBridgeSession())) return { bars: [], error: 'ICICI Breeze is not connected (Settings → Breeze session)' };
    const params = new URLSearchParams({
      interval, from: fromDate, to: toDate, exchange: 'NSE', product: 'options',
      expiry, strike: String(strike), right: type === 'PE' ? 'put' : 'call',
    });
    try {
      const res = await bridgeFetch(`${BREEZE_BRIDGE_URL}/historical/${encodeURIComponent(underlying)}?${params}`, { signal: AbortSignal.timeout(90_000) });
      const data = await res.json().catch(() => null) as any;
      if (!res.ok || !data) return { bars: [], error: data?.error ?? `bridge answered ${res.status}` };
      if (data.error) return { bars: [], error: String(data.error) };
      const bars = (data.bars as any[] ?? []).map((b: any) => ({
        timestamp: String(b.timestamp ?? '').slice(0, 19),
        open: Number(b.open) || 0, high: Number(b.high) || 0, low: Number(b.low) || 0,
        close: Number(b.close) || 0, volume: Number(b.volume) || 0,
      })).filter((b: HistoricalBar) => b.open > 0 && b.timestamp);
      return { bars };
    } catch (err) {
      return { bars: [], error: (err as Error).message };
    }
  }

  private async fetchFromBreeze(
    symbol: string,
    interval: string,
    fromDate: string,
    toDate: string,
    _userId?: string,
    exchange: string = 'NSE',
    contract: InstrumentSpec | null = null,
  ): Promise<HistoricalBar[]> {
    const breezeInterval = this.mapInterval(interval);
    const bridgeActive = await this.ensureBreezeBridgeSession();
    if (!bridgeActive) return [];

    const params = new URLSearchParams({ interval: breezeInterval, from: fromDate, to: toDate, exchange });
    if (contract && contract.instrumentType !== 'EQUITY' && contract.expiry) {
      params.set('product', contract.instrumentType === 'OPTIONS' ? 'options' : 'futures');
      params.set('expiry', istDateStr(contract.expiry));
      if (contract.instrumentType === 'OPTIONS') {
        params.set('strike', String(contract.strike));
        params.set('right', contract.optionType === 'PE' ? 'put' : 'call');
      }
    }
    const name = contract ? contract.underlying : symbol;

    // The bridge pulls long ranges in ~900-bar windows, about one Breeze call a
    // second. A single 15s budget cut every multi-window pull short.
    const days = Math.max(1, (new Date(toDate).getTime() - new Date(fromDate).getTime()) / 86400000);
    const windows = Math.ceil(days / Math.max(1, Math.floor(900 / barsPerSession(interval, exchange))));
    const timeoutMs = Math.min(15_000 + windows * 2_000, 10 * 60_000);

    try {
      const url = `${BREEZE_BRIDGE_URL}/historical/${encodeURIComponent(name)}?${params}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), timeoutMs);
      const res = await bridgeFetch(url, { signal: ac.signal });
      clearTimeout(timer);
      if (!res.ok) return [];

      const data = await res.json() as any;
      if (data.error || !data.bars) {
        if (data.error) log.warn({ symbol, interval, error: data.error }, 'Breeze history unavailable');
        return [];
      }

      return (data.bars as any[]).map((bar: any) => ({
        timestamp: (bar.timestamp ?? '').slice(0, 19),
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

      // With accounts kept apart there is no borrowing: an account without its
      // own ICICI login gets none.
      if (!credential && !(userId && ownBrokerRequired())) {
        credential = await prisma.breezeCredential.findFirst({
          where: { sessionToken: { not: null } },
          orderBy: { updatedAt: 'desc' },
        });
      }

      if (!credential?.sessionToken) {
        console.log('[Breeze Creds] No credential with sessionToken found in DB');
        return null;
      }

      if (credential.sessionExpiresAt && new Date(credential.sessionExpiresAt) < new Date()) {
        console.log(`[Breeze Creds] Session expired at ${credential.sessionExpiresAt}`);
        return null;
      }

      const key = createHash('sha256').update(env.ENCRYPTION_KEY).digest();
      const decryptField = (encrypted: string) => {
        const [ivHex, data] = encrypted.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = createDecipheriv('aes-256-cbc', key, iv);
        let decrypted = decipher.update(data, 'hex', 'utf8');
        decrypted += decipher.final('utf8');
        return cleanCredential(decrypted);
      };

      let sessionToken = credential.sessionToken!;
      try {
        sessionToken = decryptField(sessionToken);
      } catch {
        // might be stored unencrypted from an older version
      }

      const apiKey = decryptField(credential.encryptedApiKey);
      const secretKey = decryptField(credential.encryptedSecret);

      console.log(`[Breeze Creds] Found credentials — apiKey: ${apiKey.substring(0, 8)}..., sessionToken length: ${sessionToken.length}, expires: ${credential.sessionExpiresAt}`);

      return { apiKey, secretKey, sessionToken };
    } catch (err: any) {
      console.log(`[Breeze Creds] Exception: ${err.message}`);
      return null;
    }
  }

  // Breeze v2 interval names. This used to return 'day' and 'minute', which the
  // bridge did not recognise and silently served as 5-minute bars — so every
  // "daily" request answered by Breeze was really ~13 days of 5-minute candles.
  private mapInterval(interval: string): string {
    const map: Record<string, string> = {
      '1d': '1day', '1day': '1day', 'day': '1day', 'daily': '1day',
      '1m': '1minute', '1min': '1minute', 'minute': '1minute', '1minute': '1minute',
      '5m': '5minute', '5min': '5minute', '5minute': '5minute',
      '15m': '15minute', '15min': '15minute', '15minute': '15minute',
      '30m': '30minute', '30min': '30minute', '30minute': '30minute',
      // Used to be missing, so 1-hour requests were sent as daily and came back as daily bars.
      '1h': '1hour', '1hour': '1hour', '60m': '1hour', '60min': '1hour', 'hour': '1hour',
    };
    return map[interval.toLowerCase()] ?? '1day';
  }

  // ── Helpers ──

  // `generateSimulatedHistory` was removed deliberately. It produced a seeded-less
  // random walk (open/high/low/close/volume from Math.random()) for MCX and CDS
  // and returned it as historical data. A strategy backtested against it was
  // fitted to noise, and every downstream metric — Sharpe, drawdown, win rate —
  // described that noise. If simulated data is ever needed again it belongs
  // behind an explicit, clearly-labelled flag, never on the default read path.

  async diagnoseBreezeConnection(): Promise<Record<string, any>> {
    const steps: Record<string, any> = {};

    // Step 1: Check credentials in DB
    const creds = await this.getAnyBreezeCredentials();
    steps.credentials = creds
      ? { found: true, apiKeyPrefix: creds.apiKey.substring(0, 8) + '...', sessionTokenLength: creds.sessionToken.length }
      : { found: false };

    if (!creds) return { steps, result: 'FAIL — no credentials' };

    // Step 2: Initialize SDK (handles session exchange internally)
    try {
      const breeze = await this.getBreezeSDK();
      steps.sdkInit = breeze
        ? { success: true, apiSessionLength: breeze.apiSession?.length ?? 0, userId: breeze.userId ?? 'unknown' }
        : { success: false };

      if (!breeze) return { steps, result: 'FAIL — SDK session exchange failed' };

      // Step 3: Test option chain call via SDK
      const body: Record<string, string> = {
        stock_code: 'NIFTY',
        exchange_code: 'NFO',
        product_type: 'options',
        right: 'call',
        strike_price: '24000',
      };
      const headers = breeze.generateHeaders(body);
      const response = await breeze.makeRequest('GET', 'optionchain', body, headers);
      const data = response?.data;

      steps.optionChain = {
        apiStatus: data?.Status,
        recordCount: Array.isArray(data?.Success) ? data.Success.length : 0,
        error: data?.Error ?? null,
        sampleRecord: Array.isArray(data?.Success) && data.Success.length > 0 ? data.Success[0] : null,
      };
    } catch (err: any) {
      steps.sdkError = { message: err.message, code: err.code, stack: err.stack?.substring(0, 300) };
    }

    // Step 4: Check Python Breeze Bridge
    try {
      const hRes = await bridgeFetch(`${BREEZE_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3_000) });
      if (hRes.ok) {
        steps.pythonBridge = await hRes.json();
      } else {
        steps.pythonBridge = { status: 'unreachable', httpStatus: hRes.status };
      }
    } catch (err: any) {
      steps.pythonBridge = { status: 'unreachable', error: err.message };
    }

    const ok = steps.optionChain?.recordCount > 0 || steps.pythonBridge?.session_active;
    return { steps, result: ok ? 'OK' : 'FAIL' };
  }

  private buildBreezePayload(fields: Record<string, string>): string {
    const body: Record<string, string> = {};
    for (const [key, val] of Object.entries(fields)) {
      if (val !== '' && val != null) body[key] = val;
    }
    return JSON.stringify(body);
  }

  private buildBreezeHeaders(
    creds: { apiKey: string; secretKey: string; sessionToken: string },
    payload: string,
  ): { headers: Record<string, string>; timestamp: string } {
    const timestamp = new Date().toISOString().split('.')[0] + '.000Z';
    const checksum = createHash('sha256')
      .update(timestamp + payload + creds.secretKey)
      .digest('hex');
    return {
      headers: {
        'Content-Type': 'application/json',
        'X-AppKey': creds.apiKey,
        'X-SessionToken': creds.sessionToken,
        'X-Timestamp': timestamp,
        'X-Checksum': `token ${checksum}`,
      },
      timestamp,
    };
  }

  private async ensureBreezeBridgeSession(): Promise<boolean> {
    try {
      const hRes = await bridgeFetch(`${BREEZE_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3_000) });
      if (!hRes.ok) return false;
      const health = await hRes.json() as any;
      if (health.session_active === true) return true;

      // Bridge is running but has no session — try to auto-initialize from DB credentials
      return this.autoInitBreezeBridge();
    } catch {
      return false;
    }
  }

  /** One attach at a time per account. */
  private _bridgeInit = new Map<string, Promise<boolean>>();

  private async autoInitBreezeBridge(): Promise<boolean> {
    const key = await bridgeAccountKey();
    const running = this._bridgeInit.get(key);
    if (running) return running;

    const attempt = this._doAutoInitBreezeBridge();
    this._bridgeInit.set(key, attempt);
    try {
      return await attempt;
    } finally {
      this._bridgeInit.delete(key);
    }
  }

  private async _doAutoInitBreezeBridge(): Promise<boolean> {
    try {
      const creds = await this.getAnyBreezeCredentials(await credentialAccount());
      if (!creds) {
        log.info('Bridge has no session and no credentials in DB');
        return false;
      }

      log.info('Bridge running but no session — auto-initializing from DB credentials');
      const body = JSON.stringify({
        api_key: creds.apiKey,
        api_secret: creds.secretKey,
        session_token: creds.sessionToken,
      });

      const res = await bridgeFetch(`${BREEZE_BRIDGE_URL}/init`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body,
        signal: AbortSignal.timeout(25_000),
      });

      if (!res.ok) {
        log.warn({ status: res.status }, 'Bridge auto-init failed');
        return false;
      }

      const result = await res.json() as any;
      if (result.success) {
        log.info('Bridge auto-initialized successfully from DB credentials');
        return true;
      }

      log.warn({ error: result.error }, 'Bridge auto-init returned failure');
      return false;
    } catch (err) {
      log.warn({ err }, 'Bridge auto-init exception');
      return false;
    }
  }

  private async fetchFromBreezeBridge(symbol: string, expiry?: string): Promise<any> {
    await this.ensureBreezeBridgeSession();
    const url = `${BREEZE_BRIDGE_URL}/option-chain/${encodeURIComponent(symbol)}${expiry ? `?expiry=${encodeURIComponent(expiry)}` : ''}`;
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    const res = await bridgeFetch(url, { signal: ac.signal });
    clearTimeout(timer);
    if (!res.ok) throw new Error(`Bridge returned ${res.status}`);
    const data = await res.json() as any;
    if (data.error) throw new Error(data.error);
    return data;
  }

  private async fetchOptionsChainFromBreeze(symbol: string, expiryDate?: string) {
    const breeze = await this.getBreezeSDK();
    if (!breeze) return null;

    const expiry = `${expiryDate ?? (await getExpiryCalendar().nextExpiry(symbol)) ?? istDateStr()}T06:00:00.000Z`;

    const allStrikes: Map<number, any> = new Map();
    let spotPrice = 0;

    for (const right of ['call', 'put'] as const) {
      try {
        const breezeCode = BREEZE_STOCK_CODES[symbol.toUpperCase()] ?? symbol.toUpperCase();
        const body: Record<string, string> = {
          stock_code: breezeCode,
          exchange_code: 'NFO',
          product_type: 'options',
          expiry_date: expiry,
          right,
        };
        const headers = breeze.generateHeaders(body);

        console.log(`[Breeze Chain] Requesting ${right} for ${symbol} expiry=${expiry}`);
        const response = await breeze.makeRequest('GET', 'optionchain', body, headers);
        const data = response?.data;

        if (!data || data.Status !== 200 || data.Error) {
          console.log(`[Breeze Chain] ${right} API error — Status: ${data?.Status}, Error: ${JSON.stringify(data?.Error)?.substring(0, 300)}`);
          continue;
        }

        const records = data.Success ?? [];
        if (!Array.isArray(records)) continue;
        console.log(`[Breeze Chain] ${right} returned ${records.length} records`);

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
      } catch (err: any) {
        console.log(`[Breeze Chain] ${right} exception: ${err.message}`);
      }
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
        // Calls below the expiry price and puts above it finish in the money.
        // (These two were swapped, so this Breeze fallback reported the wrong strike.)
        if (s2.strike < st.strike) pain += (st.strike - s2.strike) * s2.callOI;
        if (s2.strike > st.strike) pain += (s2.strike - st.strike) * s2.putOI;
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

  private async fetchExpiryDatesFromBreeze(symbol: string): Promise<string[]> {
    const breeze = await this.getBreezeSDK();
    if (!breeze) return [];

    try {
      const defaultStrike = symbol.toUpperCase() === 'NIFTY' ? '24000'
        : symbol.toUpperCase() === 'BANKNIFTY' ? '50000'
        : symbol.toUpperCase() === 'FINNIFTY' ? '23000'
        : symbol.toUpperCase() === 'MIDCPNIFTY' ? '12000'
        : '20000';

      const body: Record<string, string> = {
        stock_code: symbol.toUpperCase(),
        exchange_code: 'NFO',
        product_type: 'options',
        right: 'call',
        strike_price: defaultStrike,
      };
      const headers = breeze.generateHeaders(body);

      console.log(`[Breeze Expiries] Requesting expiries for ${symbol} with strike=${defaultStrike}`);
      const response = await breeze.makeRequest('GET', 'optionchain', body, headers);
      const data = response?.data;

      if (!data || data.Status !== 200 || data.Error) {
        console.log(`[Breeze Expiries] API error — Status: ${data?.Status}, Error: ${JSON.stringify(data?.Error)?.substring(0, 300)}`);
        return [];
      }

      const records = data.Success ?? [];
      if (!Array.isArray(records) || records.length === 0) {
        console.log(`[Breeze Expiries] No records returned`);
        return [];
      }

      console.log(`[Breeze Expiries] Got ${records.length} records, extracting unique expiry dates`);

      const today = istMidnight();

      const expirySet = new Set<string>();
      for (const rec of records) {
        const raw = rec.expiry_date ?? '';
        if (!raw) continue;
        const dateStr = typeof raw === 'string' ? raw.split('T')[0] : '';
        if (dateStr && new Date(dateStr + 'T12:00:00Z') >= today) {
          expirySet.add(dateStr);
        }
      }

      return [...expirySet].sort();
    } catch (err: any) {
      console.log(`[Breeze Expiries] Exception: ${err.message}`);
      return [];
    }
  }

  private parseOptionsChain(symbol: string, data: any, targetExpiry?: string) {
    const records = data?.records ?? data?.filtered ?? {};
    const allData = records?.data ?? [];
    const expiries: string[] = (records?.expiryDates ?? []).map((d: string) => d.split('T')[0]);
    const expiry = targetExpiry
      ? expiries.find(e => e === targetExpiry) ?? expiries[0] ?? ''
      : expiries[0] ?? '';
    const underlyingValue = records?.underlyingValue ?? 0;

    const filtered = allData.filter((d: any) => {
      const dExp = (d.expiryDate ?? '').split('T')[0];
      return dExp === expiry;
    });
    const strikes = filtered.map((d: any) => ({
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
        // Calls below the expiry price and puts above it finish in the money.
        // (These two were swapped, so the NSE fallback reported the wrong strike.)
        if (s2.strike < st.strike) pain += (st.strike - s2.strike) * s2.callOI;
        if (s2.strike > st.strike) pain += (s2.strike - st.strike) * s2.putOI;
      }
      if (pain < minPain) { minPain = pain; maxPainStrike = st.strike; }
    }

    return {
      symbol, expiry, underlyingValue,
      strikes, pcr: Math.round(pcr * 100) / 100,
      maxPain: maxPainStrike,
      totalCallOI, totalPutOI, expiries,
    };
  }

  /**
   * Live MCX quote, from Breeze via the bridge.
   *
   * This previously mapped MCX commodities to Yahoo COMEX/NYMEX tickers (GOLD →
   * GC=F, CRUDEOIL → CL=F) and returned those, labelled `exchange: 'MCX'`. Those
   * are different instruments in a different currency: COMEX gold is ~$2,600 per
   * troy ounce, MCX GOLD is ~₹73,000 per 10 grams. Anything downstream — a
   * strategy, a backtest, a stop-loss — was reading a number with no relationship
   * to the contract it claimed to price. When Yahoo failed it returned a
   * hardcoded constant from a lookup table, still labelled as a live quote.
   *
   * A commodity quote is per CONTRACT, so an expiry is required. The canonical
   * symbol carries one (CRUDEOIL20260819FUT); a bare underlying does not identify
   * anything tradeable and now throws instead of inventing a price. Resolving a
   * bare underlying to its near-month contract needs an MCX expiry calendar,
   * which does not exist here yet.
   */
  private async getMCXQuote(symbol: string): Promise<MarketQuote> {
    const spec = parseInstrumentSymbol(symbol, 'MCX');

    if (spec.instrumentType === 'EQUITY' || !spec.expiry) {
      throw new Error(
        `Cannot quote "${symbol}" on MCX: no contract expiry. A commodity quote is ` +
        `per contract — use a canonical futures symbol such as ` +
        `${spec.underlying}YYYYMMDDFUT. Resolving a bare underlying to the ` +
        `near-month contract requires an MCX expiry calendar, which is not implemented.`,
      );
    }

    const expiryIso = istDateStr(spec.expiry);
    const cacheKey = `mcx_quote_${spec.underlying}_${expiryIso}`;
    if (this.cache) {
      const cached = await this.cache.get<MarketQuote>(cacheKey);
      if (cached) return cached;
    }

    const bridgeActive = await this.ensureBreezeBridgeSession();
    if (!bridgeActive) {
      throw new Error(`Cannot quote ${symbol}: Breeze bridge session is not active.`);
    }

    const url =
      `${BREEZE_BRIDGE_URL}/quote/${encodeURIComponent(spec.underlying)}` +
      `?exchange=MCX&product_type=futures&expiry=${encodeURIComponent(expiryIso)}`;

    const res = await bridgeFetch(url, { signal: AbortSignal.timeout(8000) });
    if (!res.ok) {
      throw new Error(`Cannot quote ${symbol}: bridge returned ${res.status}.`);
    }

    const data = await res.json() as any;
    const ltp = Number(data?.ltp);
    if (!Number.isFinite(ltp) || ltp <= 0) {
      // No synthetic fallback. A missing commodity price is reported as missing.
      throw new Error(
        `Cannot quote ${symbol}: bridge returned no valid LTP` +
        `${data?.error ? ` (${data.error})` : ''}.`,
      );
    }

    const change = Number(data.change ?? 0);
    const prevClose = ltp - change;
    const quote: MarketQuote = {
      symbol,
      exchange: 'MCX',
      ltp,
      change,
      changePercent: Number(data.changePercent ?? (prevClose > 0 ? (change / prevClose) * 100 : 0)),
      open: Number(data.open ?? ltp),
      high: Number(data.high ?? ltp),
      low: Number(data.low ?? ltp),
      close: prevClose,
      volume: Number(data.volume ?? 0),
      bidPrice: Number(data.bidPrice ?? 0),
      askPrice: Number(data.askPrice ?? 0),
      bidQty: 0,
      askQty: 0,
      timestamp: new Date().toISOString(),
    };

    this.cache?.set(cacheKey, quote, 30);
    return quote;
  }

  private async getCDSQuote(symbol: string): Promise<MarketQuote> {
    const YAHOO_CDS_MAP: Record<string, string> = {
      USDINR: 'USDINR=X', EURINR: 'EURINR=X', GBPINR: 'GBPINR=X',
      JPYINR: 'JPYINR=X', AUDINR: 'AUDINR=X', CADINR: 'CADINR=X',
      CHFINR: 'CHFINR=X', SGDINR: 'SGDINR=X', HKDINR: 'HKDINR=X',
      CNHINR: 'CNHINR=X',
    };

    const entry = POPULAR_CDS_CURRENCIES.find(([code]) => code === symbol.toUpperCase());
    const fallbackPrice = entry?.[2] ?? 83;
    const yahooTicker = YAHOO_CDS_MAP[symbol.toUpperCase()];

    if (yahooTicker) {
      try {
        const cacheKey = `cds_yahoo_${yahooTicker}`;
        if (this.cache) {
          const cached = await this.cache.get<MarketQuote>(cacheKey);
          if (cached) return cached;
        }

        const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooTicker}?interval=1d&range=2d`;
        const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(8000) });
        if (res.ok) {
          const json = await res.json() as any;
          const result = json?.chart?.result?.[0];
          const meta = result?.meta;
          if (meta?.regularMarketPrice) {
            const ltp = Number(meta.regularMarketPrice.toFixed(4));
            const prevClose = Number(meta.previousClose?.toFixed(4) ?? ltp);
            const change = Number((ltp - prevClose).toFixed(4));
            const changePercent = prevClose > 0 ? Number(((change / prevClose) * 100).toFixed(2)) : 0;
            const quote: MarketQuote = {
              symbol, exchange: 'CDS', ltp, change, changePercent,
              open: Number((meta.regularMarketOpen ?? ltp).toFixed(4)),
              high: Number((meta.regularMarketDayHigh ?? ltp).toFixed(4)),
              low: Number((meta.regularMarketDayLow ?? ltp).toFixed(4)),
              close: prevClose, volume: meta.regularMarketVolume ?? 0,
              bidPrice: Number((ltp - 0.0025).toFixed(4)), askPrice: Number((ltp + 0.0025).toFixed(4)),
              bidQty: 0, askQty: 0, timestamp: new Date().toISOString(),
            };
            this.cache?.set(cacheKey, quote, 30);
            return quote;
          }
        }
      } catch {}
    }

    // Previously returned `fallbackPrice` — a hardcoded constant from a lookup
    // table (83 for USDINR) — dressed up as a live quote with open/high/low/close
    // all equal to it. A caller could not distinguish that from a real quote.
    throw new Error(
      `Cannot quote ${symbol} on CDS: no live price available. ` +
      `(Previously a hardcoded placeholder was returned here as if it were live.)`,
    );
  }

  private async fetchFnOQuote(
    symbol: string,
    parsed: { underlying: string; expiry: string; strike: number; type: 'CE' | 'PE' } | null,
  ): Promise<MarketQuote | null> {
    if (!parsed) return null;

    try {
      const bridgeActive = await this.ensureBreezeBridgeSession();
      if (!bridgeActive) {
        console.log(`[FnOQuote] Bridge not active for ${symbol}`);
        return null;
      }

      const bridgeUrl = `${BREEZE_BRIDGE_URL}/option-chain/${encodeURIComponent(parsed.underlying)}?expiry=${encodeURIComponent(parsed.expiry)}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 15_000);
      const res = await fetch(bridgeUrl, { signal: ac.signal });
      clearTimeout(timer);

      if (!res.ok) return null;

      const data = await res.json() as any;
      if (!data.strikes || !Array.isArray(data.strikes)) return null;

      // Bridge returns strikes with callLTP/putLTP, callOI/putOI, etc.
      for (const s of data.strikes) {
        if (s.strike !== parsed.strike) continue;

        const isCall = parsed.type === 'CE';
        const ltp = isCall ? s.callLTP : s.putLTP;
        if (!ltp || ltp <= 0) continue;

        const netChange = isCall ? (s.callNetChange ?? 0) : (s.putNetChange ?? 0);
        const prevClose = ltp - netChange;
        const changePct = prevClose > 0 ? (netChange / prevClose) * 100 : 0;

        console.log(`[FnOQuote] ${symbol}: LTP=₹${ltp}, change=${netChange}`);

        return {
          symbol,
          exchange: 'NFO',
          ltp,
          change: netChange,
          changePercent: changePct,
          open: 0,
          high: 0,
          low: 0,
          close: prevClose > 0 ? prevClose : ltp,
          volume: isCall ? (s.callVolume ?? 0) : (s.putVolume ?? 0),
          bidPrice: isCall ? (s.callBidPrice ?? 0) : (s.putBidPrice ?? 0),
          askPrice: isCall ? (s.callAskPrice ?? 0) : (s.putAskPrice ?? 0),
          bidQty: 0,
          askQty: 0,
          timestamp: new Date().toISOString(),
        };
      }

      console.log(`[FnOQuote] ${symbol}: strike ${parsed.strike} not found in chain (${data.strikes.length} strikes)`);
    } catch (err) {
      console.log(`[FnOQuote] Failed to fetch ${symbol}: ${(err as Error).message}`);
    }

    return null;
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

  async getLotSizes(): Promise<{ lotSizes: Record<string, number>; source: string }> {
    const cacheKey = 'lot-sizes:all';
    if (this.cache) {
      const cached = await this.cache.get<{ lotSizes: Record<string, number>; source: string }>(cacheKey);
      if (cached) return cached;
    }

    try {
      const url = `${BREEZE_BRIDGE_URL}/lot-sizes`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20_000);
      const res = await bridgeFetch(url, { signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json() as any;
        if (data.lotSizes && Object.keys(data.lotSizes).length > 0) {
          const result = { lotSizes: data.lotSizes, source: data.source || 'bridge' };
          if (this.cache) await this.cache.set(cacheKey, result, 3600);
          return result;
        }
      }
    } catch (err) {
      console.log(`[LotSizes] Bridge fetch error: ${err}`);
    }

    // Upstox's public instrument file carries every contract's lot size and
    // needs no login, so it answers even without a broker session.
    const listed = await getUpstox().lotSizes().catch(() => ({} as Record<string, number>));
    if (Object.keys(listed).length > 0) {
      const result = { lotSizes: listed, source: 'upstox-instruments' };
      if (this.cache) await this.cache.set(cacheKey, result, 3600);
      return result;
    }

    return { lotSizes: {}, source: 'none' };
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
