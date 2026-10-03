import { getPrisma } from './prisma.js';

/**
 * Sign-in tokens are stateless JWTs valid for up to a day, so every request
 * re-checks the account behind the token:
 *  - a token issued before the last password reset is refused (whoever had the
 *    old password must not keep their session);
 *  - a blocked, deleted, or not-yet-approved account is refused at once;
 *  - the role (admin or not) is read from the database, never from the token.
 * Each user's row is cached briefly so this is not a query per request; admin
 * actions in this process update the cache immediately.
 */
const TTL_MS = 60_000;

export type AccountStatus = 'PENDING' | 'ACTIVE' | 'BLOCKED';
interface Entry { changedAtSec: number; status: AccountStatus | 'MISSING'; role: string; fetchedAt: number }
const cache = new Map<string, Entry>();

async function load(userId: string): Promise<Entry> {
  let entry = cache.get(userId);
  if (!entry || Date.now() - entry.fetchedAt > TTL_MS) {
    const user = await getPrisma().user.findUnique({
      where: { id: userId },
      select: { passwordChangedAt: true, status: true, role: true },
    });
    entry = {
      changedAtSec: user?.passwordChangedAt ? Math.floor(user.passwordChangedAt.getTime() / 1000) : 0,
      status: user ? ((user.status as AccountStatus) ?? 'ACTIVE') : 'MISSING',
      role: user?.role ?? '',
      fetchedAt: Date.now(),
    };
    cache.set(userId, entry);
  }
  return entry;
}

/** Record a password change made in this process so it takes effect at once, not after the TTL. */
export function notePasswordChanged(userId: string, at: Date): void {
  const e = cache.get(userId);
  if (e) e.changedAtSec = Math.floor(at.getTime() / 1000);
  else cache.set(userId, { changedAtSec: Math.floor(at.getTime() / 1000), status: 'ACTIVE', role: '', fetchedAt: 0 });
}

/** Forget a user's cached account state (after an admin approves, blocks or deletes them). */
export function forgetAccount(userId: string): void {
  cache.delete(userId);
}

/**
 * Why this token may not be used, or null when it may. `iat` is in whole
 * seconds: a token issued in the same second as a reset (signing straight back
 * in) stays valid.
 */
export async function sessionProblem(userId: string, iatSec: number): Promise<string | null> {
  const e = await load(userId);
  if (e.status === 'MISSING') return 'This account no longer exists.';
  if (e.status === 'BLOCKED') return 'This account has been blocked by the administrator.';
  if (e.status === 'PENDING') return 'This account is waiting for the administrator\'s approval.';
  if (e.changedAtSec > 0 && iatSec < e.changedAtSec) return 'Session ended because the password was changed. Please sign in again.';
  return null;
}

/** True when the token was issued before the user's last password change. */
export async function isIssuedBeforePasswordChange(userId: string, iatSec: number): Promise<boolean> {
  const e = await load(userId);
  return e.changedAtSec > 0 && iatSec < e.changedAtSec;
}

/** Role from the database (cached briefly). */
export async function accountRole(userId: string): Promise<string> {
  return (await load(userId)).role;
}

export function clearRevocationCache(): void {
  cache.clear();
}
