import type { FastifyInstance } from 'fastify';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { env } from '../config.js';
import { RiskService } from '../services/risk.service.js';
import { OptionsPositionService } from '../services/options-position.service.js';
import { IntradayManager } from '../services/intraday-manager.service.js';
import { DecisionAuditService } from '../services/decision-audit.service.js';
import { AuditService } from '../services/audit.service.js';
import { PerformanceMetricsService } from '../services/performance-metrics.service.js';
import { DataPipelineService } from '../services/data-pipeline.service.js';
import { isMLServiceAvailable } from '../lib/ml-service-client.js';
import { isEngineAvailable } from '../lib/rust-engine.js';
import { getRedis } from '../lib/redis.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('RiskRoutes');

export async function riskRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const oms = (app as any).oms;
  const riskService = new RiskService(prisma);
  const optionsService = new OptionsPositionService(prisma);
  const intradayManager = new IntradayManager(prisma, oms);
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

  // ── Kill Switch ──
  const audit = new AuditService(prisma);

  app.post('/kill-switch', async (request, reply) => {
    const userId = getUserId(request);
    const botEngine = (app as any).botEngine;

    if (!botEngine) {
      return reply.code(503).send({ error: 'Bot engine not available' });
    }

    botEngine.activateKillSwitch();

    const squaredOff = await intradayManager.squareOffAllIntraday();

    await audit.log('KILL_SWITCH_ACTIVATED', 'System', undefined, userId, {
      squaredOffCount: squaredOff.length,
    });

    log.fatal({ userId, squaredOff: squaredOff.length }, 'Kill switch activated');

    return reply.send({
      killSwitchActive: true,
      botsStoppedAll: true,
      positionsSquaredOff: squaredOff.length,
      message: 'KILL SWITCH ACTIVATED: All bots stopped, all positions squared off.',
    });
  });

  app.post('/kill-switch/deactivate', async (request, reply) => {
    const userId = getUserId(request);
    const botEngine = (app as any).botEngine;
    if (!botEngine) return reply.code(503).send({ error: 'Bot engine not available' });

    botEngine.deactivateKillSwitch();
    await audit.log('KILL_SWITCH_DEACTIVATED', 'System', undefined, userId);

    return reply.send({ killSwitchActive: false, message: 'Kill switch deactivated. Trading re-enabled.' });
  });

  app.get('/kill-switch/status', async (_request, reply) => {
    const botEngine = (app as any).botEngine;
    return reply.send({ killSwitchActive: botEngine?.killSwitchActive ?? false });
  });

  // ── Detailed System Health ──
  app.get('/health/detailed', async (_request, reply) => {
    const botEngine = (app as any).botEngine;

    let redisOk = false;
    try {
      const redis = getRedis();
      if (redis) { await redis.ping(); redisOk = true; }
    } catch { /* redis unavailable */ }

    let breezeOk = false;
    try {
      const res = await fetch(`${env.BREEZE_BRIDGE_URL}/health`);
      breezeOk = res.ok;
    } catch { /* breeze bridge down */ }

    const engineOk = isEngineAvailable();

    const activeBots = botEngine?.getStatus?.()?.runningBots ?? 0;
    const killSwitchActive = botEngine?.killSwitchActive ?? false;

    return reply.send({
      timestamp: new Date().toISOString(),
      services: {
        database: true,
        redis: redisOk,
        breezeBridge: breezeOk,
        rustEngine: engineOk,
      },
      trading: {
        killSwitchActive,
        activeBots,
      },
      system: {
        uptime: process.uptime(),
        memoryMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        nodeVersion: process.version,
      },
    });
  });

  // ── Execution Quality Analytics ──
  app.get('/execution-quality', async (request, reply) => {
    const userId = getUserId(request);
    const days = Number((request.query as any).days ?? 30);
    const since = new Date();
    since.setDate(since.getDate() - days);

    const portfolios = await prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    if (!portfolios.length) return reply.send({ orders: [], summary: {} });

    const orders = await prisma.order.findMany({
      where: {
        portfolioId: { in: portfolios.map(p => p.id) },
        filledAt: { gte: since },
        idealPrice: { not: null },
      },
      select: {
        symbol: true,
        side: true,
        qty: true,
        idealPrice: true,
        avgFillPrice: true,
        slippageBps: true,
        fillLatencyMs: true,
        impactCost: true,
        filledAt: true,
      },
      orderBy: { filledAt: 'desc' },
      take: 200,
    });

    const slippages = orders.map(o => Number(o.slippageBps ?? 0)).filter(s => s > 0);
    const avgSlippage = slippages.length > 0 ? slippages.reduce((a, b) => a + b, 0) / slippages.length : 0;
    const totalImpact = orders.reduce((s, o) => s + Number(o.impactCost ?? 0), 0);

    return reply.send({
      orders,
      summary: {
        totalOrders: orders.length,
        avgSlippageBps: Number(avgSlippage.toFixed(2)),
        totalImpactCost: Number(totalImpact.toFixed(2)),
        avgLatencyMs: slippages.length > 0
          ? Math.round(orders.reduce((s, o) => s + (o.fillLatencyMs ?? 0), 0) / orders.length)
          : 0,
      },
    });
  });

  // ── Performance Metrics (Section 5.3) ──
  const metricsService = new PerformanceMetricsService(prisma);

  app.get('/metrics/daily', async (request, reply) => {
    const userId = getUserId(request);
    const metrics = await metricsService.computeDailyMetrics(userId);
    return reply.send(metrics);
  });

  app.get('/metrics/summary', async (request, reply) => {
    const userId = getUserId(request);
    const { days } = request.query as { days?: string };
    const summary = await metricsService.getMetricsSummary(userId, parseInt(days ?? '7', 10));
    return reply.send(summary);
  });

  app.get('/metrics/target-progress', async (request, reply) => {
    const userId = getUserId(request);
    const { target } = request.query as { target?: string };
    const progress = await metricsService.getTargetProgress(userId, parseFloat(target ?? '0.5'));
    return reply.send(progress);
  });

  app.get('/position-sizing', async (request, reply) => {
    const userId = getUserId(request);
    const { entry, stopLoss } = request.query as { entry?: string; stopLoss?: string };

    if (!entry || !stopLoss) {
      return reply.status(400).send({ error: 'entry and stopLoss query params required' });
    }

    const portfolios = await prisma.portfolio.findMany({
      where: { userId },
      select: { initialCapital: true },
    });
    const capital = Number(portfolios[0]?.initialCapital ?? 1_000_000);

    const sizeMultiplier = await riskService.getSizeMultiplier(userId);
    const sizing = riskService.computePositionSize(
      capital * sizeMultiplier,
      parseFloat(entry),
      parseFloat(stopLoss),
    );

    return reply.send({
      ...sizing,
      sizeMultiplier,
      effectiveCapital: Math.round(capital * sizeMultiplier),
    });
  });

  // ── System Status & Pipeline (Section 5.2 / 5.3) ──
  const pipeline = new DataPipelineService();

  app.get('/system/status', async (_request, reply) => {
    const [pipelineStats, mlAvailable, rustAvailable, redisOk] = await Promise.all([
      pipeline.getStats(),
      isMLServiceAvailable(),
      Promise.resolve(isEngineAvailable()),
      (async () => { const r = getRedis(); return r !== null; })(),
    ]);

    const startTime = process.env.SERVER_START_TIME
      ? parseInt(process.env.SERVER_START_TIME, 10)
      : Date.now();
    const uptimeMs = Date.now() - startTime;
    const uptimeHours = Math.round(uptimeMs / 3_600_000 * 10) / 10;

    return reply.send({
      uptime: {
        ms: uptimeMs,
        hours: uptimeHours,
        startedAt: new Date(startTime).toISOString(),
      },
      services: {
        rustEngine: rustAvailable,
        pythonML: mlAvailable,
        redis: redisOk,
        database: true,
      },
      pipeline: pipelineStats,
      version: process.env.npm_package_version ?? '1.0.0',
    });
  });

  app.get('/pipeline/stats', async (_request, reply) => {
    const stats = await pipeline.getStats();
    return reply.send(stats);
  });

  app.get('/pipeline/stream/:name', async (request, reply) => {
    const { name } = request.params as { name: string };
    const { count } = request.query as { count?: string };
    const streamKey = `stream:${name}`;
    const entries = await pipeline.readStream(streamKey, parseInt(count ?? '20', 10));
    return reply.send({ stream: streamKey, entries });
  });
}
