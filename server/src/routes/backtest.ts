import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BacktestService, BacktestError } from '../services/backtest.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';

const runSchema = z.object({
  strategyId: z.string().min(1, 'strategyId is required'),
  symbol: z.string().min(1, 'symbol is required'),
  startDate: z.string().min(1, 'startDate is required'),
  endDate: z.string().min(1, 'endDate is required'),
  initialCapital: z.number().positive('initialCapital must be a positive number'),
  parameters: z.record(z.unknown()).optional(),
});

const compareSchema = z.object({
  resultIds: z.array(z.string()).min(2, 'At least 2 result IDs are required for comparison'),
});

export async function backtestRoutes(app: FastifyInstance): Promise<void> {
  const service = new BacktestService(getPrisma());

  app.addHook('preHandler', authenticate);

  app.post('/run', async (request, reply) => {
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const result = await service.run(userId, parsed.data);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof BacktestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/results', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const results = await service.listResults(userId);
      return reply.send(results);
    } catch (err) {
      if (err instanceof BacktestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/results/:resultId', async (request, reply) => {
    try {
      const { resultId } = request.params as { resultId: string };
      const userId = getUserId(request);
      const result = await service.getResult(resultId, userId);
      return reply.send(result);
    } catch (err) {
      if (err instanceof BacktestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/compare', async (request, reply) => {
    const parsed = compareSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const results = await service.compare(userId, parsed.data.resultIds);
      return reply.send(results);
    } catch (err) {
      if (err instanceof BacktestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });
}
