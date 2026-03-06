import type { FastifyInstance } from 'fastify';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { RiskService } from '../services/risk.service.js';
import { OptionsPositionService } from '../services/options-position.service.js';
import { IntradayManager } from '../services/intraday-manager.service.js';
import { DecisionAuditService } from '../services/decision-audit.service.js';

export async function riskRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const riskService = new RiskService(prisma);
  const optionsService = new OptionsPositionService(prisma);
  const intradayManager = new IntradayManager(prisma);
  const auditService = new DecisionAuditService(prisma);

  app.addHook('preHandler', authenticate);

  // ── Comprehensive Risk Dashboard ──
  app.get('/comprehensive', async (request, reply) => {
    const userId = getUserId(request);
    const result = await riskService.getComprehensiveRisk(userId);
    return reply.send(result);
  });

  app.get('/daily-summary', async (request, reply) => {
    const userId = getUserId(request);
    const result = await riskService.getDailyRiskSummary(userId);
    return reply.send(result);
  });

  app.get('/var', async (request, reply) => {
    const userId = getUserId(request);
    const confidence = Number((request.query as any).confidence ?? 0.95);
    const days = Number((request.query as any).days ?? 1);
    const result = await riskService.getPortfolioVaR(userId, confidence, days);
    return reply.send(result);
  });

  app.get('/sectors', async (request, reply) => {
    const userId = getUserId(request);
    const result = await riskService.getSectorConcentration(userId);
    return reply.send(result);
  });

  app.get('/margin', async (request, reply) => {
    const userId = getUserId(request);
    const result = await riskService.getMarginUtilization(userId);
    return reply.send(result);
  });

  // ── Options Position Management ──
  app.get('/options/greeks', async (request, reply) => {
    const userId = getUserId(request);
    const spotPrice = Number((request.query as any).spotPrice ?? 0) || undefined;
    const result = await optionsService.getOptionsPortfolioGreeks(userId, spotPrice);
    return reply.send(result);
  });

  app.get('/options/expiring', async (request, reply) => {
    const userId = getUserId(request);
    const withinDays = Number((request.query as any).days ?? 3);
    const result = await optionsService.getExpiringPositions(userId, withinDays);
    return reply.send(result);
  });

  app.post('/options/roll', async (request, reply) => {
    const userId = getUserId(request);
    const { positionId, newStrike, newExpiry } = request.body as any;
    if (!positionId || !newStrike || !newExpiry) {
      return reply.code(400).send({ error: 'positionId, newStrike, and newExpiry required' });
    }
    try {
      const result = await optionsService.rollPosition(userId, positionId, Number(newStrike), newExpiry);
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ── Intraday Management ──
  app.post('/intraday/square-off-all', async (request, reply) => {
    const results = await intradayManager.squareOffAllIntraday();
    return reply.send({ squaredOff: results.length, details: results });
  });

  app.post('/intraday/square-off/:positionId', async (request, reply) => {
    const { positionId } = request.params as any;
    try {
      const result = await intradayManager.squareOffPosition(positionId);
      return reply.send(result ?? { error: 'Position not found' });
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/intraday/partial-exit', async (request, reply) => {
    const userId = getUserId(request);
    const { positionId, qty } = request.body as any;
    if (!positionId || !qty) {
      return reply.code(400).send({ error: 'positionId and qty required' });
    }
    try {
      const result = await intradayManager.partialExit(positionId, Number(qty), userId);
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/intraday/scale-in', async (request, reply) => {
    const userId = getUserId(request);
    const { positionId, qty, price } = request.body as any;
    if (!positionId || !qty || !price) {
      return reply.code(400).send({ error: 'positionId, qty, and price required' });
    }
    try {
      const result = await intradayManager.scaleIn(positionId, Number(qty), Number(price), userId);
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  app.post('/intraday/convert-delivery', async (request, reply) => {
    const userId = getUserId(request);
    const { positionId } = request.body as any;
    if (!positionId) {
      return reply.code(400).send({ error: 'positionId required' });
    }
    try {
      const result = await intradayManager.convertToDelivery(positionId, userId);
      return reply.send(result);
    } catch (err: any) {
      return reply.code(400).send({ error: err.message });
    }
  });

  // ── Decision Audit Trail ──
  app.get('/decisions', async (request, reply) => {
    const userId = getUserId(request);
    const query = request.query as any;
    const result = await auditService.getDecisionHistory(userId, {
      symbol: query.symbol,
      botId: query.botId,
      decisionType: query.decisionType,
      fromDate: query.fromDate,
      toDate: query.toDate,
      page: Number(query.page ?? 1),
      limit: Number(query.limit ?? 50),
    });
    return reply.send(result);
  });

  app.get('/decisions/analytics', async (request, reply) => {
    const userId = getUserId(request);
    const days = Number((request.query as any).days ?? 30);
    const result = await auditService.getDecisionAnalytics(userId, days);
    return reply.send(result);
  });

  // ── Stop-Loss Monitor Status ──
  app.get('/stop-loss/status', async (_request, reply) => {
    const monitor = (app as any).stopLossMonitor;
    if (!monitor) return reply.send({ active: false, positions: [] });
    return reply.send({
      active: true,
      monitoredCount: monitor.getMonitoredCount(),
      positions: monitor.getMonitoredPositions(),
    });
  });

  app.post('/stop-loss/update', async (request, reply) => {
    const { positionId, newStopPrice } = request.body as any;
    if (!positionId || !newStopPrice) {
      return reply.code(400).send({ error: 'positionId and newStopPrice required' });
    }
    const monitor = (app as any).stopLossMonitor;
    if (!monitor) return reply.code(503).send({ error: 'Stop-loss monitor not active' });
    monitor.updateStopLoss(positionId, Number(newStopPrice));
    return reply.send({ updated: true, positionId, newStopPrice });
  });
}
