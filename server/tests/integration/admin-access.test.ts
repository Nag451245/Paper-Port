import { describe, it, expect, vi, beforeAll, afterAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';
import bcrypt from 'bcryptjs';

// The real per-request account check (tests/setup.ts stubs it for other files).
vi.unmock('../../src/lib/token-revocation.js');

const users = new Map<string, any>();
const seed = () => {
  users.clear();
  const base = { passwordHash: bcrypt.hashSync('Pass12345!', 4), riskAppetite: 'MODERATE', virtualCapital: 1_000_000, isActive: true, createdAt: new Date(), updatedAt: new Date(), passwordChangedAt: null };
  for (const u of [
    { id: 'admin', email: 'nagender1.p@gmail.com', fullName: 'Admin', role: 'ADMIN', status: 'ACTIVE' },
    { id: 'alice', email: 'alice@example.com', fullName: 'Alice', role: 'LEARNER', status: 'PENDING', isActive: false },
    { id: 'bob', email: 'bob@example.com', fullName: 'Bob', role: 'LEARNER', status: 'ACTIVE' },
    { id: 'carl', email: 'carl@example.com', fullName: 'Carl', role: 'LEARNER', status: 'BLOCKED', isActive: false },
  ]) users.set(u.id, { ...base, ...u });
};

vi.mock('../../src/lib/prisma.js', () => {
  const byWhere = (w: any) => [...users.values()].find((u) => (w.id ? u.id === w.id : w.email?.equals
    ? u.email.toLowerCase() === String(w.email.equals).toLowerCase() : u.email === w.email)) ?? null;
  const mock = {
    user: {
      findUnique: vi.fn(async ({ where }: any) => byWhere(where)),
      findFirst: vi.fn(async ({ where }: any) => byWhere(where)),
      findMany: vi.fn(async () => [...users.values()]),
      update: vi.fn(async ({ where, data }: any) => Object.assign(users.get(where.id), data)),
      updateMany: vi.fn(async () => ({ count: 0 })),
      delete: vi.fn(async ({ where }: any) => { const u = users.get(where.id); users.delete(where.id); return u; }),
    },
    portfolio: { findMany: vi.fn().mockResolvedValue([{ id: 'p-bob' }]) },
    tradingBot: { findMany: vi.fn().mockResolvedValue([{ id: 'bot-bob' }]), updateMany: vi.fn().mockResolvedValue({ count: 1 }), deleteMany: vi.fn().mockResolvedValue({ count: 1 }) },
    botMessage: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    order: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    trade: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    strategyExitPlan: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    optionBacktestRun: { deleteMany: vi.fn().mockResolvedValue({ count: 0 }) },
    notification: { create: vi.fn().mockResolvedValue({}) },
    breezeCredential: { findUnique: vi.fn().mockResolvedValue(null), findMany: vi.fn().mockResolvedValue([]) },
    brokerAccount: { findMany: vi.fn().mockResolvedValue([]), findFirst: vi.fn() },
    $transaction: vi.fn(async (ops: Promise<unknown>[]) => Promise.all(ops)),
    $disconnect: vi.fn(), $connect: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]), $queryRawUnsafe: vi.fn().mockResolvedValue([{ 1: 1 }]),
  };
  return { getPrisma: vi.fn(() => mock), disconnectPrisma: vi.fn(), __mockPrisma: mock };
});

let app: FastifyInstance;
let prisma: any;
const as = (id: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub: id })}` });

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js');
  prisma = ((await import('../../src/lib/prisma.js')) as any).__mockPrisma;
  app = await buildApp({ logger: false });
  await app.ready();
}, 30_000);
afterAll(async () => { await app.close(); });
beforeEach(async () => {
  seed();
  (await import('../../src/lib/token-revocation.js')).clearRevocationCache();
});

describe('administrator', () => {
  it('only the administrator sees the user list, waiting sign-ups first', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/admin/users', headers: as('bob') })).statusCode).toBe(403);
    const res = await app.inject({ method: 'GET', url: '/api/admin/users', headers: as('admin') });
    expect(res.statusCode).toBe(200);
    expect(res.json().users.map((u: any) => u.status)).toEqual(['PENDING', 'ACTIVE', 'ACTIVE', 'BLOCKED']);
  });

  it('a pending sign-up cannot use the app until approved', async () => {
    const before = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as('alice') });
    expect(before.statusCode).toBe(401);
    expect(before.json().error).toMatch(/waiting for the administrator/);

    expect((await app.inject({ method: 'POST', url: '/api/admin/users/alice/approve', headers: as('admin') })).statusCode).toBe(200);
    expect(users.get('alice')).toMatchObject({ status: 'ACTIVE', isActive: true });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as('alice') })).statusCode).toBe(200);
  });

  it('blocking signs the user out on their very next request and stops their bots', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as('bob') })).statusCode).toBe(200);   // cached as active
    await app.inject({ method: 'POST', url: '/api/admin/users/bob/block', headers: as('admin') });
    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as('bob') });
    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/blocked/);
    expect(prisma.tradingBot.updateMany).toHaveBeenCalledWith(expect.objectContaining({ where: { userId: 'bob', status: 'RUNNING' } }));

    await app.inject({ method: 'POST', url: '/api/admin/users/bob/unblock', headers: as('admin') });
    expect((await app.inject({ method: 'GET', url: '/api/auth/me', headers: as('bob') })).statusCode).toBe(200);
  });

  it('pending and blocked users are told why at sign-in, but only after a correct password', async () => {
    const login = (email: string, password: string) => app.inject({ method: 'POST', url: '/api/auth/login', payload: { email, password } });
    expect((await login('alice@example.com', 'Pass12345!')).json().error).toMatch(/waiting for the administrator/);
    expect((await login('carl@example.com', 'Pass12345!')).json().error).toMatch(/blocked/);
    expect((await login('carl@example.com', 'wrong-password')).json().error).toBe('Invalid email or password');
  });

  it('deleting removes the user and their data, and their token stops working', async () => {
    const res = await app.inject({ method: 'DELETE', url: '/api/admin/users/bob', headers: as('admin') });
    expect(res.statusCode).toBe(200);
    expect(users.has('bob')).toBe(false);
    expect(prisma.order.deleteMany).toHaveBeenCalledWith({ where: { portfolioId: { in: ['p-bob'] } } });
    const after = await app.inject({ method: 'GET', url: '/api/auth/me', headers: as('bob') });
    expect(after.statusCode).toBe(401);
    expect(after.json().error).toMatch(/no longer exists/);
  });

  it('the administrator cannot block or delete their own account, and nobody else can act', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/admin/users/admin/block', headers: as('admin') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'DELETE', url: '/api/admin/users/admin', headers: as('admin') })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/admin/users/alice/approve', headers: as('bob') })).statusCode).toBe(403);
    expect(users.get('alice').status).toBe('PENDING');
  });
});

describe('other loopholes closed', () => {
  it('engine controls shared by every user are administrator-only', async () => {
    for (const [method, url] of [['POST', '/api/engine/kill-switch'], ['POST', '/api/engine/oms/cancel-all'], ['POST', '/api/engine/oms/orders']] as const) {
      expect((await app.inject({ method, url, headers: as('bob'), payload: {} })).statusCode).toBe(403);
      expect((await app.inject({ method, url, headers: as('admin'), payload: {} })).statusCode).not.toBe(403);
    }
  });

  it('a query string can no longer skip the Edge Lab sign-in check', async () => {
    expect((await app.inject({ method: 'GET', url: '/api/edge/shadow?x=/market-status' })).statusCode).toBe(401);
  });

  it('engine and Edge Lab routes refuse a blocked account too', async () => {
    users.get('bob').status = 'BLOCKED';
    expect((await app.inject({ method: 'GET', url: '/api/engine/strategies', headers: as('bob') })).statusCode).toBe(401);
    expect((await app.inject({ method: 'GET', url: '/api/edge/shadow', headers: as('bob') })).statusCode).toBe(401);
  });
});
