import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../lib/prisma.js';
import { StrategyComposer } from '../services/strategy-composer.js';
import { SentimentEngine } from '../services/sentiment-engine.js';
import { engineAdvancedSignals, engineIVSurface, engineWalkForward } from '../lib/rust-engine.js';
import type { ServerOrchestrator } from '../services/server-orchestrator.js';

export async function edgeRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const composer = new StrategyComposer(prisma);
  const sentiment = new SentimentEngine(prisma);

  app.addHook('onRequest', async (request, reply) => {
    // Market status is public — skip auth
    if (request.url.endsWith('/market-status')) return;
    try {
      await request.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized('Invalid or missing token');
    }
  });

  app.get('/market-status', async () => {
    const orchestrator = (app as any).orchestrator as ServerOrchestrator | undefined;
    if (!orchestrator) {
      return { error: 'Orchestrator not available' };
    }
    return orchestrator.getStatus();
  });

  // ── Strategy Composition ──
  app.get('/composition', async (req) => {
    const userId = (req as any).user?.id;
    return composer.composePortfolio(userId);
  });

  app.get('/composition/kelly/:strategy', async (req) => {
    const userId = (req as any).user?.id;
    const { strategy } = req.params as { strategy: string };

    const ledgers = await prisma.strategyLedger.findMany({
      where: { userId, strategyId: strategy },
      orderBy: { date: 'desc' },
      take: 30,
    });

    if (ledgers.length === 0) {
      return { kellyFraction: 0, halfKelly: 0, suggestedAllocation: 0.05, winRate: 0, avgWinLossRatio: 0, message: 'Insufficient data' };
    }

    const wins = ledgers.filter((l: any) => l.winRate > 50);
    const winRate = wins.length / ledgers.length;
    const avgWin = ledgers.filter((l: any) => Number(l.netPnl) > 0).reduce((s: number, l: any) => s + Number(l.netPnl), 0) / (wins.length || 1);
    const avgLoss = Math.abs(ledgers.filter((l: any) => Number(l.netPnl) < 0).reduce((s: number, l: any) => s + Number(l.netPnl), 0)) / (ledgers.filter((l: any) => Number(l.netPnl) < 0).length || 1);

    return composer.computeKelly(winRate, avgWin, avgLoss);
  });

  // ── Walk-Forward Validation ──
  app.post('/walk-forward', async (req) => {
    const body = req.body as {
      strategy: string;
      symbol: string;
      candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
      param_grid?: Record<string, number[]>;
      num_folds?: number;
    };

    return engineWalkForward({
      strategy: body.strategy,
      symbol: body.symbol,
      initial_capital: 100000,
      candles: body.candles,
      param_grid: body.param_grid ?? { ema_short: [5, 7, 9, 12, 15], ema_long: [15, 18, 21, 26, 30] },
      in_sample_ratio: 0.7,
      num_folds: body.num_folds ?? 5,
    });
  });

  // ── Sentiment Intelligence ──
  app.get('/sentiment', async () => {
    return sentiment.getSentimentSnapshot();
  });

  app.post('/sentiment/analyze', async (req) => {
    const { symbols } = req.body as { symbols: string[] };
    return sentiment.getAISentimentAnalysis(symbols ?? []);
  });

  // ── Advanced Signals (VWAP, Volume Profile, Order Flow, Market Profile) ──
  app.post('/advanced-signals', async (req) => {
    const body = req.body as {
      candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
      compute?: string[];
    };

    return engineAdvancedSignals({
      candles: body.candles,
      compute: body.compute ?? ['vwap', 'volume_profile', 'order_flow', 'market_profile'],
    });
  });

  // ── IV Surface ──
  app.post('/iv-surface', async (req) => {
    const body = req.body as {
      spot: number;
      strikes: Array<{
        strike: number;
        expiry_days: number;
        call_price?: number;
        put_price?: number;
        call_iv?: number;
        put_iv?: number;
      }>;
    };

    return engineIVSurface({
      spot: body.spot,
      strikes: body.strikes,
    });
  });

  // ── Track Record / Performance ──
  app.get('/track-record', async (req) => {
    const userId = (req as any).user?.id;
    const trades = await prisma.trade.findMany({
      where: { portfolio: { userId } },
      orderBy: { exitTime: 'asc' },
    });

    let cumPnl = 0;
    const timeline: Array<{ date: string; cumPnl: number; tradeCount: number }> = [];
    const dailyMap = new Map<string, { pnl: number; count: number }>();

    for (const t of trades) {
      const date = t.exitTime ? new Date(t.exitTime).toISOString().split('T')[0] : 'unknown';
      const existing = dailyMap.get(date) ?? { pnl: 0, count: 0 };
      existing.pnl += Number(t.netPnl);
      existing.count += 1;
      dailyMap.set(date, existing);
    }

    for (const [date, data] of [...dailyMap.entries()].sort()) {
      cumPnl += data.pnl;
      timeline.push({ date, cumPnl: Number(cumPnl.toFixed(2)), tradeCount: data.count });
    }

    const portfolio = await prisma.portfolio.findFirst({ where: { userId } });
    const initialCapital = portfolio ? Number(portfolio.initialCapital) : 1000000;
    const currentNav = portfolio ? Number(portfolio.currentNav) : initialCapital;
    const totalReturn = ((currentNav - initialCapital) / initialCapital) * 100;

    const wins = trades.filter((t: any) => Number(t.netPnl) > 0);
    const losses = trades.filter((t: any) => Number(t.netPnl) < 0);
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
    const avgWin = wins.length > 0 ? wins.reduce((s: number, t: any) => s + Number(t.netPnl), 0) / wins.length : 0;
    const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s: number, t: any) => s + Number(t.netPnl), 0) / losses.length) : 0;
    const profitFactor = avgLoss > 0 ? avgWin * wins.length / (avgLoss * losses.length) : 0;

    let maxDD = 0;
    let peak = 0;
    for (const entry of timeline) {
      if (entry.cumPnl > peak) peak = entry.cumPnl;
      const dd = peak > 0 ? ((peak - entry.cumPnl) / peak) * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }

    const byStrategy = new Map<string, { trades: number; pnl: number; wins: number }>();
    for (const t of trades) {
      const key = t.strategyTag || 'manual';
      const existing = byStrategy.get(key) ?? { trades: 0, pnl: 0, wins: 0 };
      existing.trades += 1;
      existing.pnl += Number(t.netPnl);
      if (Number(t.netPnl) > 0) existing.wins += 1;
      byStrategy.set(key, existing);
    }

    return {
      timeline,
      summary: {
        totalTrades: trades.length,
        totalReturn: Number(totalReturn.toFixed(2)),
        winRate: Number(winRate.toFixed(1)),
        profitFactor: Number(profitFactor.toFixed(2)),
        maxDrawdown: Number(maxDD.toFixed(2)),
        avgWin: Number(avgWin.toFixed(2)),
        avgLoss: Number(avgLoss.toFixed(2)),
        initialCapital,
        currentNav: Number(currentNav.toFixed(2)),
      },
      byStrategy: Object.fromEntries(
        [...byStrategy.entries()].map(([k, v]) => [k, { ...v, pnl: Number(v.pnl.toFixed(2)), winRate: v.trades > 0 ? Number(((v.wins / v.trades) * 100).toFixed(1)) : 0 }]),
      ),
    };
  });
}
