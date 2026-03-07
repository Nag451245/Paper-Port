import type { PrismaClient } from '@prisma/client';
import { chatCompletionJSON, chatCompletion } from '../lib/openai.js';
import { MarketDataService } from './market-data.service.js';
import { engineOptimize, engineFeatureStore, engineMLScore, isEngineAvailable, type OptimizeInput } from '../lib/rust-engine.js';
import { isMLServiceAvailable, mlTrain, mlDetectRegime, mlAllocate } from '../lib/ml-service-client.js';
import { LearningStoreService } from './learning-store.service.js';
import { getRedis } from '../lib/redis.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('LearningEngine');

const STRATEGIES = [
  'ema-crossover', 'supertrend', 'sma_crossover', 'mean_reversion', 'momentum', 'rsi_reversal', 'orb',
  'gap_trading', 'vwap_reversion', 'volatility_breakout', 'sector_rotation', 'pairs_trading',
  'expiry_theta', 'calendar_spread', 'trend_following',
];

const DEFAULT_PARAM_GRIDS: Record<string, Record<string, number[]>> = {
  'ema-crossover': { ema_short: [5, 9, 13], ema_long: [15, 21, 30] },
  supertrend:      { ema_short: [7, 10, 14], ema_long: [20, 26, 34] },
  sma_crossover:   { ema_short: [5, 10, 15], ema_long: [20, 30, 50] },
  mean_reversion:  { ema_short: [8, 12, 16], ema_long: [18, 24, 32] },
  momentum:        { ema_short: [5, 9, 14], ema_long: [15, 21, 28] },
  rsi_reversal:    { ema_short: [7, 10, 14], ema_long: [20, 26, 34] },
  orb:             { ema_short: [5, 9, 13], ema_long: [15, 21, 30] },
};

export class LearningEngine {
  private marketData = new MarketDataService();
  private learningStore = new LearningStoreService();
  private running = false;

  constructor(private prisma: PrismaClient) {}

  async runNightlyLearning(): Promise<{ usersProcessed: number; insights: number }> {
    if (this.running) return { usersProcessed: 0, insights: 0 };
    this.running = true;

    try {
      const users = await this.prisma.user.findMany({
        where: { isActive: true },
        select: { id: true },
      });

      let insightCount = 0;
      for (const user of users) {
        try {
          await this.processUserLearning(user.id);
          insightCount++;
        } catch (err) {
          console.error(`[LearningEngine] Error processing user ${user.id}:`, (err as Error).message);
        }
      }

      return { usersProcessed: users.length, insights: insightCount };
    } finally {
      this.running = false;
    }
  }

  private async processUserLearning(userId: string): Promise<void> {
    const today = new Date();
    today.setHours(0, 0, 0, 0);

    const todayEnd = new Date(today);
    todayEnd.setHours(23, 59, 59, 999);

    const trades = await this.prisma.trade.findMany({
      where: {
        portfolio: { userId },
        exitTime: { gte: today, lte: todayEnd },
      },
    });

    const signals = await this.prisma.aITradeSignal.findMany({
      where: {
        userId,
        createdAt: { gte: today, lte: todayEnd },
      },
    });

    await this.computeStrategyLedgers(userId, today, trades);
    await this.tagSignalOutcomes(userId, trades, signals);
    await this.autoPopulateJournals(userId, trades);

    const marketContext = await this.getMarketContext();
    const ledgers = await this.prisma.strategyLedger.findMany({
      where: { userId, date: today },
    });
    const insight = await this.generateLearningInsight(userId, today, ledgers, marketContext, trades.length);
    await this.runParameterOptimization(userId, today);

    // Enhanced: false positive analysis, regime tracking, strategy evolution
    await this.analyzeFalsePositives(userId, today, signals, trades);
    await this.trackRegimeAndAdjust(userId, today, insight.marketRegime, ledgers);
    await this.trackStrategyEvolution(userId, today, ledgers);

    // Phase 3: ML model retraining (using expanded features from feature_store)
    await this.retrainMLScorer(userId);

    // Phase 4: Strategy allocation optimization via Thompson sampling
    await this.optimizeStrategyAllocation(userId, ledgers);

    log.info({ userId, trades: trades.length, regime: insight.marketRegime }, 'Nightly learning completed');
  }

  private async computeStrategyLedgers(
    userId: string,
    date: Date,
    trades: Array<{
      id: string;
      strategyTag: string | null;
      grossPnl: any;
      netPnl: any;
    }>,
  ): Promise<void> {
    const grouped = new Map<string, typeof trades>();
    for (const trade of trades) {
      const key = trade.strategyTag || 'unknown';
      if (!grouped.has(key)) grouped.set(key, []);
      grouped.get(key)!.push(trade);
    }

    for (const [strategyId, stratTrades] of grouped) {
      const wins = stratTrades.filter(t => Number(t.netPnl) > 0);
      const losses = stratTrades.filter(t => Number(t.netPnl) < 0);
      const grossPnl = stratTrades.reduce((s, t) => s + Number(t.grossPnl), 0);
      const netPnl = stratTrades.reduce((s, t) => s + Number(t.netPnl), 0);

      const winAmounts = wins.map(t => Number(t.netPnl));
      const lossAmounts = losses.map(t => Math.abs(Number(t.netPnl)));

      const avgWin = winAmounts.length > 0 ? winAmounts.reduce((a, b) => a + b, 0) / winAmounts.length : 0;
      const avgLoss = lossAmounts.length > 0 ? lossAmounts.reduce((a, b) => a + b, 0) / lossAmounts.length : 0;
      const winRate = stratTrades.length > 0 ? (wins.length / stratTrades.length) * 100 : 0;

      const returns = stratTrades.map(t => Number(t.netPnl));
      const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
      const variance = returns.length > 1
        ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
        : 0;
      const std = Math.sqrt(variance);
      const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

      let peak = 0;
      let maxDD = 0;
      let cumulative = 0;
      for (const r of returns) {
        cumulative += r;
        if (cumulative > peak) peak = cumulative;
        const dd = peak > 0 ? (peak - cumulative) / peak : 0;
        if (dd > maxDD) maxDD = dd;
      }

      const activeParam = await this.prisma.strategyParam.findFirst({
        where: { userId, strategyId, isActive: true },
        orderBy: { createdAt: 'desc' },
      });

      const existingLedger = await this.prisma.strategyLedger.findUnique({
        where: { userId_strategyId_date: { userId, strategyId, date } },
      });

      const ledgerData = {
        tradesCount: stratTrades.length,
        wins: wins.length,
        losses: losses.length,
        grossPnl,
        netPnl,
        winRate: round2(winRate),
        avgWin: round2(avgWin),
        avgLoss: round2(avgLoss),
        sharpeRatio: round2(sharpe),
        maxDrawdown: round2(maxDD * 100),
        paramSnapshot: activeParam ? activeParam.params : '{}',
      };

      if (existingLedger) {
        await this.prisma.strategyLedger.update({
          where: { id: existingLedger.id },
          data: ledgerData,
        });
      } else {
        await this.prisma.strategyLedger.create({
          data: { userId, strategyId, date, ...ledgerData },
        });
      }
    }
  }

  private async tagSignalOutcomes(
    userId: string,
    trades: Array<{ id: string; netPnl: any; strategyTag: string | null; symbol: string }>,
    signals: Array<{ id: string; symbol: string; status: string; outcomeTag: string | null }>,
  ): Promise<void> {
    for (const signal of signals) {
      if (signal.outcomeTag) continue;

      const matchingTrade = trades.find(t => t.symbol === signal.symbol);
      if (!matchingTrade) continue;

      const pnl = Number(matchingTrade.netPnl);
      let outcomeTag: string;
      if (Math.abs(pnl) < 10) outcomeTag = 'BREAKEVEN';
      else if (pnl > 0) outcomeTag = 'WIN';
      else outcomeTag = 'LOSS';

      try {
        const notes = await chatCompletion({
          messages: [
            { role: 'system', content: 'You are a trade outcome analyst. Write a concise 1-sentence reason for why this trade resulted the way it did.' },
            { role: 'user', content: `Signal: ${signal.symbol}, Status: ${signal.status}, PnL: ₹${pnl.toFixed(2)}, Outcome: ${outcomeTag}. Explain in one sentence.` },
          ],
          maxTokens: 100,
          temperature: 0.3,
        });
        await this.prisma.aITradeSignal.update({
          where: { id: signal.id },
          data: { outcomeTag, outcomeNotes: notes.trim() },
        });
      } catch {
        await this.prisma.aITradeSignal.update({
          where: { id: signal.id },
          data: { outcomeTag },
        });
      }
    }
  }

  private async autoPopulateJournals(
    userId: string,
    trades: Array<{
      id: string;
      symbol: string;
      side: string;
      entryPrice: any;
      exitPrice: any;
      netPnl: any;
      entryTime: Date;
      exitTime: Date;
    }>,
  ): Promise<void> {
    for (const trade of trades) {
      const existing = await this.prisma.tradeJournal.findUnique({
        where: { tradeId: trade.id },
      });

      if (existing?.signalQualityReview && existing?.exitAnalysis) continue;

      try {
        const analysis = await chatCompletionJSON<{
          signalQualityReview: string;
          exitAnalysis: string;
          improvementSuggestion: string;
        }>({
          messages: [
            {
              role: 'system',
              content: 'You are a trading journal analyst. Analyze the trade and provide brief feedback in JSON with keys: signalQualityReview, exitAnalysis, improvementSuggestion.',
            },
            {
              role: 'user',
              content: `Trade: ${trade.symbol} ${trade.side}, Entry: ₹${trade.entryPrice} at ${trade.entryTime.toISOString()}, Exit: ₹${trade.exitPrice} at ${trade.exitTime.toISOString()}, PnL: ₹${Number(trade.netPnl).toFixed(2)}`,
            },
          ],
          maxTokens: 300,
          temperature: 0.4,
        });

        if (existing) {
          await this.prisma.tradeJournal.update({
            where: { tradeId: trade.id },
            data: {
              signalQualityReview: analysis.signalQualityReview,
              exitAnalysis: analysis.exitAnalysis,
              improvementSuggestion: analysis.improvementSuggestion,
            },
          });
        } else {
          await this.prisma.tradeJournal.create({
            data: {
              tradeId: trade.id,
              userId,
              signalQualityReview: analysis.signalQualityReview,
              exitAnalysis: analysis.exitAnalysis,
              improvementSuggestion: analysis.improvementSuggestion,
            },
          });
        }
      } catch (err) {
        console.error(`[LearningEngine] Journal auto-fill failed for trade ${trade.id}:`, (err as Error).message);
      }
    }
  }

  private async getMarketContext(): Promise<{
    vix: number;
    niftyChange: number;
    fiiNetBuy: number;
  }> {
    try {
      const [vixData, indices, fiiDii] = await Promise.all([
        this.marketData.getVIX().catch(() => ({ value: 15, change: 0, changePercent: 0 })),
        this.marketData.getIndices().catch(() => []),
        this.marketData.getFIIDII().catch(() => ({ fii: { netBuy: 0 }, dii: { netBuy: 0 } })),
      ]);

      const nifty = indices.find((i: { name: string }) => i.name.includes('NIFTY'));
      return {
        vix: vixData.value,
        niftyChange: nifty?.changePercent ?? 0,
        fiiNetBuy: (fiiDii as any)?.fii?.netBuy ?? 0,
      };
    } catch {
      return { vix: 15, niftyChange: 0, fiiNetBuy: 0 };
    }
  }

  private async generateLearningInsight(
    userId: string,
    date: Date,
    ledgers: Array<{
      strategyId: string;
      winRate: number;
      netPnl: any;
      sharpeRatio: number;
      tradesCount: number;
    }>,
    marketContext: { vix: number; niftyChange: number; fiiNetBuy: number },
    totalTrades: number,
  ): Promise<{ marketRegime: string }> {
    const strategyPerformance = ledgers.map(l => ({
      strategy: l.strategyId,
      winRate: l.winRate,
      netPnl: Number(l.netPnl),
      sharpe: l.sharpeRatio,
      trades: l.tradesCount,
    }));

    const sorted = [...strategyPerformance].sort((a, b) => b.netPnl - a.netPnl);
    const topWinners = sorted.filter(s => s.netPnl > 0).slice(0, 3);
    const topLosers = sorted.filter(s => s.netPnl < 0).slice(0, 3);

    let insight: {
      marketRegime: string;
      narrative: string;
      paramAdjustments: Record<string, unknown>;
    };

    try {
      insight = await chatCompletionJSON<{
        marketRegime: string;
        narrative: string;
        paramAdjustments: Record<string, unknown>;
      }>({
        messages: [
          {
            role: 'system',
            content: `You are a quantitative trading analyst. Analyze today's trading performance and market conditions.
Return JSON with:
- marketRegime: one of "trending_up", "trending_down", "range_bound", "volatile"
- narrative: 2-3 paragraph analysis of what worked and what didn't
- paramAdjustments: suggested parameter changes for strategies (keys are strategy names, values are parameter objects)`,
          },
          {
            role: 'user',
            content: `Market Context: VIX=${marketContext.vix}, NIFTY change=${marketContext.niftyChange}%, FII net buy=₹${marketContext.fiiNetBuy}Cr.
Total trades today: ${totalTrades}.
Strategy performance: ${JSON.stringify(strategyPerformance)}
Top winners: ${JSON.stringify(topWinners)}
Top losers: ${JSON.stringify(topLosers)}`,
          },
        ],
        maxTokens: 1000,
        temperature: 0.4,
      });
    } catch {
      insight = {
        marketRegime: marketContext.vix > 20 ? 'volatile' : (marketContext.niftyChange > 0.5 ? 'trending_up' : marketContext.niftyChange < -0.5 ? 'trending_down' : 'range_bound'),
        narrative: `Today saw ${totalTrades} trades across ${ledgers.length} strategies. VIX at ${marketContext.vix}. ${topWinners.length > 0 ? `Best performer: ${topWinners[0].strategy}` : 'No winning strategies today.'}`,
        paramAdjustments: {},
      };
    }

    const existing = await this.prisma.learningInsight.findUnique({
      where: { userId_date: { userId, date } },
    });

    const insightData = {
      marketRegime: insight.marketRegime,
      topWinningStrategies: JSON.stringify(topWinners.map(w => w.strategy)),
      topLosingStrategies: JSON.stringify(topLosers.map(l => l.strategy)),
      paramAdjustments: JSON.stringify(insight.paramAdjustments),
      narrative: insight.narrative,
    };

    if (existing) {
      await this.prisma.learningInsight.update({
        where: { id: existing.id },
        data: insightData,
      });
    } else {
      await this.prisma.learningInsight.create({
        data: { userId, date, ...insightData },
      });
    }

    return { marketRegime: insight.marketRegime };
  }

  private async runParameterOptimization(userId: string, date: Date): Promise<void> {
    const thirtyDaysAgo = new Date(date);
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    for (const strategy of STRATEGIES) {
      try {
        const grid = DEFAULT_PARAM_GRIDS[strategy];
        if (!grid) continue;

        const recentTrades = await this.prisma.trade.findMany({
          where: {
            portfolio: { userId },
            strategyTag: strategy,
            exitTime: { gte: thirtyDaysAgo },
          },
          take: 1,
        });
        if (recentTrades.length === 0) continue;

        let candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }> = [];
        try {
          const history = await this.marketData.getHistory('NIFTY 50', '1day', thirtyDaysAgo.toISOString().split('T')[0], date.toISOString().split('T')[0], userId, 'NSE');
          candles = (history as any[]).map((h: any) => ({
            timestamp: h.date || h.timestamp || new Date().toISOString(),
            open: Number(h.open),
            high: Number(h.high),
            low: Number(h.low),
            close: Number(h.close),
            volume: Number(h.volume || 0),
          }));
        } catch {
          continue;
        }

        if (candles.length < 20) continue;

        const input: OptimizeInput = {
          strategy,
          symbol: 'NIFTY 50',
          initial_capital: 1000000,
          candles,
          param_grid: grid,
        };

        const result = await engineOptimize(input);

        if (result.best_sharpe <= 0) continue;

        await this.prisma.strategyParam.updateMany({
          where: { userId, strategyId: strategy, isActive: true },
          data: { isActive: false },
        });

        const latestParam = await this.prisma.strategyParam.findFirst({
          where: { userId, strategyId: strategy },
          orderBy: { version: 'desc' },
        });

        await this.prisma.strategyParam.create({
          data: {
            userId,
            strategyId: strategy,
            version: (latestParam?.version ?? 0) + 1,
            params: JSON.stringify(result.best_params),
            source: 'backtest_optimized',
            backtestMetrics: JSON.stringify({
              sharpe: result.best_sharpe,
              winRate: result.best_win_rate,
              profitFactor: result.best_profit_factor,
            }),
            isActive: true,
          },
        });
      } catch (err) {
        console.error(`[LearningEngine] Optimization failed for ${strategy}:`, (err as Error).message);
      }
    }
  }

  private async analyzeFalsePositives(
    userId: string,
    date: Date,
    signals: Array<{ id: string; symbol: string; signalType: string; compositeScore: number; status: string; outcomeTag: string | null }>,
    trades: Array<{ symbol: string; netPnl: any }>,
  ): Promise<void> {
    const falsePositives = signals.filter(s => {
      if (s.outcomeTag === 'LOSS') return true;
      if (s.status === 'EXPIRED' || s.status === 'REJECTED') return true;
      if (s.status === 'EXECUTED') {
        const trade = trades.find(t => t.symbol === s.symbol);
        return trade && Number(trade.netPnl) < 0;
      }
      return false;
    });

    if (falsePositives.length === 0) return;

    // Group by symbol to find pattern
    const bySymbol = new Map<string, number>();
    for (const fp of falsePositives) {
      bySymbol.set(fp.symbol, (bySymbol.get(fp.symbol) || 0) + 1);
    }

    const fpData = {
      date: date.toISOString().split('T')[0],
      total: falsePositives.length,
      bySymbol: Object.fromEntries(bySymbol),
      avgConfidence: falsePositives.reduce((s, fp) => s + fp.compositeScore, 0) / falsePositives.length,
      signals: falsePositives.map(fp => ({
        symbol: fp.symbol,
        type: fp.signalType,
        confidence: fp.compositeScore,
        status: fp.status,
        outcome: fp.outcomeTag,
      })),
    };

    try {
      await this.learningStore.writeFalsePositives(date, fpData);
    } catch (err) {
      console.error('[LearningEngine] FP store write failed:', (err as Error).message);
    }
  }

  private async trackRegimeAndAdjust(
    userId: string,
    date: Date,
    regime: string,
    ledgers: Array<{ strategyId: string; winRate: number; netPnl: any; sharpeRatio: number }>,
  ): Promise<void> {
    // Record regime
    const performanceSummary: Record<string, { winRate: number; pnl: number; sharpe: number }> = {};
    for (const l of ledgers) {
      performanceSummary[l.strategyId] = {
        winRate: l.winRate,
        pnl: Number(l.netPnl),
        sharpe: l.sharpeRatio,
      };
    }

    try {
      await this.learningStore.writeRegimeLog(date, regime, {
        strategyPerformance: performanceSummary,
      });
    } catch (err) {
      console.error('[LearningEngine] Regime log write failed:', (err as Error).message);
    }
  }

  private async trackStrategyEvolution(
    userId: string,
    date: Date,
    ledgers: Array<{ strategyId: string; winRate: number; netPnl: any; sharpeRatio: number; tradesCount: number }>,
  ): Promise<void> {
    for (const ledger of ledgers) {
      if (ledger.tradesCount === 0) continue;

      const activeParam = await this.prisma.strategyParam.findFirst({
        where: { userId, strategyId: ledger.strategyId, isActive: true },
        select: { params: true, version: true },
      });

      try {
        await this.learningStore.writeStrategyEvolution(ledger.strategyId, {
          date: date.toISOString().split('T')[0],
          userId,
          winRate: ledger.winRate,
          pnl: Number(ledger.netPnl),
          sharpe: ledger.sharpeRatio,
          trades: ledger.tradesCount,
          paramVersion: activeParam?.version ?? 0,
          params: activeParam?.params ? JSON.parse(activeParam.params) : null,
        });
      } catch (err) {
        console.error(`[LearningEngine] Strategy evolution write failed for ${ledger.strategyId}:`, (err as Error).message);
      }
    }

    // Alpha decay tracking
    await this.trackAlphaDecay(userId, date, ledgers);
  }

  private async trackAlphaDecay(
    userId: string,
    date: Date,
    ledgers: Array<{ strategyId: string; winRate: number; netPnl: any; sharpeRatio: number; tradesCount: number }>,
  ): Promise<void> {
    for (const ledger of ledgers) {
      try {
        const dateOnly = new Date(date.toISOString().split('T')[0]);

        // Compute rolling Sharpe from recent trade history
        const windows = [30, 60, 90];
        const sharpes: Record<string, number | null> = {};
        let hitRate30d: number | null = null;

        for (const days of windows) {
          const since = new Date(date);
          since.setDate(since.getDate() - days);
          const trades = await this.prisma.trade.findMany({
            where: {
              portfolio: { userId },
              strategyTag: ledger.strategyId,
              exitTime: { gte: since, lte: date },
            },
            select: { netPnl: true },
          });

          if (trades.length >= 5) {
            const returns = trades.map(t => Number(t.netPnl));
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
            sharpes[`sharpe${days}d`] = std > 0 ? (mean / std) * Math.sqrt(252 / days) : 0;

            if (days === 30) {
              hitRate30d = returns.filter(r => r > 0).length / returns.length;
            }
          } else {
            sharpes[`sharpe${days}d`] = null;
          }
        }

        const isDecaying = (sharpes['sharpe30d'] ?? 1) < 0.5 && (sharpes['sharpe60d'] ?? 1) > (sharpes['sharpe30d'] ?? 0);

        await this.prisma.alphaDecay.upsert({
          where: {
            userId_strategyId_date: { userId, strategyId: ledger.strategyId, date: dateOnly },
          },
          update: {
            sharpe30d: sharpes['sharpe30d'],
            sharpe60d: sharpes['sharpe60d'],
            sharpe90d: sharpes['sharpe90d'],
            hitRate30d: hitRate30d,
            signalCount: ledger.tradesCount,
            isDecaying,
          },
          create: {
            userId,
            strategyId: ledger.strategyId,
            date: dateOnly,
            sharpe30d: sharpes['sharpe30d'],
            sharpe60d: sharpes['sharpe60d'],
            sharpe90d: sharpes['sharpe90d'],
            hitRate30d: hitRate30d,
            signalCount: ledger.tradesCount,
            isDecaying,
          },
        });

        if (isDecaying) {
          console.warn(`[LearningEngine] Alpha decay detected for ${ledger.strategyId}: 30d Sharpe=${sharpes['sharpe30d']?.toFixed(2)}`);
        }
      } catch (err) {
        console.error(`[LearningEngine] Alpha decay tracking failed for ${ledger.strategyId}:`, (err as Error).message);
      }
    }
  }

  private async retrainMLScorer(userId: string): Promise<void> {
    try {
      if (!isEngineAvailable()) return;

      // Collect last 90 days of decision audits with outcomes
      const since = new Date();
      since.setDate(since.getDate() - 90);

      const decisions = await this.prisma.decisionAudit.findMany({
        where: {
          userId,
          createdAt: { gte: since },
          outcome: { not: null },
          decisionType: 'ENTRY_SIGNAL',
        },
        select: {
          symbol: true,
          confidence: true,
          direction: true,
          outcome: true,
          marketDataSnapshot: true,
          entryPrice: true,
          exitPrice: true,
          pnl: true,
          createdAt: true,
        },
        orderBy: { createdAt: 'desc' },
        take: 500,
      });

      if (decisions.length < 30) {
        log.info({ userId, samples: decisions.length }, 'Not enough samples for ML retraining (need 30)');
        return;
      }

      // Build training data, enriching with full 76-feature vectors from the Feature Store
      const trainingData = [];
      for (const d of decisions) {
        const snapshot = typeof d.marketDataSnapshot === 'string'
          ? JSON.parse(d.marketDataSnapshot) : d.marketDataSnapshot;

        const hour = d.createdAt.getHours();
        const dow = d.createdAt.getDay();

        // Attempt to compute rich features from stored candle data
        let rawFeatures: number[] = [];
        if (isEngineAvailable()) {
          try {
            const fromDate = new Date(d.createdAt.getTime() - 60 * 86400000).toISOString().split('T')[0];
            const toDate = d.createdAt.toISOString().split('T')[0];
            const candles = await this.marketData.getHistory(
              d.symbol, '1d', fromDate, toDate, undefined, 'NSE',
            );
            if (candles && candles.length >= 30) {
              const featureResult = await engineFeatureStore({
                command: 'extract_features',
                candles: candles.map((c: any) => ({
                  timestamp: c.timestamp || c.date,
                  open: c.open, high: c.high, low: c.low,
                  close: c.close, volume: c.volume,
                })),
              }) as any;
              // Use the last row of features (most recent day)
              if (featureResult?.features?.data?.length > 0) {
                const lastRow = featureResult.features.data[featureResult.features.data.length - 1];
                rawFeatures = lastRow;
              }
            }
          } catch {
            // Fall back to empty raw_features — base features still work
          }
        }

        trainingData.push({
          features: {
            ema_vote: snapshot?.ema_vote ?? d.confidence * 0.5,
            rsi_vote: snapshot?.rsi_vote ?? 0,
            macd_vote: snapshot?.macd_vote ?? 0,
            supertrend_vote: snapshot?.supertrend_vote ?? 0,
            bollinger_vote: snapshot?.bollinger_vote ?? 0,
            vwap_vote: snapshot?.vwap_vote ?? 0,
            momentum_vote: snapshot?.momentum_vote ?? d.confidence * 0.6,
            volume_vote: snapshot?.volume_vote ?? 0,
            composite_score: d.confidence,
            regime: 1.0,
            hour_of_day: hour,
            day_of_week: dow,
            raw_features: rawFeatures,
          },
          outcome: d.outcome === 'WIN' ? 1.0 : 0.0,
        });
      }

      // Ensure all feature rows have consistent dimension (some may lack raw_features)
      const maxRawLen = Math.max(...trainingData.map(d => d.features.raw_features.length));
      if (maxRawLen > 0) {
        for (const d of trainingData) {
          while (d.features.raw_features.length < maxRawLen) {
            d.features.raw_features.push(0);
          }
        }
      }

      const result = await engineMLScore({
        command: 'train',
        training_data: trainingData,
        learning_rate: 0.01,
        epochs: 500,
      }) as { weights: Record<string, unknown>; training_accuracy: number; samples_used: number };

      // Persist weights for the bot engine to load
      const existingWeights = await this.prisma.strategyParam.findFirst({
        where: { userId, strategyId: 'ml_scorer_weights' },
        orderBy: { createdAt: 'desc' },
      });

      if (existingWeights) {
        await this.prisma.strategyParam.update({
          where: { id: existingWeights.id },
          data: {
            params: JSON.stringify(result.weights),
            isActive: true,
            version: existingWeights.version + 1,
          },
        });
      } else {
        await this.prisma.strategyParam.create({
          data: {
            userId,
            strategyId: 'ml_scorer_weights',
            params: JSON.stringify(result.weights),
            isActive: true,
            version: 1,
          },
        });
      }

      log.info({
        userId,
        accuracy: result.training_accuracy,
        samples: result.samples_used,
      }, 'Rust ML scorer retrained');

      // Also train Python XGBoost/LightGBM if available
      if (await isMLServiceAvailable()) {
        try {
          const xgbResult = await mlTrain({
            training_data: trainingData,
            model_type: 'xgboost',
            walk_forward_days: 30,
            purge_gap_days: 5,
          });
          log.info({
            userId,
            model: 'xgboost',
            accuracy: xgbResult.accuracy,
            auc: xgbResult.auc_roc,
            trainSamples: xgbResult.training_samples,
          }, 'Python XGBoost model retrained');

          const lgbResult = await mlTrain({
            training_data: trainingData,
            model_type: 'lightgbm',
            walk_forward_days: 30,
            purge_gap_days: 5,
          });
          log.info({
            userId,
            model: 'lightgbm',
            accuracy: lgbResult.accuracy,
            auc: lgbResult.auc_roc,
          }, 'Python LightGBM model retrained');
        } catch (pyErr) {
          log.warn({ err: pyErr }, 'Python ML training failed (non-fatal, Rust model still active)');
        }
      }
    } catch (err) {
      log.error({ err, userId }, 'ML scorer retraining failed');
    }
  }

  private async optimizeStrategyAllocation(
    userId: string,
    ledgers: Array<{ strategyId: string; wins: number; losses: number; sharpeRatio: number }>,
  ): Promise<void> {
    try {
      if (!isEngineAvailable()) return;
      if (ledgers.length === 0) return;

      // Get alpha decay data for each strategy
      const decayData = await this.prisma.alphaDecay.findMany({
        where: { userId },
        orderBy: { date: 'desc' },
        distinct: ['strategyId'],
      });
      const decayMap = new Map(decayData.map(d => [d.strategyId, d.isDecaying]));

      const strategyStats = ledgers.map(l => ({
        strategy_id: l.strategyId,
        wins: l.wins,
        losses: l.losses,
        sharpe: l.sharpeRatio,
        is_decaying: decayMap.get(l.strategyId) ?? false,
      }));

      const user = await this.prisma.user.findUnique({
        where: { id: userId },
        select: { virtualCapital: true },
      });
      const capital = Number(user?.virtualCapital ?? 1_000_000);

      const result = await engineMLScore({
        command: 'allocate' as any,
        strategy_stats: strategyStats as any,
        total_capital: capital,
      }) as any;

      if (result?.allocations) {
        // Persist allocation result so bot-engine can use it for capital sizing
        const existingAlloc = await this.prisma.strategyParam.findFirst({
          where: { userId, strategyId: 'strategy_allocations' },
          orderBy: { createdAt: 'desc' },
        });

        const allocData = JSON.stringify({
          allocations: result.allocations,
          method: result.method,
          computedAt: new Date().toISOString(),
        });

        if (existingAlloc) {
          await this.prisma.strategyParam.update({
            where: { id: existingAlloc.id },
            data: { params: allocData, isActive: true, version: existingAlloc.version + 1 },
          });
        } else {
          await this.prisma.strategyParam.create({
            data: {
              userId,
              strategyId: 'strategy_allocations',
              params: allocData,
              isActive: true,
              version: 1,
            },
          });
        }

        log.info({
          userId,
          allocations: result.allocations,
          method: result.method,
        }, 'Strategy allocation optimized and persisted (Rust)');
      }

      // Also call Python ML service for enhanced Bayesian allocation
      if (await isMLServiceAvailable()) {
        try {
          const pyResult = await mlAllocate({
            strategy_stats: strategyStats.map(s => ({
              ...s,
              avg_return: 0,
            })),
            total_capital: capital,
            current_regime: 'unknown',
            risk_budget_pct: 2.0,
          });

          log.info({
            userId,
            allocations: pyResult.allocations,
            method: pyResult.method,
            explorationRate: pyResult.exploration_rate,
          }, 'Python strategy allocation computed');
        } catch (pyErr) {
          log.warn({ err: pyErr }, 'Python allocation failed (non-fatal)');
        }
      }
    } catch (err) {
      log.error({ err, userId }, 'Strategy allocation optimization failed');
    }
  }

  // Track consecutive losses per strategy for intraday deallocation
  private consecutiveLosses = new Map<string, number>();
  private intradayTradeCount = 0;
  private lastRegimeCheck = 0;

  /**
   * Intraday Bayesian update — called on each POSITION_CLOSED event during trading hours.
   * Updates per-strategy Thompson sampling alpha/beta, adjusts confidence,
   * persists state to Redis, and triggers regime re-detection every 5 trades.
   */
  async runIntradayUpdate(trade: {
    strategyTag: string;
    netPnl: number;
    userId: string;
    symbol: string;
  }): Promise<void> {
    const { strategyTag, netPnl, userId } = trade;
    if (!strategyTag) return;

    const won = netPnl > 0;
    const key = `${userId}:${strategyTag}`;
    this.intradayTradeCount++;

    // Update consecutive loss tracker
    if (won) {
      this.consecutiveLosses.set(key, 0);
    } else {
      const prev = this.consecutiveLosses.get(key) ?? 0;
      this.consecutiveLosses.set(key, prev + 1);
    }

    const consecutiveLossCount = this.consecutiveLosses.get(key) ?? 0;

    // Update StrategyParam confidence in DB
    try {
      const activeParam = await this.prisma.strategyParam.findFirst({
        where: { userId, strategyId: strategyTag, isActive: true },
        orderBy: { createdAt: 'desc' },
      });

      if (activeParam) {
        const currentParams = typeof activeParam.params === 'string'
          ? JSON.parse(activeParam.params) : (activeParam.params ?? {});

        // Bayesian confidence update: shift confidence toward actual outcomes
        const priorConfidence = currentParams.confidence ?? 1.0;
        const learningRate = 0.1;
        const newConfidence = priorConfidence * (1 - learningRate) + (won ? 1.0 : 0.0) * learningRate;

        // Apply penalty for 3+ consecutive losses: reduce allocation by 50%
        const confidenceMultiplier = consecutiveLossCount >= 3 ? 0.5 : 1.0;

        currentParams.confidence = Math.round(newConfidence * confidenceMultiplier * 1000) / 1000;
        currentParams.intradayWins = (currentParams.intradayWins ?? 0) + (won ? 1 : 0);
        currentParams.intradayLosses = (currentParams.intradayLosses ?? 0) + (won ? 0 : 1);
        currentParams.consecutiveLosses = consecutiveLossCount;
        currentParams.lastUpdateTime = new Date().toISOString();

        await this.prisma.strategyParam.update({
          where: { id: activeParam.id },
          data: { params: JSON.stringify(currentParams) },
        });

        if (consecutiveLossCount >= 3) {
          log.warn({
            userId, strategyTag, consecutiveLossCount,
            reducedConfidence: currentParams.confidence,
          }, 'Strategy throttled: 3+ consecutive losses, allocation reduced 50%');
        }
      }
    } catch (err) {
      log.warn({ err, strategyTag, userId }, 'Intraday Bayesian update failed');
    }

    // Persist Thompson sampling state to Redis for crash recovery
    await this.persistThompsonState(userId, strategyTag, won);

    // Intraday regime re-detection every 5 trades
    if (this.intradayTradeCount % 5 === 0) {
      this.intradayRegimeRecheck(userId).catch(err =>
        log.warn({ err }, 'Intraday regime recheck failed'),
      );
    }

    // Intraday alpha decay check every 10 trades
    if (this.intradayTradeCount % 10 === 0) {
      this.intradayAlphaDecayCheck(userId, strategyTag).catch(err =>
        log.warn({ err }, 'Intraday alpha decay check failed'),
      );
    }
  }

  private async persistThompsonState(userId: string, strategyTag: string, won: boolean): Promise<void> {
    try {
      const redis = getRedis();
      if (!redis) return;

      const key = `cg:thompson:${userId}:${strategyTag}`;
      const raw = await redis.get(key);
      const state = raw ? JSON.parse(raw) : { alpha: 1, beta: 1, emaWinRate: 0.5, totalTrades: 0 };

      if (won) { state.alpha += 1; } else { state.beta += 1; }
      state.totalTrades += 1;
      const decay = 0.05;
      state.emaWinRate = state.emaWinRate * (1 - decay) + (won ? 1.0 : 0.0) * decay;
      state.lastUpdate = new Date().toISOString();

      await redis.set(key, JSON.stringify(state), 'EX', 24 * 3600);
    } catch (err) {
      log.warn({ err, userId, strategyTag }, 'Failed to persist Thompson state');
    }
  }

  private async intradayRegimeRecheck(userId: string): Promise<void> {
    const now = Date.now();
    if (now - this.lastRegimeCheck < 120_000) return;
    this.lastRegimeCheck = now;

    if (!await isMLServiceAvailable()) return;

    try {
      const candles = await this.marketData.getHistory('NIFTY 50', '5m',
        new Date(now - 2 * 86400000).toISOString().split('T')[0],
        new Date().toISOString().split('T')[0], undefined, 'NSE',
      );
      if (!candles || candles.length < 30) return;

      const closes = candles.slice(-60).map(c => c.close);
      const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
      const volatility = returns.map((_, i) => {
        const window = returns.slice(Math.max(0, i - 9), i + 1);
        const mean = window.reduce((a, b) => a + b, 0) / window.length;
        return Math.sqrt(window.reduce((s, r) => s + (r - mean) ** 2, 0) / window.length);
      });

      const regime = await mlDetectRegime({ returns, volatility });

      const redis = getRedis();
      if (redis && regime?.current_regime) {
        const maxProb = Math.max(...Object.values(regime.regime_probabilities ?? {}), 0);
        await redis.set(`cg:intraday_regime:${userId}`, JSON.stringify({
          regime: regime.current_regime,
          confidence: maxProb,
          timestamp: new Date().toISOString(),
        }), 'EX', 3600);
        log.info({ userId, regime: regime.current_regime, confidence: maxProb },
          'Intraday regime re-detected');
      }
    } catch (err) {
      log.warn({ err, userId }, 'Intraday regime recheck failed');
    }
  }

  private async intradayAlphaDecayCheck(userId: string, strategyTag: string): Promise<void> {
    try {
      const since = new Date();
      since.setDate(since.getDate() - 7);

      const recentTrades = await this.prisma.trade.findMany({
        where: {
          portfolio: { userId },
          strategyTag,
          exitTime: { gte: since },
        },
        select: { netPnl: true },
        orderBy: { exitTime: 'desc' },
        take: 20,
      });

      if (recentTrades.length < 5) return;

      const returns = recentTrades.map(t => Number(t.netPnl));
      const wins = returns.filter(r => r > 0).length;
      const hitRate = wins / returns.length;
      const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
      const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
      const recentSharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

      const isDecaying = recentSharpe < 0.3 && hitRate < 0.4;

      if (isDecaying) {
        log.warn({
          userId, strategyTag, recentSharpe: round2(recentSharpe),
          hitRate: round2(hitRate), sampleSize: returns.length,
        }, 'Intraday alpha decay detected — strategy underperforming in recent trades');

        const redis = getRedis();
        if (redis) {
          await redis.set(`cg:alpha_decay_alert:${userId}:${strategyTag}`,
            JSON.stringify({ isDecaying, recentSharpe, hitRate, detectedAt: new Date().toISOString() }),
            'EX', 8 * 3600);
        }
      }
    } catch (err) {
      log.warn({ err, userId, strategyTag }, 'Intraday alpha decay check failed');
    }
  }

  /**
   * Reset intraday learning state at market open.
   * Called by the server orchestrator at 9:15 IST.
   */
  resetIntradayState(): void {
    this.consecutiveLosses.clear();
    this.intradayTradeCount = 0;
    this.lastRegimeCheck = 0;
    log.info('Intraday learning state reset for new trading day');
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
