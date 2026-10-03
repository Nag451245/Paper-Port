import type { FastifyInstance } from 'fastify';
import { authenticate, requireAdmin } from '../middleware/auth.js';
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
  engineOMSModifyOrder,
  engineOMSCancelOrder,
  engineOMSCancelAll,
  engineOMSOrders,
  engineOMSReconcile,
  engineAlerts,
  engineAlertCounts,
  engineAlertAcknowledge,
  engineBrokerStatus,
  engineBrokerInitSession,
  engineBrokerOptionChain,
  engineBrokerExpiries,
  engineBrokerLotSizes,
  engineBrokerQuote,
  engineMarketDataPrices,
} from '../lib/rust-engine.js';

export async function engineRoutes(app: FastifyInstance) {
  // Matched against the route pattern (never the raw URL, which a query string can pad).
  const publicRoutes = new Set([`${app.prefix}/status`]);

  app.addHook('preHandler', async (request, reply) => {
    if (publicRoutes.has(request.routeOptions?.url ?? '')) return;
    await authenticate(request, reply);
  });

  // Engine controls act on the engine shared by every user: administrator only.
  const adminOnly = { preHandler: [requireAdmin] };

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
  app.post('/kill-switch', adminOnly, async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineKillSwitch(true);
  });

  app.post('/kill-switch/off', adminOnly, async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineKillSwitch(false);
  });

  // Audit log
  app.get('/audit-log', adminOnly, async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineAuditLog();
  });

  // ── OMS Routes ──

  app.post('/oms/orders', adminOnly, async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineOMSSubmitOrder(req.body as any);
  });

  app.get('/oms/orders', adminOnly, async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const query = req.query as Record<string, string>;
    return engineOMSOrders(query.strategy_id);
  });

  app.post('/oms/orders/:orderId/modify', adminOnly, async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const { orderId } = req.params as { orderId: string };
    const body = req.body as { quantity?: number; price?: number; trigger_price?: number } | undefined;
    return engineOMSModifyOrder(orderId, body ?? {});
  });

  app.post('/oms/orders/:orderId/cancel', adminOnly, async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const { orderId } = req.params as { orderId: string };
    return engineOMSCancelOrder(orderId);
  });

  app.post('/oms/cancel-all', adminOnly, async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineOMSCancelAll();
  });

  app.post('/oms/reconcile', adminOnly, async () => {
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

  app.post('/alerts/:alertId/acknowledge', adminOnly, async (req) => {
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

  app.post('/broker/init-session', adminOnly, async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineBrokerInitSession();
  });

  // ── Market Data via Engine (direct Breeze Bridge access) ──

  app.get('/broker/option-chain/:symbol', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const { symbol } = req.params as { symbol: string };
    const query = req.query as Record<string, string>;
    return engineBrokerOptionChain(symbol, query.expiry);
  });

  app.get('/broker/expiries/:symbol', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const { symbol } = req.params as { symbol: string };
    return engineBrokerExpiries(symbol);
  });

  app.get('/broker/lot-sizes', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineBrokerLotSizes();
  });

  app.get('/broker/quote/:symbol', async (req) => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    const { symbol } = req.params as { symbol: string };
    return engineBrokerQuote(symbol);
  });

  app.get('/market-data/prices', async () => {
    if (!isEngineAvailable()) {
      throw app.httpErrors.serviceUnavailable('Engine not available');
    }
    return engineMarketDataPrices();
  });
}
