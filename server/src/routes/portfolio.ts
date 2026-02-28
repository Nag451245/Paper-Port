import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PortfolioService, PortfolioError } from '../services/portfolio.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';

const createSchema = z.object({
  name: z.string().min(1),
  initial_capital: z.number().positive().optional().default(1000000),
});

const updateCapitalSchema = z.object({
  virtual_capital: z.number().positive(),
});

export async function portfolioRoutes(app: FastifyInstance): Promise<void> {
  const service = new PortfolioService(getPrisma());

  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    const userId = getUserId(request);
    const portfolios = await service.list(userId);
    return reply.send(portfolios);
  });

  app.post('/', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const userId = getUserId(request);
    const portfolio = await service.create(userId, parsed.data.name, parsed.data.initial_capital);
    return reply.code(201).send(portfolio);
  });

  app.get('/:portfolioId', async (request, reply) => {
    try {
      const { portfolioId } = request.params as { portfolioId: string };
      const userId = getUserId(request);
      const portfolio = await service.getById(portfolioId, userId);
      return reply.send(portfolio);
    } catch (err) {
      if (err instanceof PortfolioError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/:portfolioId/summary', async (request, reply) => {
    try {
      const { portfolioId } = request.params as { portfolioId: string };
      const userId = getUserId(request);
      const summary = await service.getSummary(portfolioId, userId);
      return reply.send(summary);
    } catch (err) {
      if (err instanceof PortfolioError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/:portfolioId/equity-curve', async (request, reply) => {
    try {
      const { portfolioId } = request.params as { portfolioId: string };
      const userId = getUserId(request);
      const curve = await service.getEquityCurve(portfolioId, userId);
      return reply.send(curve);
    } catch (err) {
      if (err instanceof PortfolioError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/:portfolioId/risk-metrics', async (request, reply) => {
    try {
      const { portfolioId } = request.params as { portfolioId: string };
      const userId = getUserId(request);
      const metrics = await service.getRiskMetrics(portfolioId, userId);
      return reply.send(metrics);
    } catch (err) {
      if (err instanceof PortfolioError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/:portfolioId/pnl-history', async (request, reply) => {
    try {
      const { portfolioId } = request.params as { portfolioId: string };
      const { days } = request.query as { days?: string };
      const userId = getUserId(request);
      const history = await service.getPnlHistory(portfolioId, userId, days ? Number(days) : 30);
      return reply.send(history);
    } catch (err) {
      if (err instanceof PortfolioError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.put('/:portfolioId/capital', async (request, reply) => {
    const parsed = updateCapitalSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { portfolioId } = request.params as { portfolioId: string };
      const userId = getUserId(request);
      const portfolio = await service.updateCapital(portfolioId, userId, parsed.data.virtual_capital);
      return reply.send(portfolio);
    } catch (err) {
      if (err instanceof PortfolioError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });
}
