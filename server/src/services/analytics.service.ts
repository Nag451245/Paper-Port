import type { PrismaClient } from '@prisma/client';

interface TradeStats {
  totalTrades: number;
  winCount: number;
  lossCount: number;
  winRate: number;
  totalPnl: number;
  avgWin: number;
  avgLoss: number;
  avgRR: number;
  profitFactor: number;
  largestWin: number;
  largestLoss: number;
  avgHoldDuration: string;
  sharpeRatio: number;
  maxDrawdown: number;
}

interface SymbolBreakdown {
  symbol: string;
  trades: number;
  pnl: number;
  winRate: number;
}

interface StrategyBreakdown {
  strategy: string;
  trades: number;
  pnl: number;
  winRate: number;
  sharpe: number;
}

export class AnalyticsService {
  constructor(private prisma: PrismaClient) {}

  async getTradeStats(userId: string, fromDate?: string, toDate?: string): Promise<TradeStats> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId }, select: { id: true },
    });
    if (portfolios.length === 0) return this.emptyStats();

    const where: any = {
      portfolioId: { in: portfolios.map(p => p.id) },
    };
    if (fromDate) where.exitTime = { ...(where.exitTime || {}), gte: new Date(fromDate) };
    if (toDate) where.exitTime = { ...(where.exitTime || {}), lte: new Date(toDate) };

    const trades = await this.prisma.trade.findMany({
      where,
      select: { netPnl: true, grossPnl: true, entryTime: true, exitTime: true, holdDuration: true },
      orderBy: { exitTime: 'asc' },
    });

    if (trades.length === 0) return this.emptyStats();

    const pnls = trades.map(t => Number(t.netPnl));
    const wins = pnls.filter(p => p > 0);
    const losses = pnls.filter(p => p < 0);

    const totalPnl = pnls.reduce((a, b) => a + b, 0);
    const grossWins = wins.reduce((a, b) => a + b, 0);
    const grossLosses = Math.abs(losses.reduce((a, b) => a + b, 0));
    const profitFactor = grossLosses > 0 ? grossWins / grossLosses : grossWins > 0 ? Infinity : 0;

    const avgWin = wins.length > 0 ? grossWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? grossLosses / losses.length : 0;
    const avgRR = avgLoss > 0 ? avgWin / avgLoss : 0;

    // Sharpe (annualized, assuming 252 trading days)
    const mean = totalPnl / pnls.length;
    const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0;

    // Max drawdown
    let peak = 0;
    let maxDD = 0;
    let cumPnl = 0;
    for (const pnl of pnls) {
      cumPnl += pnl;
      if (cumPnl > peak) peak = cumPnl;
      const dd = peak - cumPnl;
      if (dd > maxDD) maxDD = dd;
    }

    return {
      totalTrades: trades.length,
      winCount: wins.length,
      lossCount: losses.length,
      winRate: wins.length / trades.length,
      totalPnl,
      avgWin,
      avgLoss,
      avgRR,
      profitFactor,
      largestWin: wins.length > 0 ? Math.max(...wins) : 0,
      largestLoss: losses.length > 0 ? Math.min(...losses.map(l => -l)) * -1 : 0,
      avgHoldDuration: this.avgDuration(trades),
      sharpeRatio,
      maxDrawdown: maxDD,
    };
  }

  async getSymbolBreakdown(userId: string): Promise<SymbolBreakdown[]> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId }, select: { id: true },
    });
    if (portfolios.length === 0) return [];

    const trades = await this.prisma.trade.findMany({
      where: { portfolioId: { in: portfolios.map(p => p.id) } },
      select: { symbol: true, netPnl: true },
    });

    const map = new Map<string, { pnl: number; trades: number; wins: number }>();
    for (const t of trades) {
      const pnl = Number(t.netPnl);
      const entry = map.get(t.symbol) ?? { pnl: 0, trades: 0, wins: 0 };
      entry.pnl += pnl;
      entry.trades++;
      if (pnl > 0) entry.wins++;
      map.set(t.symbol, entry);
    }

    return [...map.entries()]
      .map(([symbol, data]) => ({
        symbol,
        trades: data.trades,
        pnl: data.pnl,
        winRate: data.trades > 0 ? data.wins / data.trades : 0,
      }))
      .sort((a, b) => b.pnl - a.pnl);
  }

  async getStrategyBreakdown(userId: string): Promise<StrategyBreakdown[]> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId }, select: { id: true },
    });
    if (portfolios.length === 0) return [];

    const trades = await this.prisma.trade.findMany({
      where: { portfolioId: { in: portfolios.map(p => p.id) } },
      select: { strategyTag: true, netPnl: true },
    });

    const map = new Map<string, number[]>();
    for (const t of trades) {
      const strategy = t.strategyTag || 'Manual';
      const arr = map.get(strategy) ?? [];
      arr.push(Number(t.netPnl));
      map.set(strategy, arr);
    }

    return [...map.entries()].map(([strategy, pnls]) => {
      const wins = pnls.filter(p => p > 0).length;
      const totalPnl = pnls.reduce((a, b) => a + b, 0);
      const mean = totalPnl / pnls.length;
      const variance = pnls.reduce((s, p) => s + (p - mean) ** 2, 0) / pnls.length;
      const stdDev = Math.sqrt(variance);

      return {
        strategy,
        trades: pnls.length,
        pnl: totalPnl,
        winRate: pnls.length > 0 ? wins / pnls.length : 0,
        sharpe: stdDev > 0 ? (mean / stdDev) * Math.sqrt(252) : 0,
      };
    }).sort((a, b) => b.pnl - a.pnl);
  }

  async getEquityCurve(userId: string): Promise<Array<{ date: string; pnl: number; cumPnl: number }>> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId }, select: { id: true },
    });
    if (portfolios.length === 0) return [];

    const trades = await this.prisma.trade.findMany({
      where: { portfolioId: { in: portfolios.map(p => p.id) } },
      select: { exitTime: true, netPnl: true },
      orderBy: { exitTime: 'asc' },
    });

    let cumPnl = 0;
    return trades.map(t => {
      cumPnl += Number(t.netPnl);
      return {
        date: t.exitTime.toISOString().split('T')[0],
        pnl: Number(t.netPnl),
        cumPnl,
      };
    });
  }

  async exportTradesCSV(userId: string): Promise<string> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId }, select: { id: true },
    });
    if (portfolios.length === 0) return 'No trades found';

    const trades = await this.prisma.trade.findMany({
      where: { portfolioId: { in: portfolios.map(p => p.id) } },
      orderBy: { exitTime: 'desc' },
    });

    const headers = 'Date,Symbol,Side,Entry,Exit,Qty,Gross P&L,Costs,Net P&L,Strategy,Duration';
    const rows = trades.map(t =>
      `${t.exitTime.toISOString().split('T')[0]},${t.symbol},${t.side},${t.entryPrice},${t.exitPrice},${t.qty},${t.grossPnl},${t.totalCosts},${t.netPnl},${t.strategyTag || 'Manual'},${t.holdDuration || ''}`
    );

    return [headers, ...rows].join('\n');
  }

  private emptyStats(): TradeStats {
    return {
      totalTrades: 0, winCount: 0, lossCount: 0, winRate: 0,
      totalPnl: 0, avgWin: 0, avgLoss: 0, avgRR: 0, profitFactor: 0,
      largestWin: 0, largestLoss: 0, avgHoldDuration: '0m',
      sharpeRatio: 0, maxDrawdown: 0,
    };
  }

  private avgDuration(trades: { entryTime: Date; exitTime: Date }[]): string {
    if (trades.length === 0) return '0m';
    const totalMs = trades.reduce((s, t) => s + (t.exitTime.getTime() - t.entryTime.getTime()), 0);
    const avgMs = totalMs / trades.length;
    const mins = Math.round(avgMs / 60000);
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    return `${hours}h ${mins % 60}m`;
  }
}
