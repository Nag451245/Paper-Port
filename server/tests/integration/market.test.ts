import { describe, it, expect, vi, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let originalFetch: typeof globalThis.fetch;

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: { findUnique: vi.fn() },
    breezeCredential: { findUnique: vi.fn(), upsert: vi.fn() },
    portfolio: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    position: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    order: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    trade: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    watchlist: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    watchlistItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    $disconnect: vi.fn(),
  };
  return { getPrisma: vi.fn(() => mock), disconnectPrisma: vi.fn(), __mockPrisma: mock };
});

beforeAll(async () => {
  originalFetch = globalThis.fetch;
  const { buildApp } = await import('../../src/app.js');
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => {
  globalThis.fetch = originalFetch;
  await app.close();
});

beforeEach(() => { vi.resetAllMocks(); });
afterEach(() => { globalThis.fetch = originalFetch; });

describe('Market Routes Integration', () => {
  describe('GET /api/market/quote/:symbol', () => {
    it('should return a quote (even empty when API unavailable)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/market/quote/RELIANCE',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.symbol).toBe('RELIANCE');
    });
  });

  describe('GET /api/market/search', () => {
    it('should search for stocks by query', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/market/search?q=reli',
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body).toHaveLength(1);
      expect(body[0].symbol).toBe('RELIANCE');
    });

    it('should return empty for no match', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/market/search?q=xyzzzz',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(0);
    });

    it('should return multiple results for partial match', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/market/search?q=bank',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().length).toBeGreaterThan(1);
    });
  });

  describe('GET /api/market/history/:symbol', () => {
    it('should return historical data (empty when API unavailable)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/market/history/RELIANCE?interval=1day&from_date=2025-01-01&to_date=2025-01-31',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  describe('GET /api/market/indices', () => {
    it('should return indices (empty when API unavailable)', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/market/indices',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toEqual([]);
    });
  });

  describe('GET /api/market/vix', () => {
    it('should return VIX data', async () => {
      globalThis.fetch = vi.fn().mockRejectedValue(new Error('Network'));

      const res = await app.inject({
        method: 'GET',
        url: '/api/market/vix',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().value).toBeDefined();
    });
  });

  describe('GET /api/market/fii-dii', () => {
    it('should return FII/DII data', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/market/fii-dii',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().date).toBeTruthy();
    });
  });

  describe('GET /api/market/options-chain/:symbol', () => {
    it('should return placeholder for options chain', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/market/options-chain/NIFTY',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().symbol).toBe('NIFTY');
    });
  });

  describe('GET /api/market/market-depth/:symbol', () => {
    it('should return placeholder for market depth', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/api/market/market-depth/RELIANCE',
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().symbol).toBe('RELIANCE');
    });
  });
});
