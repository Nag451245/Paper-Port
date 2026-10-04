import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PortfolioService, PortfolioError } from '../services/portfolio.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { MetricsService } from '../services/metrics.service.js';
import { MarketDataService } from '../services/market-data.service.js';
import { MANUAL_CAPITAL_LIMIT } from '../lib/capital.js';
import { ValuationService } from '../services/valuation.service.js';

const createSchema = z.object({
  name: z.string().min(1),
  initial_capital: z.number().positive().max(MANUAL_CAPITAL_LIMIT, 'Capital can be at most ₹1 crore').optional().default(1000000),
});

const updateCapitalSchema = z.object({
  virtual_capital: z.number().positive().max(MANUAL_CAPITAL_LIMIT, 'Capital can be at most ₹1 crore').optional(),
  auto_top_up: z.boolean().optional(),
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
      include: { _count: { select: { trades: true } } },
    });
    // The same valuation the Dashboard and the Risk page use.
    const live = (app as any).priceFeedService?.getAllLastPrices?.() ?? {};
    const v = await new ValuationService(prisma).forUser(userId, live);

    return reply.send({
      portfolioCount: portfolios.length,
      totalCapital: v.capital,
      totalNav: v.netWorth,
      totalPnl: v.totalPnl,
      totalPnlPct: v.totalPnlPct,
      totalOpenPositions: v.positions.length,
      totalTrades: portfolios.reduce((n, p) => n + p._count.trades, 0),
      portfolios: portfolios.map((p) => {
        const own = v.positions.filter((x) => x.portfolioId === p.id);
        const capital = Number(p.initialCapital);
        const nav = Number(p.currentNav) + own.reduce((t, x) => t + x.capitalInUse + x.pnl, 0);
        return {
          id: p.id,
          name: p.name,
          isDefault: p.isDefault,
          capital,
          nav: Number(nav.toFixed(2)),
          pnl: Number((nav - capital).toFixed(2)),
          openPositions: own.length,
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
      const priceFeed = (app as any).priceFeedService;
      const priceCache = priceFeed?.getAllLastPrices?.() ?? undefined;
      const summaryStart = Date.now();
      const summary = await service.getSummary(portfolioId, userId, priceCache);
      MetricsService.getInstance().recordSummaryFetchDuration(Date.now() - summaryStart);
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
      const parsedDays = days ? Math.max(1, Math.min(365, Math.floor(Number(days)))) : 0;
      if (days && isNaN(Number(days))) {
        return reply.code(400).send({ error: 'Invalid days parameter' });
      }
      const history = await service.getPnlHistory(portfolioId, userId, parsedDays);
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
      if (parsed.data.virtual_capital == null && parsed.data.auto_top_up == null) {
        return reply.code(400).send({ error: 'Nothing to change' });
      }
      const portfolio = await service.updateCapital(portfolioId, userId, parsed.data.virtual_capital, parsed.data.auto_top_up);
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
