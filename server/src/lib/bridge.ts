/**
 * Calls to the ICICI bridge and saved broker logins, for the right account.
 *
 * The bridge holds one ICICI session per account. A call made for the owner (or
 * for the server's own jobs) carries no header and reaches the owner's session,
 * exactly as before accounts were separated. A call made for any other account
 * names it, and reaches only that account's session.
 */
import { brokerAccount, currentAccount, isOwnerWork } from './account-context.js';
import { ownBrokerRequired } from './broker-access.js';
import type { CacheService } from './redis.js';

/** "" for the owner and the server's own work; otherwise the account's id. */
export async function bridgeAccountKey(): Promise<string> {
  if (!ownBrokerRequired()) return '';
  return (await isOwnerWork()) ? '' : currentAccount()!;
}

export async function bridgeFetch(url: string, init: RequestInit = {}): Promise<Response> {
  const key = await bridgeAccountKey();
  if (!key) return fetch(url, init);
  return fetch(url, { ...init, headers: { ...(init.headers as Record<string, string> | undefined), 'X-Account': key } });
}

/**
 * The account whose saved broker logins may be used right now.
 * undefined = the old behaviour (anyone's), only when accounts are not separated.
 */
export async function credentialAccount(): Promise<string | undefined> {
  if (!ownBrokerRequired()) return undefined;
  return (await brokerAccount()) ?? undefined;
}

/**
 * A cache in which prices fetched with one account's broker login are not
 * handed to another account. The owner's keys are unchanged.
 */
export function accountScoped(cache: CacheService): CacheService {
  const scoped = async (key: string) => { const a = await bridgeAccountKey(); return a ? `acct:${a}:${key}` : key; };
  return new Proxy(cache, {
    get(target, prop, receiver) {
      const value = Reflect.get(target, prop, receiver);
      if (typeof value !== 'function' || !['get', 'set', 'del', 'exists', 'ttl'].includes(String(prop))) return value;
      return async (key: string, ...rest: unknown[]) => (value as (...a: unknown[]) => unknown).call(target, await scoped(key), ...rest);
    },
  });
}
