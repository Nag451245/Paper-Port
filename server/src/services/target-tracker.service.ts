import type { PrismaClient } from '@prisma/client';

export type Aggression = 'high' | 'medium' | 'low' | 'none';

export interface TargetProgress {
  targetId: string;
  type: string;
  capitalBase: number;
  profitTargetPct: number;
  maxLossPct: number;
  profitTargetAbs: number;
  maxLossAbs: number;
  currentPnl: number;
  progressPct: number;
  status: string;
  consecutiveLossDays: number;
  instruments: string;
  aggression: Aggression;
  tradingAllowed: boolean;
  reason?: string;
}

function getIST(): Date {
  const now = new Date();
  return new Date(now.getTime() + (5.5 * 60 * 60 * 1000) - (now.getTimezoneOffset() * 60 * 1000));
}

function todayStartIST(): Date {
  const ist = getIST();
  ist.setHours(0, 0, 0, 0);
  return new Date(ist.getTime() - (5.5 * 60 * 60 * 1000) + (new Date().getTimezoneOffset() * 60 * 1000));
}

function minutesSinceMarketOpen(): number {
  const ist = getIST();
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes - 555; // 9:15 AM = 555 minutes
}

function minutesUntilMarketClose(): number {
  return 930 - (minutesSinceMarketOpen() + 555); // 15:30 = 930 minutes
}

export class TargetTracker {
  constructor(private prisma: PrismaClient) {}

  async getActiveTarget(userId: string) {
    return this.prisma.tradingTarget.findFirst({
      where: { userId, status: 'ACTIVE' },
      orderBy: { createdAt: 'desc' },
    });
  }

  async createTarget(userId: string, data: {
    type: string;
    capitalBase: number;
    profitTargetPct: number;
    maxLossPct?: number;
    instruments?: string;
  }) {
    // Deactivate any existing active targets
    await this.prisma.tradingTarget.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'PAUSED' },
    });

    return this.prisma.tradingTarget.create({
      data: {
        userId,
        type: data.type,
        capitalBase: data.capitalBase,
        profitTargetPct: data.profitTargetPct,
        maxLossPct: data.maxLossPct ?? 0.3,
        instruments: data.instruments ?? 'ALL',
        status: 'ACTIVE',
      },
    });
  }

  async pauseTarget(userId: string): Promise<boolean> {
    const result = await this.prisma.tradingTarget.updateMany({
      where: { userId, status: 'ACTIVE' },
      data: { status: 'PAUSED' },
    });
    return result.count > 0;
  }

  async resumeTarget(userId: string): Promise<boolean> {
    const target = await this.prisma.tradingTarget.findFirst({
      where: { userId, status: { in: ['PAUSED', 'LOSS_LIMIT', 'REVIEW_REQUIRED'] } },
      orderBy: { updatedAt: 'desc' },
    });
    if (!target) return false;

    await this.prisma.tradingTarget.update({
      where: { id: target.id },
      data: { status: 'ACTIVE', lastReviewDate: new Date() },
    });
    return true;
  }

  async updateProgress(userId: string): Promise<TargetProgress | null> {
    const target = await this.getActiveTarget(userId);
    if (!target) return null;

    const todayPnl = await this.computeTodayPnl(userId);

    await this.prisma.tradingTarget.update({
      where: { id: target.id },
      data: { currentPnl: todayPnl },
    });

    const profitTargetAbs = target.capitalBase * (target.profitTargetPct / 100);
    const maxLossAbs = target.capitalBase * (target.maxLossPct / 100);

    // Check loss limit
    if (todayPnl <= -maxLossAbs && target.status === 'ACTIVE') {
      await this.prisma.tradingTarget.update({
        where: { id: target.id },
        data: { status: 'LOSS_LIMIT' },
      });
      target.status = 'LOSS_LIMIT';
    }

    // Check target hit
    if (todayPnl >= profitTargetAbs && target.status === 'ACTIVE') {
      await this.prisma.tradingTarget.update({
        where: { id: target.id },
        data: { status: 'TARGET_HIT' },
      });
      target.status = 'TARGET_HIT';
    }

    const aggression = this.computeAggression(todayPnl, profitTargetAbs, maxLossAbs, target.status, target.consecutiveLossDays);
    const { allowed, reason } = this.isTradingAllowed(target.status, target.consecutiveLossDays, target.lastReviewDate);

    return {
      targetId: target.id,
      type: target.type,
      capitalBase: target.capitalBase,
      profitTargetPct: target.profitTargetPct,
      maxLossPct: target.maxLossPct,
      profitTargetAbs,
      maxLossAbs,
      currentPnl: todayPnl,
      progressPct: profitTargetAbs > 0 ? (todayPnl / profitTargetAbs) * 100 : 0,
      status: target.status,
      consecutiveLossDays: target.consecutiveLossDays,
      instruments: target.instruments,
      aggression,
      tradingAllowed: allowed,
      reason,
    };
  }

  async computeTodayPnl(userId: string): Promise<number> {
    const todayStart = todayStartIST();

    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    const portfolioIds = portfolios.map(p => p.id);

    const trades = await this.prisma.trade.findMany({
      where: {
        portfolioId: { in: portfolioIds },
        exitTime: { gte: todayStart },
      },
      select: { netPnl: true },
    });
    const realizedPnl = trades.reduce((sum, t) => sum + Number(t.netPnl), 0);

    return Math.round(realizedPnl * 100) / 100;
  }

  async recordDailyPnl(userId: string): Promise<void> {
    const todayStart = todayStartIST();
    const todayPnl = await this.computeTodayPnl(userId);

    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    const portfolioIds = portfolios.map(p => p.id);

    const trades = await this.prisma.trade.findMany({
      where: {
        portfolioId: { in: portfolioIds },
        exitTime: { gte: todayStart },
      },
      select: { netPnl: true },
    });

    const wins = trades.filter(t => Number(t.netPnl) > 0).length;
    const losses = trades.filter(t => Number(t.netPnl) < 0).length;
    const status = todayPnl > 10 ? 'PROFIT' : todayPnl < -10 ? 'LOSS' : 'BREAKEVEN';

    await this.prisma.dailyPnlRecord.upsert({
      where: { userId_date: { userId, date: todayStart } },
      create: {
        userId,
        date: todayStart,
        grossPnl: trades.reduce((s, t) => s + Math.abs(Number(t.netPnl)), 0),
        netPnl: todayPnl,
        tradeCount: trades.length,
        winCount: wins,
        lossCount: losses,
        status,
      },
      update: {
        netPnl: todayPnl,
        tradeCount: trades.length,
        winCount: wins,
        lossCount: losses,
        status,
      },
    });

    // Update consecutive loss days on target
    const target = await this.getActiveTarget(userId);
    if (target) {
      const newConsecutive = status === 'LOSS'
        ? target.consecutiveLossDays + 1
        : 0;

      const newStatus = newConsecutive >= 2 ? 'REVIEW_REQUIRED' : target.status;

      await this.prisma.tradingTarget.update({
        where: { id: target.id },
        data: {
          consecutiveLossDays: newConsecutive,
          status: newStatus === 'ACTIVE' || newStatus === 'TARGET_HIT' || newStatus === 'LOSS_LIMIT'
            ? (newConsecutive >= 2 ? 'REVIEW_REQUIRED' : 'ACTIVE')
            : newStatus,
        },
      });
    }
  }

  async resetDailyTarget(userId: string): Promise<void> {
    const target = await this.prisma.tradingTarget.findFirst({
      where: { userId, status: { in: ['TARGET_HIT', 'LOSS_LIMIT', 'ACTIVE'] } },
      orderBy: { updatedAt: 'desc' },
    });
    if (!target) return;

    await this.prisma.tradingTarget.update({
      where: { id: target.id },
      data: { currentPnl: 0, status: 'ACTIVE' },
    });
  }

  async getRecentPnlRecords(userId: string, days = 7) {
    const from = new Date();
    from.setDate(from.getDate() - days);
    return this.prisma.dailyPnlRecord.findMany({
      where: { userId, date: { gte: from } },
      orderBy: { date: 'desc' },
    });
  }

  private computeAggression(
    currentPnl: number,
    targetAbs: number,
    maxLossAbs: number,
    status: string,
    consecutiveLossDays: number,
  ): Aggression {
    if (status === 'LOSS_LIMIT' || status === 'REVIEW_REQUIRED') return 'none';
    if (status === 'TARGET_HIT') return 'low';
    if (consecutiveLossDays >= 2) return 'none';

    if (currentPnl <= -(maxLossAbs * 0.7)) return 'none';
    if (currentPnl <= -(maxLossAbs * 0.5)) return 'low';

    const remaining = minutesUntilMarketClose();
    const progressRatio = targetAbs > 0 ? currentPnl / targetAbs : 0;

    if (progressRatio >= 0.75) return 'low';
    if (progressRatio >= 0.5) return 'medium';
    if (remaining > 120) return 'high';
    if (remaining > 60 && progressRatio < 0.3) return 'high';
    return 'medium';
  }

  private isTradingAllowed(
    status: string,
    consecutiveLossDays: number,
    lastReviewDate: Date | null,
  ): { allowed: boolean; reason?: string } {
    if (status === 'LOSS_LIMIT')
      return { allowed: false, reason: 'Daily loss limit reached. Trading halted.' };
    if (status === 'REVIEW_REQUIRED')
      return { allowed: false, reason: `${consecutiveLossDays} consecutive loss days. Review required before resuming.` };
    if (status === 'PAUSED')
      return { allowed: false, reason: 'Target is paused by user.' };
    return { allowed: true };
  }
}
