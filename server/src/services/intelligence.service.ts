import { CacheService } from '../lib/redis.js';
import { getPrisma } from '../lib/prisma.js';
import { createHash, createDecipheriv } from 'crypto';
import https from 'https';
import { env } from '../config.js';
import { engineGreeks, isEngineAvailable } from '../lib/rust-engine.js';

const CACHE_TTL = 120;
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const BREEZE_STOCK_CODES: Record<string, string> = {
  NIFTY: 'NIFTY', BANKNIFTY: 'CNXBAN', FINNIFTY: 'NIFFIN',
  MIDCPNIFTY: 'NIFSEL', NIFTYNXT50: 'NIFNEX', SENSEX: 'SENSEX',
  RELIANCE: 'RELIND', HDFCBANK: 'HDFBAN', ICICIBANK: 'ICIBAN',
  INFY: 'INFTEC', SBIN: 'STABAN', HINDUNILVR: 'HINLEV',
  BHARTIARTL: 'BHAAIR', KOTAKBANK: 'KOTMAH', LT: 'LARTOU',
  AXISBANK: 'AXIBAN', BAJFINANCE: 'BAJFI', HCLTECH: 'HCLTEC',
  TATAMOTORS: 'TATMOT', SUNPHARMA: 'SUNPHA', TITAN: 'TITIND',
  ASIANPAINT: 'ASIPAI', ADANIENT: 'ADAENT', TATASTEEL: 'TATSTE',
  POWERGRID: 'POWGRI', JSWSTEEL: 'JSWSTE', 'M&M': 'MAHMAH',
  BAJAJFINSV: 'BAFINS', ULTRACEMCO: 'ULTCEM', NESTLEIND: 'NESIND',
  DRREDDY: 'DRREDD', DIVISLAB: 'DIVLAB', HEROMOTOCO: 'HERHON',
};

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

async function yahooChart(symbol: string): Promise<{ price: number; prevClose: number; change: number; changePct: number; name: string } | null> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 8000);
    const res = await fetch(
      `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=1d&interval=1d`,
      { headers: { 'User-Agent': UA }, signal: ac.signal },
    );
    clearTimeout(t);
    if (!res.ok) { await drainResponse(res); return null; }
    const json = await res.json();
    const meta = json?.chart?.result?.[0]?.meta;
    if (!meta) return null;
    const price = meta.regularMarketPrice ?? 0;
    const prevClose = meta.chartPreviousClose ?? meta.previousClose ?? price;
    const change = price - prevClose;
    const changePct = prevClose > 0 ? (change / prevClose) * 100 : 0;
    return { price, prevClose, change, changePct, name: meta.longName ?? meta.shortName ?? meta.symbol ?? symbol };
  } catch {
    return null;
  }
}

async function yahooChartBatch(symbols: string[]): Promise<Map<string, { price: number; prevClose: number; change: number; changePct: number; name: string }>> {
  const results = new Map<string, { price: number; prevClose: number; change: number; changePct: number; name: string }>();
  const chunks: string[][] = [];
  for (let i = 0; i < symbols.length; i += 5) {
    chunks.push(symbols.slice(i, i + 5));
  }
  for (const chunk of chunks) {
    const batch = await Promise.all(chunk.map(s => yahooChart(s)));
    for (let i = 0; i < chunk.length; i++) {
      if (batch[i]) results.set(chunk[i], batch[i]!);
    }
  }
  return results;
}

async function niftyTraderFiiDii(): Promise<any> {
  try {
    const ac = new AbortController();
    const t = setTimeout(() => ac.abort(), 10000);
    const res = await fetch('https://webapi.niftytrader.in/webapi/Resource/fii-dii-activity-data', {
      headers: { 'User-Agent': UA, 'Accept': 'application/json' },
      signal: ac.signal,
    });
    clearTimeout(t);
    if (!res.ok) return null;
    const json = await res.json();
    if (json?.result === 1 && json?.resultData?.fii_dii_data) {
      return json.resultData.fii_dii_data;
    }
    return null;
  } catch {
    return null;
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

  // ── FII / DII (NiftyTrader API — primary) ──

  async getFIIDII() {
    return this.cached('intel:fii-dii', async () => {
      // Primary: NiftyTrader API (reliable, returns recent data)
      try {
        const rows = await niftyTraderFiiDii();
        if (rows && rows.length > 0) {
          const latest = rows[0];
          return {
            date: latest.created_at?.split('T')[0] ?? new Date().toISOString().split('T')[0],
            fiiNet: latest.fii_net_value ?? 0,
            diiNet: latest.dii_net_value ?? 0,
            fiiBuy: latest.fii_buy_value ?? 0,
            fiiSell: latest.fii_sell_value ?? 0,
            diiBuy: latest.dii_buy_value ?? 0,
            diiSell: latest.dii_sell_value ?? 0,
            niftyPrice: latest.last_trade_price ?? 0,
            niftyChange: latest.change_value ?? 0,
            niftyChangePct: latest.change_per ?? 0,
            source: 'niftytrader',
          };
        }
      } catch { /* fall through */ }

      // Fallback: NSE
      try {
        const data = await nseFetch('https://www.nseindia.com/api/fiidiiTradeReact');
        if (data && Array.isArray(data)) {
          const fii = data.find((d: any) => d.category === 'FII/FPI *');
          const dii = data.find((d: any) => d.category === 'DII *');
          if (fii || dii) {
            return {
              date: fii?.date || new Date().toISOString().split('T')[0],
              fiiNet: parseFloat(fii?.netValue ?? '0') * 100,
              diiNet: parseFloat(dii?.netValue ?? '0') * 100,
              fiiBuy: parseFloat(fii?.buyValue ?? '0') * 100,
              fiiSell: parseFloat(fii?.sellValue ?? '0') * 100,
              diiBuy: parseFloat(dii?.buyValue ?? '0') * 100,
              diiSell: parseFloat(dii?.sellValue ?? '0') * 100,
              source: 'nse',
            };
          }
        }
      } catch { /* fall through */ }

      return {
        date: new Date().toISOString().split('T')[0],
        fiiNet: 0, diiNet: 0,
        fiiBuy: 0, fiiSell: 0,
        diiBuy: 0, diiSell: 0,
        message: 'FII/DII data temporarily unavailable.',
      };
    });
  }

  async getFIIDIITrend(days = 30) {
    return this.cached(`intel:fii-dii-trend:${days}`, async () => {
      // NiftyTrader returns ~30 days of historical FII/DII data
      try {
        const rows = await niftyTraderFiiDii();
        if (rows && rows.length > 0) {
          return rows.slice(0, days).reverse().map((r: any) => ({
            date: r.created_at?.split('T')[0] ?? '',
            fiiNet: r.fii_net_value ?? 0,
            diiNet: r.dii_net_value ?? 0,
            niftyPrice: r.last_trade_price ?? 0,
            niftyChange: r.change_per ?? 0,
          }));
        }
      } catch { /* fallback */ }
      return [];
    });
  }

  // ── Options ──

  async getPCR(symbol: string) {
    return this.cached(`intel:pcr:${symbol}`, async () => {
      try {
        const chain = await this.fetchOptionsChainDeduped(symbol);
        if (chain && chain.strikes?.length > 0) {
          const pcr = chain.pcr ?? 0;
          let interpretation = 'Neutral';
          if (pcr > 1.3) interpretation = 'Bullish';
          else if (pcr > 1.0) interpretation = 'Moderately Bullish';
          else if (pcr < 0.7) interpretation = 'Bearish';
          else if (pcr < 1.0) interpretation = 'Moderately Bearish';
          return { symbol, pcr, interpretation };
        }
      } catch { /* fallback */ }
      return { symbol, pcr: 0, interpretation: 'Data unavailable — configure Breeze API in Settings' };
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
      return { symbol, strikes: [], message: 'Options data unavailable — configure Breeze API in Settings' };
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
          const spot = chain.spotPrice ?? chain.underlyingValue ?? 0;
          const strikes = chain.strikes as any[];

          // Collect IV from both call and put sides, using max(callIV, putIV) per strike
          const ivs = strikes
            .map((s: any) => {
              const civ = s.callIV ?? 0;
              const piv = s.putIV ?? 0;
              return Math.max(civ, piv);
            })
            .filter((iv: number) => iv > 0);

          if (ivs.length > 0) {
            // ATM IV: find the strike closest to spot, else use median
            let currentIV: number;
            if (spot > 0) {
              const atm = strikes.reduce((best: any, s: any) =>
                Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best
              , strikes[0]);
              currentIV = Math.max(atm.callIV ?? 0, atm.putIV ?? 0) || ivs[Math.floor(ivs.length / 2)];
            } else {
              currentIV = ivs[Math.floor(ivs.length / 2)];
            }

            const sorted = [...ivs].sort((a, b) => a - b);
            const rank = sorted.filter(v => v < currentIV).length;
            const ivPercentile = Math.round((rank / sorted.length) * 100);
            return { symbol, currentIV: Math.round(currentIV * 100) / 100, ivPercentile, ivRank: ivPercentile };
          }
        }
      } catch { /* fallback */ }
      return { symbol, currentIV: 0, ivPercentile: 0, ivRank: 0, message: 'Data unavailable' };
    });
  }

  // ── Sectors ──

  async getSectorPerformance() {
    return this.cached('intel:sectors:perf', async () => {
      try {
        const data = await nseFetch('https://www.nseindia.com/api/allIndices');
        if (data?.data) {
          const sectorIndices = [
            'NIFTY IT', 'NIFTY BANK', 'NIFTY PHARMA', 'NIFTY AUTO', 'NIFTY METAL',
            'NIFTY ENERGY', 'NIFTY FMCG', 'NIFTY REALTY', 'NIFTY INFRA', 'NIFTY MEDIA',
            'NIFTY PSU BANK', 'NIFTY FIN SERVICE', 'NIFTY HEALTHCARE', 'NIFTY CONSUMER DURABLES',
          ];
          const sectors = data.data
            .filter((idx: any) => sectorIndices.includes(idx.index))
            .map((idx: any) => ({
              sector: idx.index.replace('NIFTY ', ''),
              value: idx.last ?? 0,
              change: idx.percentChange ?? 0,
              changePercent: idx.percentChange ?? 0,
              advances: idx.advances ?? 0,
              declines: idx.declines ?? 0,
            }))
            .sort((a: any, b: any) => b.change - a.change);
          if (sectors.length > 0) return sectors;
        }
      } catch { /* fall through */ }

      // Yahoo v8 chart fallback for Indian sectors
      try {
        const sectorSymbols = [
          { sym: '^CNXIT', name: 'IT' }, { sym: '^NSEBANK', name: 'Banking' },
          { sym: '^CNXPHARMA', name: 'Pharma' }, { sym: '^CNXAUTO', name: 'Auto' },
          { sym: '^CNXMETAL', name: 'Metal' }, { sym: '^CNXENERGY', name: 'Energy' },
          { sym: '^CNXFMCG', name: 'FMCG' }, { sym: '^CNXREALTY', name: 'Realty' },
        ];
        const dataMap = await yahooChartBatch(sectorSymbols.map(s => s.sym));
        if (dataMap.size > 0) {
          return sectorSymbols.map(s => {
            const d = dataMap.get(s.sym);
            return {
              sector: s.name,
              value: d?.price ?? 0,
              change: d?.changePct ?? 0,
              changePercent: d?.changePct ?? 0,
            };
          }).filter(s => s.value > 0).sort((a, b) => b.change - a.change);
        }
      } catch { /* fallback */ }

      return [];
    });
  }

  async getSectorHeatmap() {
    return this.cached('intel:sectors:heatmap', async () => {
      const perf = await this.getSectorPerformance();
      if (Array.isArray(perf) && perf.length > 0) {
        return perf.map((s: any) => ({
          sector: s.sector ?? s.name,
          change: s.change ?? s.changePercent ?? 0,
          value: Math.abs(s.change ?? s.changePercent ?? 0),
        }));
      }
      return [];
    });
  }

  async getSectorRRG() {
    return this.cached('intel:sectors:rrg', async () => {
      const sectorIndices: Array<{ name: string; symbol: string; sector: string }> = [
        { name: 'Nifty Bank', symbol: '^NSEBANK', sector: 'Banking' },
        { name: 'Nifty IT', symbol: '^CNXIT', sector: 'IT' },
        { name: 'Nifty Pharma', symbol: '^CNXPHARMA', sector: 'Pharma' },
        { name: 'Nifty Auto', symbol: '^CNXAUTO', sector: 'Auto' },
        { name: 'Nifty Metal', symbol: '^CNXMETAL', sector: 'Metals' },
        { name: 'Nifty FMCG', symbol: '^CNXFMCG', sector: 'FMCG' },
        { name: 'Nifty Energy', symbol: '^CNXENERGY', sector: 'Energy' },
        { name: 'Nifty Realty', symbol: '^CNXREALTY', sector: 'Realty' },
        { name: 'Nifty Media', symbol: '^CNXMEDIA', sector: 'Media' },
        { name: 'Nifty PSU Bank', symbol: '^CNXPSUBANK', sector: 'PSU Banking' },
      ];

      const results: Array<{
        sector: string; rsRatio: number; rsMomentum: number;
        quadrant: 'Leading' | 'Weakening' | 'Lagging' | 'Improving';
      }> = [];

      for (const si of sectorIndices) {
        try {
          const url = `https://query1.finance.yahoo.com/v8/finance/chart/${si.symbol}?interval=1wk&range=3mo`;
          const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: AbortSignal.timeout(5000) });
          if (!res.ok) continue;
          const json = await res.json() as any;
          const closes = json?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];
          const validCloses = closes.filter((c: any) => c !== null && c > 0);

          if (validCloses.length < 4) continue;

          const n = validCloses.length;
          const current = validCloses[n - 1];
          const prev1 = validCloses[n - 2];
          const prev4 = validCloses[Math.max(0, n - 4)];

          const rsRatio = Number(((current / prev4) * 100).toFixed(2));
          const rsMomentum = Number(((current / prev1 - 1) * 100).toFixed(2));

          let quadrant: 'Leading' | 'Weakening' | 'Lagging' | 'Improving';
          if (rsRatio > 100 && rsMomentum > 0) quadrant = 'Leading';
          else if (rsRatio > 100 && rsMomentum <= 0) quadrant = 'Weakening';
          else if (rsRatio <= 100 && rsMomentum <= 0) quadrant = 'Lagging';
          else quadrant = 'Improving';

          results.push({ sector: si.sector, rsRatio, rsMomentum, quadrant });
        } catch { /* skip sector */ }
      }

      return results;
    });
  }

  async getSectorRotationAlerts() {
    return this.cached('intel:sectors:rotation', async () => {
      const rrg = await this.getSectorRRG();
      const alerts: Array<{ sector: string; alert: string; severity: string }> = [];

      for (const item of rrg) {
        if (item.quadrant === 'Leading' && item.rsMomentum > 1.5) {
          alerts.push({ sector: item.sector, alert: `${item.sector} showing strong leadership momentum`, severity: 'positive' });
        } else if (item.quadrant === 'Weakening' && item.rsMomentum < -1) {
          alerts.push({ sector: item.sector, alert: `${item.sector} losing momentum — consider reducing exposure`, severity: 'warning' });
        } else if (item.quadrant === 'Improving' && item.rsMomentum > 1) {
          alerts.push({ sector: item.sector, alert: `${item.sector} entering improving phase — potential opportunity`, severity: 'info' });
        } else if (item.quadrant === 'Lagging' && item.rsMomentum < -2) {
          alerts.push({ sector: item.sector, alert: `${item.sector} deeply lagging — avoid`, severity: 'danger' });
        }
      }

      return alerts;
    });
  }

  // ── Global Markets (Yahoo Finance v8 Chart API) ──

  async getGlobalIndices() {
    return this.cached('intel:global:indices', async () => {
      const indexList: { symbol: string; label: string; region: string }[] = [
        // India
        { symbol: '^NSEI', label: 'NIFTY 50', region: 'India' },
        { symbol: '^BSESN', label: 'SENSEX', region: 'India' },
        { symbol: '^NSEBANK', label: 'BANK NIFTY', region: 'India' },
        // US
        { symbol: '^GSPC', label: 'S&P 500', region: 'US' },
        { symbol: '^IXIC', label: 'NASDAQ', region: 'US' },
        { symbol: '^DJI', label: 'Dow Jones', region: 'US' },
        { symbol: '^RUT', label: 'Russell 2000', region: 'US' },
        { symbol: '^VIX', label: 'VIX (Fear Index)', region: 'US' },
        // UK
        { symbol: '^FTSE', label: 'FTSE 100', region: 'UK' },
        // Europe
        { symbol: '^GDAXI', label: 'DAX (Germany)', region: 'Europe' },
        { symbol: '^FCHI', label: 'CAC 40 (France)', region: 'Europe' },
        { symbol: '^STOXX50E', label: 'Euro Stoxx 50', region: 'Europe' },
        // Japan
        { symbol: '^N225', label: 'Nikkei 225', region: 'Japan' },
        // China
        { symbol: '000001.SS', label: 'Shanghai Composite', region: 'China' },
        { symbol: '^HSI', label: 'Hang Seng', region: 'China/HK' },
        { symbol: '399001.SZ', label: 'Shenzhen Component', region: 'China' },
        // Australia
        { symbol: '^AXJO', label: 'ASX 200', region: 'Australia' },
        // South Korea
        { symbol: '^KS11', label: 'KOSPI', region: 'South Korea' },
        // Singapore
        { symbol: '^STI', label: 'Straits Times', region: 'Singapore' },
      ];

      const symbols = indexList.map(i => i.symbol);
      const dataMap = await yahooChartBatch(symbols);
      const results: any[] = [];
      for (const idx of indexList) {
        const d = dataMap.get(idx.symbol);
        if (d && d.price > 0) {
          results.push({
            name: idx.label,
            region: idx.region,
            value: d.price,
            change: d.change,
            changePercent: d.changePct,
          });
        }
      }
      return results;
    });
  }

  async getFXRates() {
    return this.cached('intel:global:fx', async () => {
      const pairList: { symbol: string; label: string }[] = [
        { symbol: 'USDINR=X', label: 'USD/INR' },
        { symbol: 'EURINR=X', label: 'EUR/INR' },
        { symbol: 'GBPINR=X', label: 'GBP/INR' },
        { symbol: 'JPYINR=X', label: 'JPY/INR' },
        { symbol: 'EURUSD=X', label: 'EUR/USD' },
        { symbol: 'GBPUSD=X', label: 'GBP/USD' },
        { symbol: 'AUDUSD=X', label: 'AUD/USD' },
        { symbol: 'USDJPY=X', label: 'USD/JPY' },
        { symbol: 'USDCNY=X', label: 'USD/CNY' },
      ];
      const dataMap = await yahooChartBatch(pairList.map(p => p.symbol));
      const results: any[] = [];
      for (const p of pairList) {
        const d = dataMap.get(p.symbol);
        if (d && d.price > 0) {
          results.push({ pair: p.label, rate: d.price, change: d.change, changePercent: d.changePct });
        }
      }
      return results;
    });
  }

  async getCommodities() {
    return this.cached('intel:global:commodities', async () => {
      const commodityList: { symbol: string; label: string; unit: string }[] = [
        { symbol: 'GC=F', label: 'Gold', unit: 'USD/oz' },
        { symbol: 'SI=F', label: 'Silver', unit: 'USD/oz' },
        { symbol: 'CL=F', label: 'Crude Oil (WTI)', unit: 'USD/bbl' },
        { symbol: 'BZ=F', label: 'Brent Crude', unit: 'USD/bbl' },
        { symbol: 'NG=F', label: 'Natural Gas', unit: 'USD/MMBtu' },
        { symbol: 'HG=F', label: 'Copper', unit: 'USD/lb' },
      ];
      const dataMap = await yahooChartBatch(commodityList.map(c => c.symbol));
      const results: any[] = [];
      for (const c of commodityList) {
        const d = dataMap.get(c.symbol);
        if (d && d.price > 0) {
          results.push({ name: c.label, price: d.price, change: d.change, changePercent: d.changePct, unit: c.unit });
        }
      }
      return results;
    });
  }

  async getUSSummary() {
    return this.cached('intel:global:us-summary', async () => {
      const dataMap = await yahooChartBatch(['^GSPC', '^IXIC', '^VIX']);
      const sp500 = dataMap.get('^GSPC');
      const nasdaq = dataMap.get('^IXIC');
      const vix = dataMap.get('^VIX');
      return {
        marketStatus: 'unknown',
        sp500: { value: sp500?.price ?? 0, change: sp500?.changePct ?? 0 },
        nasdaq: { value: nasdaq?.price ?? 0, change: nasdaq?.changePct ?? 0 },
        vix: { value: vix?.price ?? 0, change: vix?.changePct ?? 0 },
      };
    });
  }

  async getSGXNifty() {
    return this.cached('intel:global:sgx-nifty', async () => {
      const d = await yahooChart('^NSEI');
      return {
        value: d?.price ?? 0, change: d?.change ?? 0, changePercent: d?.changePct ?? 0,
        lastUpdated: new Date().toISOString(),
      };
    });
  }

  // ── Earnings & Events ──

  async getEarningsCalendar() {
    return this.cached('intel:earnings-calendar', async () => {
      // Use NSE corporate actions / board meetings as proxy
      try {
        const data = await nseFetch('https://www.nseindia.com/api/corporate-announcements?index=equities&from_date=&to_date=');
        if (data && Array.isArray(data)) {
          return data
            .filter((a: any) => a.desc?.toLowerCase().includes('financial result') || a.desc?.toLowerCase().includes('board meeting'))
            .slice(0, 25)
            .map((a: any) => ({
              symbol: a.symbol ?? '',
              company: a.company ?? a.symbol ?? '',
              date: a.an_dt ?? a.date ?? '',
              quarter: '',
              description: a.desc ?? '',
            }));
        }
      } catch { /* fallback */ }
      return [];
    });
  }

  async getRBIMPC() {
    return this.cached('intel:rbi-mpc', () => ({
      nextDate: '2026-04-07',
      lastDecision: 'Repo rate held at 6.50%',
      currentRate: 6.50,
    }));
  }

  async getMacroEvents() {
    return this.cached('intel:macro-events', async () => {
      // Static curated list of upcoming key events
      const now = new Date();
      const events = [
        { event: 'RBI MPC Decision', date: '2026-04-07', country: 'India', impact: 'high' },
        { event: 'US Fed FOMC Meeting', date: '2026-03-18', country: 'US', impact: 'high' },
        { event: 'India GDP Q3 Data', date: '2026-03-28', country: 'India', impact: 'high' },
        { event: 'US CPI Data', date: '2026-03-12', country: 'US', impact: 'high' },
        { event: 'India IIP Data', date: '2026-03-12', country: 'India', impact: 'medium' },
        { event: 'US Non-Farm Payrolls', date: '2026-03-07', country: 'US', impact: 'high' },
        { event: 'India WPI Inflation', date: '2026-03-14', country: 'India', impact: 'medium' },
        { event: 'ECB Rate Decision', date: '2026-04-17', country: 'EU', impact: 'medium' },
        { event: 'India CPI Inflation', date: '2026-03-12', country: 'India', impact: 'high' },
        { event: 'US PPI Data', date: '2026-03-13', country: 'US', impact: 'medium' },
        { event: 'India Trade Balance', date: '2026-03-15', country: 'India', impact: 'medium' },
        { event: 'Bank of Japan Decision', date: '2026-03-14', country: 'Japan', impact: 'medium' },
      ];
      return events
        .filter(e => new Date(e.date) >= new Date(now.getTime() - 2 * 86_400_000))
        .sort((a, b) => new Date(a.date).getTime() - new Date(b.date).getTime());
    });
  }

  async getBlackout(symbol: string) {
    return this.cached(`intel:blackout:${symbol}`, () => ({
      symbol, isBlackoutPeriod: false, reason: '',
    }));
  }

  async getEventImpact() {
    return this.cached('intel:event-impact', async () => {
      const events: Array<{
        event: string; date: string; expectedImpact: string;
        affectedSectors: string[]; historicalMoveAvg: number;
      }> = [];

      try {
        const data = await nseFetch('https://www.nseindia.com/api/event-calendar');
        if (Array.isArray(data)) {
          for (const e of data.slice(0, 15)) {
            const desc = (e.bm_desc ?? e.purpose ?? '').toLowerCase();
            let expectedImpact = 'low';
            let affectedSectors: string[] = [];
            let historicalMoveAvg = 0.5;

            if (desc.includes('rbi') || desc.includes('policy') || desc.includes('rate')) {
              expectedImpact = 'high'; affectedSectors = ['Banking', 'Finance', 'Realty']; historicalMoveAvg = 1.5;
            } else if (desc.includes('budget') || desc.includes('fiscal')) {
              expectedImpact = 'very_high'; affectedSectors = ['All']; historicalMoveAvg = 2.5;
            } else if (desc.includes('result') || desc.includes('earnings') || desc.includes('dividend')) {
              expectedImpact = 'medium'; affectedSectors = [e.symbol ?? 'Company-specific']; historicalMoveAvg = 1.0;
            } else if (desc.includes('agm') || desc.includes('meeting')) {
              expectedImpact = 'low'; affectedSectors = [e.symbol ?? 'Company-specific']; historicalMoveAvg = 0.3;
            }

            events.push({
              event: e.bm_desc ?? e.purpose ?? 'Unknown event',
              date: e.bm_date ?? e.date ?? '',
              expectedImpact,
              affectedSectors,
              historicalMoveAvg,
            });
          }
        }
      } catch { /* fallback to empty */ }

      return events;
    });
  }

  // ── Block Deals / Insider ──

  async getBlockDeals() {
    return this.cached('intel:block-deals', async () => {
      try {
        const data = await nseFetch('https://www.nseindia.com/api/block-deal');
        if (data?.data && Array.isArray(data.data)) {
          return data.data.slice(0, 20).map((d: any) => ({
            symbol: d.symbol ?? '',
            clientName: d.clientName ?? '',
            buyOrSell: d.buySell ?? '',
            qty: d.quantity ?? 0,
            price: d.tradedPrice ?? 0,
            date: d.dealDate ?? '',
          }));
        }
      } catch { /* fallback */ }
      return [];
    });
  }

  async getSmartMoney() {
    return this.cached('intel:smart-money', async () => {
      const blockDeals = await this.getBlockDeals();
      if (!Array.isArray(blockDeals) || blockDeals.length === 0) return [];

      // Aggregate block deal data to identify smart money flow
      const symbolAgg = new Map<string, { totalBuyValue: number; totalSellValue: number; buyers: string[]; sellers: string[] }>();

      for (const deal of blockDeals) {
        if (!deal.symbol) continue;
        const entry = symbolAgg.get(deal.symbol) ?? { totalBuyValue: 0, totalSellValue: 0, buyers: [], sellers: [] };

        const value = (deal.qty ?? 0) * (deal.price ?? 0);
        if (deal.buyOrSell === 'Buy' || deal.buyOrSell === 'B') {
          entry.totalBuyValue += value;
          if (deal.clientName) entry.buyers.push(deal.clientName);
        } else {
          entry.totalSellValue += value;
          if (deal.clientName) entry.sellers.push(deal.clientName);
        }
        symbolAgg.set(deal.symbol, entry);
      }

      return [...symbolAgg.entries()]
        .map(([symbol, data]) => ({
          symbol,
          netFlow: Number((data.totalBuyValue - data.totalSellValue).toFixed(0)),
          direction: data.totalBuyValue > data.totalSellValue ? 'ACCUMULATION' : 'DISTRIBUTION',
          buyValue: Number(data.totalBuyValue.toFixed(0)),
          sellValue: Number(data.totalSellValue.toFixed(0)),
          topBuyers: data.buyers.slice(0, 3),
          topSellers: data.sellers.slice(0, 3),
        }))
        .sort((a, b) => Math.abs(b.netFlow) - Math.abs(a.netFlow))
        .slice(0, 20);
    });
  }

  async getInsiderTransactions() {
    return this.cached('intel:insider-txns', async () => {
      try {
        const data = await nseFetch('https://www.nseindia.com/api/corporates-pit');
        if (data?.data && Array.isArray(data.data)) {
          return data.data.slice(0, 30).map((t: any) => ({
            symbol: t.symbol ?? '',
            personName: t.acqName ?? t.personName ?? '',
            category: t.personCategory ?? t.category ?? '',
            transactionType: t.tdpTransactionType ?? t.transactionType ?? '',
            qty: Number(t.securitiesValue ?? t.noOfSecurities ?? 0),
            value: Number(t.securitiesValue ?? 0),
            date: t.acquisitionFromDate ?? t.date ?? '',
            mode: t.acquisitionMode ?? '',
          }));
        }
      } catch { /* fallback */ }
      return [];
    });
  }

  async getClusterBuys() {
    return this.cached('intel:cluster-buys', async () => {
      const insiderTxns = await this.getInsiderTransactions();
      if (!Array.isArray(insiderTxns) || insiderTxns.length === 0) return [];

      // Group by symbol and find cluster patterns (multiple insiders buying)
      const symbolBuys = new Map<string, { count: number; totalValue: number; persons: string[] }>();

      for (const txn of insiderTxns) {
        if (txn.transactionType?.toLowerCase().includes('buy') || txn.transactionType === 'Acquisition') {
          const entry = symbolBuys.get(txn.symbol) ?? { count: 0, totalValue: 0, persons: [] };
          entry.count++;
          entry.totalValue += txn.value;
          if (txn.personName && !entry.persons.includes(txn.personName)) {
            entry.persons.push(txn.personName);
          }
          symbolBuys.set(txn.symbol, entry);
        }
      }

      return [...symbolBuys.entries()]
        .filter(([, data]) => data.count >= 2)
        .map(([symbol, data]) => ({
          symbol,
          insiderBuyCount: data.count,
          totalValue: Number(data.totalValue.toFixed(0)),
          insiders: data.persons.slice(0, 5),
          signal: data.count >= 3 ? 'STRONG_CLUSTER' : 'CLUSTER',
        }))
        .sort((a, b) => b.insiderBuyCount - a.insiderBuyCount)
        .slice(0, 15);
    });
  }

  async getInsiderSelling(symbol: string) {
    return this.cached(`intel:insider-selling:${symbol}`, async () => {
      const allTxns = await this.getInsiderTransactions();
      const symbolTxns = Array.isArray(allTxns) ? allTxns.filter((t: any) => t.symbol === symbol) : [];
      const sellingTxns = symbolTxns.filter((t: any) =>
        t.transactionType?.toLowerCase().includes('sell') || t.transactionType === 'Disposal'
      );

      return {
        symbol,
        transactions: sellingTxns.slice(0, 10),
        hasRecentSelling: sellingTxns.length > 0,
        totalSellValue: sellingTxns.reduce((s: number, t: any) => s + (t.value ?? 0), 0),
      };
    });
  }

  // ── Options Chain ──

  private async getBreezeCredentials(): Promise<{ apiKey: string; secretKey: string; sessionToken: string } | null> {
    try {
      const prisma = getPrisma();
      const credential = await prisma.breezeCredential.findFirst({
        where: { sessionToken: { not: null } },
        orderBy: { updatedAt: 'desc' },
      });
      if (!credential?.sessionToken) return null;
      if (credential.sessionExpiresAt && new Date(credential.sessionExpiresAt) < new Date()) return null;

      const key = createHash('sha256').update(env.ENCRYPTION_KEY).digest();
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

    const today = new Date();
    const dayOfWeek = today.getDay();
    // NSE weekly expiry moved to Tuesday (effective Sep 2025)
    const daysUntilTuesday = (2 - dayOfWeek + 7) % 7 || 7;
    const nextTuesday = new Date(today);
    nextTuesday.setDate(today.getDate() + (dayOfWeek <= 2 ? (2 - dayOfWeek) : daysUntilTuesday));
    const expiryDate = nextTuesday.toISOString().split('T')[0] + 'T06:00:00.000Z';

    const breezeCode = BREEZE_STOCK_CODES[symbol.toUpperCase()] ?? symbol.toUpperCase();

    const payload = JSON.stringify({
      stock_code: breezeCode,
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

    const putPayload = JSON.stringify({
      stock_code: breezeCode,
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

    const strikeMap = new Map<number, any>();
    for (const rec of callRecords) {
      const strike = Number(rec.strike_price);
      if (!strike) continue;
      strikeMap.set(strike, {
        strike, callOI: Number(rec.open_interest ?? 0), callOIChange: Number(rec.change_oi ?? 0),
        callLTP: Number(rec.ltp ?? 0), callIV: Number(rec.implied_volatility ?? 0),
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
    // Primary: Python Breeze Bridge (correct symbol mapping, IV computation, Greeks)
    try {
      const bridgeUrl = `${env.BREEZE_BRIDGE_URL}/option-chain/${encodeURIComponent(symbol.toUpperCase())}`;
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 20_000);
      const res = await fetch(bridgeUrl, { signal: ac.signal });
      clearTimeout(timer);
      if (res.ok) {
        const data = await res.json() as any;
        if (data && !data.error && data.strikes?.length > 0) {
          console.log(`[Intelligence] ${symbol} chain → Breeze Bridge (${data.strikes.length} strikes)`);
          return data;
        }
      }
    } catch (err) {
      console.warn(`[Intelligence] ${symbol} Bridge chain error: ${(err as Error)?.message}`);
    }

    // Fallback: direct Breeze REST API (legacy path)
    try {
      const breezeResult = await this.fetchOptionsChainFromBreeze(symbol);
      if (breezeResult) return breezeResult;
    } catch { /* fall through */ }

    return null;
  }

  // ── Greeks (uses Rust engine or JS fallback) ──

  private jsBlackScholes(s: number, k: number, t: number, r: number, sigma: number, isCall: boolean) {
    if (t <= 0) {
      const intrinsic = isCall ? Math.max(s - k, 0) : Math.max(k - s, 0);
      return { price: intrinsic, delta: isCall ? (s > k ? 1 : 0) : (s < k ? -1 : 0), gamma: 0, theta: 0, vega: 0, rho: 0 };
    }
    const d1 = (Math.log(s / k) + (r + sigma * sigma / 2) * t) / (sigma * Math.sqrt(t));
    const d2 = d1 - sigma * Math.sqrt(t);
    const nd1 = this.normCdf(d1);
    const nd2 = this.normCdf(d2);
    const nd1n = this.normCdf(-d1);
    const nd2n = this.normCdf(-d2);
    const pdfD1 = Math.exp(-d1 * d1 / 2) / Math.sqrt(2 * Math.PI);
    const ert = Math.exp(-r * t);

    const price = isCall ? s * nd1 - k * ert * nd2 : k * ert * nd2n - s * nd1n;
    const delta = isCall ? nd1 : nd1 - 1;
    const gamma = pdfD1 / (s * sigma * Math.sqrt(t));
    const theta = isCall
      ? (-(s * pdfD1 * sigma) / (2 * Math.sqrt(t)) - r * k * ert * nd2) / 365
      : (-(s * pdfD1 * sigma) / (2 * Math.sqrt(t)) + r * k * ert * nd2n) / 365;
    const vega = s * pdfD1 * Math.sqrt(t) / 100;
    const rho = isCall ? k * t * ert * nd2 / 100 : -k * t * ert * nd2n / 100;
    return { price, delta, gamma, theta, vega, rho };
  }

  private normCdf(x: number): number {
    const t = 1 / (1 + 0.3275911 * Math.abs(x));
    const poly = t * (0.254829592 + t * (-0.284496736 + t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
    const result = 1 - poly * Math.exp(-x * x);
    return x >= 0 ? result : 1 - result;
  }

  async getGreeks(symbol: string) {
    return this.cached(`intel:greeks:${symbol}`, async () => {
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

        let callResult: any, putResult: any;
        const useRust = isEngineAvailable();

        if (useRust) {
          callResult = await engineGreeks({ spot, strike, time_to_expiry: timeToExpiry, risk_free_rate: 0.065, volatility: iv, option_type: 'call' });
          putResult = await engineGreeks({ spot, strike, time_to_expiry: timeToExpiry, risk_free_rate: 0.065, volatility: iv, option_type: 'put' });
        } else {
          const callBS = this.jsBlackScholes(spot, strike, timeToExpiry, 0.065, iv, true);
          callResult = { ...callBS, implied_volatility: iv, price: Math.round(callBS.price * 100) / 100 };
          const putBS = this.jsBlackScholes(spot, strike, timeToExpiry, 0.065, iv, false);
          putResult = { ...putBS, implied_volatility: iv, price: Math.round(putBS.price * 100) / 100 };
        }

        return {
          symbol, atmStrike: strike,
          call: { price: callResult.price, delta: callResult.delta, gamma: callResult.gamma, theta: callResult.theta, vega: callResult.vega, rho: callResult.rho, iv: callResult.implied_volatility },
          put: { price: putResult.price, delta: putResult.delta, gamma: putResult.gamma, theta: putResult.theta, vega: putResult.vega, rho: putResult.rho, iv: putResult.implied_volatility },
          delta: callResult.delta, gamma: callResult.gamma, theta: callResult.theta, vega: callResult.vega, rho: callResult.rho, price: callResult.price,
          source: useRust ? 'rust-engine' : 'js-fallback',
        };
      } catch {
        return { symbol, delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, price: 0, source: 'error' };
      }
    });
  }

  // ── Cache helper ──

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
