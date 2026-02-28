import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

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
    aIAgentConfig: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    aITradeSignal: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn() },
    $disconnect: vi.fn(),
  };
  return { getPrisma: vi.fn(() => mock), disconnectPrisma: vi.fn(), __mockPrisma: mock };
});

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js');
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => { await app.close(); });

const endpoints = [
  { path: '/api/intelligence/fii-dii', check: 'date' },
  { path: '/api/intelligence/fii-dii/trend', isArray: true },
  { path: '/api/intelligence/options/pcr/NIFTY', check: 'symbol' },
  { path: '/api/intelligence/options/oi-heatmap/NIFTY', check: 'symbol' },
  { path: '/api/intelligence/options/max-pain/NIFTY', check: 'symbol' },
  { path: '/api/intelligence/options/iv-percentile/NIFTY', check: 'symbol' },
  { path: '/api/intelligence/options/greeks/NIFTY', check: 'delta' },
  { path: '/api/intelligence/sectors/performance', isArray: true },
  { path: '/api/intelligence/sectors/heatmap', isArray: true },
  { path: '/api/intelligence/sectors/rrg', isArray: true },
  { path: '/api/intelligence/sectors/rotation-alerts', isArray: true },
  { path: '/api/intelligence/global/indices', isArray: true },
  { path: '/api/intelligence/global/fx', isArray: true },
  { path: '/api/intelligence/global/commodities', isArray: true },
  { path: '/api/intelligence/global/us-summary', check: 'marketStatus' },
  { path: '/api/intelligence/global/sgx-nifty', check: 'value' },
  { path: '/api/intelligence/block-deals', isArray: true },
  { path: '/api/intelligence/block-deals/smart-money', isArray: true },
  { path: '/api/intelligence/insider-transactions', isArray: true },
  { path: '/api/intelligence/insider-transactions/cluster-buys', isArray: true },
  { path: '/api/intelligence/insider-transactions/selling/RELIANCE', check: 'symbol' },
  { path: '/api/intelligence/earnings/calendar', isArray: true },
  { path: '/api/intelligence/earnings/rbi-mpc', check: 'currentRate' },
  { path: '/api/intelligence/earnings/macro-events', isArray: true },
  { path: '/api/intelligence/earnings/blackout/TCS', check: 'symbol' },
  { path: '/api/intelligence/earnings/event-impact', isArray: true },
];

describe('Intelligence Routes Integration', () => {
  for (const endpoint of endpoints) {
    it(`GET ${endpoint.path} should return 200`, async () => {
      const res = await app.inject({ method: 'GET', url: endpoint.path });

      expect(res.statusCode).toBe(200);

      const body = res.json();
      if (endpoint.isArray) {
        expect(Array.isArray(body)).toBe(true);
      }
      if (endpoint.check) {
        expect(body).toHaveProperty(endpoint.check);
      }
    });
  }
});
