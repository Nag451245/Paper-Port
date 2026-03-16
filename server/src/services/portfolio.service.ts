import { PrismaClient, type Prisma } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { istDateStr, istMidnight } from '../lib/ist.js';
import { calculateCosts } from '../lib/costs.js';

export interface PortfolioSummary {
  totalNav: number;
  dayPnl: number;
  dayPnlPercent: number;
  totalPnl: number;
  totalPnlPercent: number;
  unrealizedPnl: number;
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

  /**
   * @param priceCache — pre-fetched LTP map (symbol → price) from PriceFeedService.
   *   Symbols found here skip the Breeze bridge round-trip entirely.
   *   Symbols NOT found fall back to individual getQuote() calls with a 5s timeout.
   */
  async getSummary(portfolioId: string, userId: string, priceCache?: Record<string, number>): Promise<PortfolioSummary> {
    const portfolio = await this.getById(portfolioId, userId);
    const initialCapital = Number(portfolio.initialCapital);
    const availableCash = Number(portfolio.currentNav);
    const openPositions = (portfolio as any).positions ?? [];

    const todayStart = istMidnight();

    const uncachedPositions = priceCache
      ? openPositions.filter((pos: any) => !(pos.symbol in priceCache) || priceCache[pos.symbol] <= 0)
      : openPositions;

    const [todayTrades, ltpResults] = await Promise.all([
      this.prisma.trade.findMany({
        where: { portfolioId, exitTime: { gte: todayStart } },
        select: { netPnl: true },
      }),
      Promise.allSettled(
        uncachedPositions.map(async (pos: any) => {
          try {
            const quote = await Promise.race([
              this.marketData.getQuote(pos.symbol, pos.exchange ?? 'NSE'),
              new Promise((_, reject) => setTimeout(() => reject(new Error('timeout')), 5_000)),
            ]) as any;
            return { symbol: pos.symbol, ltp: Number(quote.ltp ?? 0) };
          } catch {
            return { symbol: pos.symbol, ltp: 0 };
          }
        })
      ),
    ]);

    const todayRealizedPnl = todayTrades.reduce((sum, t) => sum + Number(t.netPnl), 0);

    const ltpMap = new Map<string, number>();

    if (priceCache) {
      for (const [sym, ltp] of Object.entries(priceCache)) {
        if (ltp > 0) ltpMap.set(sym, ltp);
      }
    }

    for (const r of ltpResults) {
      if (r.status === 'fulfilled' && r.value.ltp > 0) {
        ltpMap.set(r.value.symbol, r.value.ltp);
      }
    }

    let investedValue = 0;
    let unrealizedPnl = 0;

    for (const pos of openPositions) {
      const entryPrice = Number(pos.avgEntryPrice);
      if (pos.side === 'LONG') {
        investedValue += entryPrice * pos.qty;
      } else {
        const rate = (pos.exchange ?? 'NSE') === 'MCX' ? 0.10 : (pos.exchange ?? 'NSE') === 'CDS' ? 0.05 : 0.25;
        investedValue += entryPrice * pos.qty * rate;
      }

      const ltp = ltpMap.get(pos.symbol) ?? 0;
      if (ltp > 0) {
        unrealizedPnl += pos.side === 'SHORT'
          ? (entryPrice - ltp) * pos.qty
          : (ltp - entryPrice) * pos.qty;
      }
    }

    const totalNav = availableCash + investedValue + unrealizedPnl;
    const totalRealizedPnl = availableCash + investedValue - initialCapital;

    return {
      totalNav,
      dayPnl: todayRealizedPnl,
      dayPnlPercent: initialCapital > 0 ? (todayRealizedPnl / initialCapital) * 100 : 0,
      totalPnl: Number(totalRealizedPnl.toFixed(2)),
      totalPnlPercent: initialCapital > 0 ? (totalRealizedPnl / initialCapital) * 100 : 0,
      unrealizedPnl,
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
      { date: istDateStr(portfolio!.createdAt), value: initialCapital },
    ];

    const dateMap: Record<string, number> = {};
    for (const trade of trades) {
      runningNav += Number(trade.netPnl);
      const day = istDateStr(trade.exitTime);
      dateMap[day] = runningNav;
    }

    for (const [date, value] of Object.entries(dateMap).sort(([a], [b]) => a.localeCompare(b))) {
      curve.push({ date, value });
    }

    // Append today's live NAV including open positions
    try {
      const summary = await this.getSummary(portfolioId, userId);
      const today = istDateStr();
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

  async getPnlHistory(portfolioId: string, userId: string, days = 0) {
    await this.getById(portfolioId, userId);

    const where: any = { portfolioId };
    if (days > 0) {
      const since = new Date();
      since.setDate(since.getDate() - days);
      where.exitTime = { gte: since };
    }

    const trades = await this.prisma.trade.findMany({
      where,
      orderBy: { exitTime: 'asc' },
      select: { exitTime: true, netPnl: true },
    });

    const dayMap: Record<string, number> = {};
    for (const t of trades) {
      const day = istDateStr(t.exitTime);
      dayMap[day] = (dayMap[day] || 0) + Number(t.netPnl);
    }

    return Object.entries(dayMap)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, totalPnl]) => ({ date, totalPnl: Number(totalPnl.toFixed(2)) }));
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

    const allTrades = await this.prisma.trade.findMany({
      where: { portfolioId },
      select: { netPnl: true },
    });
    const totalRealizedPnl = allTrades.reduce((sum, t) => sum + Number(t.netPnl), 0);

    const openPositions = await this.prisma.position.findMany({
      where: { portfolioId, status: 'OPEN' },
    });

    let lockedCapital = 0;
    let openEntryCosts = 0;
    for (const pos of openPositions) {
      const entryPrice = Number(pos.avgEntryPrice);
      if (pos.side === 'LONG') {
        lockedCapital += entryPrice * pos.qty;
      } else {
        const rate = pos.exchange === 'MCX' ? 0.10 : pos.exchange === 'CDS' ? 0.05 : 0.25;
        lockedCapital += entryPrice * pos.qty * rate;
      }

      const entrySide = pos.side === 'LONG' ? 'BUY' : 'SELL';
      const ec = calculateCosts(pos.qty, entryPrice, entrySide, pos.exchange ?? 'NSE');
      openEntryCosts += ec.totalCost;
    }

    const correctCash = initialCapital + totalRealizedPnl - lockedCapital - openEntryCosts;

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
