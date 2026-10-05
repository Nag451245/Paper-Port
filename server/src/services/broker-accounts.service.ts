/**
 * Saved broker accounts and the choice of which broker feeds market data.
 * ICICI Breeze keeps its own table and flow (auth.service); this covers the
 * others, plus the per-user "active broker" switch.
 */
import { forgetBrokerState } from '../lib/broker-access.js';
import type { PrismaClient } from '@prisma/client';
import { env } from '../config.js';
import { BROKERS, brokerInfo, type BrokerId, type CredentialField } from '../lib/brokers.js';
import { encrypt, decrypt } from './auth.service.js';
import { appBaseUrl } from '../lib/app-url.js';
import { createBreezeState as createLoginState, consumeBreezeState as consumeLoginState } from '../lib/oauth-state.js';
import { getUpstox, type UpstoxService } from './upstox.service.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('BrokerAccounts');

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
/** Where Upstox delivers a token after the user approves the daily request. */
export const upstoxNotifierUri = () => `${appBaseUrl()}/api/brokers/upstox/notifier`;

export interface UpstoxTokenNotice {
  client_id?: string;
  user_id?: string;
  access_token?: string;
  expires_at?: string | number;
  message_type?: string;
}

/** Short cache so a quote does not cost a database lookup. */
const TOKEN_TTL_MS = 30_000;
const tokenCache = new Map<string, { token: string | null; at: number }>();

export class BrokerAccountsService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly fetchImpl: typeof fetch = (input, init) => fetch(input, init),
    private readonly upstox: Pick<UpstoxService, 'profileUserId'> = getUpstox(),
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
      notifierUris: { upstox: upstoxNotifierUri() },
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
        return {
          ...b, saved: !!a, connected, tokenExpiresAt: a?.tokenExpiresAt?.toISOString() ?? null, fieldsSaved,
          // Daily approval needs the account id from one browser login first.
          autoSessionReady: b.id === 'upstox' && !!a?.brokerUserId,
        };
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
    // Remember whose account this is, so a token pushed to the notifier webhook
    // later can be checked against it.
    const brokerUserId = await this.upstox.profileUserId(body.access_token);
    await this.prisma.brokerAccount.update({
      where: { id: a.id },
      data: {
        encryptedAccessToken: this.enc(body.access_token), tokenExpiresAt: nextUpstoxExpiry(),
        ...(brokerUserId ? { brokerUserId } : {}),
      },
    });
    // The user chose Upstox and just logged in: make it the data source.
    await this.prisma.user.update({ where: { id: userId }, data: { activeBroker: 'upstox' } });
    tokenCache.clear();
    return userId;
  }

  /**
   * Save today's Upstox access token pasted by the user (the developer page's
   * "Generate" button gives one), the same way ICICI's daily session token is
   * pasted. Upstox itself must confirm the token, and it must belong to the
   * Upstox account already linked here, if any.
   */
  async saveUpstoxToken(userId: string, accessToken: string): Promise<void> {
    forgetBrokerState(userId);
    const token = accessToken.replace(/s+/g, '');
    if (token.length < 20) throw new BrokerError('That does not look like an Upstox access token.');
    const brokerUserId = await this.upstox.profileUserId(token);
    if (!brokerUserId) throw new BrokerError('Upstox did not accept this token. Generate a new one on the Upstox developer page (tokens expire at 3:30 AM).');
    const a = await this.prisma.brokerAccount.findUnique({ where: { userId_broker: { userId, broker: 'upstox' } } });
    if (a?.brokerUserId && a.brokerUserId !== brokerUserId) {
      throw new BrokerError('This token belongs to a different Upstox account than the one linked here. Remove Upstox and set it up again to switch accounts.');
    }
    const data = { encryptedAccessToken: this.enc(token), tokenExpiresAt: nextUpstoxExpiry(), brokerUserId };
    await this.prisma.brokerAccount.upsert({
      where: { userId_broker: { userId, broker: 'upstox' } },
      create: { userId, broker: 'upstox', ...data },
      update: data,
    });
    await this.prisma.user.update({ where: { id: userId }, data: { activeBroker: 'upstox' } });
    tokenCache.clear();
  }

  /**
   * Ask Upstox to send this user an approval request (Upstox app and WhatsApp).
   * When they approve, Upstox posts the day's token to the notifier webhook, so
   * no password, PIN or 2FA secret is ever stored here.
   */
  async requestUpstoxToken(userId: string): Promise<{ message: string }> {
    const a = await this.prisma.brokerAccount.findUnique({ where: { userId_broker: { userId, broker: 'upstox' } } });
    if (!a?.encryptedApiKey || !a.encryptedApiSecret) throw new BrokerError('Save your Upstox API key and secret first.');
    if (!a.brokerUserId) throw new BrokerError('Log in with Upstox once in the browser first; after that the daily login can be approved from your phone.');
    const clientId = this.dec(a.encryptedApiKey);
    const res = await this.fetchImpl(`https://api.upstox.com/v3/login/auth/token/request/${encodeURIComponent(clientId)}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ client_secret: this.dec(a.encryptedApiSecret) }),
      signal: AbortSignal.timeout(15_000),
    });
    const body = await res.json().catch(() => null) as any;
    if (!res.ok || body?.status === 'error') {
      throw new BrokerError(`Upstox refused the request: ${body?.errors?.[0]?.message ?? `HTTP ${res.status}`}`);
    }
    return { message: 'Approval request sent. Approve it in the Upstox app or on WhatsApp; the login completes by itself.' };
  }

  /**
   * Upstox posting a token after the user approved. Anyone can call this URL,
   * so the token is used only if the app key matches a saved Upstox account,
   * the account id matches the one seen at the browser login, and Upstox
   * itself confirms the token belongs to that account.
   */
  async acceptUpstoxNotice(notice: UpstoxTokenNotice): Promise<boolean> {
    if (notice.message_type && notice.message_type !== 'access_token') return false;
    if (!notice.client_id || !notice.user_id || !notice.access_token) return false;
    const rows = await this.prisma.brokerAccount.findMany({
      where: { broker: 'upstox', brokerUserId: String(notice.user_id) },
      select: { id: true, userId: true, encryptedApiKey: true },
    });
    const match = rows.find((r) => {
      try { return !!r.encryptedApiKey && this.dec(r.encryptedApiKey) === notice.client_id; } catch { return false; }
    });
    if (!match) return false;
    if ((await this.upstox.profileUserId(notice.access_token)) !== String(notice.user_id)) {
      log.warn('Upstox notifier: token does not belong to the linked Upstox account; ignored');
      return false;
    }
    const expiresMs = Number(notice.expires_at);
    await this.prisma.brokerAccount.update({
      where: { id: match.id },
      data: {
        encryptedAccessToken: this.enc(notice.access_token),
        tokenExpiresAt: expiresMs > Date.now() ? new Date(expiresMs) : nextUpstoxExpiry(),
      },
    });
    tokenCache.clear();
    log.info({ userId: match.userId }, 'Upstox daily login approved and saved');
    return true;
  }

  /** Morning job: send the approval request to everyone using Upstox without a live login. */
  async requestDailyUpstoxTokens(): Promise<{ requested: number; errors: string[] }> {
    const rows = await this.prisma.brokerAccount.findMany({
      where: {
        broker: 'upstox', brokerUserId: { not: null }, user: { activeBroker: 'upstox' },
        OR: [{ tokenExpiresAt: null }, { tokenExpiresAt: { lte: new Date() } }],
      },
      select: { userId: true },
    });
    let requested = 0;
    const errors: string[] = [];
    for (const r of rows) {
      try { await this.requestUpstoxToken(r.userId); requested += 1; } catch (err) { errors.push((err as Error).message); }
    }
    return { requested, errors };
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
