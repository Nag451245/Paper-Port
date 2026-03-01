import type { PrismaClient } from '@prisma/client';
import { chatCompletionJSON, chatCompletion } from '../lib/openai.js';
import { MarketDataService } from './market-data.service.js';
import { engineOptimize, isEngineAvailable, type OptimizeInput } from '../lib/rust-engine.js';

const STRATEGIES = ['ema-crossover', 'supertrend', 'sma_crossover', 'mean_reversion', 'momentum', 'rsi_reversal', 'orb'];

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

    console.log(`[LearningEngine] User ${userId}: ${trades.length} trades, regime=${insight.marketRegime}`);
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
          const history = await this.marketData.getHistory('NIFTY 50', 'NSE', '1day', thirtyDaysAgo.toISOString().split('T')[0], date.toISOString().split('T')[0]);
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
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
