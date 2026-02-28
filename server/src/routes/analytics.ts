import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../lib/prisma.js';
import { AnalyticsService } from '../services/analytics.service.js';

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const analytics = new AnalyticsService(getPrisma());

  app.addHook('onRequest', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized('Invalid or missing token');
    }
  });

  app.get('/stats', async (request) => {
    const userId = (request.user as any).id;
    const query = request.query as { from?: string; to?: string };
    return { data: await analytics.getTradeStats(userId, query.from, query.to) };
  });

  app.get('/symbols', async (request) => {
    const userId = (request.user as any).id;
    return { data: await analytics.getSymbolBreakdown(userId) };
  });

  app.get('/strategies', async (request) => {
    const userId = (request.user as any).id;
    return { data: await analytics.getStrategyBreakdown(userId) };
  });

  app.get('/equity-curve', async (request) => {
    const userId = (request.user as any).id;
    return { data: await analytics.getEquityCurve(userId) };
  });

  app.get('/export/csv', async (request, reply) => {
    const userId = (request.user as any).id;
    const csv = await analytics.exportTradesCSV(userId);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename=trades.csv');
    return csv;
  });
}
