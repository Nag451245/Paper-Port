import { describe, it, expect, vi, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';

let app: FastifyInstance;

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: { findUnique: vi.fn().mockResolvedValue({ activeBroker: 'breeze' }), update: vi.fn() },
    brokerAccount: { findMany: vi.fn().mockResolvedValue([]), findUnique: vi.fn(), findFirst: vi.fn(), update: vi.fn() },
    breezeCredential: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    $disconnect: vi.fn(),
    $connect: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ 1: 1 }]),
  };
  return { getPrisma: vi.fn(() => mock), disconnectPrisma: vi.fn(), __mockPrisma: mock };
});

let mockPrisma: any;

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js');
  mockPrisma = ((await import('../../src/lib/prisma.js')) as any).__mockPrisma;
  app = await buildApp({ logger: false });
  await app.ready();
}, 30_000);

afterAll(async () => { await app.close(); });

describe('/api/brokers', () => {
  it('needs a signed-in user', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/brokers' })).statusCode).toBe(401);
  });

  it('lists every broker with what it can do and the active one', async () => {
    const token = app.jwt.sign({ sub: 'u1' });
    const res = await app.inject({ method: 'GET', url: '/api/brokers', headers: { authorization: `Bearer ${token}` } });
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.active).toBe('breeze');
    expect(body.brokers.map((b: any) => b.id)).toEqual(['breeze', 'upstox', 'zerodha', 'fyers', 'dhan']);
    expect(body.brokers.find((b: any) => b.id === 'upstox').marketData).toBe(true);
    expect(body.redirectUris.upstox).toMatch(/\/api\/brokers\/upstox\/callback$/);
  });

  it('sends the browser back to the app\'s own Settings page, whatever Host the request claims', async () => {
    const res = await app.inject({
      method: 'GET', url: '/api/brokers/upstox/callback?code=x&state=never-issued',
      headers: { host: 'evil.example', 'x-forwarded-host': 'evil.example' },
    });
    expect(res.statusCode).toBe(302);
    const location = new URL(res.headers.location as string);
    expect(location.host).not.toBe('evil.example');
    expect(location.pathname).toBe('/settings');
    expect(Object.fromEntries(location.searchParams)).toMatchObject({ broker: 'upstox', status: 'error' });
  });

  it('answers the notifier webhook the same way whatever is posted, and saves nothing unverified', async () => {
    const forged = await app.inject({
      method: 'POST', url: '/api/brokers/upstox/notifier',
      payload: { client_id: 'guess', user_id: 'guess', access_token: 'attacker-token', message_type: 'access_token' },
    });
    const junk = await app.inject({ method: 'POST', url: '/api/brokers/upstox/notifier', payload: { hello: 'world' } });
    expect(forged.statusCode).toBe(200);
    expect(forged.json()).toEqual(junk.json());
    expect(mockPrisma.brokerAccount.update).not.toHaveBeenCalled();
  });

  it('needs a signed-in user to send the phone approval request', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/brokers/upstox/request-token' })).statusCode).toBe(401);
  });
});
