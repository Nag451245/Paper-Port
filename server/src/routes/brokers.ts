import { ownerAccountId } from '../lib/account-context.js';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { appBaseUrl } from '../lib/app-url.js';
import { BROKERS } from '../lib/brokers.js';
import { BrokerAccountsService, BrokerError } from '../services/broker-accounts.service.js';

const brokerIds = BROKERS.map((b) => b.id) as [string, ...string[]];
const brokerParam = z.enum(brokerIds);
const field = z.string().max(500).optional();
const saveSchema = z.object({ apiKey: field, apiSecret: field, clientId: field, accessToken: field });
const activeSchema = z.object({ broker: brokerParam });

export async function brokerRoutes(app: FastifyInstance): Promise<void> {
  const service = new BrokerAccountsService(getPrisma());

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof BrokerError) return reply.code(err.statusCode).send({ error: err.message });
    throw err;
  };

  app.get('/', { preHandler: [authenticate] }, async (request, reply) => {
    return reply.send(await service.list(getUserId(request)));
  });

  app.put('/:broker', { preHandler: [authenticate] }, async (request, reply) => {
    const broker = brokerParam.safeParse((request.params as { broker?: string }).broker);
    const body = saveSchema.safeParse(request.body ?? {});
    if (!broker.success || !body.success) return reply.code(400).send({ error: 'Validation failed' });
    try {
      await service.save(getUserId(request), broker.data, body.data);
      return reply.send(await service.list(getUserId(request)));
    } catch (err) { return fail(reply, err); }
  });

  app.delete('/:broker', { preHandler: [authenticate] }, async (request, reply) => {
    const broker = brokerParam.safeParse((request.params as { broker?: string }).broker);
    if (!broker.success || broker.data === 'breeze') return reply.code(400).send({ error: 'Unknown broker' });
    await service.remove(getUserId(request), broker.data);
    return reply.send(await service.list(getUserId(request)));
  });

  app.post('/active', { preHandler: [authenticate] }, async (request, reply) => {
    const body = activeSchema.safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Validation failed' });
    try {
      await service.setActive(getUserId(request), body.data.broker);
      return reply.send(await service.list(getUserId(request)));
    } catch (err) { return fail(reply, err); }
  });

  app.get('/upstox/login', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      return reply.send(await service.upstoxLoginUrl(getUserId(request)));
    } catch (err) { return fail(reply, err); }
  });

  // Today's access token pasted by the user (like ICICI's daily session token).
  app.post('/upstox/session', { preHandler: [authenticate] }, async (request, reply) => {
    const body = z.object({ accessToken: z.string().min(1).max(4000) }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Paste the access token.' });
    try {
      await service.saveUpstoxToken(getUserId(request), body.data.accessToken);
      return reply.send(await service.list(getUserId(request)));
    } catch (err) { return fail(reply, err); }
  });

  // Daily login without a browser: Upstox asks the user to approve on their phone.
  app.post('/upstox/request-token', { preHandler: [authenticate] }, async (request, reply) => {
    try {
      return reply.send(await service.requestUpstoxToken(getUserId(request)));
    } catch (err) { return fail(reply, err); }
  });

  // Upstox posts the approved token here. No app session: the payload is
  // checked against the saved account and verified with Upstox before use.
  // Always 200, so the response says nothing about which accounts exist.
  app.post('/upstox/notifier', { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } }, async (request, reply) => {
    try {
      await service.acceptUpstoxNotice((request.body ?? {}) as Record<string, string>);
    } catch { /* ignored: never reveal why */ }
    return reply.send({ status: 'received' });
  });

  // "My broker is not listed": tell the administrator which one is wanted.
  // It is recorded as a notification on the administrator's account.
  app.post('/request', { preHandler: [authenticate] }, async (request, reply) => {
    const body = z.object({
      broker: z.string().trim().min(2).max(60).regex(/^[\p{L}\p{N} .&()'-]+$/u, 'Use the broker name only'),
      note: z.string().trim().max(500).optional(),
    }).safeParse(request.body ?? {});
    if (!body.success) return reply.code(400).send({ error: 'Enter the name of the broker (letters and numbers), and an optional note of up to 500 characters.' });
    const prisma = getPrisma();
    const userId = getUserId(request);
    const ownerId = await ownerAccountId();
    if (!ownerId) return reply.code(503).send({ error: 'There is no administrator account to send the request to.' });
    const since = new Date(Date.now() - 86_400_000);
    const recent = await prisma.notification.count({
      where: { userId: ownerId, type: 'broker_request', createdAt: { gte: since }, metadata: { contains: userId } },
    });
    if (recent >= 3) return reply.code(429).send({ error: 'You have already sent three broker requests today. The administrator has them.' });
    const who = await prisma.user.findUnique({ where: { id: userId }, select: { fullName: true, email: true } });
    await prisma.notification.create({
      data: {
        userId: ownerId, type: 'broker_request', title: `Broker requested: ${body.data.broker}`,
        message: `${who?.fullName ?? 'A user'} (${who?.email ?? userId}) asked for ${body.data.broker} to be supported.${body.data.note ? ` Note: ${body.data.note}` : ''}`,
        metadata: JSON.stringify({ from: userId, broker: body.data.broker }),
      },
    });
    return reply.send({ ok: true });
  });

  // Upstox redirects the browser here after login. No app session is needed:
  // the single-use `state` nonce identifies the user who started the login.
  app.get('/upstox/callback', async (request, reply) => {
    const q = request.query as { code?: string; state?: string; error?: string; error_description?: string };
    const back = (status: 'connected' | 'error', message?: string) => {
      const url = new URL(`${appBaseUrl()}/settings`);
      url.searchParams.set('broker', 'upstox');
      url.searchParams.set('status', status);
      if (message) url.searchParams.set('message', message.slice(0, 200));
      return reply.redirect(url.toString());
    };
    if (q.error) return back('error', q.error_description || q.error);
    if (!q.code || !q.state) return back('error', 'Upstox did not return a login code.');
    try {
      await service.upstoxCallback(q.code, q.state);
      return back('connected');
    } catch (err) {
      return back('error', err instanceof BrokerError ? err.message : 'Upstox login failed.');
    }
  });
}
