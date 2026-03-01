import { describe, it, expect, vi, beforeEach } from 'vitest';
import { IntelligenceService } from '../../src/services/intelligence.service.js';
import { CacheService } from '../../src/lib/redis.js';

function createMockCache() {
  return {
    get: vi.fn().mockResolvedValue(null),
    set: vi.fn().mockResolvedValue(undefined),
    del: vi.fn(),
    exists: vi.fn(),
    ttl: vi.fn(),
  } as unknown as CacheService;
}

describe('IntelligenceService', () => {
  let service: IntelligenceService;
  let mockCache: CacheService;

  beforeEach(() => {
    mockCache = createMockCache();
    service = new IntelligenceService(mockCache);
  });

  describe('FII/DII', () => {
    it('should return FII/DII data', async () => {
      const result = await service.getFIIDII();
      expect(result).toHaveProperty('date');
      expect(result).toHaveProperty('fiiBuy');
      expect(result).toHaveProperty('fiiNet');
    });

    it('should cache FII/DII data', async () => {
      await service.getFIIDII();
      expect(mockCache.set).toHaveBeenCalledWith('intel:fii-dii', expect.anything(), 120);
    });

    it('should return cached FII/DII data', async () => {
      const cached = { date: '2025-06-01', fiiBuy: 5000, fiiSell: 3000, fiiNet: 2000, diiBuy: 4000, diiSell: 2000, diiNet: 2000 };
      (mockCache.get as any).mockResolvedValue(cached);

      const result = await service.getFIIDII();
      expect(result).toEqual(cached);
    });

    it('should return FII/DII trend', async () => {
      const result = await service.getFIIDIITrend(30);
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Options analytics', () => {
    it('should return PCR for a symbol', async () => {
      const result = await service.getPCR('NIFTY');
      expect(result.symbol).toBe('NIFTY');
      expect(result).toHaveProperty('pcr');
    });

    it('should return OI heatmap', async () => {
      const result = await service.getOIHeatmap('NIFTY');
      expect(result.symbol).toBe('NIFTY');
    });

    it('should return max pain', async () => {
      const result = await service.getMaxPain('BANKNIFTY');
      expect(result.symbol).toBe('BANKNIFTY');
      expect(result).toHaveProperty('maxPainStrike');
    });

    it('should return IV percentile', async () => {
      const result = await service.getIVPercentile('RELIANCE');
      expect(result.symbol).toBe('RELIANCE');
      expect(result).toHaveProperty('ivPercentile');
    });

    it('should return Greeks', async () => {
      const result = await service.getGreeks('NIFTY');
      expect(result).toHaveProperty('delta');
      expect(result).toHaveProperty('gamma');
      expect(result).toHaveProperty('theta');
      expect(result).toHaveProperty('vega');
    });
  });

  describe('Sector analytics', () => {
    it('should return sector performance', async () => {
      const result = await service.getSectorPerformance();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('sector');
    });

    it('should return sector heatmap', async () => {
      const result = await service.getSectorHeatmap();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return sector RRG data', async () => {
      const result = await service.getSectorRRG();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return rotation alerts', async () => {
      const result = await service.getSectorRotationAlerts();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Global markets', () => {
    it('should return global indices', async () => {
      const result = await service.getGlobalIndices();
      expect(Array.isArray(result)).toBe(true);
      expect(result.length).toBeGreaterThan(0);
      expect(result[0]).toHaveProperty('name');
    });

    it('should return FX rates', async () => {
      const result = await service.getFXRates();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return commodities', async () => {
      const result = await service.getCommodities();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return US market summary', async () => {
      const result = await service.getUSSummary();
      expect(result).toHaveProperty('marketStatus');
      expect(result).toHaveProperty('sp500');
    });

    it('should return SGX Nifty', async () => {
      const result = await service.getSGXNifty();
      expect(result).toHaveProperty('value');
      expect(result).toHaveProperty('lastUpdated');
    });
  });

  describe('Block deals & Insider', () => {
    it('should return block deals', async () => {
      const result = await service.getBlockDeals();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return smart money signals', async () => {
      const result = await service.getSmartMoney();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return insider transactions', async () => {
      const result = await service.getInsiderTransactions();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return cluster buys', async () => {
      const result = await service.getClusterBuys();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return insider selling for symbol', async () => {
      const result = await service.getInsiderSelling('RELIANCE');
      expect(result.symbol).toBe('RELIANCE');
      expect(result).toHaveProperty('hasRecentSelling');
    });
  });

  describe('Earnings & Events', () => {
    it('should return earnings calendar', async () => {
      const result = await service.getEarningsCalendar();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return RBI MPC data', async () => {
      const result = await service.getRBIMPC();
      expect(result).toHaveProperty('currentRate');
    });

    it('should return macro events', async () => {
      const result = await service.getMacroEvents();
      expect(Array.isArray(result)).toBe(true);
    });

    it('should return blackout period check', async () => {
      const result = await service.getBlackout('TCS');
      expect(result.symbol).toBe('TCS');
      expect(result).toHaveProperty('isBlackoutPeriod');
    });

    it('should return event impact analysis', async () => {
      const result = await service.getEventImpact();
      expect(Array.isArray(result)).toBe(true);
    });
  });

  describe('Caching behavior', () => {
    it('should use cache for all intelligence endpoints', async () => {
      const cached = { custom: 'cached-data' };
      (mockCache.get as any).mockResolvedValue(cached);

      const result = await service.getSectorPerformance();
      expect(result).toEqual(cached);
      expect(mockCache.set).not.toHaveBeenCalled();
    });

    it('should set cache with TTL on miss', async () => {
      (mockCache.get as any).mockResolvedValue(null);

      await service.getSectorPerformance();

      expect(mockCache.set).toHaveBeenCalledWith(
        'intel:sectors:perf',
        expect.anything(),
        120,
      );
    });
  });
});
