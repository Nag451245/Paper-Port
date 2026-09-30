import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BacktestService, BacktestError } from '../services/backtest.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { BacktestEngine } from '../services/backtest-engine.service.js';
import { WalkForwardOptimizer } from '../services/walk-forward.service.js';
import { MonteCarloSimulator } from '../services/monte-carlo.service.js';
import { StrategyRegistry } from '../services/strategy-sdk.js';
import { HistoricalDataService } from '../services/historical-data.service.js';
import { isDerivativeSymbol, parseInstrumentSymbol } from '../lib/instrument.js';
import { ReplayService, ReplayError } from '../services/replay.service.js';

const runSchema = z.object({
  strategyId: z.string().min(1, 'strategyId is required'),
  symbol: z.string().min(1, 'symbol is required'),
  startDate: z.string().min(1, 'startDate is required'),
  endDate: z.string().min(1, 'endDate is required'),
  initialCapital: z.number().positive('initialCapital must be a positive number'),
  parameters: z.record(z.unknown()).optional(),
  // Breeze v2 serves these; 15-minute and hourly are not among them.
  interval: z.enum(['1day', '30minute', '5minute', '1minute']).optional(),
}).superRefine((v, ctx) => {
  // A contract symbol that names no real contract (bad expiry date, fractional
  // strike) must be refused here, not become a backtest over nothing.
  if (isDerivativeSymbol(v.symbol)) {
    try { parseInstrumentSymbol(v.symbol); } catch (err) {
      ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['symbol'], message: (err as Error).message });
    }
  }
});

const replayIntervals = z.enum(['1day', '30minute', '5minute', '1minute']);

const replayCandlesSchema = z.object({
  symbol: z.string().min(1).max(40),
  interval: replayIntervals,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
});

const replayChargesSchema = z.object({
  fills: z.array(z.object({
    symbol: z.string().min(1).max(40),
    qty: z.number().positive(),
    price: z.number().positive(),
    side: z.enum(['BUY', 'SELL']),
  })).min(1).max(50),
});

const replaySessionSchema = z.object({
  mode: z.enum(['stock', 'fno']),
  symbol: z.string().min(1).max(40),
  interval: replayIntervals,
  from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'Use YYYY-MM-DD'),
  initialCapital: z.number().positive(),
  notes: z.string().max(2000).optional(),
  trades: z.array(z.object({
    symbol: z.string().min(1).max(40),
    side: z.enum(['LONG', 'SHORT']),
    qty: z.number().positive(),
    entryTime: z.string().min(1),
    exitTime: z.string().min(1),
    entryPrice: z.number().positive(),
    exitPrice: z.number().nonnegative(),
    charges: z.number().nonnegative(),
    netPnl: z.number(),
    reason: z.string().max(20),
  })).max(5000),
  equityCurve: z.array(z.object({ time: z.string(), value: z.number() })).max(20000),
});

const compareSchema = z.object({
  resultIds: z.array(z.string()).min(2, 'At least 2 result IDs are required for comparison'),
});

const walkForwardSchema = z.object({
  strategyName: z.string().min(1),
  symbol: z.string().min(1),
  startDate: z.string().min(1),
  endDate: z.string().min(1),
  initialCapital: z.number().positive(),
  windowCount: z.number().int().min(2).max(20).optional(),
  inSampleRatio: z.number().min(0.5).max(0.9).optional(),
  anchoredStart: z.boolean().optional(),
  paramRanges: z.array(z.object({ name: z.string(), values: z.array(z.number()) })).optional(),
});

const monteCarloSchema = z.object({
  resultId: z.string().min(1),
  iterations: z.number().int().min(100).max(100000).optional(),
});

export async function backtestRoutes(app: FastifyInstance): Promise<void> {
  const service = new BacktestService(getPrisma());

  app.addHook('preHandler', authenticate);

  app.post('/run', async (request, reply) => {
    const parsed = runSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const result = await service.run(userId, parsed.data);
      return reply.code(201).send(result);
    } catch (err) {
      if (err instanceof BacktestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/results', async (request, reply) => {
    try {
      const userId = getUserId(request);
      const results = await service.listResults(userId);
      return reply.send(results);
    } catch (err) {
      if (err instanceof BacktestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.get('/results/:resultId', async (request, reply) => {
    try {
      const { resultId } = request.params as { resultId: string };
      const userId = getUserId(request);
      const result = await service.getResult(resultId, userId);
      return reply.send(result);
    } catch (err) {
      if (err instanceof BacktestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/compare', async (request, reply) => {
    const parsed = compareSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const results = await service.compare(userId, parsed.data.resultIds);
      return reply.send(results);
    } catch (err) {
      if (err instanceof BacktestError) {
        return reply.code(err.statusCode).send({ error: err.message });
      }
      throw err;
    }
  });

  app.post('/walk-forward', async (request, reply) => {
    const parsed = walkForwardSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const { strategyName, symbol, startDate, endDate, initialCapital, windowCount, inSampleRatio, anchoredStart, paramRanges } = parsed.data;

      const strategy = StrategyRegistry.getInstance().get(strategyName);
      if (!strategy) return reply.code(404).send({ error: `Strategy '${strategyName}' not found` });

      const histService = new HistoricalDataService();
      const bars = await histService.getHistory(symbol, 'NSE', '1d', new Date(startDate), new Date(endDate));
      const sdkBars = bars.map(b => ({ timestamp: new Date(b.timestamp), open: b.open, high: b.high, low: b.low, close: b.close, volume: Number(b.volume) }));

      const optimizer = new WalkForwardOptimizer();
      const result = optimizer.run({
        strategy,
        bars: sdkBars,
        paramRanges: paramRanges ?? strategy.parameters.filter(p => p.type === 'number').map(p => ({ name: p.name, values: Array.from({ length: 5 }, (_, i) => (p.min ?? 5) + i * (p.step ?? 5)) })),
        symbol,
        initialCapital,
        windowCount,
        inSampleRatio,
        anchoredStart,
      });

      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof BacktestError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/monte-carlo', async (request, reply) => {
    const parsed = monteCarloSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const { resultId, iterations } = parsed.data;

      const btResult = await service.getResult(resultId, userId);
      if (!btResult) return reply.code(404).send({ error: 'Backtest result not found' });

      const tradeLog = typeof btResult.tradeLog === 'string' ? JSON.parse(btResult.tradeLog) : btResult.tradeLog;
      const trades = tradeLog.map((t: any) => ({
        entryDate: new Date(t.entryDate), exitDate: new Date(t.exitDate), symbol: btResult.strategyId,
        side: t.side === 'SHORT' ? 'SELL' as const : 'BUY' as const,
        entryPrice: t.entryPrice, exitPrice: t.exitPrice, qty: t.qty,
        grossPnl: t.pnl, commission: 0, slippage: 0, netPnl: t.pnl,
        holdingBars: 0, mae: 0, mfe: 0,
      }));

      const mc = new MonteCarloSimulator();
      const result = mc.run({ trades, initialCapital: Number(btResult.equityCurve ? JSON.parse(typeof btResult.equityCurve === 'string' ? btResult.equityCurve : '[]')[0]?.value ?? 1000000 : 1000000), iterations });

      return reply.code(200).send(result);
    } catch (err) {
      if (err instanceof BacktestError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/results/:resultId/analysis', async (request, reply) => {
    try {
      const { resultId } = request.params as { resultId: string };
      const userId = getUserId(request);
      const btResult = await service.getResult(resultId, userId);
      if (!btResult) return reply.code(404).send({ error: 'Result not found' });

      const tradeLog = typeof btResult.tradeLog === 'string' ? JSON.parse(btResult.tradeLog) : btResult.tradeLog;
      const trades = tradeLog.map((t: any) => ({
        entryDate: new Date(t.entryDate), exitDate: new Date(t.exitDate), symbol: btResult.strategyId,
        side: t.side === 'SHORT' ? 'SELL' as const : 'BUY' as const,
        entryPrice: t.entryPrice, exitPrice: t.exitPrice, qty: t.qty,
        grossPnl: t.pnl, commission: 0, slippage: 0, netPnl: t.pnl,
        holdingBars: 0, mae: 0, mfe: 0,
      }));

      const mc = new MonteCarloSimulator();
      const analysis = mc.run({ trades, initialCapital: 1000000 });

      return reply.code(200).send({
        metrics: {
          sharpeRatio: btResult.sharpeRatio,
          sortinoRatio: btResult.sortinoRatio,
          maxDrawdown: btResult.maxDrawdown,
          winRate: btResult.winRate,
          profitFactor: btResult.profitFactor,
          totalTrades: btResult.totalTrades,
          cagr: btResult.cagr,
        },
        monteCarlo: analysis,
      });
    } catch (err) {
      if (err instanceof BacktestError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // ── Replay Lab: manual backtesting ──
  const replay = new ReplayService(getPrisma());
  const replayFail = (reply: any, err: unknown) => {
    if (err instanceof ReplayError) return reply.code(err.statusCode).send({ error: err.message });
    throw err;
  };

  app.get('/replay/candles', async (request, reply) => {
    const parsed = replayCandlesSchema.safeParse(request.query);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const { symbol, interval, from, to } = parsed.data;
    try {
      const bars = await replay.candles(getUserId(request), symbol.toUpperCase(), interval, from, to);
      return reply.send({ symbol: symbol.toUpperCase(), interval, bars });
    } catch (err) { return replayFail(reply, err); }
  });

  app.post('/replay/charges', async (request, reply) => {
    const parsed = replayChargesSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    try {
      return reply.send({ charges: replay.charges(parsed.data.fills) });
    } catch (err) {
      return reply.code(400).send({ error: (err as Error).message });
    }
  });

  app.get('/replay/lot-size', async (request, reply) => {
    const underlying = String((request.query as { underlying?: string }).underlying ?? '');
    if (!/^[A-Za-z&]{1,20}$/.test(underlying)) return reply.code(400).send({ error: 'underlying is required' });
    return reply.send(await replay.lotSize(underlying));
  });

  app.post('/replay/sessions', async (request, reply) => {
    const parsed = replaySessionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    try {
      const saved = await replay.saveSession(getUserId(request), parsed.data);
      return reply.code(201).send(saved);
    } catch (err) { return replayFail(reply, err); }
  });
}
