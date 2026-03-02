import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mockPrisma: any;

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletion: vi.fn().mockResolvedValue('mock'),
  chatCompletionJSON: vi.fn().mockResolvedValue({ stance: 'neutral', keyPoints: [] }),
  getOpenAIStatus: vi.fn().mockReturnValue({ circuitOpen: false, queueLength: 0, recentRequests: 0, cooldownRemainingMs: 0 }),
  _resetForTesting: vi.fn(),
}));

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({
    getHistory: vi.fn().mockResolvedValue(
      Array.from({ length: 100 }, (_, i) => ({
        timestamp: `2024-${String(Math.floor(i / 30) + 1).padStart(2, '0')}-${String((i % 28) + 1).padStart(2, '0')}T09:15:00.000Z`,
        open: 2400 + i, high: 2420 + i, low: 2380 + i, close: 2410 + i, volume: 1000000,
      }))
    ),
    getQuote: vi.fn().mockResolvedValue({ symbol: 'RELIANCE', ltp: 2500, open: 2480, high: 2520, low: 2470, close: 2500, volume: 1000000, exchange: 'NSE' }),
    search: vi.fn().mockResolvedValue([]),
    getIndices: vi.fn().mockResolvedValue([]),
    getIndicesForExchange: vi.fn().mockResolvedValue([]),
    getVIX: vi.fn().mockResolvedValue({ value: 14.5, change: -0.2, changePercent: -1.36 }),
    getFIIDII: vi.fn().mockResolvedValue({ date: new Date().toISOString().split('T')[0], fiiBuy: 0, fiiSell: 0, fiiNet: 0, diiBuy: 0, diiSell: 0, diiNet: 0 }),
    getOptionsChain: vi.fn().mockResolvedValue({ symbol: 'NIFTY', strikes: [], expiry: '' }),
  })),
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
    tradingBot: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    botMessage: { findMany: vi.fn(), create: vi.fn() },
    botTask: { findMany: vi.fn(), create: vi.fn() },
    backtestResult: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
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
beforeEach(() => { vi.clearAllMocks(); });

function authHeaders(userId = 'test-user') {
  return { authorization: `Bearer ${app.jwt.sign({ sub: userId })}` };
}

describe('Bot Routes Integration', () => {
  describe('GET /api/bots', () => {
    it('should list bots', async () => {
      mockPrisma.tradingBot.findMany.mockResolvedValue([
        { id: 'b1', name: 'Scanner Bot', role: 'SCANNER', status: 'IDLE' },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/bots', headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    });

    it('should return 401 without auth', async () => {
      const res = await app.inject({ method: 'GET', url: '/api/bots' });
      expect(res.statusCode).toBe(401);
    });
  });

  describe('POST /api/bots', () => {
    it('should create a bot', async () => {
      mockPrisma.tradingBot.create.mockResolvedValue({
        id: 'b-new', name: 'Test Bot', role: 'SCANNER', status: 'IDLE',
      });

      const res = await app.inject({
        method: 'POST', url: '/api/bots', headers: authHeaders(),
        payload: { name: 'Test Bot', role: 'SCANNER', avatar_emoji: '🤖', description: 'A test bot', max_capital: 100000 },
      });

      expect(res.statusCode).toBe(201);
      expect(res.json().name).toBe('Test Bot');
    });

    it('should return 400 for missing name', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/bots', headers: authHeaders(),
        payload: { role: 'SCANNER' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/bots/:id', () => {
    it('should get bot details', async () => {
      mockPrisma.tradingBot.findUnique.mockResolvedValue({
        id: 'b1', userId: 'test-user', name: 'Bot', role: 'SCANNER',
      });

      const res = await app.inject({ method: 'GET', url: '/api/bots/b1', headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      expect(res.json().name).toBe('Bot');
    });

    it('should return 404 for non-existent bot', async () => {
      mockPrisma.tradingBot.findUnique.mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/bots/nonexistent', headers: authHeaders() });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/bots/:id/start', () => {
    it('should start a bot', async () => {
      mockPrisma.tradingBot.findUnique.mockResolvedValue({
        id: 'b1', userId: 'test-user', status: 'IDLE',
      });
      mockPrisma.tradingBot.update.mockResolvedValue({
        id: 'b1', status: 'RUNNING',
      });

      const res = await app.inject({ method: 'POST', url: '/api/bots/b1/start', headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      expect(res.json().status).toBe('RUNNING');
    });
  });

  describe('POST /api/bots/:id/stop', () => {
    it('should stop a bot', async () => {
      mockPrisma.tradingBot.findUnique.mockResolvedValue({
        id: 'b1', userId: 'test-user', status: 'RUNNING',
      });
      mockPrisma.tradingBot.update.mockResolvedValue({
        id: 'b1', status: 'IDLE',
      });

      const res = await app.inject({ method: 'POST', url: '/api/bots/b1/stop', headers: authHeaders() });
      expect(res.statusCode).toBe(200);
    });
  });

  describe('POST /api/bots/:id/tasks', () => {
    it('should assign a task to bot', async () => {
      mockPrisma.tradingBot.findUnique.mockResolvedValue({
        id: 'b1', userId: 'test-user',
      });
      mockPrisma.botTask.create.mockResolvedValue({
        id: 'task-1', taskType: 'scan', description: 'Scan NIFTY 50',
      });

      const res = await app.inject({
        method: 'POST', url: '/api/bots/b1/tasks', headers: authHeaders(),
        payload: { taskType: 'scan', description: 'Scan NIFTY 50' },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('POST /api/bots/:id/messages', () => {
    it('should send a message', async () => {
      mockPrisma.tradingBot.findUnique.mockResolvedValue({
        id: 'b1', userId: 'test-user',
      });
      mockPrisma.botMessage.create.mockResolvedValue({
        id: 'msg-1', content: 'Hello bot',
      });

      const res = await app.inject({
        method: 'POST', url: '/api/bots/b1/messages', headers: authHeaders(),
        payload: { content: 'Hello bot' },
      });

      expect(res.statusCode).toBe(201);
    });
  });

  describe('GET /api/bots/messages/all', () => {
    it('should return all messages', async () => {
      mockPrisma.botMessage.findMany.mockResolvedValue([
        { id: 'msg-1', content: 'Hello' },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/bots/messages/all', headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    });
  });

  describe('DELETE /api/bots/:id', () => {
    it('should delete a bot', async () => {
      mockPrisma.tradingBot.findUnique.mockResolvedValue({
        id: 'b1', userId: 'test-user',
      });
      mockPrisma.tradingBot.delete.mockResolvedValue({ id: 'b1' });

      const res = await app.inject({ method: 'DELETE', url: '/api/bots/b1', headers: authHeaders() });
      expect(res.statusCode).toBe(204);
    });
  });
});

describe('Backtest Routes Integration', () => {
  describe('POST /api/backtest/run', () => {
    it('should run a backtest', async () => {
      mockPrisma.backtestResult.create.mockResolvedValue({
        id: 'bt-1', strategyId: 'ema-crossover', cagr: 15.5, winRate: 55,
      });

      const res = await app.inject({
        method: 'POST', url: '/api/backtest/run', headers: authHeaders(),
        payload: {
          strategyId: 'ema-crossover', symbol: 'RELIANCE',
          startDate: '2024-01-01', endDate: '2024-12-31',
          initialCapital: 1000000, parameters: { ema_short: 9, ema_long: 21 },
        },
      });

      expect(res.statusCode).toBe(201);
    });

    it('should return 400 for missing strategyId', async () => {
      const res = await app.inject({
        method: 'POST', url: '/api/backtest/run', headers: authHeaders(),
        payload: { symbol: 'RELIANCE' },
      });
      expect(res.statusCode).toBe(400);
    });
  });

  describe('GET /api/backtest/results', () => {
    it('should list backtest results', async () => {
      mockPrisma.backtestResult.findMany.mockResolvedValue([
        { id: 'bt-1', strategyId: 'ema-crossover', cagr: 15.5 },
      ]);

      const res = await app.inject({ method: 'GET', url: '/api/backtest/results', headers: authHeaders() });
      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(1);
    });
  });

  describe('GET /api/backtest/results/:id', () => {
    it('should get specific result', async () => {
      mockPrisma.backtestResult.findUnique.mockResolvedValue({
        id: 'bt-1', userId: 'test-user', strategyId: 'ema-crossover',
      });

      const res = await app.inject({ method: 'GET', url: '/api/backtest/results/bt-1', headers: authHeaders() });
      expect(res.statusCode).toBe(200);
    });

    it('should return 404 for non-existent result', async () => {
      mockPrisma.backtestResult.findUnique.mockResolvedValue(null);

      const res = await app.inject({ method: 'GET', url: '/api/backtest/results/nonexistent', headers: authHeaders() });
      expect(res.statusCode).toBe(404);
    });
  });

  describe('POST /api/backtest/compare', () => {
    it('should compare results', async () => {
      mockPrisma.backtestResult.findMany.mockResolvedValue([
        { id: 'bt-1', cagr: 15 },
        { id: 'bt-2', cagr: 20 },
      ]);

      const res = await app.inject({
        method: 'POST', url: '/api/backtest/compare', headers: authHeaders(),
        payload: { resultIds: ['bt-1', 'bt-2'] },
      });

      expect(res.statusCode).toBe(200);
      expect(res.json()).toHaveLength(2);
    });
  });
});
