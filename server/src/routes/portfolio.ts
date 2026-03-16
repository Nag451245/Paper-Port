import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { PortfolioService, PortfolioError } from '../services/portfolio.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { MetricsService } from '../services/metrics.service.js';
import { MarketDataService } from '../services/market-data.service.js';

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

    const portfolioIds = portfolios.map(p => p.id);

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
    const marketData = new MarketDataService();
    let totalUnrealizedPnl = 0;

    const allPositions = portfolios.flatMap(p => p.positions);
    const uniqueSymbols = [...new Set(allPositions.map(pos => pos.symbol))];
    const ltpMap = new Map<string, number>();
    const priceFeed = (app as any).priceFeedService;
    const priceCache = priceFeed?.getAllLastPrices?.() ?? {};

    for (const sym of uniqueSymbols) {
      if (priceCache[sym] && priceCache[sym] > 0) {
        ltpMap.set(sym, priceCache[sym]);
      } else {
        try {
          const quote = await Promise.race([
            marketData.getQuote(sym, 'NSE'),
            new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
          ]) as any;
          if (quote.ltp > 0) ltpMap.set(sym, Number(quote.ltp));
        } catch { /* skip */ }
      }
    }

    for (const pos of allPositions) {
      const entryPrice = Number(pos.avgEntryPrice);
      const ltp = ltpMap.get(pos.symbol) ?? 0;
      if (ltp > 0) {
        totalUnrealizedPnl += pos.side === 'SHORT'
          ? (entryPrice - ltp) * pos.qty
          : (ltp - entryPrice) * pos.qty;
      }
    }

    const totalNav = totalCash + totalInvestedValue + totalUnrealizedPnl;
    const totalPnl = totalNav - totalCapital;

    return reply.send({
      portfolioCount: portfolios.length,
      totalCapital: Number(totalCapital.toFixed(2)),
      totalNav: Number(totalNav.toFixed(2)),
      totalPnl: Number(totalPnl.toFixed(2)),
      totalPnlPct: totalCapital > 0 ? Number(((totalPnl / totalCapital) * 100).toFixed(2)) : 0,
      totalOpenPositions,
      totalTrades,
      portfolios: portfolios.map(p => {
        let pInvested = 0;
        let pUnrealizedPnl = 0;
        for (const pos of p.positions) {
          const ep = Number(pos.avgEntryPrice);
          if (pos.side === 'LONG') {
            pInvested += ep * pos.qty;
          } else {
            const rate = pos.exchange === 'MCX' ? 0.10 : pos.exchange === 'CDS' ? 0.05 : 0.25;
            pInvested += ep * pos.qty * rate;
          }
          const ltp = ltpMap.get(pos.symbol) ?? 0;
          if (ltp > 0) {
            pUnrealizedPnl += pos.side === 'SHORT'
              ? (ep - ltp) * pos.qty
              : (ltp - ep) * pos.qty;
          }
        }
        const pCash = Number(p.currentNav);
        const pCapital = Number(p.initialCapital);
        const pNav = pCash + pInvested + pUnrealizedPnl;
        const pTotalPnl = pNav - pCapital;
        return {
          id: p.id,
          name: p.name,
          isDefault: p.isDefault,
          capital: pCapital,
          nav: Number(pNav.toFixed(2)),
          pnl: Number(pTotalPnl.toFixed(2)),
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
