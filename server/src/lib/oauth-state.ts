import { randomBytes } from 'crypto';
import { getRedis } from './redis.js';

/**
 * Single-use state nonces for the Breeze login redirect.
 *
 * The state parameter travels to api.icicidirect.com in a query string, so it
 * lands in a third party's access logs, in browser history and in Referer
 * headers. It must therefore be an opaque value that grants nothing on its own
 * — never a JWT signed with JWT_SECRET, which the auth middleware would accept
 * as a bearer token for every endpoint.
 *
 * Backed by Redis when configured so nonces survive a restart and work across
 * instances; falls back to an in-process map otherwise.
 */
const TTL_SECONDS = 15 * 60;
const REDIS_PREFIX = 'breeze_state:';

const memoryStore = new Map<string, { userId: string; expiresAt: number }>();

function sweepMemoryStore(): void {
  const now = Date.now();
  for (const [nonce, entry] of memoryStore) {
    if (entry.expiresAt <= now) memoryStore.delete(nonce);
  }
}

export async function createBreezeState(userId: string): Promise<string> {
  const nonce = randomBytes(32).toString('base64url');
  const redis = getRedis();

  if (redis) {
    try {
      await redis.set(`${REDIS_PREFIX}${nonce}`, userId, 'EX', TTL_SECONDS);
      return nonce;
    } catch {
      // fall through to the in-process store
    }
  }

  sweepMemoryStore();
  memoryStore.set(nonce, { userId, expiresAt: Date.now() + TTL_SECONDS * 1000 });
  return nonce;
}

/**
 * Resolve a state nonce to its userId and consume it. Returns null if the
 * nonce is unknown, expired, or already used.
 */
export async function consumeBreezeState(nonce: string): Promise<string | null> {
  if (!nonce) return null;
  const redis = getRedis();

  if (redis) {
    try {
      const key = `${REDIS_PREFIX}${nonce}`;
      const userId = await redis.get(key);
      if (userId) {
        await redis.del(key);
        return userId;
      }
    } catch {
      // fall through to the in-process store
    }
  }

  sweepMemoryStore();
  const entry = memoryStore.get(nonce);
  if (!entry) return null;
  memoryStore.delete(nonce);
  return entry.expiresAt > Date.now() ? entry.userId : null;
}
