/**
 * Each account uses its own broker.
 *
 * Market data on this server comes from a broker login. It used to be shared:
 * whoever was signed in was served through the owner's ICICI session, used the
 * owner's daily call allowance, and had bots trading on it. Now an account gets
 * broker data, new orders and bot trades only while its OWN broker is connected
 * (ICICI Breeze keys with today's session, or an Upstox login that has not expired).
 *
 * Reading what the account already has (positions, portfolio, history of its
 * trades) and closing positions are never blocked.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import type { PrismaClient } from '@prisma/client';
import { env } from '../config.js';
import { getPrisma } from './prisma.js';

export type BrokerState = 'connected' | 'saved' | 'none';
export interface OwnBroker { state: BrokerState; broker: string | null }

const cache = new Map<string, { at: number; value: OwnBroker }>();
const TTL_MS = 20_000;

/** Forget what is remembered about an account (call when it saves keys or a session). */
export function forgetBrokerState(userId?: string): void {
  if (userId) cache.delete(userId); else cache.clear();
}

export async function ownBroker(prisma: PrismaClient, userId: string, now: Date = new Date()): Promise<OwnBroker> {
  const hit = cache.get(userId);
  if (hit && now.getTime() - hit.at < TTL_MS) return hit.value;
  const [breeze, accounts] = await Promise.all([
    prisma.breezeCredential.findUnique({ where: { userId } }),
    prisma.brokerAccount.findMany({ where: { userId } }),
  ]);
  let value: OwnBroker = { state: 'none', broker: null };
  const live = (accounts ?? []).find((a) => !!a.encryptedAccessToken && !!a.tokenExpiresAt && a.tokenExpiresAt > now);
  if (breeze?.sessionToken && (!breeze.sessionExpiresAt || breeze.sessionExpiresAt > now)) value = { state: 'connected', broker: 'breeze' };
  else if (live) value = { state: 'connected', broker: live.broker };
  else if (breeze) value = { state: 'saved', broker: 'breeze' };
  else if ((accounts ?? []).length) value = { state: 'saved', broker: accounts[0].broker };
  if (cache.size > 5_000) cache.clear();
  cache.set(userId, { at: now.getTime(), value });
  return value;
}

export const ownBrokerRequired = () => env.REQUIRE_OWN_BROKER === 'true';

export function brokerMessage(b: OwnBroker): string {
  return b.state === 'saved'
    ? 'Your broker is set up but not logged in for today. Log in to it from Settings to get market data and place orders.'
    : 'Connect your own broker in Settings to get market data and place orders. Each account uses its own broker login.';
}

/** Is this account allowed broker data and new trades right now? Fails open when the check itself cannot run. */
export async function brokerAllowed(userId: string, prisma: PrismaClient = getPrisma()): Promise<{ allowed: boolean; broker: OwnBroker }> {
  if (!ownBrokerRequired()) return { allowed: true, broker: { state: 'connected', broker: null } };
  try {
    const broker = await ownBroker(prisma, userId);
    return { allowed: broker.state === 'connected', broker };
  } catch {
    // Database trouble must not lock every account out of its own data.
    return { allowed: true, broker: { state: 'connected', broker: null } };
  }
}

/** Route guard: put after `authenticate`. */
export async function requireOwnBroker(request: FastifyRequest, reply: FastifyReply): Promise<void> {
  if (reply.sent || !ownBrokerRequired()) return;
  const userId = (request.user as { sub?: string } | undefined)?.sub;
  if (!userId) return;                                  // not signed in: the route's own check answers
  const { allowed, broker } = await brokerAllowed(userId);
  if (!allowed) reply.code(403).send({ error: brokerMessage(broker), brokerRequired: true, brokerState: broker.state });
}
