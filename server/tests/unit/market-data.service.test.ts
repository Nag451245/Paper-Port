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
});
