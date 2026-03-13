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

    const openPositions = (portfolio as any).positions ?? [];

    let investedValue = 0;
    let unrealizedPnl = 0;
    let todayUnrealizedChange = 0;

    const quoteTimeout = (promise: Promise<any>, ms = 5_000) =>
      Promise.race([promise, new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), ms))]);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [quoteResults, todayTrades] = await Promise.all([
      Promise.allSettled(
        openPositions.map(async (pos: any) => {
          try {
            const quote = await quoteTimeout(this.marketData.getQuote(pos.symbol, pos.exchange ?? 'NSE'));
            return {
              symbol: pos.symbol,
              ltp: Number((quote as any).ltp ?? 0),
              change: Number((quote as any).change ?? 0),
            };
          } catch {
            return { symbol: pos.symbol, ltp: 0, change: 0 };
          }
        })
      ),
      this.prisma.trade.findMany({
        where: { portfolioId, exitTime: { gte: todayStart } },
        select: { netPnl: true },
      }),
    ]);

    const quoteMap = new Map<string, { ltp: number; change: number }>();
    for (const r of quoteResults) {
      if (r.status === 'fulfilled' && r.value.ltp > 0) {
        quoteMap.set(r.value.symbol, { ltp: r.value.ltp, change: r.value.change });
      }
    }

    for (const pos of openPositions) {
      const entryPrice = Number(pos.avgEntryPrice);
      if (pos.side === 'LONG') {
        investedValue += entryPrice * pos.qty;
      } else {
        const rate = (pos.exchange ?? 'NSE') === 'MCX' ? 0.10 : (pos.exchange ?? 'NSE') === 'CDS' ? 0.05 : 0.25;
        investedValue += entryPrice * pos.qty * rate;
      }

      const q = quoteMap.get(pos.symbol);
      if (q && q.ltp > 0) {
        const posUnrealized = pos.side === 'SHORT'
          ? (entryPrice - q.ltp) * pos.qty
          : (q.ltp - entryPrice) * pos.qty;
        unrealizedPnl += posUnrealized;

        const posDayChange = pos.side === 'SHORT'
          ? -q.change * pos.qty
          : q.change * pos.qty;
        todayUnrealizedChange += posDayChange;
      }
    }

    const todayRealizedPnl = todayTrades.reduce((sum, t) => sum + Number(t.netPnl), 0);
    const dayPnl = todayRealizedPnl + todayUnrealizedChange;

    const totalNav = availableCash + investedValue + unrealizedPnl;
    const totalPnl = totalNav - initialCapital;
    const totalPnlPercent = initialCapital > 0 ? (totalPnl / initialCapital) * 100 : 0;

    const startOfDayNav = totalNav - dayPnl;

    return {
      totalNav,
      dayPnl,
      dayPnlPercent: startOfDayNav > 0 ? (dayPnl / startOfDayNav) * 100 : 0,
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

    const dateMap: Record<string, number> = {};
    for (const trade of trades) {
      runningNav += Number(trade.netPnl);
      const day = trade.exitTime.toISOString().split('T')[0];
      dateMap[day] = runningNav;
    }

    for (const [date, value] of Object.entries(dateMap).sort(([a], [b]) => a.localeCompare(b))) {
      curve.push({ date, value });
    }

    // Append today's live NAV including open positions
    try {
      const summary = await this.getSummary(portfolioId, userId);
      const today = new Date().toISOString().split('T')[0];
      const lastDate = curve[curve.length - 1]?.date;
      if (today !== lastDate) {
        curve.push({ date: today, value: summary.totalNav });
      } else {
        curve[curve.length - 1].value = summary.totalNav;
      }
    } catch { /* fall through — curve still valid without live point */ }

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

    // Beta & Alpha vs Nifty 50 benchmark
    let beta = 0;
    let alpha = 0;
    try {
      const niftyReturns = await this.fetchNiftyDailyReturns(trades.length);
      if (niftyReturns.length >= 5 && pnls.length >= 5) {
        const portfolioReturns = pnls.map(p => p / initialCapital);
        const n = Math.min(portfolioReturns.length, niftyReturns.length);
        const pr = portfolioReturns.slice(0, n);
        const nr = niftyReturns.slice(0, n);

        const prMean = pr.reduce((s, v) => s + v, 0) / n;
        const nrMean = nr.reduce((s, v) => s + v, 0) / n;

        let covariance = 0;
        let nrVariance = 0;
        for (let i = 0; i < n; i++) {
          covariance += (pr[i] - prMean) * (nr[i] - nrMean);
          nrVariance += (nr[i] - nrMean) ** 2;
        }
        covariance /= n;
        nrVariance /= n;

        beta = nrVariance > 0 ? covariance / nrVariance : 0;
        const annualizedPortfolioReturn = prMean * 252;
        const annualizedBenchmarkReturn = nrMean * 252;
        const riskFreeRate = 0.065; // 6.5% RBI repo rate
        alpha = annualizedPortfolioReturn - (riskFreeRate + beta * (annualizedBenchmarkReturn - riskFreeRate));
      }
    } catch { /* Beta/Alpha calculation failed — fall through */ }

    return {
      sharpeRatio: Number(sharpeRatio.toFixed(2)),
      maxDrawdown: Number(maxDrawdown.toFixed(2)),
      maxDrawdownPercent: Number(maxDrawdownPercent.toFixed(2)),
      winRate: Number(winRate.toFixed(2)),
      profitFactor: Number(profitFactor === Infinity ? 999 : profitFactor.toFixed(2)),
      beta: Number(beta.toFixed(3)),
      alpha: Number((alpha * 100).toFixed(2)),
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

    // Include today's unrealized *change* (not total unrealized) using quote.change
    try {
      const openPositions = await this.prisma.position.findMany({
        where: { portfolioId, status: 'OPEN' },
        select: { side: true, qty: true, symbol: true, exchange: true },
      });
      const quoteResults = await Promise.allSettled(
        openPositions.map(async (pos) => {
          try {
            const quote = await this.marketData.getQuote(pos.symbol, pos.exchange ?? 'NSE');
            return { symbol: pos.symbol, change: Number(quote.change ?? 0), side: pos.side, qty: pos.qty };
          } catch {
            return { symbol: pos.symbol, change: 0, side: pos.side, qty: pos.qty };
          }
        })
      );
      let todayUnrealizedChange = 0;
      for (const r of quoteResults) {
        if (r.status !== 'fulfilled' || r.value.change === 0) continue;
        const { change, side, qty } = r.value;
        todayUnrealizedChange += side === 'LONG' ? change * qty : -change * qty;
      }
      if (todayUnrealizedChange !== 0) {
        const today = new Date().toISOString().split('T')[0];
        dayMap[today] = (dayMap[today] || 0) + todayUnrealizedChange;
      }
    } catch { /* skip */ }

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
        // SHORT: only margin is blocked, no premium added to cash
        const rate = pos.exchange === 'MCX' ? 0.10 : pos.exchange === 'CDS' ? 0.05 : 0.25;
        lockedCapital += entryPrice * pos.qty * rate;
      }
    }

    // correctCash = initial capital + realized P&L - capital locked in open positions
    const correctCash = initialCapital + totalRealizedPnl - lockedCapital;

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

  private async fetchNiftyDailyReturns(days: number): Promise<number[]> {
    const period1 = Math.floor(Date.now() / 1000) - Math.max(days, 60) * 86400;
    const period2 = Math.floor(Date.now() / 1000);
    const url = `https://query1.finance.yahoo.com/v8/finance/chart/%5ENSEI?period1=${period1}&period2=${period2}&interval=1d`;

    const res = await fetch(url, {
      headers: { 'User-Agent': 'Mozilla/5.0' },
      signal: AbortSignal.timeout(10_000),
    });

    if (!res.ok) return [];

    const data: any = await res.json();
    const closes: number[] = data?.chart?.result?.[0]?.indicators?.quote?.[0]?.close ?? [];

    const returns: number[] = [];
    for (let i = 1; i < closes.length; i++) {
      if (closes[i] && closes[i - 1] && closes[i - 1] > 0) {
        returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
      }
    }
    return returns;
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
