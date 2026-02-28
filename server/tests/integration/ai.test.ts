import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mockPrisma: any;

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletion: vi.fn().mockResolvedValue('Mock AI response'),
  chatCompletionJSON: vi.fn().mockResolvedValue({
    date: '2025-06-01', stance: 'neutral', keyPoints: ['Test'],
    globalCues: [], sectorOutlook: {}, supportLevels: [], resistanceLevels: [], keyEvents: [],
  }),
}));

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

describe('AI Routes Integration', () => {
  describe('GET /api/ai/config', () => {
    it('should return agent config', async () => {
      mockPrisma.aIAgentConfig.findUnique.mockResolvedValue({
        id: 'cfg1', userId: 'test-user', mode: 'ADVISORY', isActive: false,
      });

      const res = await app.inject({ method: 'GET', url: '/api/ai/config', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json().mode).toBe('ADVISORY');
    });

    it('should return 401 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/ai/config' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('PUT /api/ai/config', () => {
    it('should update config', async () => {
      mockPrisma.aIAgentConfig.upsert.mockResolvedValue({
        userId: 'test-user', mode: 'SIGNAL', isActive: true,
      });

      const res = await app.inject({
        method: 'PUT', url: '/api/ai/config', headers: authHeaders(),
        payload: { mode: 'SIGNAL', isActive: true },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().mode).toBe('SIGNAL');
    });
  });

  describe('POST /api/ai/start', () => {
    it('should start agent', async () => {
      mockPrisma.aIAgentConfig.upsert.mockResolvedValue({});

      const res = await app.inject({ method: 'POST', url: '/api/ai/start', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('running');
    });
  });

  describe('POST /api/ai/stop', () => {
    it('should stop agent', async () => {
      mockPrisma.aIAgentConfig.upsert.mockResolvedValue({});

      const res = await app.inject({ method: 'POST', url: '/api/ai/stop', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('stopped');
    });
  });

  describe('GET /api/ai/status', () => {
    it('should return agent status', async () => {
      mockPrisma.aIAgentConfig.findUnique.mockResolvedValue({
        userId: 'test-user', mode: 'ADVISORY', isActive: true, updatedAt: new Date(),
      });
      mockPrisma.aITradeSignal.count.mockResolvedValue(0);

      const res = await app.inject({ method: 'GET', url: '/api/ai/status', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('isActive');
    });
  });

  describe('GET /api/ai/signals', () => {
    it('should list signals', async () => {
      mockPrisma.aITradeSignal.findMany.mockResolvedValue([
        { id: 's1', symbol: 'RELIANCE', status: 'PENDING' },
      ]);
      mockPrisma.aITradeSignal.count.mockResolvedValue(1);

      const res = await app.inject({ method: 'GET', url: '/api/ai/signals', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json().signals).toHaveLength(1);
    });
  });

  describe('POST /api/ai/signals/:id/execute', () => {
    it('should execute a pending signal', async () => {
      mockPrisma.aITradeSignal.findUnique.mockResolvedValue({
        id: 's1', userId: 'test-user', status: 'PENDING',
      });
      mockPrisma.aITradeSignal.update.mockResolvedValue({
        id: 's1', status: 'EXECUTED',
      });

      const res = await app.inject({
        method: 'POST', url: '/api/ai/signals/s1/execute', headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('EXECUTED');
    });

    it('should return 404 for non-existent signal', async () => {
      mockPrisma.aITradeSignal.findUnique.mockResolvedValue(null);

      const res = await app.inject({
        method: 'POST', url: '/api/ai/signals/nonexistent/execute', headers: authHeaders(),
      });

      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/ai/signals/:id/reject', () => {
    it('should reject a signal', async () => {
      mockPrisma.aITradeSignal.findUnique.mockResolvedValue({
        id: 's1', userId: 'test-user', status: 'PENDING',
      });
      mockPrisma.aITradeSignal.update.mockResolvedValue({ id: 's1', status: 'REJECTED' });

      const res = await app.inject({
        method: 'POST', url: '/api/ai/signals/s1/reject', headers: authHeaders(),
      });

      expect(res.statusCode).toBe(200);
    });
  });

  describe('GET /api/ai/briefing/pre-market', () => {
    it('should return pre-market briefing', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/ai/briefing/pre-market', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('stance');
    });
  });

  describe('GET /api/ai/briefing/post-trade', () => {
    it('should return post-trade briefing', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.trade.findMany.mockResolvedValue([]);

      const res = await app.inject({ method: 'GET', url: '/api/ai/briefing/post-trade', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveProperty('summary');
    });
  });

  describe('GET /api/ai/strategies', () => {
    it('should return available strategies', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/ai/strategies', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      const body = res.json();
      expect(body.length).toBeGreaterThan(0);
      expect(body[0]).toHaveProperty('id');
    });
  });

  describe('GET /api/ai/capital-rules', () => {
    it('should return capital rules', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/ai/capital-rules', headers: authHeaders() });

      expect(res.statusCode).toBe(200);
      expect(res.json().length).toBeGreaterThan(0);
    });
  });
});
