import { describe, it, expect, beforeAll, afterAll, vi } from 'vitest';
import type { FastifyInstance } from 'fastify';

// A small allowance so the test reaches it quickly.
process.env.RATE_LIMIT_MAX = '5';

vi.mock('../../src/lib/prisma.js', () => {
  const mock = {
    user: { findUnique: vi.fn().mockResolvedValue(null), findFirst: vi.fn().mockResolvedValue(null) },
    $disconnect: vi.fn(), $connect: vi.fn(), $queryRaw: vi.fn().mockResolvedValue([{ 1: 1 }]),
  };
  return { getPrisma: vi.fn(() => mock), disconnectPrisma: vi.fn() };
});

let app: FastifyInstance;
beforeAll(async () => {
  const { buildApp } = await import('../../src/app.js');
  app = await buildApp({ logger: false });
  await app.ready();
}, 30_000);
afterAll(async () => { await app.close(); });

const hit = (headers: Record<string, string>) => app.inject({ method: 'GET', url: '/health', headers });
const as = (sub: string) => ({ authorization: `Bearer ${app.jwt.sign({ sub })}` });

describe('rate limit', () => {
  it('each signed-in user has their own allowance, even when every request comes through nginx', async () => {
    for (let i = 0; i < 5; i++) expect((await hit(as('alice'))).statusCode).toBe(200);
    expect((await hit(as('alice'))).statusCode).toBe(429);
    // Bob, through the same proxy address, is unaffected by Alice.
    expect((await hit(as('bob'))).statusCode).toBe(200);
  });

  it('a forged token cannot spend someone else\'s allowance', async () => {
    const forged = { authorization: 'Bearer eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiJjYXJvbCJ9.bad' };
    for (let i = 0; i < 6; i++) await hit(forged);
    expect((await hit(as('carol'))).statusCode).toBe(200);
  });

  it('visitors who are not signed in are told apart by the address nginx passes on', async () => {
    for (let i = 0; i < 5; i++) await hit({ 'x-forwarded-for': '203.0.113.7' });
    expect((await hit({ 'x-forwarded-for': '203.0.113.7' })).statusCode).toBe(429);
    expect((await hit({ 'x-forwarded-for': '198.51.100.9' })).statusCode).toBe(200);
  });
});
