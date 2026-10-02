import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BrokerAccountsService, BrokerError, nextUpstoxExpiry } from '../../src/services/broker-accounts.service.js';
import { createBreezeState } from '../../src/lib/oauth-state.js';
import { encrypt } from '../../src/services/auth.service.js';
import { env } from '../../src/config.js';

const prisma = {
  user: { findUnique: vi.fn(), update: vi.fn() },
  brokerAccount: { findMany: vi.fn(), findUnique: vi.fn(), findFirst: vi.fn(), upsert: vi.fn(), update: vi.fn(), deleteMany: vi.fn() },
  breezeCredential: { findUnique: vi.fn() },
} as any;

const enc = (v: string) => encrypt(v, env.ENCRYPTION_KEY);

describe('BrokerAccountsService', () => {
  beforeEach(() => {
    for (const model of Object.values(prisma)) for (const fn of Object.values(model as object)) (fn as any).mockReset();
  });

  it('expires Upstox tokens at the next 3:30 AM in India', () => {
    expect(nextUpstoxExpiry(new Date('2026-10-01T10:00:00+05:30')).toISOString()).toBe('2026-10-01T22:00:00.000Z');
    expect(nextUpstoxExpiry(new Date('2026-10-02T02:00:00+05:30')).toISOString()).toBe('2026-10-01T22:00:00.000Z');
  });

  it('stores keys encrypted, and new app keys drop the old login', async () => {
    await new BrokerAccountsService(prisma).save('u1', 'upstox', { apiKey: 'my-key', apiSecret: 'my-secret', clientId: 'ignored' });
    const { create, update } = prisma.brokerAccount.upsert.mock.calls[0][0];
    expect(JSON.stringify(create)).not.toMatch(/my-key|my-secret|ignored/);
    expect(update).toMatchObject({ encryptedAccessToken: null, tokenExpiresAt: null });
  });

  it('refuses to make a broker active that cannot supply data, or Upstox before its login', async () => {
    const svc = new BrokerAccountsService(prisma);
    await expect(svc.setActive('u1', 'zerodha')).rejects.toThrow(/cannot supply market data/);
    prisma.brokerAccount.findUnique.mockResolvedValue({ encryptedAccessToken: null });
    await expect(svc.setActive('u1', 'upstox')).rejects.toBeInstanceOf(BrokerError);
    expect(prisma.user.update).not.toHaveBeenCalled();
  });

  it('builds the login link for Upstox\'s own site with a single-use state', async () => {
    prisma.brokerAccount.findUnique.mockResolvedValue({ encryptedApiKey: enc('the-key'), encryptedApiSecret: enc('s') });
    const { loginUrl, redirectUri } = await new BrokerAccountsService(prisma).upstoxLoginUrl('u1');
    const url = new URL(loginUrl);
    expect(url.origin + url.pathname).toBe('https://api.upstox.com/v2/login/authorization/dialog');
    expect(url.searchParams.get('client_id')).toBe('the-key');
    expect(url.searchParams.get('redirect_uri')).toBe(redirectUri);
    expect(url.searchParams.get('state')).toMatch(/^[\w-]{20,}$/);
    expect(redirectUri).toMatch(/\/api\/brokers\/upstox\/callback$/);
  });

  it('swaps the code for a token, stores it encrypted and makes Upstox active', async () => {
    prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', encryptedApiKey: enc('the-key'), encryptedApiSecret: enc('the-secret') });
    const fetchImpl = vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ access_token: 'upstox-token' }) });
    const state = await createBreezeState('u1');

    await new BrokerAccountsService(prisma, fetchImpl as any).upstoxCallback('one-time-code', state);

    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('https://api.upstox.com/v2/login/authorization/token');
    expect(Object.fromEntries(init.body)).toMatchObject({
      code: 'one-time-code', client_id: 'the-key', client_secret: 'the-secret', grant_type: 'authorization_code',
    });
    const saved = prisma.brokerAccount.update.mock.calls[0][0].data;
    expect(saved.encryptedAccessToken).not.toContain('upstox-token');
    expect(prisma.user.update).toHaveBeenCalledWith({ where: { id: 'u1' }, data: { activeBroker: 'upstox' } });
  });

  it('refuses a callback whose state was never issued or is already used', async () => {
    const svc = new BrokerAccountsService(prisma, vi.fn() as any);
    await expect(svc.upstoxCallback('code', 'made-up-state')).rejects.toThrow(/expired/);
    const state = await createBreezeState('u1');
    prisma.brokerAccount.findUnique.mockResolvedValue({ id: 'a1', encryptedApiKey: enc('k'), encryptedApiSecret: enc('s') });
    const ok = new BrokerAccountsService(prisma, vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ access_token: 't' }) }) as any);
    await ok.upstoxCallback('code', state);
    await expect(ok.upstoxCallback('code', state)).rejects.toThrow(/expired/);
  });

  it('hands out an Upstox token only for users who made Upstox active', async () => {
    prisma.brokerAccount.findFirst.mockResolvedValue({ encryptedAccessToken: enc('live-token') });
    expect(await new BrokerAccountsService(prisma).upstoxToken('u-token-test')).toBe('live-token');
    expect(prisma.brokerAccount.findFirst.mock.calls[0][0].where).toMatchObject({
      broker: 'upstox', userId: 'u-token-test', user: { activeBroker: 'upstox' },
    });
  });
});
