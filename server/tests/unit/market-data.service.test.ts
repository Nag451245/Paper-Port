import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { MarketDataService } from '../../src/services/market-data.service.js';
import { CacheService } from '../../src/lib/redis.js';

function createMockCache() {
  return {
    get: vi.fn(),
    set: vi.fn(),
    del: vi.fn(),
    exists: vi.fn(),
    ttl: vi.fn(),
  } as unknown as CacheService;
}

describe('MarketDataService', () => {
  let service: MarketDataService;
  let mockCache: CacheService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    mockCache = createMockCache();
    service = new MarketDataService(mockCache);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('search', () => {
    it('should return matching stocks from the popular list', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      (mockCache.set as any).mockResolvedValue(undefined);

      const results = await service.search('reli');

      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('RELIANCE');
      expect(results[0].name).toBe('Reliance Industries Ltd');
      expect(results[0].exchange).toBe('NSE');
    });

    it('should return multiple matches', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      (mockCache.set as any).mockResolvedValue(undefined);

      const results = await service.search('tata');

      expect(results.length).toBeGreaterThanOrEqual(2);
      const symbols = results.map((r: any) => r.symbol);
      expect(symbols).toContain('TATAMOTORS');
      expect(symbols).toContain('TATASTEEL');
    });

    it('should return empty for no match', async () => {
      (mockCache.get as any).mockResolvedValue(null);

      const results = await service.search('xyznonexistent');

      expect(results).toHaveLength(0);
    });

    it('should return empty for empty query', async () => {
      const results = await service.search('');
      expect(results).toHaveLength(0);
    });

    it('should use cached results when available', async () => {
      const cached = [{ symbol: 'CACHED', name: 'Cached Stock' }];
      (mockCache.get as any).mockResolvedValue(cached);

      const results = await service.search('cached');

      expect(results).toEqual(cached);
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it('should limit results', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      (mockCache.set as any).mockResolvedValue(undefined);

      const results = await service.search('a', 3);

      expect(results.length).toBeLessThanOrEqual(3);
    });

    it('should be case-insensitive', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      (mockCache.set as any).mockResolvedValue(undefined);

      const results = await service.search('INFY');

      expect(results).toHaveLength(1);
      expect(results[0].symbol).toBe('INFY');
    });
  });

  describe('getQuote', () => {
    it('should return cached quote if available', async () => {
      const cachedQuote = { symbol: 'RELIANCE', ltp: 2500 };
      (mockCache.get as any).mockResolvedValue(cachedQuote);

      const result = await service.getQuote('RELIANCE');

      expect(result).toEqual(cachedQuote);
    });

    it('should return empty quote when NSE API fails', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await service.getQuote('RELIANCE');

      expect(result.symbol).toBe('RELIANCE');
      expect(result.ltp).toBe(0);
    });

    it('should fetch from NSE and cache result', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      (mockCache.set as any).mockResolvedValue(undefined);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            info: { symbol: 'RELIANCE' },
            priceInfo: {
              lastPrice: 2550,
              change: 25,
              pChange: 0.99,
              open: 2530,
              previousClose: 2525,
              intraDayHighLow: { max: 2560, min: 2520 },
            },
            securityWiseDP: { quantityTraded: 5000000 },
          }),
      } as any);

      const result = await service.getQuote('RELIANCE');

      expect(result.symbol).toBe('RELIANCE');
      expect(result.ltp).toBe(2550);
      expect(result.change).toBe(25);
      expect(mockCache.set).toHaveBeenCalled();
    });
  });

  describe('getHistory', () => {
    it('should return cached history', async () => {
      const cached = [{ timestamp: '2025-01-01', open: 100, high: 105, low: 98, close: 103, volume: 1000 }];
      (mockCache.get as any).mockResolvedValue(cached);

      const result = await service.getHistory('RELIANCE', '1day', '2025-01-01', '2025-01-31');

      expect(result).toEqual(cached);
    });

    it('should return empty array on fetch failure', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('error'));

      const result = await service.getHistory('RELIANCE', '1day', '2025-01-01', '2025-01-31');

      expect(result).toEqual([]);
    });
  });

  describe('getVIX', () => {
    it('should return VIX data from NSE', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      (mockCache.set as any).mockResolvedValue(undefined);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { index: 'NIFTY 50', last: 22000, variation: 100, percentChange: 0.45 },
              { index: 'INDIA VIX', last: 14.5, variation: -0.3, percentChange: -2.03 },
            ],
          }),
      } as any);

      const result = await service.getVIX();

      expect(result.value).toBe(14.5);
      expect(result.change).toBe(-0.3);
    });

    it('should return zeros on API failure', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('error'));

      const result = await service.getVIX();

      expect(result.value).toBe(0);
    });
  });

  describe('getIndices', () => {
    it('should return indices from NSE', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      (mockCache.set as any).mockResolvedValue(undefined);

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () =>
          Promise.resolve({
            data: [
              { index: 'NIFTY 50', last: 22000, variation: 100, percentChange: 0.45 },
              { index: 'NIFTY BANK', last: 47000, variation: -200, percentChange: -0.42 },
            ],
          }),
      } as any);

      const result = await service.getIndices();

      expect(result).toHaveLength(2);
      expect(result[0].name).toBe('NIFTY 50');
      expect(result[0].value).toBe(22000);
    });

    it('should return empty on failure', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('error'));

      const result = await service.getIndices();

      expect(result).toEqual([]);
    });
  });

  describe('getFIIDII', () => {
    it('should return default values when no data available', async () => {
      (mockCache.get as any).mockResolvedValue(null);

      const result = await service.getFIIDII();

      expect(result.fiiBuy).toBe(0);
      expect(result.date).toBeTruthy();
    });

    it('should use cached data', async () => {
      const cached = { date: '2025-06-01', fiiBuy: 5000, fiiSell: 3000, fiiNet: 2000, diiBuy: 4000, diiSell: 2000, diiNet: 2000 };
      (mockCache.get as any).mockResolvedValue(cached);

      const result = await service.getFIIDII();

      expect(result).toEqual(cached);
    });
  });

  describe('getOptionsChain', () => {
    it('should return cached option chain if available', async () => {
      const cached = { symbol: 'NIFTY', strikes: [{ strike: 25000 }], expiry: '2026-03-06' };
      (mockCache.get as any).mockResolvedValue(cached);

      const result = await service.getOptionsChain('NIFTY');

      expect(result).toEqual(cached);
    });

    it('should parse NSE option chain response correctly', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      (mockCache.set as any).mockResolvedValue(undefined);

      const nseData = {
        records: {
          expiryDates: ['06-Mar-2026'],
          underlyingValue: 25178.65,
          data: [
            {
              strikePrice: 24000,
              expiryDate: '06-Mar-2026',
              CE: { openInterest: 22900, changeinOpenInterest: -9800, lastPrice: 1005, impliedVolatility: 20.11 },
              PE: { openInterest: 22000, changeinOpenInterest: -3900, lastPrice: 4.75, impliedVolatility: 0 },
            },
            {
              strikePrice: 25000,
              expiryDate: '06-Mar-2026',
              CE: { openInterest: 71000, changeinOpenInterest: -3000, lastPrice: 191.65, impliedVolatility: 12.57 },
              PE: { openInterest: 25000, changeinOpenInterest: 130, lastPrice: 26, impliedVolatility: 12.61 },
            },
            {
              strikePrice: 25200,
              expiryDate: '06-Mar-2026',
              CE: { openInterest: 51700, changeinOpenInterest: -6000, lastPrice: 67.85, impliedVolatility: 10.34 },
              PE: { openInterest: 25000, changeinOpenInterest: 660, lastPrice: 88.55, impliedVolatility: 10.34 },
            },
          ],
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(nseData),
      } as any);

      const result = await service.getOptionsChain('NIFTY');

      expect(result.symbol).toBe('NIFTY');
      expect(result.expiry).toBe('06-Mar-2026');
      expect(result.underlyingValue).toBe(25178.65);
      expect(result.strikes).toHaveLength(3);

      const atm = result.strikes.find((s: any) => s.strike === 25000);
      expect(atm).toBeDefined();
      expect(atm.callOI).toBe(71000);
      expect(atm.callLTP).toBe(191.65);
      expect(atm.putOI).toBe(25000);
      expect(atm.putLTP).toBe(26);

      expect(result.totalCallOI).toBeGreaterThan(0);
      expect(result.totalPutOI).toBeGreaterThan(0);
      expect(result.pcr).toBeGreaterThan(0);
      expect(result.maxPain).toBeGreaterThan(0);
    });

    it('should return empty when both NSE and Breeze fail', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network error'));

      const result = await service.getOptionsChain('NIFTY');

      expect(result.symbol).toBe('NIFTY');
      expect(result.strikes).toEqual([]);
    });

    it('should compute max pain correctly from NSE data matching screenshot values', async () => {
      (mockCache.get as any).mockResolvedValue(null);
      (mockCache.set as any).mockResolvedValue(undefined);

      const nseData = {
        records: {
          expiryDates: ['06-Mar-2026'],
          underlyingValue: 25178.65,
          data: [
            { strikePrice: 24000, expiryDate: '06-Mar-2026', CE: { openInterest: 22900, changeinOpenInterest: -9800, lastPrice: 1005, impliedVolatility: 20.11 }, PE: { openInterest: 22000, changeinOpenInterest: -3900, lastPrice: 4.75, impliedVolatility: 0 } },
            { strikePrice: 24100, expiryDate: '06-Mar-2026', CE: { openInterest: 16200, changeinOpenInterest: -10300, lastPrice: 955, impliedVolatility: 19.17 }, PE: { openInterest: 24900, changeinOpenInterest: -8000, lastPrice: 4.75, impliedVolatility: 0 } },
            { strikePrice: 24200, expiryDate: '06-Mar-2026', CE: { openInterest: 42500, changeinOpenInterest: 7800, lastPrice: 807.33, impliedVolatility: 27.79 }, PE: { openInterest: 69500, changeinOpenInterest: -3300, lastPrice: 6.96, impliedVolatility: 0 } },
            { strikePrice: 24300, expiryDate: '06-Mar-2026', CE: { openInterest: 51500, changeinOpenInterest: -7000, lastPrice: 758.69, impliedVolatility: 23.77 }, PE: { openInterest: 86500, changeinOpenInterest: -1400, lastPrice: 8.26, impliedVolatility: 0 } },
            { strikePrice: 24500, expiryDate: '06-Mar-2026', CE: { openInterest: 82000, changeinOpenInterest: -2300, lastPrice: 610.73, impliedVolatility: 22.53 }, PE: { openInterest: 99300, changeinOpenInterest: -4200, lastPrice: 10.25, impliedVolatility: 0 } },
            { strikePrice: 25000, expiryDate: '06-Mar-2026', CE: { openInterest: 71000, changeinOpenInterest: -3000, lastPrice: 191.65, impliedVolatility: 12.57 }, PE: { openInterest: 25000, changeinOpenInterest: 130, lastPrice: 26, impliedVolatility: 12.61 } },
            { strikePrice: 25200, expiryDate: '06-Mar-2026', CE: { openInterest: 102000, changeinOpenInterest: 104900, lastPrice: 67.85, impliedVolatility: 10.34 }, PE: { openInterest: 6600, changeinOpenInterest: 660, lastPrice: 88.55, impliedVolatility: 10.34 } },
            { strikePrice: 25300, expiryDate: '06-Mar-2026', CE: { openInterest: 162000, changeinOpenInterest: -84600, lastPrice: 34.83, impliedVolatility: 0 }, PE: { openInterest: 25200, changeinOpenInterest: 660, lastPrice: 55, impliedVolatility: 12.07 } },
          ],
        },
      };

      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(nseData),
      } as any);

      const result = await service.getOptionsChain('NIFTY');

      expect(result.strikes.length).toBe(8);
      expect(result.maxPain).toBeGreaterThanOrEqual(24000);
      expect(result.maxPain).toBeLessThanOrEqual(26000);
      expect(result.pcr).toBeGreaterThan(0);

      const s25000 = result.strikes.find((s: any) => s.strike === 25000);
      expect(s25000.callOI).toBe(71000);
      expect(s25000.callOIChange).toBe(-3000);
      expect(s25000.callLTP).toBe(191.65);
      expect(s25000.putLTP).toBe(26);
    });

    it('getNextExpiry should return a valid Thursday date', () => {
      const svc = service as any;
      const expiry = svc.getNextExpiry();

      expect(expiry).toMatch(/^\d{4}-\d{2}-\d{2}T06:00:00\.000Z$/);

      const d = new Date(expiry);
      expect(d.getUTCDay()).toBe(4); // Thursday
      expect(d.getTime()).toBeGreaterThanOrEqual(Date.now() - 86400000);
    });
  });
});
