import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { IntelligenceService } from '../services/intelligence.service.js';

const symbolParam = z.string().min(1).max(30).regex(/^[A-Z0-9&_-]+$/i, 'Invalid symbol');

function parseSymbol(params: unknown): string | null {
  const result = symbolParam.safeParse((params as any)?.symbol);
  return result.success ? result.data : null;
}

export async function intelligenceRoutes(app: FastifyInstance): Promise<void> {
  const service = new IntelligenceService();

  app.get('/fii-dii', async (_req, reply) => reply.send(await service.getFIIDII()));
  app.get('/fii-dii/trend', async (req, reply) => {
    const { days } = req.query as { days?: string };
    const d = Math.min(Math.max(Number(days) || 30, 1), 365);
    return reply.send(await service.getFIIDIITrend(d));
  });

  app.get('/options/pcr/:symbol', async (req, reply) => {
    const sym = parseSymbol(req.params);
    if (!sym) return reply.code(400).send({ error: 'Invalid symbol' });
    return reply.send(await service.getPCR(sym));
  });
  app.get('/options/oi-heatmap/:symbol', async (req, reply) => {
    const sym = parseSymbol(req.params);
    if (!sym) return reply.code(400).send({ error: 'Invalid symbol' });
    return reply.send(await service.getOIHeatmap(sym));
  });
  app.get('/options/max-pain/:symbol', async (req, reply) => {
    const sym = parseSymbol(req.params);
    if (!sym) return reply.code(400).send({ error: 'Invalid symbol' });
    return reply.send(await service.getMaxPain(sym));
  });
  app.get('/options/iv-percentile/:symbol', async (req, reply) => {
    const sym = parseSymbol(req.params);
    if (!sym) return reply.code(400).send({ error: 'Invalid symbol' });
    return reply.send(await service.getIVPercentile(sym));
  });
  app.get('/options/greeks/:symbol', async (req, reply) => {
    const sym = parseSymbol(req.params);
    if (!sym) return reply.code(400).send({ error: 'Invalid symbol' });
    return reply.send(await service.getGreeks(sym));
  });

  app.get('/sectors/performance', async (_req, reply) => reply.send(await service.getSectorPerformance()));
  app.get('/sectors/heatmap', async (_req, reply) => reply.send(await service.getSectorHeatmap()));
  app.get('/sectors/rrg', async (_req, reply) => reply.send(await service.getSectorRRG()));
  app.get('/sectors/rotation-alerts', async (_req, reply) => reply.send(await service.getSectorRotationAlerts()));

  app.get('/global/indices', async (_req, reply) => reply.send(await service.getGlobalIndices()));
  app.get('/global/fx', async (_req, reply) => reply.send(await service.getFXRates()));
  app.get('/global/commodities', async (_req, reply) => reply.send(await service.getCommodities()));
  app.get('/global/us-summary', async (_req, reply) => reply.send(await service.getUSSummary()));
  app.get('/global/sgx-nifty', async (_req, reply) => reply.send(await service.getSGXNifty()));

  app.get('/block-deals', async (_req, reply) => reply.send(await service.getBlockDeals()));
  app.get('/block-deals/smart-money', async (_req, reply) => reply.send(await service.getSmartMoney()));
  app.get('/insider-transactions', async (_req, reply) => reply.send(await service.getInsiderTransactions()));
  app.get('/insider-transactions/cluster-buys', async (_req, reply) => reply.send(await service.getClusterBuys()));
  app.get('/insider-transactions/selling/:symbol', async (req, reply) => {
    const sym = parseSymbol(req.params);
    if (!sym) return reply.code(400).send({ error: 'Invalid symbol' });
    return reply.send(await service.getInsiderSelling(sym));
  });

  app.get('/earnings/calendar', async (_req, reply) => reply.send(await service.getEarningsCalendar()));
  app.get('/earnings/rbi-mpc', async (_req, reply) => reply.send(await service.getRBIMPC()));
  app.get('/earnings/macro-events', async (_req, reply) => reply.send(await service.getMacroEvents()));
  app.get('/earnings/blackout/:symbol', async (req, reply) => {
    const sym = parseSymbol(req.params);
    if (!sym) return reply.code(400).send({ error: 'Invalid symbol' });
    return reply.send(await service.getBlackout(sym));
  });
  app.get('/earnings/event-impact', async (_req, reply) => reply.send(await service.getEventImpact()));
}
