import { PrismaClient, type Prisma } from '@prisma/client';

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
  constructor(private prisma: PrismaClient) {}

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
    const currentNav = Number(portfolio.currentNav);
    const totalPnl = currentNav - initialCapital;
    const totalPnlPercent = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0;

    const openPositions = await this.prisma.position.findMany({
      where: { portfolioId, status: 'OPEN' },
    });

    let investedValue = 0;
    let unrealizedPnl = 0;
    for (const pos of openPositions) {
      investedValue += Number(pos.avgEntryPrice) * pos.qty;
      unrealizedPnl += Number(pos.unrealizedPnl ?? 0);
    }

    return {
      totalNav: currentNav,
      dayPnl: unrealizedPnl,
      dayPnlPercent: currentNav > 0 ? (unrealizedPnl / currentNav) * 100 : 0,
      totalPnl,
      totalPnlPercent,
      investedValue,
      currentValue: currentNav,
      availableMargin: currentNav - investedValue,
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
