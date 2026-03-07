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
} from '../lib/rust-engine.js';

export async function engineRoutes(app: FastifyInstance) {
  app.addHook('onRequest', async (request, reply) => {
    if (request.url.endsWith('/status')) return;
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
      return { available: true, status: 'error', error: err.message };
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
}
