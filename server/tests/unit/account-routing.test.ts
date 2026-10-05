import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import Fastify from 'fastify';

const users = { findFirst: vi.fn() };
vi.mock('../../src/lib/prisma.js', () => ({ getPrisma: () => ({ user: users }) }));

import { env } from '../../src/config.js';
import { currentAccount, runAs, installAccountContext, setRequestAccount, ownerAccountId, forgetOwner, brokerAccount, isOwnerWork } from '../../src/lib/account-context.js';
import { bridgeAccountKey, bridgeFetch, credentialAccount, accountScoped } from '../../src/lib/bridge.js';

const OWNER = 'owner-id', MOIN = 'moin-id';

describe('work is done for an account', () => {
  const before = env.REQUIRE_OWN_BROKER;
  beforeEach(() => {
    forgetOwner();
    users.findFirst.mockReset().mockResolvedValue({ id: OWNER });
    (env as any).REQUIRE_OWN_BROKER = 'true';
  });
  afterAll(() => { (env as any).REQUIRE_OWN_BROKER = before; });

  it('carries the account through awaits and timers, and keeps concurrent work apart', async () => {
    expect(currentAccount()).toBeNull();
    const seen = await Promise.all([OWNER, MOIN, 'third'].map((id, i) => runAs(id, async () => {
      await new Promise((r) => setTimeout(r, 15 - i * 5));
      await Promise.resolve();
      return currentAccount();
    })));
    expect(seen).toEqual([OWNER, MOIN, 'third']);
    expect(currentAccount()).toBeNull();
    // Nested work for someone else is theirs, then it is ours again.
    await runAs(OWNER, async () => {
      expect(await runAs(MOIN, async () => currentAccount())).toBe(MOIN);
      expect(currentAccount()).toBe(OWNER);
    });
  });

  it('gives each web request its own account, including after a request body is read', async () => {
    const app = Fastify();
    installAccountContext(app);
    app.addHook('preHandler', async (request) => { setRequestAccount(String(request.headers['x-test-user'])); });
    const handler = async () => { await new Promise((r) => setTimeout(r, 5)); return { account: currentAccount(), key: await bridgeAccountKey() }; };
    app.get('/who', handler);
    app.post('/who', handler);
    const answers = await Promise.all([
      app.inject({ method: 'GET', url: '/who', headers: { 'x-test-user': OWNER } }),
      app.inject({ method: 'POST', url: '/who', headers: { 'x-test-user': MOIN }, payload: { some: 'body' } }),
      app.inject({ method: 'POST', url: '/who', headers: { 'x-test-user': 'third' }, payload: { big: 'x'.repeat(50_000) } }),
    ]);
    expect(answers.map((a) => a.json())).toEqual([
      { account: OWNER, key: '' },          // the owner's calls go out exactly as before
      { account: MOIN, key: MOIN },
      { account: 'third', key: 'third' },
    ]);
    expect(currentAccount()).toBeNull();
    await app.close();
  });

  it('the server\u2019s own work uses the owner\u2019s broker; an account\u2019s work uses only its own', async () => {
    expect(await ownerAccountId()).toBe(OWNER);
    expect(await brokerAccount()).toBe(OWNER);                    // no account: the owner
    expect(await isOwnerWork()).toBe(true);
    expect(await credentialAccount()).toBe(OWNER);
    expect(await bridgeAccountKey()).toBe('');
    await runAs(MOIN, async () => {
      expect(await isOwnerWork()).toBe(false);
      expect(await credentialAccount()).toBe(MOIN);               // never falls back to anyone else
      expect(await bridgeAccountKey()).toBe(MOIN);
    });
  });

  it('names the account on bridge calls, except the owner\u2019s', async () => {
    const calls: [string, RequestInit | undefined][] = [];
    const real = globalThis.fetch;
    globalThis.fetch = (async (url: string, init?: RequestInit) => { calls.push([url, init]); return new Response('{}'); }) as typeof fetch;
    try {
      await bridgeFetch('http://bridge/quote/SBIN', { signal: undefined });
      await runAs(OWNER, () => bridgeFetch('http://bridge/quote/SBIN'));
      await runAs(MOIN, () => bridgeFetch('http://bridge/quote/SBIN', { headers: { 'Content-Type': 'application/json' } }));
    } finally { globalThis.fetch = real; }
    expect((calls[0][1]?.headers as any)?.['X-Account']).toBeUndefined();
    expect((calls[1][1]?.headers as any)?.['X-Account']).toBeUndefined();
    expect(calls[2][1]?.headers).toEqual({ 'Content-Type': 'application/json', 'X-Account': MOIN });
  });

  it('keeps cached prices per account, with the owner\u2019s keys unchanged', async () => {
    const store = new Map<string, unknown>();
    const cache = accountScoped({
      get: async (k: string) => store.get(k) ?? null, set: async (k: string, v: unknown) => { store.set(k, v); },
      del: async () => {}, exists: async () => false, ttl: async () => 0,
    } as any);
    await cache.set('quote:NSE:SBIN', { ltp: 960 });
    await runAs(MOIN, () => cache.set('quote:NSE:SBIN', { ltp: 961 }));
    expect([...store.keys()].sort()).toEqual([`acct:${MOIN}:quote:NSE:SBIN`, 'quote:NSE:SBIN']);
    expect(await cache.get('quote:NSE:SBIN')).toEqual({ ltp: 960 });
    expect(await runAs(MOIN, () => cache.get('quote:NSE:SBIN'))).toEqual({ ltp: 961 });
    expect(await runAs('third', () => cache.get('quote:NSE:SBIN'))).toBeNull();
  });

  it('goes back to one shared login when the rule is switched off', async () => {
    (env as any).REQUIRE_OWN_BROKER = 'false';
    await runAs(MOIN, async () => {
      expect(await bridgeAccountKey()).toBe('');
      expect(await credentialAccount()).toBeUndefined();
    });
  });
});
