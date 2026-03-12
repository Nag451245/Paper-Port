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

  // BUG-1 FIX: Register /consolidated/summary BEFORE /:portfolioId to prevent route collision
  app.get('/consolidated/summary', async (request, reply) => {
    const userId = getUserId(request);
    const prisma = getPrisma();

    const portfolios = await prisma.portfolio.findMany({
      where: { userId },
      include: {
        positions: { where: { status: 'OPEN' }, select: { symbol: true, qty: true, avgEntryPrice: true, side: true, exchange: true } },
        _count: { select: { trades: true } },
      },
    });

    let totalCapital = 0, totalCash = 0, totalInvestedValue = 0, totalOpenPositions = 0, totalTrades = 0;
    for (const p of portfolios) {
      totalCapital += Number(p.initialCapital);
      totalCash += Number(p.currentNav);
      totalOpenPositions += p.positions.length;
      totalTrades += p._count.trades;
      for (const pos of p.positions) {
        const entryPrice = Number(pos.avgEntryPrice);
        if (pos.side === 'LONG') {
          totalInvestedValue += entryPrice * pos.qty;
        } else {
          const rate = pos.exchange === 'MCX' ? 0.10 : pos.exchange === 'CDS' ? 0.05 : 0.25;
          totalInvestedValue += entryPrice * pos.qty * rate;
        }
      }
    }
    const totalNav = totalCash + totalInvestedValue;

    return reply.send({
      portfolioCount: portfolios.length,
      totalCapital: Number(totalCapital.toFixed(2)),
      totalNav: Number(totalNav.toFixed(2)),
      totalPnl: Number((totalNav - totalCapital).toFixed(2)),
      totalPnlPct: totalCapital > 0 ? Number((((totalNav - totalCapital) / totalCapital) * 100).toFixed(2)) : 0,
      totalOpenPositions,
      totalTrades,
      portfolios: portfolios.map(p => {
        let pInvested = 0;
        for (const pos of p.positions) {
          const ep = Number(pos.avgEntryPrice);
          if (pos.side === 'LONG') {
            pInvested += ep * pos.qty;
          } else {
            const rate = (pos as any).exchange === 'MCX' ? 0.10 : (pos as any).exchange === 'CDS' ? 0.05 : 0.25;
            pInvested += ep * pos.qty * rate;
          }
        }
        const pNav = Number(p.currentNav) + pInvested;
        return {
          id: p.id,
          name: p.name,
          isDefault: p.isDefault,
          capital: Number(p.initialCapital),
          nav: Number(pNav.toFixed(2)),
          pnl: Number((pNav - Number(p.initialCapital)).toFixed(2)),
          openPositions: p.positions.length,
          trades: p._count.trades,
        };
      }),
    });
  });

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

  app.post('/:portfolioId/reconcile', async (request, reply) => {
    try {
      const { portfolioId } = request.params as { portfolioId: string };
      const userId = getUserId(request);
      const result = await service.reconcileNav(portfolioId, userId);
      return reply.send(result);
    } catch (err) {
      if (err instanceof PortfolioError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/:portfolioId/set-default', async (request, reply) => {
    try {
      const { portfolioId } = request.params as { portfolioId: string };
      const userId = getUserId(request);
      const prisma = getPrisma();

      const portfolio = await prisma.portfolio.findUnique({ where: { id: portfolioId } });
      if (!portfolio || portfolio.userId !== userId) {
        return reply.code(404).send({ error: 'Portfolio not found' });
      }

      await prisma.$transaction([
        prisma.portfolio.updateMany({
          where: { userId, isDefault: true },
          data: { isDefault: false },
        }),
        prisma.portfolio.update({
          where: { id: portfolioId },
          data: { isDefault: true },
        }),
      ]);

      return reply.send({ message: 'Default portfolio updated', portfolioId });
    } catch (err) {
      if (err instanceof PortfolioError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

}
