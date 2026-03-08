import type { FastifyInstance } from 'fastify';
import {
  isEngineAvailable,
  engineHealth,
  engineListStrategies,
  enginePortfolioSnapshot,
  engineListPositions,
  engineMonteCarlo,
  engineCorrelation,
  engineFeatureStore,
  engineMultiTimeframeScan,
  enginePortfolioOptimize,
  engineKillSwitch,
  engineAuditLog,
  engineOMSSubmitOrder,
  engineOMSCancelOrder,
  engineOMSCancelAll,
  engineOMSOrders,
  engineOMSReconcile,
  engineAlerts,
  engineAlertCounts,
  engineAlertAcknowledge,
  engineBrokerStatus,
  engineBrokerInitSession,
} from '../lib/rust-engine.js';

export async function engineRoutes(app: FastifyInstance) {
  const publicPaths = ['/status'];

  app.addHook('onRequest', async (request, reply) => {
    const routePath = request.routeOptions?.url ?? request.url;
    if (publicPaths.includes(routePath)) return;
    try {
      await request.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized('Invalid or missing token');
    }
  });

  app.get('/status', async () => {
    const available = isEngineAvailable();
    if (!available) {
      return { available: false, status: 'not_installed' };
    }
    try {
      const health = await engineHealth();
      return { available: true, ...health };
    } catch (err: any) {
      return { available: true, status: 'error', error: 'Health check failed' };
    }
  });

  app.get('/strategies', async () => {
    if (!isEngineAvailable()) {
      return {
        strategies: [
          'ema_crossover', 'sma_crossover', 'rsi_reversal',
          'mean_reversion', 'momentum', 'opening_range_breakout',
        ],
        source: 'fallback',
      };
    }
    try {
      const result = await engineListStrategies();
      return { ...result, source: 'engine' };
    } catch {
      return {
        strategies: [
          'ema_crossover', 'sma_crossover', 'rsi_reversal',
          'mean_reversion', 'momentum', 'opening_range_breakout',
        ],
        source: 'fallback',
      };
    }
  });

  app.get('/portfolio/snapshot', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return enginePortfolioSnapshot();
  });

  app.get('/portfolio/positions', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineListPositions();
  });

  app.post('/monte-carlo', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineMonteCarlo(req.body as any);
  });

  app.post('/correlation', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineCorrelation(req.body as any);
  });

  app.post('/feature-store', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineFeatureStore(req.body as any);
  });

  app.post('/multi-timeframe', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineMultiTimeframeScan(req.body as any);
  });

  app.post('/portfolio/optimize', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return enginePortfolioOptimize(req.body as any);
  });

  // Kill switch
  app.post('/kill-switch', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineKillSwitch(true);
  });

  app.post('/kill-switch/off', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineKillSwitch(false);
  });

  // Audit log
  app.get('/audit-log', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineAuditLog();
  });

  // ── OMS Routes ──

  app.post('/oms/orders', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineOMSSubmitOrder(req.body as any);
  });

  app.get('/oms/orders', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const query = req.query as Record<string, string>;
    return engineOMSOrders(query.strategy_id);
  });

  app.post('/oms/orders/:orderId/cancel', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const { orderId } = req.params as { orderId: string };
    return engineOMSCancelOrder(orderId);
  });

  app.post('/oms/cancel-all', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineOMSCancelAll();
  });

  app.post('/oms/reconcile', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineOMSReconcile();
  });

  // ── Alert Routes ──

  app.get('/alerts', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const query = req.query as Record<string, string>;
    return engineAlerts(query.min_severity, query.limit ? parseInt(query.limit) : undefined);
  });

  app.get('/alerts/counts', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineAlertCounts();
  });

  app.post('/alerts/:alertId/acknowledge', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const { alertId } = req.params as { alertId: string };
    return engineAlertAcknowledge(alertId);
  });

  // ── Broker Routes ──

  app.get('/broker/status', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineBrokerStatus();
  });

  app.post('/broker/init-session', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineBrokerInitSession();
  });
}
