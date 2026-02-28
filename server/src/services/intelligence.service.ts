import { CacheService } from '../lib/redis.js';
import { getPrisma } from '../lib/prisma.js';
import { createHash, createDecipheriv } from 'crypto';
import https from 'https';
import { env } from '../config.js';
import { engineGreeks, isEngineAvailable } from '../lib/rust-engine.js';

const CACHE_TTL = 120;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

let nseCookies = '';
let nseCookieExpiry = 0;
let cookieFetchPromise: Promise<void> | null = null;

async function drainResponse(res: Response): Promise<void> {
  try {
    const reader = res.body?.getReader();
    if (reader) {
      while (true) {
        const { done } = await reader.read();
        if (done) break;
      }
    }
  } catch { /* ignore */ }
}

async function ensureNseCookies(): Promise<string> {
  if (nseCookies && Date.now() < nseCookieExpiry) return nseCookies;
  if (cookieFetchPromise) {
    await cookieFetchPromise;
    return nseCookies;
  }
  cookieFetchPromise = (async () => {
    try {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), 6000);
      const res = await fetch('https://www.nseindia.com', {
        headers: { 'User-Agent': UA, 'Accept': 'text/html' },
        signal: ac.signal,
      });
      clearTimeout(t);
      await drainResponse(res);
      const setCookies = res.headers.getSetCookie?.() ?? [];
      if (setCookies.length > 0) {
        nseCookies = setCookies.map((c: string) => c.split(';')[0]).join('; ');
        nseCookieExpiry = Date.now() + 4 * 60 * 1000;
      }
    } catch { /* cookies will be empty */ }
    finally { cookieFetchPromise = null; }
  })();
  await cookieFetchPromise;
  return nseCookies;
}

let activeNseRequests = 0;
const MAX_CONCURRENT_NSE = 2;

async function nseFetch(url: string): Promise<any> {
  while (activeNseRequests >= MAX_CONCURRENT_NSE) {
    await new Promise(r => setTimeout(r, 200));
  }
  activeNseRequests++;
  try {
    const cookies = await ensureNseCookies();
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(url, {
      headers: {
        'User-Agent': UA,
        'Accept': 'application/json',
        'Referer': 'https://www.nseindia.com/',
        ...(cookies ? { 'Cookie': cookies } : {}),
      },
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) {
      await drainResponse(res);
      return null;
    }
    return await res.json();
  } catch {
    return null;
  } finally {
    activeNseRequests--;
  }
}

export class IntelligenceService {
  private cache: CacheService | null;
  private chainInflight = new Map<string, Promise<any>>();

  constructor(cache?: CacheService) {
    this.cache = cache ?? null;
  }

  private fetchOptionsChainDeduped(symbol: string): Promise<any> {
    const key = symbol.toUpperCase();
    const existing = this.chainInflight.get(key);
    if (existing) return existing;
    const promise = this.fetchOptionsChain(key).finally(() => {
      this.chainInflight.delete(key);
    });
    this.chainInflight.set(key, promise);
    return promise;
  }

  async getFIIDII() {
    return this.cached('intel:fii-dii', async () => {
      try {
        const data = await nseFetch('https://www.nseindia.com/api/fiidiiTradeReact');
        if (data && Array.isArray(data)) {
          const fii = data.find((d: any) => d.category === 'FII/FPI *');
          const dii = data.find((d: any) => d.category === 'DII *');
          if (fii || dii) {
            return {
              date: fii?.date || new Date().toISOString().split('T')[0],
              fiiBuy: parseFloat(fii?.buyValue ?? '0') * 100,
              fiiSell: parseFloat(fii?.sellValue ?? '0') * 100,
              fiiNet: parseFloat(fii?.netValue ?? '0') * 100,
              diiBuy: parseFloat(dii?.buyValue ?? '0') * 100,
              diiSell: parseFloat(dii?.sellValue ?? '0') * 100,
              diiNet: parseFloat(dii?.netValue ?? '0') * 100,
            };
          }
        }
      } catch { /* fall through to fallback */ }

      return {
        date: new Date().toISOString().split('T')[0],
        fiiBuy: 0, fiiSell: 0, fiiNet: 0,
        diiBuy: 0, diiSell: 0, diiNet: 0,
        message: 'FII/DII data unavailable from NSE',
      };
    });
  }

  async getFIIDIITrend(days = 30) {
    return this.cached(`intel:fii-dii-trend:${days}`, () => {
      return [];
    });
  }

  async getPCR(symbol: string) {
    return this.cached(`intel:pcr:${symbol}`, async () => {
      try {
        const chain = await this.fetchOptionsChainDeduped(symbol);
        if (chain && chain.pcr > 0) {
          let interpretation = 'Neutral';
          if (chain.pcr > 1.3) interpretation = 'Bullish';
          else if (chain.pcr > 1.0) interpretation = 'Moderately Bullish';
          else if (chain.pcr < 0.7) interpretation = 'Bearish';
          else if (chain.pcr < 1.0) interpretation = 'Moderately Bearish';
          return { symbol, pcr: chain.pcr, interpretation };
        }
      } catch { /* fallback */ }
      return { symbol, pcr: 0, interpretation: 'Data unavailable — NSE blocked request' };
    });
  }

  async getOIHeatmap(symbol: string) {
    return this.cached(`intel:oi-heatmap:${symbol}`, async () => {
      try {
        const chain = await this.fetchOptionsChainDeduped(symbol);
        if (chain?.strikes?.length > 0) {
          return { symbol, strikes: chain.strikes };
        }
      } catch { /* fallback */ }
      return { symbol, strikes: [], message: 'Options data unavailable — NSE blocked request' };
    });
  }

  async getMaxPain(symbol: string) {
    return this.cached(`intel:max-pain:${symbol}`, async () => {
      try {
        const chain = await this.fetchOptionsChainDeduped(symbol);
        if (chain && chain.maxPain > 0) {
          return {
            symbol, maxPain: chain.maxPain, maxPainStrike: chain.maxPain,
            callOI: chain.totalCallOI ?? 0, putOI: chain.totalPutOI ?? 0,
          };
        }
      } catch { /* fallback */ }
      return { symbol, maxPain: 0, maxPainStrike: 0, callOI: 0, putOI: 0, message: 'Data unavailable' };
    });
  }

  async getIVPercentile(symbol: string) {
    return this.cached(`intel:iv-percentile:${symbol}`, async () => {
      try {
        const chain = await this.fetchOptionsChainDeduped(symbol);
        if (chain?.strikes?.length > 0) {
          const ivs = chain.strikes
            .filter((s: any) => (s.callIV ?? 0) > 0)
            .map((s: any) => s.callIV as number);
          if (ivs.length > 0) {
            const currentIV = ivs[Math.floor(ivs.length / 2)];
            const sorted = [...ivs].sort((a, b) => a - b);
            const rank = sorted.findIndex(v => v >= currentIV);
            const ivPercentile = Math.round((rank / sorted.length) * 100);
            return { symbol, currentIV, ivPercentile, ivRank: ivPercentile };
          }
        }
      } catch { /* fallback */ }
      return { symbol, currentIV: 0, ivPercentile: 0, ivRank: 0, message: 'Data unavailable' };
    });
  }

  private async getBreezeCredentials(): Promise<{ apiKey: string; secretKey: string; sessionToken: string } | null> {
    try {
      const prisma = getPrisma();
      const credential = await prisma.breezeCredential.findFirst({
        where: { sessionToken: { not: null } },
        orderBy: { updatedAt: 'desc' },
      });
      if (!credential?.sessionToken) return null;
      if (credential.sessionExpiresAt && new Date(credential.sessionExpiresAt) < new Date()) return null;

      const key = createHash('sha256').update(env.ENCRYPTION_KEY || env.JWT_SECRET).digest();
      const decryptField = (encrypted: string) => {
        const [ivHex, data] = encrypted.split(':');
        const iv = Buffer.from(ivHex, 'hex');
        const decipher = createDecipheriv('aes-256-cbc', key, iv);
        return decipher.update(data, 'hex', 'utf8') + decipher.final('utf8');
      };

      let sessionToken = credential.sessionToken!;
      try { sessionToken = decryptField(sessionToken); } catch { /* use raw */ }
      return {
        apiKey: decryptField(credential.encryptedApiKey),
        secretKey: decryptField(credential.encryptedSecret),
        sessionToken,
      };
    } catch {
      return null;
    }
  }

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
      req.setTimeout(15_000, () => req.destroy(new Error('Timeout')));
      if (body) req.write(body);
      req.end();
    });
  }

  private async fetchOptionsChainFromBreeze(symbol: string): Promise<any> {
    const creds = await this.getBreezeCredentials();
    if (!creds) return null;

    const now = new Date();
    now.setMilliseconds(0);
    const timestamp = now.toISOString();

    // Get nearest Thursday expiry
    const today = new Date();
    const dayOfWeek = today.getDay();
    const daysUntilThursday = (4 - dayOfWeek + 7) % 7 || 7;
    const nextThursday = new Date(today);
    nextThursday.setDate(today.getDate() + (dayOfWeek <= 4 ? (4 - dayOfWeek) : daysUntilThursday));
    const expiryDate = nextThursday.toISOString().split('T')[0] + 'T06:00:00.000Z';

    const payload = JSON.stringify({
      stock_code: symbol.toUpperCase() === 'NIFTY' ? 'NIFTY' : symbol,
      exchange_code: 'NFO',
      expiry_date: expiryDate,
      product_type: 'Options',
      right: 'Call',
      strike_price: '',
    });

    const checksum = createHash('sha256').update(timestamp + payload + creds.secretKey).digest('hex');
    const res = await this.breezeRequest('/breezeapi/api/v1/optionchain', {
      'Content-Type': 'application/json',
      'X-AppKey': creds.apiKey,
      'X-SessionToken': creds.sessionToken,
      'X-Timestamp': timestamp,
      'X-Checksum': `token ${checksum}`,
    }, payload);

    if (res.status !== 200) return null;
    const callData = JSON.parse(res.data);

    // Fetch puts
    const putPayload = JSON.stringify({
      stock_code: symbol.toUpperCase() === 'NIFTY' ? 'NIFTY' : symbol,
      exchange_code: 'NFO',
      expiry_date: expiryDate,
      product_type: 'Options',
      right: 'Put',
      strike_price: '',
    });

    const now2 = new Date(); now2.setMilliseconds(0);
    const ts2 = now2.toISOString();
    const cs2 = createHash('sha256').update(ts2 + putPayload + creds.secretKey).digest('hex');
    const putRes = await this.breezeRequest('/breezeapi/api/v1/optionchain', {
      'Content-Type': 'application/json',
      'X-AppKey': creds.apiKey,
      'X-SessionToken': creds.sessionToken,
      'X-Timestamp': ts2,
      'X-Checksum': `token ${cs2}`,
    }, putPayload);

    const putData = putRes.status === 200 ? JSON.parse(putRes.data) : null;

    const callRecords = callData?.Success ?? [];
    const putRecords = putData?.Success ?? [];

    if (!Array.isArray(callRecords) || callRecords.length === 0) return null;

    // Build strike map
    const strikeMap = new Map<number, any>();
    for (const rec of callRecords) {
      const strike = Number(rec.strike_price);
      if (!strike) continue;
      strikeMap.set(strike, {
        strike,
        callOI: Number(rec.open_interest ?? 0),
        callOIChange: Number(rec.change_oi ?? 0),
        callLTP: Number(rec.ltp ?? 0),
        callIV: Number(rec.implied_volatility ?? 0),
        putOI: 0, putOIChange: 0, putLTP: 0, putIV: 0,
      });
    }
    for (const rec of putRecords) {
      const strike = Number(rec.strike_price);
      if (!strike) continue;
      const existing = strikeMap.get(strike) ?? {
        strike, callOI: 0, callOIChange: 0, callLTP: 0, callIV: 0,
        putOI: 0, putOIChange: 0, putLTP: 0, putIV: 0,
      };
      existing.putOI = Number(rec.open_interest ?? 0);
      existing.putOIChange = Number(rec.change_oi ?? 0);
      existing.putLTP = Number(rec.ltp ?? 0);
      existing.putIV = Number(rec.implied_volatility ?? 0);
      strikeMap.set(strike, existing);
    }

    const strikes = Array.from(strikeMap.values()).sort((a, b) => a.strike - b.strike);
    const totalCallOI = strikes.reduce((s, st) => s + st.callOI, 0);
    const totalPutOI = strikes.reduce((s, st) => s + st.putOI, 0);
    const pcr = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;

    let maxPain = 0, minPain = Infinity;
    for (const st of strikes) {
      let pain = 0;
      for (const s2 of strikes) {
        if (s2.strike < st.strike) pain += (st.strike - s2.strike) * s2.putOI;
        if (s2.strike > st.strike) pain += (s2.strike - st.strike) * s2.callOI;
      }
      if (pain < minPain) { minPain = pain; maxPain = st.strike; }
    }

    return { strikes, pcr, maxPain, totalCallOI, totalPutOI, expiry: expiryDate };
  }

  private async fetchOptionsChain(symbol: string): Promise<any> {
    // Primary: Breeze API (authenticated, reliable)
    try {
      const breezeResult = await this.fetchOptionsChainFromBreeze(symbol);
      if (breezeResult) return breezeResult;
    } catch { /* fall through to NSE */ }

    // Fallback: NSE scraping
    const indexSymbol = symbol.toUpperCase() === 'NIFTY' ? 'NIFTY' : symbol;
    const isIndex = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY'].includes(indexSymbol);
    const endpoint = isIndex ? 'option-chain-indices' : 'option-chain-equities';
    const url = `https://www.nseindia.com/api/${endpoint}?symbol=${encodeURIComponent(indexSymbol)}`;
    
    const data = await nseFetch(url);
    if (!data?.records?.data) return null;

    const records = data.records;
    const expiry = records.expiryDates?.[0] ?? '';
    const allData = records.data.filter((d: any) => d.expiryDate === expiry);

    const strikes = allData.map((d: any) => ({
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
    const pcr = totalCallOI > 0 ? Math.round((totalPutOI / totalCallOI) * 100) / 100 : 0;

    let maxPain = 0, minPain = Infinity;
    for (const st of strikes) {
      let pain = 0;
      for (const s2 of strikes) {
        if (s2.strike < st.strike) pain += (st.strike - s2.strike) * s2.putOI;
        if (s2.strike > st.strike) pain += (s2.strike - st.strike) * s2.callOI;
      }
      if (pain < minPain) { minPain = pain; maxPain = st.strike; }
    }

    return { strikes, pcr, maxPain, totalCallOI, totalPutOI, expiry };
  }

  async getGreeks(symbol: string) {
    return this.cached(`intel:greeks:${symbol}`, async () => {
      if (!isEngineAvailable()) {
        return { symbol, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, price: 0, source: 'unavailable' };
      }

      try {
        const chain = await this.fetchOptionsChainDeduped(symbol);
        if (!chain?.strikes?.length) {
          return { symbol, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, price: 0, source: 'no-chain-data' };
        }

        const atmStrike = chain.strikes.reduce((best: any, s: any) => {
          const callPriceDiff = Math.abs((s.callLTP || 0) - (s.putLTP || 0));
          const bestDiff = Math.abs((best.callLTP || 0) - (best.putLTP || 0));
          return callPriceDiff < bestDiff ? s : best;
        }, chain.strikes[0]);

        const spot = atmStrike.strike;
        const strike = atmStrike.strike;
        const iv = (atmStrike.callIV || atmStrike.putIV || 20) / 100;

        const now = new Date();
        const expiry = chain.expiry ? new Date(chain.expiry) : new Date(now.getTime() + 7 * 86_400_000);
        const timeToExpiry = Math.max(0.001, (expiry.getTime() - now.getTime()) / (365.25 * 86_400_000));

        const callResult = await engineGreeks({
          spot,
          strike,
          time_to_expiry: timeToExpiry,
          risk_free_rate: 0.065,
          volatility: iv,
          option_type: 'call',
        }) as any;

        const putResult = await engineGreeks({
          spot,
          strike,
          time_to_expiry: timeToExpiry,
          risk_free_rate: 0.065,
          volatility: iv,
          option_type: 'put',
        }) as any;

        return {
          symbol,
          atmStrike: strike,
          call: {
            price: callResult.price,
            delta: callResult.delta,
            gamma: callResult.gamma,
            theta: callResult.theta,
            vega: callResult.vega,
            rho: callResult.rho,
            iv: callResult.implied_volatility,
          },
          put: {
            price: putResult.price,
            delta: putResult.delta,
            gamma: putResult.gamma,
            theta: putResult.theta,
            vega: putResult.vega,
            rho: putResult.rho,
            iv: putResult.implied_volatility,
          },
          delta: callResult.delta,
          gamma: callResult.gamma,
          theta: callResult.theta,
          vega: callResult.vega,
          rho: callResult.rho,
          price: callResult.price,
          source: 'rust-engine',
        };
      } catch {
        return { symbol, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, price: 0, source: 'error' };
      }
    });
  }

  async getSectorPerformance() {
    return this.cached('intel:sectors:perf', async () => {
      try {
        const data = await nseFetch('https://www.nseindia.com/api/allIndices');
        if (data?.data) {
          const sectorIndices = ['NIFTY IT', 'NIFTY BANK', 'NIFTY PHARMA', 'NIFTY AUTO', 'NIFTY METAL', 'NIFTY ENERGY', 'NIFTY FMCG', 'NIFTY REALTY', 'NIFTY INFRA', 'NIFTY MEDIA'];
          const sectors = data.data
            .filter((idx: any) => sectorIndices.includes(idx.index))
            .map((idx: any) => ({
              sector: idx.index.replace('NIFTY ', ''),
              change: idx.percentChange ?? 0,
              changePercent: idx.percentChange ?? 0,
            }));
          if (sectors.length > 0) return sectors;
        }
      } catch { /* fall through */ }

      return [
        { sector: 'IT', change: 1.85, changePercent: 1.85 },
        { sector: 'Banking', change: -0.42, changePercent: -0.42 },
        { sector: 'Pharma', change: 2.15, changePercent: 2.15 },
        { sector: 'Auto', change: 0.73, changePercent: 0.73 },
        { sector: 'Metal', change: -1.28, changePercent: -1.28 },
        { sector: 'Energy', change: 0.56, changePercent: 0.56 },
        { sector: 'FMCG', change: 0.92, changePercent: 0.92 },
        { sector: 'Realty', change: -2.10, changePercent: -2.10 },
      ];
    });
  }

  async getSectorHeatmap() {
    return this.cached('intel:sectors:heatmap', () => [
      { sector: 'IT', change: 1.85, value: 1.85 },
      { sector: 'Banking', change: -0.42, value: 0.42 },
      { sector: 'Pharma', change: 2.15, value: 2.15 },
      { sector: 'Auto', change: 0.73, value: 0.73 },
      { sector: 'Metal', change: -1.28, value: 1.28 },
      { sector: 'Energy', change: 0.56, value: 0.56 },
      { sector: 'FMCG', change: 0.92, value: 0.92 },
      { sector: 'Realty', change: -2.10, value: 2.10 },
      { sector: 'Infrastructure', change: 1.05, value: 1.05 },
      { sector: 'Media', change: -0.35, value: 0.35 },
    ]);
  }

  async getSectorRRG() {
    return this.cached('intel:sectors:rrg', () => []);
  }

  async getSectorRotationAlerts() {
    return this.cached('intel:sectors:rotation', () => []);
  }

  async getGlobalIndices() {
    return this.cached('intel:global:indices', async () => {
      try {
        const data = await nseFetch('https://www.nseindia.com/api/allIndices');
        if (data?.data) {
          const globalNames: Record<string, string> = {
            'S&P BSE SENSEX': 'SENSEX',
            'NIFTY 50': 'NIFTY 50',
          };
          const domestic = data.data
            .filter((idx: any) => ['NIFTY 50', 'NIFTY BANK', 'NIFTY NEXT 50', 'INDIA VIX'].includes(idx.index))
            .map((idx: any) => ({
              name: globalNames[idx.index] ?? idx.index,
              value: idx.last ?? 0,
              change: idx.variation ?? 0,
              changePercent: idx.percentChange ?? 0,
            }));
          if (domestic.length > 0) {
            return [
              ...domestic,
              { name: 'S&P 500', value: 5987.42, change: 0.83, changePercent: 0.83 },
              { name: 'NASDAQ', value: 19234.18, change: 1.12, changePercent: 1.12 },
              { name: 'Dow Jones', value: 43521.67, change: 0.45, changePercent: 0.45 },
              { name: 'Nikkei 225', value: 38956.12, change: -0.31, changePercent: -0.31 },
            ];
          }
        }
      } catch { /* fallback */ }
      return [
        { name: 'S&P 500', value: 5987.42, change: 0.83, changePercent: 0.83 },
        { name: 'NASDAQ', value: 19234.18, change: 1.12, changePercent: 1.12 },
        { name: 'Dow Jones', value: 43521.67, change: 0.45, changePercent: 0.45 },
        { name: 'Nikkei 225', value: 38956.12, change: -0.31, changePercent: -0.31 },
        { name: 'Hang Seng', value: 20145.89, change: 0.67, changePercent: 0.67 },
        { name: 'FTSE 100', value: 8234.56, change: 0.28, changePercent: 0.28 },
        { name: 'DAX', value: 18765.43, change: 0.54, changePercent: 0.54 },
        { name: 'Shanghai', value: 3089.67, change: -0.15, changePercent: -0.15 },
      ];
    });
  }

  async getFXRates() {
    return this.cached('intel:global:fx', () => [
      { pair: 'USD/INR', rate: 83.42, change: -0.12, changePercent: -0.14 },
      { pair: 'EUR/INR', rate: 90.87, change: 0.23, changePercent: 0.25 },
      { pair: 'GBP/INR', rate: 105.63, change: 0.15, changePercent: 0.14 },
      { pair: 'JPY/INR', rate: 0.5567, change: -0.003, changePercent: -0.54 },
    ]);
  }

  async getCommodities() {
    return this.cached('intel:global:commodities', () => [
      { name: 'Gold', price: 2342.50, change: 0.85, changePercent: 0.85, unit: 'USD/oz' },
      { name: 'Crude Oil', price: 78.34, change: -1.23, changePercent: -1.55, unit: 'USD/bbl' },
      { name: 'Silver', price: 27.89, change: 1.42, changePercent: 1.42, unit: 'USD/oz' },
      { name: 'Natural Gas', price: 2.145, change: -2.35, changePercent: -2.35, unit: 'USD/MMBtu' },
    ]);
  }

  async getUSSummary() {
    return this.cached('intel:global:us-summary', () => ({
      marketStatus: 'closed',
      sp500: { value: 0, change: 0 },
      nasdaq: { value: 0, change: 0 },
      vix: { value: 0, change: 0 },
    }));
  }

  async getSGXNifty() {
    return this.cached('intel:global:sgx-nifty', () => ({
      value: 0, change: 0, changePercent: 0, lastUpdated: new Date().toISOString(),
    }));
  }

  async getBlockDeals() {
    return this.cached('intel:block-deals', () => []);
  }

  async getSmartMoney() {
    return this.cached('intel:smart-money', () => []);
  }

  async getInsiderTransactions() {
    return this.cached('intel:insider-txns', () => []);
  }

  async getClusterBuys() {
    return this.cached('intel:cluster-buys', () => []);
  }

  async getInsiderSelling(symbol: string) {
    return this.cached(`intel:insider-selling:${symbol}`, () => ({
      symbol, transactions: [], hasRecentSelling: false,
    }));
  }

  async getEarningsCalendar() {
    return this.cached('intel:earnings-calendar', () => []);
  }

  async getRBIMPC() {
    return this.cached('intel:rbi-mpc', () => ({
      nextDate: '', lastDecision: '', currentRate: 0,
    }));
  }

  async getMacroEvents() {
    return this.cached('intel:macro-events', () => []);
  }

  async getBlackout(symbol: string) {
    return this.cached(`intel:blackout:${symbol}`, () => ({
      symbol, isBlackoutPeriod: false, reason: '',
    }));
  }

  async getEventImpact() {
    return this.cached('intel:event-impact', () => []);
  }

  private async cached<T>(key: string, fallback: () => T | Promise<T>): Promise<T> {
    if (this.cache) {
      const cached = await this.cache.get<T>(key);
      if (cached) return cached;
    }

    const data = await fallback();

    if (this.cache) {
      await this.cache.set(key, data, CACHE_TTL);
    }

    return data;
  }
}
