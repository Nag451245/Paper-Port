import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mockPrisma: any;

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
  const { buildApp } = await import('../../src/app.js');
  const prismaModule = await import('../../src/lib/prisma.js');
  mockPrisma = (prismaModule as any).__mockPrisma;
  app = await buildApp({ logger: false });
  await app.ready();
});

afterAll(async () => { await app.close(); });
beforeEach(() => { vi.resetAllMocks(); });

function authHeaders(userId = 'test-user') {
  return { authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
}

describe('Watchlist Routes Integration', () => {
  describe('GET /api/watchlist', () => {
    it('should list watchlists', async () => {
      mockPrisma.watchlist.findMany.mockResolvedValue([
        { id: 'w1', name: 'My Watchlist', items: [{ symbol: 'RELIANCE', exchange: 'NSE' }] },
      ]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/watchlist',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
      expect(res.json()[0].items).toHaveLength(1);
    });

    it('should return 401 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/watchlist' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/watchlist', () => {
    it('should create a watchlist', async () => {
      mockPrisma.watchlist.create.mockResolvedValue({
        id: 'w-new', name: 'Tech Stocks', items: [],
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/watchlist',
        headers: authHeaders(),
        payload: { name: 'Tech Stocks' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('Tech Stocks');
    });

    it('should return 400 for missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/watchlist',
        headers: authHeaders(),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/watchlist/:id', () => {
    it('should return watchlist with items', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1', userId: 'test-user', name: 'My Watchlist',
        items: [{ id: 'i1', symbol: 'RELIANCE' }, { id: 'i2', symbol: 'TCS' }],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/watchlist/w1',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().items).toHaveLength(2);
    });

    it('should return 404 for non-existent watchlist', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/watchlist/nonexistent',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/watchlist/:id/items', () => {
    it('should add item to watchlist', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1', userId: 'test-user', items: [],
      });
      mockPrisma.watchlistItem.findFirst.mockResolvedValue(null);
      mockPrisma.watchlistItem.create.mockResolvedValue({
        id: 'item-new', symbol: 'INFY', exchange: 'NSE',
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/watchlist/w1/items',
        headers: authHeaders(),
        payload: { symbol: 'INFY', exchange: 'NSE' },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().symbol).toBe('INFY');
    });

    it('should return 409 for duplicate symbol', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1', userId: 'test-user', items: [],
      });
      mockPrisma.watchlistItem.findFirst.mockResolvedValue({ id: 'existing' });

      const res = await app.inject({
        method: 'POST',
        url: '/api/watchlist/w1/items',
        headers: authHeaders(),
        payload: { symbol: 'RELIANCE', exchange: 'NSE' },
      });

      expect(res.statusCode).toBe(409);
    });
  });

  describe('DELETE /api/watchlist/:id/items/:itemId', () => {
    it('should remove item from watchlist', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1', userId: 'test-user', items: [],
      });
      mockPrisma.watchlistItem.findUnique.mockResolvedValue({
        id: 'item-1', watchlistId: 'w1',
      });
      mockPrisma.watchlistItem.delete.mockResolvedValue({ id: 'item-1' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/watchlist/w1/items/item-1',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(204);
    });

    it('should return 404 for non-existent item', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1', userId: 'test-user', items: [],
      });
      mockPrisma.watchlistItem.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/watchlist/w1/items/nonexistent',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('DELETE /api/watchlist/:id', () => {
    it('should delete entire watchlist', async () => {
      mockPrisma.watchlist.findUnique.mockResolvedValue({
        id: 'w1', userId: 'test-user', items: [],
      });
      mockPrisma.watchlist.delete.mockResolvedValue({ id: 'w1' });

      const res = await app.inject({
        method: 'DELETE',
        url: '/api/watchlist/w1',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(204);
    });
  });
});
