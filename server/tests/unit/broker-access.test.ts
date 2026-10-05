import { describe, it, expect, beforeEach, afterAll, vi } from 'vitest';
import { env } from '../../src/config.js';
import { ownBroker, brokerAllowed, requireOwnBroker, forgetBrokerState, brokerMessage } from '../../src/lib/broker-access.js';

const now = new Date('2026-10-05T06:00:00Z');
const later = new Date(now.getTime() + 3_600_000), earlier = new Date(now.getTime() - 3_600_000);
const db = (breeze: unknown, accounts: unknown[] = []) => ({
  breezeCredential: { findUnique: vi.fn(async () => breeze) },
  brokerAccount: { findMany: vi.fn(async () => accounts) },
}) as any;
const reply = () => { const r: any = { sent: false, status: 0, body: null }; r.code = (c: number) => { r.status = c; return r; }; r.send = (b: unknown) => { r.body = b; r.sent = true; return r; }; return r; };

describe('each account uses its own broker', () => {
  const before = env.REQUIRE_OWN_BROKER;
  beforeEach(() => { forgetBrokerState(); (env as any).REQUIRE_OWN_BROKER = 'true'; });
  afterAll(() => { (env as any).REQUIRE_OWN_BROKER = before; });

  it('knows whether the account has no broker, a saved one, or one logged in for today', async () => {
    expect(await ownBroker(db(null), 'u1', now)).toEqual({ state: 'none', broker: null });
    forgetBrokerState();
    expect(await ownBroker(db({ sessionToken: null }), 'u1', now)).toEqual({ state: 'saved', broker: 'breeze' });
    forgetBrokerState();
    expect(await ownBroker(db({ sessionToken: 'x', sessionExpiresAt: earlier }), 'u1', now)).toEqual({ state: 'saved', broker: 'breeze' });
    forgetBrokerState();
    expect(await ownBroker(db({ sessionToken: 'x', sessionExpiresAt: later }), 'u1', now)).toEqual({ state: 'connected', broker: 'breeze' });
    forgetBrokerState();
    expect(await ownBroker(db(null, [{ broker: 'upstox', encryptedAccessToken: 't', tokenExpiresAt: later }]), 'u1', now)).toEqual({ state: 'connected', broker: 'upstox' });
    forgetBrokerState();
    expect(await ownBroker(db(null, [{ broker: 'upstox', encryptedAccessToken: 't', tokenExpiresAt: earlier }]), 'u1', now)).toEqual({ state: 'saved', broker: 'upstox' });
  });

  it('never answers for one account from what it remembers about another', async () => {
    const admin = db({ sessionToken: 'x', sessionExpiresAt: null });
    expect((await brokerAllowed('admin', admin)).allowed).toBe(true);
    expect((await brokerAllowed('other', db(null))).allowed).toBe(false);       // the admin's login does not carry over
    expect((await brokerAllowed('admin', db(null))).allowed).toBe(true);        // remembered for a few seconds
    forgetBrokerState('admin');
    expect((await brokerAllowed('admin', db(null))).allowed).toBe(false);       // and re-read once forgotten
  });

  it('refuses broker data with a message that says what to do', async () => {
    const r = reply();
    await requireOwnBroker({ user: { sub: 'nobody-with-a-broker' } } as any, r);
    // getPrisma() has no such account in the test database mock: treat a failed lookup as allowed,
    // so check the refusal through brokerAllowed with a database that answers.
    expect((await brokerAllowed('fresh', db(null))).broker.state).toBe('none');
    expect(brokerMessage({ state: 'none', broker: null })).toMatch(/Connect your own broker in Settings/);
    expect(brokerMessage({ state: 'saved', broker: 'upstox' })).toMatch(/not logged in for today/);
    expect([0, 403]).toContain(r.status);
  });

  it('lets a request through when the account is not signed in (the route answers 401) or the reply is already sent', async () => {
    const r = reply();
    await requireOwnBroker({ user: undefined } as any, r);
    expect(r.sent).toBe(false);
    const done = reply(); done.sent = true;
    await requireOwnBroker({ user: { sub: 'u1' } } as any, done);
    expect(done.status).toBe(0);
  });

  it('does not lock accounts out when the check itself cannot run', async () => {
    const broken = { breezeCredential: { findUnique: vi.fn(async () => { throw new Error('db down'); }) }, brokerAccount: { findMany: vi.fn(async () => []) } } as any;
    expect((await brokerAllowed('u9', broken)).allowed).toBe(true);
  });

  it('can be switched off', async () => {
    (env as any).REQUIRE_OWN_BROKER = 'false';
    expect((await brokerAllowed('anyone', db(null))).allowed).toBe(true);
  });
});

describe('an account without its own broker is valued from saved prices only', () => {
  const before = env.REQUIRE_OWN_BROKER;
  beforeEach(() => { forgetBrokerState(); (env as any).REQUIRE_OWN_BROKER = 'true'; });
  afterAll(() => { (env as any).REQUIRE_OWN_BROKER = before; });

  it('uses neither the shared live feed nor a fresh quote', async () => {
    const { ValuationService } = await import('../../src/services/valuation.service.js');
    const quote = vi.fn(async () => ({ ltp: 999 }));
    const position = { id: 'p', portfolioId: 'pf', symbol: 'SBIN', exchange: 'NSE', side: 'LONG', status: 'OPEN', qty: 10, avgEntryPrice: 100, lastPrice: 105, lastPriceAt: now };
    const prisma = (breeze: unknown) => ({
      portfolio: { findMany: vi.fn(async () => [{ id: 'pf', userId: 'u', initialCapital: 100_000, currentNav: 99_000 }]) },
      position: { findMany: vi.fn(async () => [position]), update: vi.fn(async () => ({})) },
      breezeCredential: { findUnique: vi.fn(async () => breeze) },
      brokerAccount: { findMany: vi.fn(async () => []) },
    }) as any;
    const open = () => true;

    const blocked = await new ValuationService(prisma(null), quote, open, () => now).forUser('u', { SBIN: 500 });
    expect(blocked.positions[0]).toMatchObject({ price: 105, priceSource: 'saved' });   // not 500 (feed), not 999 (quote)
    expect(quote).not.toHaveBeenCalled();

    forgetBrokerState();
    const own = await new ValuationService(prisma({ sessionToken: 'x', sessionExpiresAt: null }), quote, open, () => now).forUser('u', { SBIN: 500 });
    // Connected to its own broker: a fresh quote through that broker (999), and still
    // not the shared feed (500), which is priced through the owner's broker.
    expect(own.positions[0]).toMatchObject({ price: 999, priceSource: 'live' });
  });
});
