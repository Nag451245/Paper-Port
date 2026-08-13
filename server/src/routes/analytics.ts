import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../lib/prisma.js';
import { AnalyticsService } from '../services/analytics.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';

export async function analyticsRoutes(app: FastifyInstance): Promise<void> {
  const analytics = new AnalyticsService(getPrisma());

  app.addHook('onRequest', authenticate);

  app.get('/stats', async (request) => {
    const userId = getUserId(request);
    const query = request.query as { from?: string; to?: string };
    return { data: await analytics.getTradeStats(userId, query.from, query.to) };
  });

  app.get('/symbols', async (request) => {
    const userId = getUserId(request);
    return { data: await analytics.getSymbolBreakdown(userId) };
  });

  app.get('/strategies', async (request) => {
    const userId = getUserId(request);
    return { data: await analytics.getStrategyBreakdown(userId) };
  });

  app.get('/equity-curve', async (request) => {
    const userId = getUserId(request);
    return { data: await analytics.getEquityCurve(userId) };
  });

  app.get('/export/csv', async (request, reply) => {
    const userId = getUserId(request);
    const csv = await analytics.exportTradesCSV(userId);
    reply.header('Content-Type', 'text/csv');
    reply.header('Content-Disposition', 'attachment; filename=trades.csv');
    return csv;
  });
}
