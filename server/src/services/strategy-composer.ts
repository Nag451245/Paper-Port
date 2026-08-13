import type { PrismaClient } from '@prisma/client';
import { chatCompletionJSON } from '../lib/openai.js';
import { engineWalkForward, type WalkForwardResult } from '../lib/rust-engine.js';

interface StrategyWeight {
  strategyId: string;
  weight: number;
  capitalAllocation: number;
  maxDrawdownLimit: number;
  correlationGroup: string;
}

interface CompositionResult {
  strategies: StrategyWeight[];
  totalCapital: number;
  diversificationScore: number;
  expectedSharpe: number;
  rebalanceNeeded: boolean;
}

interface KellyResult {
  kellyFraction: number;
  halfKelly: number;
  suggestedAllocation: number;
  winRate: number;
  avgWinLossRatio: number;
}

export class StrategyComposer {
  constructor(private prisma: PrismaClient) {}

  async composePortfolio(userId: string): Promise<CompositionResult> {
    const ledgers = await this.prisma.strategyLedger.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 100,
    });

    if (ledgers.length === 0) {
      return this.defaultComposition(userId);
    }

    const strategyStats = new Map<string, { sharpe: number; winRate: number; pnl: number; trades: number; maxDD: number }>();
    for (const l of ledgers) {
      const existing = strategyStats.get(l.strategyId) ?? { sharpe: 0, winRate: 0, pnl: 0, trades: 0, maxDD: 0 };
      existing.sharpe = (existing.sharpe + Number(l.sharpeRatio)) / 2;
      existing.winRate = (existing.winRate + Number(l.winRate)) / 2;
      existing.pnl += Number(l.netPnl);
      existing.trades += l.tradesCount;
      existing.maxDD = Math.max(existing.maxDD, Number(l.maxDrawdown));
      strategyStats.set(l.strategyId, existing);
    }

    const portfolio = await this.prisma.portfolio.findFirst({ where: { userId } });
    const totalCapital = portfolio ? Number(portfolio.currentNav) : 1000000;

    const kellys: Map<string, KellyResult> = new Map();
    for (const [sid, stats] of strategyStats) {
      kellys.set(sid, this.computeKelly(stats.winRate / 100, stats.pnl > 0 && stats.trades > 0 ? stats.pnl / stats.trades : 1, 1));
    }

    const strategies: StrategyWeight[] = [];
    let totalWeight = 0;

    for (const [sid, stats] of strategyStats) {
      if (stats.sharpe < -0.5 || stats.trades < 3) continue;

      const kelly = kellys.get(sid)!;
      const riskAdjWeight = Math.max(0.05, Math.min(0.35, kelly.halfKelly));
      totalWeight += riskAdjWeight;

      strategies.push({
        strategyId: sid,
        weight: riskAdjWeight,
        capitalAllocation: 0,
        maxDrawdownLimit: Math.min(stats.maxDD * 1.5, 15),
        correlationGroup: this.getCorrelationGroup(sid),
      });
    }

    if (totalWeight > 0) {
      for (const s of strategies) {
        s.weight = Number((s.weight / totalWeight).toFixed(3));
        s.capitalAllocation = Number((totalCapital * s.weight).toFixed(0));
      }
    }

    const diversification = this.computeDiversification(strategies);
    const expectedSharpe = strategies.reduce((s, st) => {
      const stats = strategyStats.get(st.strategyId);
      return s + (stats?.sharpe ?? 0) * st.weight;
    }, 0);

    return {
      strategies,
      totalCapital,
      diversificationScore: diversification,
      expectedSharpe: Number(expectedSharpe.toFixed(2)),
      rebalanceNeeded: strategies.some(s => s.weight < 0.05 || s.weight > 0.4),
    };
  }

  computeKelly(winRate: number, avgWin: number, avgLoss: number): KellyResult {
    const wlRatio = avgLoss > 0 ? avgWin / avgLoss : 1;
    const kelly = winRate > 0 ? winRate - (1 - winRate) / wlRatio : 0;
    const halfKelly = kelly / 2;
    const suggested = Math.max(0.02, Math.min(0.25, halfKelly));

    return {
      kellyFraction: Number(kelly.toFixed(4)),
      halfKelly: Number(halfKelly.toFixed(4)),
      suggestedAllocation: Number(suggested.toFixed(4)),
      winRate,
      avgWinLossRatio: Number(wlRatio.toFixed(2)),
    };
  }

  async validateWithWalkForward(
    userId: string,
    strategyId: string,
    candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>,
  ): Promise<{ robust: boolean; overfitScore: number; result: WalkForwardResult }> {
    const activeParams = await this.prisma.strategyParam.findFirst({
      where: { userId, strategyId, isActive: true },
    });

    const paramGrid: Record<string, number[]> = {};
    if (activeParams) {
      try {
        const params = JSON.parse(activeParams.params);
        for (const [key, val] of Object.entries(params)) {
          const v = Number(val);
          if (!isNaN(v)) {
            paramGrid[key] = [v * 0.8, v * 0.9, v, v * 1.1, v * 1.2].map(x => Math.round(x));
          }
        }
      } catch { /* use defaults */ }
    }

    if (Object.keys(paramGrid).length === 0) {
      paramGrid['ema_short'] = [5, 7, 9, 12, 15];
      paramGrid['ema_long'] = [15, 18, 21, 26, 30];
    }

    const result = await engineWalkForward({
      strategy: strategyId,
      symbol: 'BACKTEST',
      initial_capital: 100000,
      candles,
      param_grid: paramGrid,
      in_sample_ratio: 0.7,
      num_folds: 5,
    });

    return {
      robust: result.overfitting_score < 0.5 && result.aggregate.consistency_score > 0.5,
      overfitScore: result.overfitting_score,
      result,
    };
  }

  private getCorrelationGroup(strategyId: string): string {
    const trendFollowing = ['ema-crossover', 'supertrend', 'sma_crossover', 'momentum'];
    const meanReversion = ['mean_reversion', 'rsi_reversal'];
    const breakout = ['orb'];

    if (trendFollowing.includes(strategyId)) return 'trend_following';
    if (meanReversion.includes(strategyId)) return 'mean_reversion';
    if (breakout.includes(strategyId)) return 'breakout';
    return 'other';
  }

  private computeDiversification(strategies: StrategyWeight[]): number {
    if (strategies.length <= 1) return 0;
    const groups = new Set(strategies.map(s => s.correlationGroup));
    const groupScore = groups.size / 4;
    const herfindahl = strategies.reduce((s, st) => s + st.weight ** 2, 0);
    const concentrationPenalty = herfindahl;
    return Number(Math.min(1, (groupScore + (1 - concentrationPenalty)) / 2).toFixed(2));
  }

  private async defaultComposition(userId: string): Promise<CompositionResult> {
    const portfolio = await this.prisma.portfolio.findFirst({ where: { userId } });
    const totalCapital = portfolio ? Number(portfolio.currentNav) : 1000000;

    const defaults: StrategyWeight[] = [
      { strategyId: 'ema-crossover', weight: 0.3, capitalAllocation: totalCapital * 0.3, maxDrawdownLimit: 10, correlationGroup: 'trend_following' },
      { strategyId: 'supertrend', weight: 0.25, capitalAllocation: totalCapital * 0.25, maxDrawdownLimit: 10, correlationGroup: 'trend_following' },
      { strategyId: 'mean_reversion', weight: 0.2, capitalAllocation: totalCapital * 0.2, maxDrawdownLimit: 8, correlationGroup: 'mean_reversion' },
      { strategyId: 'orb', weight: 0.15, capitalAllocation: totalCapital * 0.15, maxDrawdownLimit: 12, correlationGroup: 'breakout' },
      { strategyId: 'rsi_reversal', weight: 0.1, capitalAllocation: totalCapital * 0.1, maxDrawdownLimit: 8, correlationGroup: 'mean_reversion' },
    ];

    return {
      strategies: defaults,
      totalCapital,
      diversificationScore: 0.75,
      expectedSharpe: 0,
      rebalanceNeeded: false,
    };
  }
}
