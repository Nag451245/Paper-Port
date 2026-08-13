import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';
import { istMidnight } from '../lib/ist.js';

const log = createChildLogger('PerformanceMetrics');

export interface DailyMetrics {
  date: string;
  dailySharpe: number;
  winRate: number;
  avgWinLossRatio: number;
  maxDailyDrawdownPct: number;
  signalHitRate: number;
  strategyCorrelation: number;
  timeToFirstTradeMin: number | null;
  avgSlippageBps: number;
  tradesCount: number;
  netPnl: number;
  grossPnl: number;
}

export interface TargetProgress {
  dailyReturnPct: number;
  targetReturnPct: number;
  onTrack: boolean;
  projectedAnnualReturn: number;
  daysAboveTarget: number;
  daysBelowTarget: number;
  streakDays: number;
  streakType: 'winning' | 'losing' | 'none';
}

export class PerformanceMetricsService {
  constructor(private prisma: PrismaClient) {}

  async computeDailyMetrics(userId: string, date?: Date): Promise<DailyMetrics> {
    const targetDate = date ?? new Date();
    const dayStart = new Date(targetDate);
    dayStart.setHours(0, 0, 0, 0);
    const dayEnd = new Date(dayStart);
    dayEnd.setHours(23, 59, 59, 999);

    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, initialCapital: true, currentNav: true },
    });

    if (portfolios.length === 0) {
      return emptyMetrics(dayStart.toISOString().split('T')[0]);
    }

    const capital = Number(portfolios[0].initialCapital);
    const portfolioIds = portfolios.map(p => p.id);

    const trades = await this.prisma.trade.findMany({
      where: {
        portfolioId: { in: portfolioIds },
        exitTime: { gte: dayStart, lte: dayEnd },
      },
      select: {
        netPnl: true,
        grossPnl: true,
        entryPrice: true,
        exitPrice: true,
        entryTime: true,
        exitTime: true,
        strategyTag: true,
        symbol: true,
        side: true,
        qty: true,
      },
      orderBy: { entryTime: 'asc' },
    });

    const wins = trades.filter(t => Number(t.netPnl) > 0);
    const losses = trades.filter(t => Number(t.netPnl) < 0);
    const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;

    const avgWin = wins.length > 0
      ? wins.reduce((s, t) => s + Number(t.netPnl), 0) / wins.length : 0;
    const avgLoss = losses.length > 0
      ? Math.abs(losses.reduce((s, t) => s + Number(t.netPnl), 0) / losses.length) : 1;
    const avgWinLossRatio = avgLoss > 0 ? avgWin / avgLoss : avgWin > 0 ? Infinity : 0;

    const netPnl = trades.reduce((s, t) => s + Number(t.netPnl), 0);
    const grossPnl = trades.reduce((s, t) => s + Number(t.grossPnl), 0);

    // Daily Sharpe: mean return / std of returns
    const returns = trades.map(t => Number(t.netPnl) / capital);
    const meanReturn = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
    const variance = returns.length > 1
      ? returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1) : 0;
    const stdReturn = Math.sqrt(variance);
    const dailySharpe = stdReturn > 0 ? (meanReturn / stdReturn) * Math.sqrt(trades.length) : 0;

    // Max drawdown within the day
    let peak = 0;
    let maxDD = 0;
    let cumPnl = 0;
    for (const t of trades) {
      cumPnl += Number(t.netPnl);
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak > 0 ? (peak - cumPnl) / capital * 100 : 0;
      if (dd > maxDD) maxDD = dd;
    }
    if (cumPnl < 0) {
      const dd = Math.abs(cumPnl) / capital * 100;
      if (dd > maxDD) maxDD = dd;
    }

    // Signal hit rate: from AI trade signals
    const signals = await this.prisma.aITradeSignal.findMany({
      where: {
        userId,
        createdAt: { gte: dayStart, lte: dayEnd },
        outcomeTag: { not: null },
      },
      select: { outcomeTag: true },
    });
    const signalWins = signals.filter(s => s.outcomeTag === 'WIN').length;
    const signalHitRate = signals.length > 0 ? (signalWins / signals.length) * 100 : 0;

    // Strategy correlation: pairwise PnL correlation between strategies
    const strategyPnls = new Map<string, number[]>();
    for (const t of trades) {
      const strat = t.strategyTag || 'unknown';
      if (!strategyPnls.has(strat)) strategyPnls.set(strat, []);
      strategyPnls.get(strat)!.push(Number(t.netPnl));
    }
    const strategyCorrelation = computeAvgCorrelation([...strategyPnls.values()]);

    // Time to first trade (minutes from 09:15 IST)
    let timeToFirstTradeMin: number | null = null;
    if (trades.length > 0 && trades[0].entryTime) {
      const entryTime = new Date(trades[0].entryTime);
      const marketOpen = new Date(istMidnight(entryTime).getTime() + (9 * 60 + 15) * 60_000);
      const diffMs = entryTime.getTime() - marketOpen.getTime();
      if (diffMs > 0) {
        timeToFirstTradeMin = Math.round(diffMs / 60_000);
      }
    }

    // Average slippage from Order records
    const orders = await this.prisma.order.findMany({
      where: {
        portfolioId: { in: portfolioIds },
        createdAt: { gte: dayStart, lte: dayEnd },
        slippageBps: { not: null },
      },
      select: { slippageBps: true },
    });
    const avgSlippageBps = orders.length > 0
      ? orders.reduce((s, o) => s + Number(o.slippageBps ?? 0), 0) / orders.length : 0;

    return {
      date: dayStart.toISOString().split('T')[0],
      dailySharpe: round2(dailySharpe),
      winRate: round2(winRate),
      avgWinLossRatio: round2(avgWinLossRatio),
      maxDailyDrawdownPct: round4(maxDD),
      signalHitRate: round2(signalHitRate),
      strategyCorrelation: round2(strategyCorrelation),
      timeToFirstTradeMin,
      avgSlippageBps: round2(avgSlippageBps),
      tradesCount: trades.length,
      netPnl: round2(netPnl),
      grossPnl: round2(grossPnl),
    };
  }

  async getTargetProgress(userId: string, targetDailyPct = 0.5): Promise<TargetProgress> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, initialCapital: true },
    });

    if (portfolios.length === 0) {
      return {
        dailyReturnPct: 0, targetReturnPct: targetDailyPct, onTrack: false,
        projectedAnnualReturn: 0, daysAboveTarget: 0, daysBelowTarget: 0,
        streakDays: 0, streakType: 'none',
      };
    }

    const capital = Number(portfolios[0].initialCapital);

    const recentDays = await this.prisma.dailyPnlRecord.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 30,
      select: { netPnl: true, date: true },
    });

    if (recentDays.length === 0) {
      return {
        dailyReturnPct: 0, targetReturnPct: targetDailyPct, onTrack: false,
        projectedAnnualReturn: 0, daysAboveTarget: 0, daysBelowTarget: 0,
        streakDays: 0, streakType: 'none',
      };
    }

    const dailyReturns = recentDays.map(d => ({
      pnl: Number(d.netPnl),
      pct: capital > 0 ? (Number(d.netPnl) / capital) * 100 : 0,
    }));

    const avgDailyReturn = dailyReturns.reduce((s, d) => s + d.pct, 0) / dailyReturns.length;
    const daysAboveTarget = dailyReturns.filter(d => d.pct >= targetDailyPct).length;
    const daysBelowTarget = dailyReturns.filter(d => d.pct < 0).length;

    // Streak calculation
    let streakDays = 0;
    let streakType: 'winning' | 'losing' | 'none' = 'none';
    if (dailyReturns.length > 0) {
      const firstPnl = dailyReturns[0].pnl;
      streakType = firstPnl >= 0 ? 'winning' : 'losing';
      for (const d of dailyReturns) {
        if ((streakType === 'winning' && d.pnl >= 0) || (streakType === 'losing' && d.pnl < 0)) {
          streakDays++;
        } else {
          break;
        }
      }
    }

    // Projected annual return (compounded)
    const dailyMultiplier = 1 + avgDailyReturn / 100;
    const projectedAnnualReturn = (Math.pow(dailyMultiplier, 252) - 1) * 100;

    return {
      dailyReturnPct: round4(avgDailyReturn),
      targetReturnPct: targetDailyPct,
      onTrack: avgDailyReturn >= targetDailyPct,
      projectedAnnualReturn: round2(projectedAnnualReturn),
      daysAboveTarget,
      daysBelowTarget,
      streakDays,
      streakType,
    };
  }

  async getMetricsSummary(userId: string, days = 30): Promise<{
    metrics: DailyMetrics[];
    averages: Record<string, number>;
    targetProgress: TargetProgress;
  }> {
    const today = new Date();
    const metrics: DailyMetrics[] = [];

    // Compute for each of the last N days
    for (let i = 0; i < Math.min(days, 7); i++) {
      const date = new Date(today);
      date.setDate(date.getDate() - i);
      try {
        const m = await this.computeDailyMetrics(userId, date);
        if (m.tradesCount > 0) metrics.push(m);
      } catch { /* skip days with errors */ }
    }

    const averages: Record<string, number> = {};
    if (metrics.length > 0) {
      averages.avgDailySharpe = round2(metrics.reduce((s, m) => s + m.dailySharpe, 0) / metrics.length);
      averages.avgWinRate = round2(metrics.reduce((s, m) => s + m.winRate, 0) / metrics.length);
      averages.avgWinLossRatio = round2(metrics.reduce((s, m) => s + m.avgWinLossRatio, 0) / metrics.length);
      averages.avgDrawdownPct = round4(metrics.reduce((s, m) => s + m.maxDailyDrawdownPct, 0) / metrics.length);
      averages.avgSignalHitRate = round2(metrics.reduce((s, m) => s + m.signalHitRate, 0) / metrics.length);
      averages.avgSlippageBps = round2(metrics.reduce((s, m) => s + m.avgSlippageBps, 0) / metrics.length);
      averages.totalTrades = metrics.reduce((s, m) => s + m.tradesCount, 0);
      averages.totalNetPnl = round2(metrics.reduce((s, m) => s + m.netPnl, 0));
    }

    const targetProgress = await this.getTargetProgress(userId);

    return { metrics, averages, targetProgress };
  }
}

function computeAvgCorrelation(series: number[][]): number {
  if (series.length < 2) return 0;

  // Pad to same length
  const maxLen = Math.max(...series.map(s => s.length));
  const padded = series.map(s => {
    const p = [...s];
    while (p.length < maxLen) p.push(0);
    return p;
  });

  let totalCorr = 0;
  let pairs = 0;

  for (let i = 0; i < padded.length; i++) {
    for (let j = i + 1; j < padded.length; j++) {
      const corr = pearsonCorrelation(padded[i], padded[j]);
      if (!isNaN(corr)) {
        totalCorr += Math.abs(corr);
        pairs++;
      }
    }
  }

  return pairs > 0 ? totalCorr / pairs : 0;
}

function pearsonCorrelation(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 3) return 0;

  const xMean = x.slice(0, n).reduce((a, b) => a + b, 0) / n;
  const yMean = y.slice(0, n).reduce((a, b) => a + b, 0) / n;

  let num = 0;
  let denX = 0;
  let denY = 0;

  for (let i = 0; i < n; i++) {
    const dx = x[i] - xMean;
    const dy = y[i] - yMean;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }

  const den = Math.sqrt(denX * denY);
  return den > 0 ? num / den : 0;
}

function emptyMetrics(date: string): DailyMetrics {
  return {
    date,
    dailySharpe: 0,
    winRate: 0,
    avgWinLossRatio: 0,
    maxDailyDrawdownPct: 0,
    signalHitRate: 0,
    strategyCorrelation: 0,
    timeToFirstTradeMin: null,
    avgSlippageBps: 0,
    tradesCount: 0,
    netPnl: 0,
    grossPnl: 0,
  };
}

function round2(v: number): number { return Math.round(v * 100) / 100; }
function round4(v: number): number { return Math.round(v * 10000) / 10000; }
