import { describe, it, expect, vi, beforeEach, beforeAll, afterAll } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { createHash } from 'crypto';
import bcrypt from 'bcryptjs';

let app: FastifyInstance;
let mockPrisma: any;

const sendMail = vi.fn();
vi.mock('../../src/lib/mailer.js', () => ({
  sendMail: (msg: unknown) => sendMail(msg),
  isMailConfigured: () => true,
}));

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    passwordResetToken: {
      count: vi.fn(), create: vi.fn(), updateMany: vi.fn(), findUnique: vi.fn(),
    },
    breezeCredential: { findUnique: vi.fn(), findMany: vi.fn() },
    portfolio: { findUnique: vi.fn(), findMany: vi.fn(), create: vi.fn() },
    $disconnect: vi.fn(),
    $connect: vi.fn(),
    $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
    $queryRawUnsafe: vi.fn().mockResolvedValue([{ 1: 1 }]),
  };
  return { getPrisma: vi.fn(() => mock), disconnectPrisma: vi.fn(), __mockPrisma: mock };
});

const sha256 = (s: string) => createHash('sha256').update(s).digest('hex');
const USER = { id: 'u-1', email: 'trader@example.com', fullName: 'Trader', isActive: true, passwordHash: 'x' };
const flush = () => new Promise((r) => setTimeout(r, 10));

beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js');
  mockPrisma = ((await import('../../src/lib/prisma.js')) as any).__mockPrisma;
  app = await buildApp({ logger: false });
  await app.ready();
}, 30_000);

afterAll(async () => { await app.close(); });

beforeEach(async () => {
  vi.resetAllMocks();
  sendMail.mockResolvedValue(true);
  mockPrisma.passwordResetToken.count.mockResolvedValue(0);
  mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 1 });
  mockPrisma.passwordResetToken.create.mockResolvedValue({});
  (await import('../../src/lib/token-revocation.js')).clearRevocationCache();
});

const forgot = (email: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'POST', url: '/api/auth/forgot-password', payload: { email }, headers });

describe('POST /api/auth/forgot-password', () => {
  it('gives the same answer for an unknown email and sends nothing', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(null);
    const unknown = await forgot('nobody@example.com');
    await flush();

    mockPrisma.user.findUnique.mockResolvedValue(USER);
    const known = await forgot(USER.email);
    await flush();

    expect(unknown.statusCode).toBe(200);
    expect(unknown.json()).toEqual(known.json());
    expect(sendMail).toHaveBeenCalledTimes(1);
  });

  it('stores only a hash of the token and emails a link built from config, not the Host header', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    await forgot(USER.email, { host: 'evil.example', 'x-forwarded-host': 'evil.example' });
    await flush();

    const link: string = sendMail.mock.calls[0][0].text.match(/https?:\/\/\S+/)[0];
    expect(link).not.toContain('evil.example');
    const token = new URL(link).searchParams.get('token')!;
    const stored = mockPrisma.passwordResetToken.create.mock.calls[0][0].data;
    expect(stored.tokenHash).toBe(sha256(token));
    expect(JSON.stringify(stored)).not.toContain(token);
    expect(stored.expiresAt.getTime() - Date.now()).toBeLessThanOrEqual(30 * 60 * 1000);
  });

  it('supersedes earlier unused links for that user', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    await forgot(USER.email);
    expect(mockPrisma.passwordResetToken.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({ where: { userId: USER.id, usedAt: null } }),
    );
  });

  it('stops issuing links after 3 in an hour', async () => {
    mockPrisma.user.findUnique.mockResolvedValue(USER);
    mockPrisma.passwordResetToken.count.mockResolvedValue(3);
    const res = await forgot(USER.email);
    await flush();
    expect(res.statusCode).toBe(200);
    expect(mockPrisma.passwordResetToken.create).not.toHaveBeenCalled();
    expect(sendMail).not.toHaveBeenCalled();
  });
});

describe('POST /api/auth/reset-password', () => {
  const TOKEN = 'a'.repeat(43);
  const reset = (password = 'new-password-1', token = TOKEN) =>
    app.inject({ method: 'POST', url: '/api/auth/reset-password', payload: { token, password } });
  const row = (over: Record<string, unknown> = {}) => ({
    id: 't-1', userId: USER.id, usedAt: null, expiresAt: new Date(Date.now() + 60_000), user: USER, ...over,
  });

  it('sets the new password, records when, and uses the link up', async () => {
    mockPrisma.passwordResetToken.findUnique.mockResolvedValue(row());
    mockPrisma.user.update.mockResolvedValue({});

    const res = await reset();

    expect(res.statusCode).toBe(200);
    expect(mockPrisma.passwordResetToken.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({ where: { tokenHash: sha256(TOKEN) } }),
    );
    const data = mockPrisma.user.update.mock.calls[0][0].data;
    expect(await bcrypt.compare('new-password-1', data.passwordHash)).toBe(true);
    expect(data.passwordChangedAt).toBeInstanceOf(Date);
  });

  it.each([
    ['unknown', null],
    ['expired', row({ expiresAt: new Date(Date.now() - 1000) })],
    ['already used', row({ usedAt: new Date() })],
  ])('refuses an %s link', async (_label, found) => {
    mockPrisma.passwordResetToken.findUnique.mockResolvedValue(found);
    const res = await reset();
    expect(res.statusCode).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('lets only one of two simultaneous submissions win', async () => {
    mockPrisma.passwordResetToken.findUnique.mockResolvedValue(row());
    mockPrisma.passwordResetToken.updateMany.mockResolvedValue({ count: 0 });   // the other one claimed it
    const res = await reset();
    expect(res.statusCode).toBe(400);
    expect(mockPrisma.user.update).not.toHaveBeenCalled();
  });

  it('refuses a short password', async () => {
    const res = await reset('short');
    expect(res.statusCode).toBe(400);
  });
});

describe('sessions after a password change', () => {
  it('refuses a sign-in token issued before the change', async () => {
    const changedAt = new Date();
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER, passwordChangedAt: changedAt });
    const old = app.jwt.sign({ sub: USER.id, iat: Math.floor(changedAt.getTime() / 1000) - 3600 });

    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${old}` } });

    expect(res.statusCode).toBe(401);
    expect(res.json().error).toMatch(/password was changed/);
  });

  it('accepts a token issued after the change', async () => {
    const changedAt = new Date(Date.now() - 3600_000);
    mockPrisma.user.findUnique.mockResolvedValue({ ...USER, passwordChangedAt: changedAt });
    const fresh = app.jwt.sign({ sub: USER.id });

    const res = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${fresh}` } });

    expect(res.statusCode).not.toBe(401);
  });
});
