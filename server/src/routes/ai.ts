import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { AIAgentService, AIAgentError } from '../services/ai-agent.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';

const configSchema = z.object({
  mode: z.enum(['AUTONOMOUS', 'SIGNAL', 'ADVISORY']).optional(),
  isActive: z.boolean().optional(),
  minSignalScore: z.number().min(0).max(1).optional(),
  maxDailyTrades: z.number().int().positive().optional(),
  strategies: z.any().optional(),
  capitalPreservationOverrides: z.any().optional(),
});

export async function aiRoutes(app: FastifyInstance): Promise<void> {
  const service = new AIAgentService(getPrisma());

  app.addHook('preHandler', authenticate);

  app.get('/config', async (request, reply) => {
    const userId = getUserId(request);
    const config = await service.getConfig(userId);
    return reply.send(config);
  });

  app.put('/config', async (request, reply) => {
    const parsed = configSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const userId = getUserId(request);
    const config = await service.updateConfig(userId, parsed.data);
    return reply.send(config);
  });

  app.post('/start', async (request, reply) => {
    const userId = getUserId(request);
    const result = await service.startAgent(userId);
    const engine = (app as any).botEngine;
    if (engine) {
      engine.startAgent(userId);
      engine.startMarketScan(userId);
    }
    return reply.send(result);
  });

  app.post('/stop', async (request, reply) => {
    const userId = getUserId(request);
    const result = await service.stopAgent(userId);
    const engine = (app as any).botEngine;
    if (engine) {
      engine.stopAgent(userId);
      engine.stopMarketScan();
    }
    return reply.send(result);
  });

  app.get('/status', async (request, reply) => {
    const userId = getUserId(request);
    const status = await service.getStatus(userId);
    return reply.send(status);
  });

  app.get('/signals', async (request, reply) => {
    const query = request.query as { status?: string; page?: string; limit?: string };
    const userId = getUserId(request);
    const result = await service.listSignals(userId, {
      status: query.status as any,
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return reply.send(result);
  });

  app.get('/signals/:signalId', async (request, reply) => {
    try {
      const { signalId } = request.params as { signalId: string };
      const userId = getUserId(request);
      const signal = await service.getSignal(signalId, userId);
      return reply.send(signal);
    } catch (err) {
      if (err instanceof AIAgentError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/signals/:signalId/execute', async (request, reply) => {
    try {
      const { signalId } = request.params as { signalId: string };
      const userId = getUserId(request);
      const signal = await service.executeSignal(signalId, userId);
      return reply.send(signal);
    } catch (err) {
      if (err instanceof AIAgentError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/signals/:signalId/reject', async (request, reply) => {
    try {
      const { signalId } = request.params as { signalId: string };
      const userId = getUserId(request);
      const signal = await service.rejectSignal(signalId, userId);
      return reply.send(signal);
    } catch (err) {
      if (err instanceof AIAgentError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/briefing/pre-market', async (request, reply) => {
    const userId = getUserId(request);
    const briefing = await service.getPreMarketBriefing(userId);
    return reply.send(briefing);
  });

  app.get('/briefing/post-trade', async (request, reply) => {
    const userId = getUserId(request);
    const briefing = await service.getPostTradeBriefing(userId);
    return reply.send(briefing);
  });

  app.get('/strategies', async (_request, reply) => {
    const strategies = await service.getStrategies();
    return reply.send(strategies);
  });

  app.get('/capital-rules', async (request, reply) => {
    const userId = getUserId(request);
    const rules = await service.getCapitalRules(userId);
    return reply.send(rules);
  });

  // ---- Market Scanner endpoints ----

  app.get('/market-scan', async (request, reply) => {
    const engine = (app as any).botEngine;
    if (!engine) return reply.send({ scanning: false, result: null });

    return reply.send({
      scanning: engine.isScannerRunning(),
      result: engine.getLastScanResult(),
    });
  });

  app.post('/market-scan/start', async (request, reply) => {
    const userId = getUserId(request);
    const engine = (app as any).botEngine;
    if (!engine) return reply.code(500).send({ error: 'Bot engine not available' });

    await engine.startMarketScan(userId);
    return reply.send({ scanning: true, message: 'Market scanner started — scans NSE, MCX & CDS markets every 5 minutes' });
  });

  app.post('/market-scan/stop', async (_request, reply) => {
    const engine = (app as any).botEngine;
    if (engine) engine.stopMarketScan();
    return reply.send({ scanning: false, message: 'Market scanner stopped' });
  });
}
