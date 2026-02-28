import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mockPrisma: any;

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
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

function getToken(userId = 'test-user') { return app.jwt.sign({ sub: userId }); }
function authHeaders(userId = 'test-user') { return { authorization: `Bearer ${getToken(userId)}` }; }

describe('Portfolio Routes Integration', () => {
  describe('GET /api/portfolio', () => {
    it('should list user portfolios', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([
        { id: 'p1', name: 'Default', userId: 'test-user', initialCapital: 1000000, currentNav: 1050000 },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/portfolio', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
      expect(res.json()[0].name).toBe('Default');
    });

    it('should return 401 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/portfolio' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/portfolio', () => {
    it('should create a new portfolio', async () => {
      mockPrisma.portfolio.create.mockResolvedValue({
        id: 'new-p', name: 'Aggressive', initialCapital: 500000, currentNav: 500000,
      });

      const res = await app.inject({
        method: 'POST',
        url: '/api/portfolio',
        headers: authHeaders(),
        payload: { name: 'Aggressive', initial_capital: 500000 },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('Aggressive');
    });

    it('should return 400 for missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/api/portfolio',
        headers: authHeaders(),
        payload: {},
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/portfolio/:id', () => {
    it('should return portfolio details', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1', userId: 'test-user', name: 'Default', positions: [],
      });

      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio/p1',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().id).toBe('p1');
    });

    it('should return 404 for non-existent portfolio', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio/nonexistent',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('GET /api/portfolio/:id/summary', () => {
    it('should return portfolio summary', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1', userId: 'test-user', initialCapital: 1000000, currentNav: 1050000, positions: [],
      });
      mockPrisma.position.findMany.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio/p1/summary',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.totalNav).toBe(1050000);
      expect(body.totalPnl).toBe(50000);
    });
  });

  describe('GET /api/portfolio/:id/risk-metrics', () => {
    it('should return zero metrics for empty portfolio', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1', userId: 'test-user', positions: [],
      });
      mockPrisma.trade.findMany.mockResolvedValue([]);

      const res = await app.inject({
        method: 'GET',
        url: '/api/portfolio/p1/risk-metrics',
        headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().totalTrades).toBe(0);
    });
  });

  describe('PUT /api/portfolio/:id/capital', () => {
    it('should update virtual capital', async () => {
      mockPrisma.portfolio.findUnique.mockResolvedValue({
        id: 'p1', userId: 'test-user', positions: [],
      });
      mockPrisma.portfolio.update.mockResolvedValue({
        id: 'p1', initialCapital: 2000000, currentNav: 2000000,
      });

      const res = await app.inject({
        method: 'PUT',
        url: '/api/portfolio/p1/capital',
        headers: authHeaders(),
        payload: { virtual_capital: 2000000 },
      });

      expect(res.statusCode).toBe(200);
    });

    it('should return 400 for negative capital', async () => {
      const res = await app.inject({
        method: 'PUT',
        url: '/api/portfolio/p1/capital',
        headers: authHeaders(),
        payload: { virtual_capital: -1000 },
      });

      expect(res.statusCode).toBe(400);
    });
  });
});
