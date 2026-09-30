import { getPrisma } from './prisma.js';

/**
 * Sign-in tokens are stateless JWTs valid for up to a day. After a password
 * reset, any token issued before it must stop working — otherwise whoever had
 * the old password keeps their session. Each user's passwordChangedAt is read
 * from the database and cached briefly so this is not a query per request.
 */
const TTL_MS = 60_000;
const cache = new Map<string, { changedAtSec: number; fetchedAt: number }>();

/** Record a change made in this process so it takes effect at once, not after the TTL. */
export function notePasswordChanged(userId: string, at: Date): void {
  cache.set(userId, { changedAtSec: Math.floor(at.getTime() / 1000), fetchedAt: Date.now() });
}

/**
 * True when the token was issued before the user's last password change.
 * `iat` is in whole seconds, so the comparison is in seconds: a token issued in
 * the same second as the reset (the user signing straight back in) stays valid.
 */
export async function isIssuedBeforePasswordChange(userId: string, iatSec: number): Promise<boolean> {
  let entry = cache.get(userId);
  if (!entry || Date.now() - entry.fetchedAt > TTL_MS) {
    const user = await getPrisma().user.findUnique({
      where: { id: userId },
      select: { passwordChangedAt: true },
    });
    entry = {
      changedAtSec: user?.passwordChangedAt ? Math.floor(user.passwordChangedAt.getTime() / 1000) : 0,
      fetchedAt: Date.now(),
    };
    cache.set(userId, entry);
  }
  return entry.changedAtSec > 0 && iatSec < entry.changedAtSec;
}

export function clearRevocationCache(): void {
  cache.clear();
}
