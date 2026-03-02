import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;
let mockPrisma: any;
let authToken: string;

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletion: vi.fn().mockResolvedValue('Mock AI response'),
  chatCompletionJSON: vi.fn().mockResolvedValue({}),
  getOpenAIStatus: vi.fn().mockReturnValue({ circuitOpen: false, queueLength: 0, recentRequests: 0, cooldownRemainingMs: 0 }),
  _resetForTesting: vi.fn(),
}));

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: { findUnique: vi.fn() },
    breezeCredential: { findUnique: vi.fn(), upsert: vi.fn() },
    portfolio: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), findFirst: vi.fn() },
    position: { findUnique: vi.fn(), findMany: vi.fn(), findFirst: vi.fn(), create: vi.fn(), update: vi.fn() },
    order: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), count: vi.fn() },
    trade: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), count: vi.fn() },
    watchlist: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), delete: vi.fn() },
    watchlistItem: { findUnique: vi.fn(), findFirst: vi.fn(), create: vi.fn(), delete: vi.fn() },
    aIAgentConfig: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    aITradeSignal: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), create: vi.fn() },
    tradingBot: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn(), delete: vi.fn() },
    botMessage: { findMany: vi.fn(), create: vi.fn() },
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

  authToken = app.jwt.sign({ sub: 'test-user-123', email: 'test@example.com' });
});

afterAll(async () => {
  await app.close();
});

beforeEach(() => {
  vi.clearAllMocks();
  mockPrisma.user.findUnique.mockResolvedValue({
    id: 'test-user-123', email: 'test@example.com', name: 'Test User', riskAppetite: 'MODERATE',
  });
});

describe('GET /api/options/templates', () => {
  it('should return all 17 templates', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/options/templates',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.length).toBe(17);
  });
});

describe('GET /api/options/templates/:id', () => {
  it('should return a specific template', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/options/templates/iron-condor',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.name).toBe('Iron Condor');
    expect(data.legs.length).toBe(4);
  });

  it('should return 404 for unknown template', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/options/templates/nonexistent',
    });
    expect(res.statusCode).toBe(404);
  });
});

describe('GET /api/options/templates/category/:category', () => {
  it('should filter templates by bullish category', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/options/templates/category/bullish',
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.length).toBeGreaterThan(0);
    for (const t of data) {
      expect(t.category).toBe('bullish');
    }
  });

  it('should return empty array for unknown category', async () => {
    const res = await app.inject({
      method: 'GET',
      url: '/api/options/templates/category/unknown',
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual([]);
  });
});

describe('POST /api/options/payoff', () => {
  it('should return payoff curve and greeks for valid legs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/options/payoff',
      payload: {
        legs: [{ type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 }],
        spotPrice: 100,
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.payoffCurve).toBeDefined();
    expect(data.payoffCurve.length).toBeGreaterThan(0);
    expect(data.greeks).toBeDefined();
    expect(data.greeks).toHaveProperty('delta');
    expect(data.greeks).toHaveProperty('netPremium');
  });

  it('should return 400 for empty legs', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/options/payoff',
      payload: { legs: [], spotPrice: 100 },
    });
    expect(res.statusCode).toBe(400);
  });

  it('should return 400 for invalid data', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/options/payoff',
      payload: { legs: 'invalid', spotPrice: -5 },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/options/max-pain', () => {
  it('should compute correct max pain strike', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/options/max-pain',
      payload: {
        strikes: [90, 95, 100, 105, 110],
        callOI: { '90': 100, '95': 200, '100': 500, '105': 300, '110': 100 },
        putOI: { '90': 50, '95': 150, '100': 400, '105': 200, '110': 300 },
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.maxPainStrike).toBeDefined();
    expect(data.painByStrike).toBeDefined();
    expect(data.painByStrike.length).toBe(5);
  });

  it('should return 400 for missing fields', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/options/max-pain',
      payload: { strikes: [100] },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/options/explain', () => {
  it('should return explanation text with greeks', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/options/explain',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        strategyName: 'Long Call',
        legs: [{ type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 }],
        spotPrice: 100,
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.explanation).toContain('Long Call');
    expect(data.greeks).toBeDefined();
  });

  it('should return 400 when strategyName is missing', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/options/explain',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        legs: [{ type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 }],
        spotPrice: 100,
      },
    });
    expect(res.statusCode).toBe(400);
  });
});

describe('POST /api/options/scenario', () => {
  it('should return scenario results', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/options/scenario',
      headers: { authorization: `Bearer ${authToken}` },
      payload: {
        legs: [{ type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 }],
        spotPrice: 100,
        scenarios: [
          { spotChange: 5, ivChange: 0, daysElapsed: 0 },
          { spotChange: -5, ivChange: 10, daysElapsed: 3 },
        ],
      },
    });
    expect(res.statusCode).toBe(200);
    const data = res.json();
    expect(data.length).toBe(2);
    expect(data[0]).toHaveProperty('label');
    expect(data[0]).toHaveProperty('pnl');
  });

  it('should require authentication', async () => {
    const res = await app.inject({
      method: 'POST',
      url: '/api/options/scenario',
      payload: {
        legs: [{ type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 }],
        spotPrice: 100,
        scenarios: [{ spotChange: 5, ivChange: 0, daysElapsed: 0 }],
      },
    });
    expect(res.statusCode).toBe(401);
  });
});
