import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../lib/prisma.js';
import { LearningEngine } from '../services/learning-engine.js';

export async function learningRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const learningEngine = new LearningEngine(prisma);

  app.addHook('onRequest', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized('Invalid or missing token');
    }
  });

  app.get('/insights', async (request) => {
    const userId = (request.user as any).id;
    const query = request.query as { limit?: string };
    const limit = Math.min(parseInt(query.limit || '30', 10), 90);

    const insights = await prisma.learningInsight.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: limit,
    });

    return { data: insights };
  });

  app.get('/insights/latest', async (request) => {
    const userId = (request.user as any).id;

    const insight = await prisma.learningInsight.findFirst({
      where: { userId },
      orderBy: { date: 'desc' },
    });

    return { data: insight };
  });

  app.get('/ledger', async (request) => {
    const userId = (request.user as any).id;
    const query = request.query as { days?: string; strategy?: string };
    const days = Math.min(parseInt(query.days || '30', 10), 90);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const where: any = { userId, date: { gte: since } };
    if (query.strategy) where.strategyId = query.strategy;

    const ledgers = await prisma.strategyLedger.findMany({
      where,
      orderBy: { date: 'desc' },
    });

    return { data: ledgers };
  });

  app.get('/ledger/heatmap', async (request) => {
    const userId = (request.user as any).id;
    const query = request.query as { days?: string };
    const days = Math.min(parseInt(query.days || '60', 10), 180);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const ledgers = await prisma.strategyLedger.findMany({
      where: { userId, date: { gte: since } },
      orderBy: { date: 'asc' },
    });

    const heatmap: Record<string, Array<{ date: string; winRate: number; netPnl: number; trades: number }>> = {};
    for (const l of ledgers) {
      if (!heatmap[l.strategyId]) heatmap[l.strategyId] = [];
      heatmap[l.strategyId].push({
        date: l.date.toISOString().split('T')[0],
        winRate: l.winRate,
        netPnl: Number(l.netPnl),
        trades: l.tradesCount,
      });
    }

    return { data: heatmap };
  });

  app.get('/params', async (request) => {
    const userId = (request.user as any).id;
    const query = request.query as { strategy?: string };

    const where: any = { userId };
    if (query.strategy) where.strategyId = query.strategy;

    const params = await prisma.strategyParam.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      take: 50,
    });

    return { data: params };
  });

  app.get('/params/active', async (request) => {
    const userId = (request.user as any).id;

    const params = await prisma.strategyParam.findMany({
      where: { userId, isActive: true },
    });

    return { data: params };
  });

  app.get('/regime-timeline', async (request) => {
    const userId = (request.user as any).id;
    const query = request.query as { days?: string };
    const days = Math.min(parseInt(query.days || '30', 10), 90);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const insights = await prisma.learningInsight.findMany({
      where: { userId, date: { gte: since } },
      orderBy: { date: 'asc' },
      select: { date: true, marketRegime: true },
    });

    return {
      data: insights.map(i => ({
        date: i.date.toISOString().split('T')[0],
        regime: i.marketRegime,
      })),
    };
  });

  app.get('/calibration', async (request) => {
    const userId = (request.user as any).id;

    const signals = await prisma.aITradeSignal.findMany({
      where: { userId, outcomeTag: { not: null } },
      orderBy: { createdAt: 'desc' },
      take: 200,
      select: { compositeScore: true, outcomeTag: true },
    });

    const buckets: Record<string, { total: number; wins: number }> = {};
    for (const s of signals) {
      const bucket = `${Math.floor(s.compositeScore * 10) / 10}`;
      if (!buckets[bucket]) buckets[bucket] = { total: 0, wins: 0 };
      buckets[bucket].total++;
      if (s.outcomeTag === 'WIN') buckets[bucket].wins++;
    }

    const calibration = Object.entries(buckets)
      .map(([confidence, { total, wins }]) => ({
        confidence: parseFloat(confidence),
        predicted: parseFloat(confidence),
        actual: total > 0 ? wins / total : 0,
        count: total,
      }))
      .sort((a, b) => a.confidence - b.confidence);

    return { data: calibration };
  });

  app.post('/trigger-nightly', async (request) => {
    const userId = (request.user as any).id;
    const user = await prisma.user.findUnique({ where: { id: userId } });
    if (!user) throw app.httpErrors.notFound('User not found');

    const result = await learningEngine.runNightlyLearning();
    return { data: result };
  });
}
