/**
 * Which account is this work being done for?
 *
 * Market data comes from a broker login, and each account uses its own. The
 * account is carried implicitly (AsyncLocalStorage) rather than passed through
 * every call: a web request belongs to the signed-in account, a bot run or an
 * order belongs to the account it trades for, and work with no account at all
 * (the server's own jobs) belongs to the owner.
 */
import { AsyncLocalStorage, AsyncResource } from 'node:async_hooks';
import type { FastifyInstance } from 'fastify';
import { getPrisma } from './prisma.js';

interface Store { userId: string | null }
const als = new AsyncLocalStorage<Store>();
const RESOURCE = Symbol('account-context');

/** The account this code is running for, or null for the server's own work. */
export function currentAccount(): string | null {
  return als.getStore()?.userId ?? null;
}

/** Called once the request's sign-in has been verified. */
export function setRequestAccount(userId: string): void {
  const store = als.getStore();
  if (store) store.userId = userId;
}

/** Run `fn` on behalf of an account (bots, orders, valuations, scheduled work). */
export function runAs<T>(userId: string | null | undefined, fn: () => T): T {
  if (!userId || currentAccount() === userId) return fn();
  return als.run({ userId }, fn);
}

/** Give every request its own account slot, kept across body parsing. */
export function installAccountContext(app: FastifyInstance): void {
  app.addHook('onRequest', (request, _reply, done) => {
    als.run({ userId: null }, () => {
      const resource = new AsyncResource('account-context');
      (request as any)[RESOURCE] = resource;
      resource.runInAsyncScope(done, request.raw);
    });
  });
  // Reading a request body runs on stream callbacks that lose the context.
  app.addHook('preValidation', (request, _reply, done) => {
    const resource = (request as any)[RESOURCE] as AsyncResource | undefined;
    if (resource) resource.runInAsyncScope(done, request.raw); else done();
  });
}

// ── The owner: the administrator's account, whose broker the server's own jobs use ──
let owner: { id: string | null; at: number } | null = null;

export async function ownerAccountId(): Promise<string | null> {
  if (owner && Date.now() - owner.at < 5 * 60_000) return owner.id;
  let id: string | null = null;
  try {
    const prisma = getPrisma();
    const admin = await prisma.user.findFirst({ where: { role: 'ADMIN' }, orderBy: { createdAt: 'asc' }, select: { id: true } });
    id = admin?.id ?? (await prisma.user.findFirst({ orderBy: { createdAt: 'asc' }, select: { id: true } }))?.id ?? null;
  } catch { /* keep what was known */ if (owner) return owner.id; }
  owner = { id, at: Date.now() };
  return id;
}

/** For tests. */
export function forgetOwner(): void { owner = null; }

/**
 * The account whose broker should serve this call: the one the work is for,
 * or the owner when the work is the server's own.
 */
export async function brokerAccount(): Promise<string | null> {
  return currentAccount() ?? ownerAccountId();
}

/** True when this work is for the owner (or for nobody in particular). */
export async function isOwnerWork(): Promise<boolean> {
  const who = currentAccount();
  return !who || who === await ownerAccountId();
}
