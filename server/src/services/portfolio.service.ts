import { PrismaClient, type Prisma } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';

export interface PortfolioSummary {
  totalNav: number;
  dayPnl: number;
  dayPnlPercent: number;
  totalPnl: number;
  totalPnlPercent: number;
  investedValue: number;
  currentValue: number;
  availableMargin: number;
  usedMargin: number;
}

export class PortfolioService {
  private marketData: MarketDataService;

  constructor(private prisma: PrismaClient) {
    this.marketData = new MarketDataService();
  }

  async list(userId: string) {
    return this.prisma.portfolio.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, name: string, initialCapital: number) {
    return this.prisma.portfolio.create({
      data: {
        userId,
        name,
        initialCapital,
        currentNav: initialCapital,
      },
    });
  }

  async getById(portfolioId: string, userId: string) {
    const portfolio = await this.prisma.portfolio.findUnique({
      where: { id: portfolioId },
      include: { positions: { where: { status: 'OPEN' } } },
    });

    if (!portfolio || portfolio.userId !== userId) {
      throw new PortfolioError('Portfolio not found', 404);
    }

    return portfolio;
  }

  async getSummary(portfolioId: string, userId: string): Promise<PortfolioSummary> {
    const portfolio = await this.getById(portfolioId, userId);
    const initialCapital = Number(portfolio.initialCapital);
    const availableCash = Number(portfolio.currentNav);

    const openPositions = await this.prisma.position.findMany({
      where: { portfolioId, status: 'OPEN' },
    });

    let investedValue = 0;
    let unrealizedPnl = 0;

    for (const pos of openPositions) {
      const entryPrice = Number(pos.avgEntryPrice);
      investedValue += entryPrice * pos.qty;

      let ltp = 0;
      try {
        const quote = await this.marketData.getQuote(pos.symbol, pos.exchange ?? 'NSE');
        ltp = quote.ltp;
      } catch { /* use 0 -- unrealized stays 0 for this position */ }

      if (ltp > 0) {
        const posUnrealized = pos.side === 'SHORT'
          ? (entryPrice - ltp) * pos.qty
          : (ltp - entryPrice) * pos.qty;
        unrealizedPnl += posUnrealized;
      }
    }

    // Day P&L = unrealized P&L on open positions + realized P&L from today's closed trades
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);
    const todayTrades = await this.prisma.trade.findMany({
      where: { portfolioId, exitTime: { gte: todayStart } },
      select: { netPnl: true },
    });
    const todayRealizedPnl = todayTrades.reduce((sum, t) => sum + Number(t.netPnl), 0);
    const dayPnl = unrealizedPnl + todayRealizedPnl;

    const totalNav = availableCash + investedValue + unrealizedPnl;
    const totalPnl = totalNav - initialCapital;
    const totalPnlPercent = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0;

    return {
      totalNav,
      dayPnl,
      dayPnlPercent: totalNav > 0 ? (dayPnl / totalNav) * 100 : 0,
      totalPnl,
      totalPnlPercent,
      investedValue,
      currentValue: totalNav,
      availableMargin: availableCash,
      usedMargin: investedValue,
    };
  }

  async getEquityCurve(portfolioId: string, userId: string) {
    await this.getById(portfolioId, userId);

    const trades = await this.prisma.trade.findMany({
      where: { portfolioId },
      orderBy: { exitTime: 'asc' },
      select: { exitTime: true, netPnl: true },
    });

    const portfolio = await this.prisma.portfolio.findUnique({ where: { id: portfolioId } });
    const initialCapital = Number(portfolio!.initialCapital);

    let runningNav = initialCapital;
    const curve: { date: string; value: number }[] = [
      { date: portfolio!.createdAt.toISOString().split('T')[0], value: initialCapital },
    ];

    for (const trade of trades) {
      runningNav += Number(trade.netPnl);
      curve.push({
        date: trade.exitTime.toISOString().split('T')[0],
        value: runningNav,
      });
    }

    return curve;
  }

  async getRiskMetrics(portfolioId: string, userId: string) {
    await this.getById(portfolioId, userId);

    const trades = await this.prisma.trade.findMany({
      where: { portfolioId },
      orderBy: { exitTime: 'asc' },
    });

    if (trades.length === 0) {
      return {
        sharpeRatio: 0,
        maxDrawdown: 0,
        maxDrawdownPercent: 0,
        winRate: 0,
        profitFactor: 0,
        beta: 0,
        alpha: 0,
        sortinoRatio: 0,
        calmarRatio: 0,
        avgWin: 0,
        avgLoss: 0,
        totalTrades: 0,
      };
    }

    const pnls = trades.map((t) => Number(t.netPnl));
    const wins = pnls.filter((p) => p > 0);
    const losses = pnls.filter((p) => p < 0);

    const totalWins = wins.reduce((a, b) => a + b, 0);
    const totalLosses = Math.abs(losses.reduce((a, b) => a + b, 0));
    const winRate = (wins.length / trades.length) * 100;
    const profitFactor = totalLosses > 0 ? totalWins / totalLosses : totalWins > 0 ? Infinity : 0;
    const avgWin = wins.length > 0 ? totalWins / wins.length : 0;
    const avgLoss = losses.length > 0 ? totalLosses / losses.length : 0;

    const meanReturn = pnls.reduce((a, b) => a + b, 0) / pnls.length;
    const variance = pnls.reduce((sum, p) => sum + (p - meanReturn) ** 2, 0) / pnls.length;
    const stdDev = Math.sqrt(variance);
    const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

    const negativeReturns = pnls.filter((p) => p < 0);
    const downVariance = negativeReturns.length > 0
      ? negativeReturns.reduce((sum, p) => sum + p ** 2, 0) / negativeReturns.length
      : 0;
    const downDev = Math.sqrt(downVariance);
    const sortinoRatio = downDev > 0 ? (meanReturn / downDev) * Math.sqrt(252) : 0;

    const portfolio = await this.prisma.portfolio.findUnique({ where: { id: portfolioId } });
    const initialCapital = Number(portfolio!.initialCapital);
    let peak = initialCapital;
    let maxDrawdown = 0;
    let nav = initialCapital;

    for (const pnl of pnls) {
      nav += pnl;
      if (nav > peak) peak = nav;
      const dd = peak - nav;
      if (dd > maxDrawdown) maxDrawdown = dd;
    }

    const maxDrawdownPercent = peak > 0 ? (maxDrawdown / peak) * 100 : 0;
    const calmarRatio = maxDrawdownPercent > 0 ? (meanReturn * 252) / maxDrawdown : 0;

    return {
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(2)),
      winRate: Number(winRate.toFixed(2)),
      profitFactor: Number(profitFactor === Infinity ? 999 : profitFactor.toFixed(2)),
      beta: 0,
      alpha: 0,
      sortinoRatio: Number(sortinoRatio.toFixed(2)),
      calmarRatio: Number(calmarRatio.toFixed(4)),
      avgWin: Number(avgWin.toFixed(2)),
      avgLoss: Number(avgLoss.toFixed(2)),
      totalTrades: trades.length,
    };
  }

  async getPnlHistory(portfolioId: string, userId: string, days = 30) {
    await this.getById(portfolioId, userId);

    const since = new Date();
    since.setDate(since.getDate() - days);

    const trades = await this.prisma.trade.findMany({
      where: { portfolioId, exitTime: { gte: since } },
      orderBy: { exitTime: 'asc' },
      select: { exitTime: true, netPnl: true },
    });

    const dayMap: Record<string, number> = {};
    for (const t of trades) {
      const day = t.exitTime.toISOString().split('T')[0];
      dayMap[day] = (dayMap[day] || 0) + Number(t.netPnl);
    }

    return Object.entries(dayMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totalPnl]) => ({ date, totalPnl }));
  }

  async updateCapital(portfolioId: string, userId: string, virtualCapital: number) {
    const portfolio = await this.getById(portfolioId, userId);

    const oldCapital = Number(portfolio.initialCapital);
    const oldNav = Number(portfolio.currentNav);
    const pnlDelta = oldNav - oldCapital;
    const newNav = virtualCapital + pnlDelta;

    return this.prisma.portfolio.update({
      where: { id: portfolio.id },
      data: {
        initialCapital: virtualCapital,
        currentNav: newNav,
      },
    });
  }

  /**
   * Recalculate currentNav from ground truth:
   *   correctCash = initialCapital
   *                 + sum(all closed trade netPnl)
   *                 - sum(open LONG position entry costs)
   *                 - sum(open SHORT position margin blocked)
   *
   * This fixes drift caused by partial failures in order execution.
   */
  async reconcileNav(portfolioId: string, userId: string): Promise<{ before: number; after: number; drift: number }> {
    const portfolio = await this.getById(portfolioId, userId);
    const initialCapital = Number(portfolio.initialCapital);
    const beforeNav = Number(portfolio.currentNav);

    // Sum of all realized P&L from closed trades
    const allTrades = await this.prisma.trade.findMany({
      where: { portfolioId },
      select: { netPnl: true, totalCosts: true },
    });
    const totalRealizedPnl = allTrades.reduce((sum, t) => sum + Number(t.netPnl), 0);

    // Sum of all transaction costs on orders (covers BUY costs on still-open positions)
    const allOrders = await this.prisma.order.findMany({
      where: { portfolioId, status: 'FILLED' },
      select: { side: true, qty: true, avgFillPrice: true, totalCost: true },
    });

    // Cost locked in open positions
    const openPositions = await this.prisma.position.findMany({
      where: { portfolioId, status: 'OPEN' },
    });

    let lockedCapital = 0;
    for (const pos of openPositions) {
      const entryPrice = Number(pos.avgEntryPrice);
      if (pos.side === 'LONG') {
        lockedCapital += entryPrice * pos.qty;
      } else {
        // SHORT margin: 25% blocked
        lockedCapital += entryPrice * pos.qty * 0.25;
      }
    }

    // Transaction costs on BUY orders for open positions (approximation from order totalCost)
    const openPositionBuyCosts = allOrders
      .filter(o => o.side === 'BUY')
      .reduce((sum, o) => sum + Number(o.totalCost), 0);
    const closedTradeCosts = allTrades.reduce((sum, t) => sum + Number(t.totalCosts), 0);
    // Costs on open positions ≈ total BUY costs - costs already accounted in closed trades
    const openCosts = Math.max(0, openPositionBuyCosts - closedTradeCosts);

    const correctCash = initialCapital + totalRealizedPnl - lockedCapital - openCosts;

    await this.prisma.portfolio.update({
      where: { id: portfolioId },
      data: { currentNav: correctCash },
    });

    const drift = beforeNav - correctCash;
    return {
      before: Number(beforeNav.toFixed(2)),
      after: Number(correctCash.toFixed(2)),
      drift: Number(drift.toFixed(2)),
    };
  }
}

export class PortfolioError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'PortfolioError';
  }
}
