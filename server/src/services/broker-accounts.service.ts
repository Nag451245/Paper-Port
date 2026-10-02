/**
 * Saved broker accounts and the choice of which broker feeds market data.
 * ICICI Breeze keeps its own table and flow (auth.service); this covers the
 * others, plus the per-user "active broker" switch.
 */
import type { PrismaClient } from '@prisma/client';
import { env } from '../config.js';
import { BROKERS, brokerInfo, type BrokerId, type CredentialField } from '../lib/brokers.js';
import { encrypt, decrypt } from './auth.service.js';
import { appBaseUrl } from '../lib/app-url.js';
import { createBreezeState as createLoginState, consumeBreezeState as consumeLoginState } from '../lib/oauth-state.js';

export class BrokerError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'BrokerError';
  }
}

const FIELD_COLUMN: Record<CredentialField, 'encryptedApiKey' | 'encryptedApiSecret' | 'encryptedClientId' | 'encryptedAccessToken'> = {
  apiKey: 'encryptedApiKey',
  apiSecret: 'encryptedApiSecret',
  clientId: 'encryptedClientId',
  accessToken: 'encryptedAccessToken',
};

/** Upstox access tokens stop working at 3:30 AM IST the next morning. */
export function nextUpstoxExpiry(now = new Date()): Date {
  const ist = new Date(now.getTime() + 330 * 60_000);
  const day = ist.toISOString().slice(0, 10);
  const todays = new Date(`${day}T03:30:00+05:30`);
  return todays > now ? todays : new Date(todays.getTime() + 86_400_000);
}

export const upstoxRedirectUri = () => `${appBaseUrl()}/api/brokers/upstox/callback`;

/** Short cache so a quote does not cost a database lookup. */
const TOKEN_TTL_MS = 30_000;
const tokenCache = new Map<string, { token: string | null; at: number }>();

export class BrokerAccountsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
  ) {}

  private enc = (v: string) => encrypt(v, env.ENCRYPTION_KEY);
  private dec = (v: string) => decrypt(v, env.ENCRYPTION_KEY);

  async list(userId: string) {
    const [user, accounts, breeze] = await Promise.all([
      this.prisma.user.findUnique({ where: { id: userId }, select: { activeBroker: true } }),
      this.prisma.brokerAccount.findMany({ where: { userId } }),
      this.prisma.breezeCredential.findUnique({ where: { userId } }),
    ]);
    const now = new Date();
    return {
      active: user?.activeBroker ?? 'breeze',
      redirectUris: { upstox: upstoxRedirectUri() },
      brokers: BROKERS.map((b) => {
        if (b.id === 'breeze') {
          const connected = !!breeze?.sessionToken && (!breeze.sessionExpiresAt || breeze.sessionExpiresAt > now);
          return { ...b, saved: !!breeze, connected, tokenExpiresAt: breeze?.sessionExpiresAt?.toISOString() ?? null, fieldsSaved: [] as string[] };
        }
        const a = accounts.find((x) => x.broker === b.id);
        const fieldsSaved = b.fields.filter((f) => !!a?.[FIELD_COLUMN[f.key]]).map((f) => f.key);
        const connected = b.login === 'oauth'
          ? !!a?.encryptedAccessToken && !!a.tokenExpiresAt && a.tokenExpiresAt > now
          : false;
        return { ...b, saved: !!a, connected, tokenExpiresAt: a?.tokenExpiresAt?.toISOString() ?? null, fieldsSaved };
      }),
    };
  }

  /** Save or replace keys. Blank fields keep what is stored; new app keys drop the old login. */
  async save(userId: string, broker: string, input: Partial<Record<CredentialField, string>>): Promise<void> {
    const info = brokerInfo(broker);
    if (!info || info.id === 'breeze') throw new BrokerError('Unknown broker. ICICI Breeze keys are saved in the Breeze section.');
    const data: Record<string, string | null> = {};
    for (const f of info.fields) {
      const v = input[f.key]?.trim();
      if (v) data[FIELD_COLUMN[f.key]] = this.enc(v);
    }
    if (Object.keys(data).length === 0) throw new BrokerError('Nothing to save.');
    if (info.login === 'oauth' && (data.encryptedApiKey || data.encryptedApiSecret)) {
      data.encryptedAccessToken = null;
      (data as any).tokenExpiresAt = null;
    }
    await this.prisma.brokerAccount.upsert({
      where: { userId_broker: { userId, broker: info.id } },
      create: { userId, broker: info.id, ...data },
      update: data,
    });
    tokenCache.clear();
  }

  async remove(userId: string, broker: string): Promise<void> {
    await this.prisma.brokerAccount.deleteMany({ where: { userId, broker } });
    const user = await this.prisma.user.findUnique({ where: { id: userId }, select: { activeBroker: true } });
    if (user?.activeBroker === broker) {
      await this.prisma.user.update({ where: { id: userId }, data: { activeBroker: 'breeze' } });
    }
    tokenCache.clear();
  }

  async setActive(userId: string, broker: string): Promise<void> {
    const info = brokerInfo(broker);
    if (!info) throw new BrokerError('Unknown broker.');
    if (!info.marketData) throw new BrokerError(`${info.name} cannot supply market data in this app yet.`);
    if (info.id === 'upstox') {
      const a = await this.prisma.brokerAccount.findUnique({ where: { userId_broker: { userId, broker: 'upstox' } } });
      if (!a?.encryptedAccessToken || !a.tokenExpiresAt || a.tokenExpiresAt <= new Date()) {
        throw new BrokerError('Log in with Upstox first.');
      }
    }
    await this.prisma.user.update({ where: { id: userId }, data: { activeBroker: info.id } });
    tokenCache.clear();
  }

  /** Where to send the browser to log in on Upstox's own site. */
  async upstoxLoginUrl(userId: string): Promise<{ loginUrl: string; redirectUri: string }> {
    const a = await this.prisma.brokerAccount.findUnique({ where: { userId_broker: { userId, broker: 'upstox' } } });
    if (!a?.encryptedApiKey || !a.encryptedApiSecret) throw new BrokerError('Save your Upstox API key and secret first.');
    const redirectUri = upstoxRedirectUri();
    const url = new URL('https://api.upstox.com/v2/login/authorization/dialog');
    url.searchParams.set('client_id', this.dec(a.encryptedApiKey));
    url.searchParams.set('redirect_uri', redirectUri);
    url.searchParams.set('response_type', 'code');
    url.searchParams.set('state', await createLoginState(userId));
    return { loginUrl: url.toString(), redirectUri };
  }

  /** Upstox sends the browser back here with a one-time code; swap it for an access token. */
  async upstoxCallback(code: string, state: string): Promise<string> {
    const userId = await consumeLoginState(state);
    if (!userId) throw new BrokerError('This login link has expired. Start the Upstox login again from Settings.');
    const a = await this.prisma.brokerAccount.findUnique({ where: { userId_broker: { userId, broker: 'upstox' } } });
    if (!a?.encryptedApiKey || !a.encryptedApiSecret) throw new BrokerError('Upstox keys are missing. Save them again in Settings.');

    const res = await this.fetchImpl('https://api.upstox.com/v2/login/authorization/token', {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded', Accept: 'application/json' },
      body: new URLSearchParams({
        code,
        client_id: this.dec(a.encryptedApiKey),
        client_secret: this.dec(a.encryptedApiSecret),
        redirect_uri: upstoxRedirectUri(),
        grant_type: 'authorization_code',
      }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null) as any;
    if (!res.ok || !body?.access_token) {
      throw new BrokerError(`Upstox refused the login: ${body?.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
    }
    await this.prisma.brokerAccount.update({
      where: { id: a.id },
      data: { encryptedAccessToken: this.enc(body.access_token), tokenExpiresAt: nextUpstoxExpiry() },
    });
    // The user chose Upstox and just logged in: make it the data source.
    await this.prisma.user.update({ where: { id: userId }, data: { activeBroker: 'upstox' } });
    tokenCache.clear();
    return userId;
  }

  /**
   * Upstox refused this token: record it as logged out, so Settings and the top
   * bar say "log in" instead of showing Upstox as connected while prices
   * silently come from elsewhere.
   */
  async expireUpstoxToken(token: string): Promise<void> {
    const rows = await this.prisma.brokerAccount.findMany({
      where: { broker: 'upstox', encryptedAccessToken: { not: null } },
      select: { id: true, encryptedAccessToken: true },
    });
    const now = new Date();
    for (const r of rows) {
      let t: string | null = null;
      try { t = this.dec(r.encryptedAccessToken!); } catch { /* unreadable: leave it */ }
      if (t === token) await this.prisma.brokerAccount.update({ where: { id: r.id }, data: { tokenExpiresAt: now } });
    }
    tokenCache.clear();
  }

  /**
   * A live Upstox token to fetch market data with, or null when Upstox is not
   * the active broker. Without a user (background jobs), any user who made
   * Upstox active with a live token is used — the same way Breeze works here.
   */
  async upstoxToken(userId?: string): Promise<string | null> {
    const cacheKey = userId ?? '*';
    const hit = tokenCache.get(cacheKey);
    if (hit && Date.now() - hit.at < TOKEN_TTL_MS) return hit.token;

    const now = new Date();
    const row = await this.prisma.brokerAccount.findFirst({
      where: {
        broker: 'upstox',
        tokenExpiresAt: { gt: now },
        encryptedAccessToken: { not: null },
        user: { activeBroker: 'upstox' },
        ...(userId ? { userId } : {}),
      },
      orderBy: { updatedAt: 'desc' },
    });
    let token: string | null = null;
    try { token = row?.encryptedAccessToken ? this.dec(row.encryptedAccessToken) : null; } catch { token = null; }
    tokenCache.set(cacheKey, { token, at: Date.now() });
    return token;
  }
}
