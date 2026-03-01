import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

/**
 * End-to-End UAT Tests
 *
 * These tests simulate full user flows through the API, testing:
 * 1. User registration and onboarding
 * 2. Portfolio management flow
 * 3. Trading flow (order -> position -> close -> trade)
 * 4. Market data browsing
 * 5. AI agent configuration and signals
 * 6. Watchlist management
 * 7. Bot management
 * 8. Backtest execution
 * 9. Settings management (Breeze credentials)
 * 10. Intelligence dashboard data
 */

let app: FastifyInstance;
let mockPrisma: any;

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletion: vi.fn().mockResolvedValue('Mock AI response'),
  chatCompletionJSON: vi.fn().mockResolvedValue({
    date: '2025-06-01', stance: 'bullish', keyPoints: ['Markets look positive'],
    globalCues: ['US markets up 0.5%'], sectorOutlook: { IT: 'positive' },
    supportLevels: [21800], resistanceLevels: [22200], keyEvents: ['RBI MPC'],
  }),
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
    search: vi.fn().mockImplementation((q: string) => {
      const stocks = [
        { symbol: 'RELIANCE', name: 'Reliance Industries', exchange: 'NSE', sector: 'Oil & Gas' },
        { symbol: 'TCS', name: 'Tata Consultancy Services', exchange: 'NSE', sector: 'IT' },
      ];
      return Promise.resolve(stocks.filter(s => s.symbol.toLowerCase().includes(q.toLowerCase()) || s.name.toLowerCase().includes(q.toLowerCase())));
    }),
    getIndices: vi.fn().mockResolvedValue([]),
    getIndicesForExchange: vi.fn().mockResolvedValue([]),
    getVIX: vi.fn().mockResolvedValue({ value: 14.5, change: -0.2, changePercent: -1.36 }),
    getFIIDII: vi.fn().mockResolvedValue({ date: new Date().toISOString().split('T')[0], fiiBuy: 0, fiiSell: 0, fiiNet: 0, diiBuy: 0, diiSell: 0, diiNet: 0 }),
    getOptionsChain: vi.fn().mockResolvedValue({ symbol: 'NIFTY', strikes: [], expiry: '' }),
  })),
}));

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: { findUnique: vi.fn(), create: vi.fn(), update: vi.fn() },
    breezeCredential: { findUnique: vi.fn(), upsert: vi.fn() },
    portfolio: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
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
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ 1: 1 }]),
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
beforeEach(() => {
  vi.clearAllMocks();
});

function getToken(userId = 'uat-user') {
  return app.jwt.sign({ sub: userId });
}

function auth(userId = 'uat-user') {
  return { authorization: `Bearer ${getToken(userId)}` };
}

describe('UAT Flow 1: User Registration & Onboarding', () => {
  it('should complete full registration flow', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    mockPrisma.user.create.mockResolvedValue({
      id: 'new-uat-user', email: 'uat@example.com', fullName: 'UAT User',
      riskAppetite: 'MODERATE', virtualCapital: 1000000, role: 'LEARNER',
      isActive: true, createdAt: new Date(), updatedAt: new Date(),
    });

    const registerRes = await app.inject({
      method: 'POST', url: '/api/auth/register',
      payload: { email: 'uat@example.com', password: 'UATPass123!', fullName: 'UAT User' },
    });

    expect(registerRes.statusCode).toBe(201);
    const { access_token, user } = registerRes.json();
    expect(access_token).toBeTruthy();
    expect(user.email).toBe('uat@example.com');

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'new-uat-user', email: 'uat@example.com', fullName: 'UAT User',
      riskAppetite: 'MODERATE', virtualCapital: 1000000, role: 'LEARNER',
      isActive: true, createdAt: new Date(), updatedAt: new Date(),
    });

    const profileRes = await app.inject({
      method: 'GET', url: '/api/auth/me',
      headers: { authorization: `Bearer ${access_token}` },
    });

    expect(profileRes.statusCode).toBe(200);
    expect(profileRes.json().fullName).toBe('UAT User');
  });

  it('should complete login flow', async () => {
    const bcrypt = await import('bcryptjs');
    const hash = bcrypt.hashSync('UATPass123!', 12);

    mockPrisma.user.findUnique.mockResolvedValue({
      id: 'existing-user', email: 'existing@example.com', passwordHash: hash,
      fullName: 'Existing User', riskAppetite: 'MODERATE', virtualCapital: 1000000,
      role: 'LEARNER', isActive: true, createdAt: new Date(), updatedAt: new Date(),
    });

    const loginRes = await app.inject({
      method: 'POST', url: '/api/auth/login',
      payload: { email: 'existing@example.com', password: 'UATPass123!' },
    });

    expect(loginRes.statusCode).toBe(200);
    expect(loginRes.json().access_token).toBeTruthy();
  });
});

describe('UAT Flow 2: Dashboard Data Loading', () => {
  it('should load all dashboard components', async () => {
    const [healthRes, indicesRes, vixRes, fiiDiiRes] = await Promise.all([
      app.inject({ method: 'GET', url: '/health' }),
      app.inject({ method: 'GET', url: '/api/market/indices' }),
      app.inject({ method: 'GET', url: '/api/market/vix' }),
      app.inject({ method: 'GET', url: '/api/market/fii-dii' }),
    ]);

    expect(healthRes.statusCode).toBe(200);
    expect(indicesRes.statusCode).toBe(200);
    expect(vixRes.statusCode).toBe(200);
    expect(fiiDiiRes.statusCode).toBe(200);
  });
});

describe('UAT Flow 3: Portfolio Management', () => {
  it('should create portfolio, check summary, and update capital', async () => {
    mockPrisma.portfolio.create.mockResolvedValue({
      id: 'uat-portfolio', name: 'UAT Portfolio', initialCapital: 500000, currentNav: 500000,
    });

    const createRes = await app.inject({
      method: 'POST', url: '/api/portfolio',
      headers: auth(), payload: { name: 'UAT Portfolio', initial_capital: 500000 },
    });
    expect(createRes.statusCode).toBe(201);

    mockPrisma.portfolio.findUnique.mockResolvedValue({
      id: 'uat-portfolio', userId: 'uat-user', name: 'UAT Portfolio',
      initialCapital: 500000, currentNav: 500000, positions: [],
    });
    mockPrisma.position.findMany.mockResolvedValue([]);

    const summaryRes = await app.inject({
      method: 'GET', url: '/api/portfolio/uat-portfolio/summary', headers: auth(),
    });
    expect(summaryRes.statusCode).toBe(200);
    expect(summaryRes.json().totalNav).toBe(500000);

    mockPrisma.portfolio.update.mockResolvedValue({
      id: 'uat-portfolio', initialCapital: 2000000, currentNav: 2000000,
    });

    const updateRes = await app.inject({
      method: 'PUT', url: '/api/portfolio/uat-portfolio/capital',
      headers: auth(), payload: { virtual_capital: 2000000 },
    });
    expect(updateRes.statusCode).toBe(200);
  });
});

describe('UAT Flow 4: Trading Terminal', () => {
  it('should search for stock, place order, view position, close position', async () => {
    const searchRes = await app.inject({
      method: 'GET', url: '/api/market/search?q=reliance',
    });
    expect(searchRes.statusCode).toBe(200);
    expect(searchRes.json().length).toBeGreaterThan(0);
    expect(searchRes.json()[0].symbol).toBe('RELIANCE');

    mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', userId: 'uat-user' });
    mockPrisma.order.create.mockResolvedValue({
      id: 'uat-order', symbol: 'RELIANCE', side: 'BUY', orderType: 'MARKET',
      qty: 10, status: 'FILLED', avgFillPrice: 2500,
    });
    mockPrisma.position.findFirst.mockResolvedValue(null);
    mockPrisma.position.create.mockResolvedValue({ id: 'uat-pos' });
    mockPrisma.order.update.mockResolvedValue({});

    const orderRes = await app.inject({
      method: 'POST', url: '/api/trades/orders', headers: auth(),
      payload: {
        portfolio_id: 'a0eebc99-9c0b-4ef8-bb6d-6bb9bd380a11',
        symbol: 'RELIANCE', side: 'BUY', order_type: 'MARKET', qty: 10,
        price: 2500, instrument_token: 'tok1',
      },
    });
    expect(orderRes.statusCode).toBe(201);

    mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
    mockPrisma.position.findMany.mockResolvedValue([
      { id: 'uat-pos', symbol: 'RELIANCE', qty: 10, avgEntryPrice: 2500, side: 'LONG', status: 'OPEN' },
    ]);

    const positionsRes = await app.inject({
      method: 'GET', url: '/api/trades/positions', headers: auth(),
    });
    expect(positionsRes.statusCode).toBe(200);
    expect(positionsRes.json().length).toBeGreaterThan(0);

    mockPrisma.position.findUnique.mockResolvedValue({
      id: 'uat-pos', portfolioId: 'p1', symbol: 'RELIANCE', exchange: 'NSE',
      qty: 10, avgEntryPrice: 2500, side: 'LONG', status: 'OPEN',
      openedAt: new Date(), strategyTag: null, portfolio: { userId: 'uat-user' },
    });
    mockPrisma.trade.create.mockResolvedValue({
      id: 'uat-trade', grossPnl: 5000, netPnl: 4950, symbol: 'RELIANCE',
    });
    mockPrisma.position.update.mockResolvedValue({});
    mockPrisma.portfolio.findUnique.mockResolvedValue({ id: 'p1', currentNav: 1000000 });
    mockPrisma.portfolio.update.mockResolvedValue({});

    const closeRes = await app.inject({
      method: 'POST', url: '/api/trades/positions/uat-pos/close',
      headers: auth(), payload: { exit_price: 3000 },
    });
    expect(closeRes.statusCode).toBe(200);
    expect(closeRes.json().netPnl).toBe(4950);
  });
});

describe('UAT Flow 5: AI Agent Panel', () => {
  it('should configure AI agent, start it, and get briefing', async () => {
    mockPrisma.aIAgentConfig.upsert.mockResolvedValue({
      userId: 'uat-user', mode: 'SIGNAL', isActive: true, minSignalScore: 0.7,
    });

    const configRes = await app.inject({
      method: 'PUT', url: '/api/ai/config', headers: auth(),
      payload: { mode: 'SIGNAL', isActive: true, minSignalScore: 0.7 },
    });
    expect(configRes.statusCode).toBe(200);

    mockPrisma.aIAgentConfig.upsert.mockResolvedValue({});
    const startRes = await app.inject({
      method: 'POST', url: '/api/ai/start', headers: auth(),
    });
    expect(startRes.statusCode).toBe(200);
    expect(startRes.json().status).toBe('running');

    const briefingRes = await app.inject({
      method: 'GET', url: '/api/ai/briefing/pre-market', headers: auth(),
    });
    expect(briefingRes.statusCode).toBe(200);
    expect(briefingRes.json()).toHaveProperty('stance');

    const strategiesRes = await app.inject({
      method: 'GET', url: '/api/ai/strategies', headers: auth(),
    });
    expect(strategiesRes.statusCode).toBe(200);
    expect(strategiesRes.json().length).toBeGreaterThan(0);

    const rulesRes = await app.inject({
      method: 'GET', url: '/api/ai/capital-rules', headers: auth(),
    });
    expect(rulesRes.statusCode).toBe(200);
    expect(rulesRes.json().length).toBeGreaterThan(0);
  });
});

describe('UAT Flow 6: Watchlist Management', () => {
  it('should create watchlist, add items, then remove', async () => {
    mockPrisma.watchlist.create.mockResolvedValue({
      id: 'uat-wl', name: 'My Stocks', items: [],
    });

    const createRes = await app.inject({
      method: 'POST', url: '/api/watchlist', headers: auth(),
      payload: { name: 'My Stocks' },
    });
    expect(createRes.statusCode).toBe(201);

    mockPrisma.watchlist.findUnique.mockResolvedValue({
      id: 'uat-wl', userId: 'uat-user', name: 'My Stocks', items: [],
    });
    mockPrisma.watchlistItem.findFirst.mockResolvedValue(null);
    mockPrisma.watchlistItem.create.mockResolvedValue({
      id: 'wl-item-1', symbol: 'TCS', exchange: 'NSE',
    });

    const addRes = await app.inject({
      method: 'POST', url: '/api/watchlist/uat-wl/items', headers: auth(),
      payload: { symbol: 'TCS', exchange: 'NSE' },
    });
    expect(addRes.statusCode).toBe(201);

    mockPrisma.watchlistItem.findUnique.mockResolvedValue({
      id: 'wl-item-1', watchlistId: 'uat-wl',
    });
    mockPrisma.watchlistItem.delete.mockResolvedValue({});

    const removeRes = await app.inject({
      method: 'DELETE', url: '/api/watchlist/uat-wl/items/wl-item-1', headers: auth(),
    });
    expect(removeRes.statusCode).toBe(204);
  });
});

describe('UAT Flow 7: Bot Management', () => {
  it('should create bot, start it, assign task, send message', async () => {
    mockPrisma.tradingBot.create.mockResolvedValue({
      id: 'uat-bot', name: 'Scanner Bot', role: 'SCANNER', status: 'IDLE',
    });

    const createRes = await app.inject({
      method: 'POST', url: '/api/bots', headers: auth(),
      payload: { name: 'Scanner Bot', role: 'SCANNER', avatar_emoji: '🔍', description: 'Scans for opportunities', max_capital: 100000 },
    });
    expect(createRes.statusCode).toBe(201);

    mockPrisma.tradingBot.findUnique.mockResolvedValue({
      id: 'uat-bot', userId: 'uat-user', status: 'IDLE',
    });
    mockPrisma.tradingBot.update.mockResolvedValue({
      id: 'uat-bot', status: 'RUNNING',
    });

    const startRes = await app.inject({
      method: 'POST', url: '/api/bots/uat-bot/start', headers: auth(),
    });
    expect(startRes.statusCode).toBe(200);

    mockPrisma.tradingBot.findUnique.mockResolvedValue({
      id: 'uat-bot', userId: 'uat-user',
    });
    mockPrisma.botTask.create.mockResolvedValue({
      id: 'task-1', taskType: 'scan', description: 'Scan NIFTY 50 stocks',
    });

    const taskRes = await app.inject({
      method: 'POST', url: '/api/bots/uat-bot/tasks', headers: auth(),
      payload: { taskType: 'scan', description: 'Scan NIFTY 50 stocks' },
    });
    expect(taskRes.statusCode).toBe(201);

    mockPrisma.botMessage.create.mockResolvedValue({
      id: 'msg-1', content: 'Start scanning banking sector',
    });

    const msgRes = await app.inject({
      method: 'POST', url: '/api/bots/uat-bot/messages', headers: auth(),
      payload: { content: 'Start scanning banking sector' },
    });
    expect(msgRes.statusCode).toBe(201);
  });
});

describe('UAT Flow 8: Backtest Execution', () => {
  it('should run backtest and view results', async () => {
    mockPrisma.backtestResult.create.mockResolvedValue({
      id: 'uat-bt', strategyId: 'ema-crossover', symbol: 'RELIANCE',
      cagr: 18.5, maxDrawdown: 12.3, sharpeRatio: 1.8, winRate: 58,
    });

    const runRes = await app.inject({
      method: 'POST', url: '/api/backtest/run', headers: auth(),
      payload: {
        strategyId: 'ema-crossover', symbol: 'RELIANCE',
        startDate: '2024-01-01', endDate: '2024-12-31',
        initialCapital: 1000000, parameters: { ema_short: 9, ema_long: 21 },
      },
    });
    expect(runRes.statusCode).toBe(201);

    mockPrisma.backtestResult.findMany.mockResolvedValue([
      { id: 'uat-bt', strategyId: 'ema-crossover', cagr: 18.5 },
    ]);

    const resultsRes = await app.inject({
      method: 'GET', url: '/api/backtest/results', headers: auth(),
    });
    expect(resultsRes.statusCode).toBe(200);
    expect(resultsRes.json().length).toBeGreaterThan(0);
  });
});

describe('UAT Flow 9: Settings - Breeze API Credentials', () => {
  it('should save and check Breeze credentials', async () => {
    mockPrisma.breezeCredential.upsert.mockResolvedValue({
      id: 'cred-1', userId: 'uat-user', updatedAt: new Date(),
    });

    const saveRes = await app.inject({
      method: 'POST', url: '/api/auth/breeze-credentials', headers: auth(),
      payload: { api_key: 'my-breeze-key', secret_key: 'my-breeze-secret' },
    });
    expect(saveRes.statusCode).toBe(200);
    expect(saveRes.json().configured).toBe(true);

    mockPrisma.breezeCredential.findUnique.mockResolvedValue({
      userId: 'uat-user', totpSecret: null, updatedAt: new Date(),
    });

    const statusRes = await app.inject({
      method: 'GET', url: '/api/auth/breeze-credentials/status', headers: auth(),
    });
    expect(statusRes.statusCode).toBe(200);
    expect(statusRes.json().configured).toBe(true);
  });
});

describe('UAT Flow 10: Intelligence Dashboard', () => {
  it('should load all intelligence sections', async () => {
    const endpoints = [
      '/api/intelligence/fii-dii',
      '/api/intelligence/sectors/performance',
      '/api/intelligence/global/indices',
      '/api/intelligence/global/us-summary',
      '/api/intelligence/earnings/calendar',
      '/api/intelligence/options/pcr/NIFTY',
      '/api/intelligence/block-deals',
    ];

    const results = await Promise.all(
      endpoints.map((url) => app.inject({ method: 'GET', url })),
    );

    for (const res of results) {
      expect(res.statusCode).toBe(200);
    }
  });
});

describe('UAT Flow 11: Cross-cutting Concerns', () => {
  it('should reject all protected endpoints without auth', async () => {
    const protectedEndpoints = [
      { method: 'GET' as const, url: '/api/auth/me' },
      { method: 'GET' as const, url: '/api/portfolio' },
      { method: 'GET' as const, url: '/api/trades/positions' },
      { method: 'GET' as const, url: '/api/watchlist' },
      { method: 'GET' as const, url: '/api/ai/config' },
      { method: 'GET' as const, url: '/api/bots' },
      { method: 'GET' as const, url: '/api/backtest/results' },
    ];

    const results = await Promise.all(
      protectedEndpoints.map((ep) => app.inject(ep)),
    );

    for (const res of results) {
      expect(res.statusCode).toBe(401);
    }
  });

  it('should allow public endpoints without auth', async () => {
    const publicEndpoints = [
      '/health',
      '/api/market/search?q=reliance',
      '/api/market/vix',
      '/api/market/fii-dii',
      '/api/intelligence/sectors/performance',
    ];

    const results = await Promise.all(
      publicEndpoints.map((url) => app.inject({ method: 'GET', url })),
    );

    for (const res of results) {
      expect(res.statusCode).toBe(200);
    }
  });
});
