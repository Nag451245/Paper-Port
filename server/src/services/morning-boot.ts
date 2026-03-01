import type { PrismaClient } from '@prisma/client';
import { chatCompletionJSON } from '../lib/openai.js';
import { MarketDataService } from './market-data.service.js';

const REGIME_STRATEGY_MAP: Record<string, { preferred: string[]; avoid: string[] }> = {
  TRENDING_UP: { preferred: ['ema-crossover', 'supertrend', 'momentum'], avoid: ['mean_reversion'] },
  TRENDING_DOWN: { preferred: ['mean_reversion', 'rsi_reversal'], avoid: ['momentum', 'orb'] },
  RANGE_BOUND: { preferred: ['mean_reversion', 'rsi_reversal', 'orb'], avoid: ['supertrend', 'momentum'] },
  HIGH_VOLATILITY: { preferred: ['mean_reversion', 'rsi_reversal'], avoid: ['ema-crossover', 'orb'] },
  LOW_VOLATILITY: { preferred: ['orb', 'momentum', 'ema-crossover'], avoid: ['mean_reversion'] },
  UNKNOWN: { preferred: ['ema-crossover', 'supertrend'], avoid: [] },
};

export class MorningBoot {
  private marketData = new MarketDataService();
  private running = false;

  constructor(private prisma: PrismaClient) {}

  async runMorningBoot(): Promise<{ usersProcessed: number; strategiesActivated: number }> {
    if (this.running) return { usersProcessed: 0, strategiesActivated: 0 };
    this.running = true;

    try {
      const users = await this.prisma.user.findMany({
        where: { isActive: true },
        select: { id: true },
      });

      let totalActivated = 0;
      for (const user of users) {
        try {
          const activated = await this.processUserBoot(user.id);
          totalActivated += activated;
        } catch (err) {
          console.error(`[MorningBoot] Error for user ${user.id}:`, (err as Error).message);
        }
      }

      return { usersProcessed: users.length, strategiesActivated: totalActivated };
    } finally {
      this.running = false;
    }
  }

  private async processUserBoot(userId: string): Promise<number> {
    const yesterday = new Date();
    yesterday.setDate(yesterday.getDate() - 1);
    yesterday.setHours(0, 0, 0, 0);

    const latestInsight = await this.prisma.learningInsight.findFirst({
      where: { userId },
      orderBy: { date: 'desc' },
    });

    const activeParams = await this.prisma.strategyParam.findMany({
      where: { userId, isActive: true },
    });

    await this.activateOptimizedParams(userId, activeParams);
    await this.adjustSignalThresholds(userId, yesterday);

    await this.applyRegimeAdaptation(userId, latestInsight);
    const strategiesActivated = await this.adjustBotStrategies(userId, latestInsight);

    if (latestInsight && !latestInsight.appliedAt) {
      await this.prisma.learningInsight.update({
        where: { id: latestInsight.id },
        data: { appliedAt: new Date() },
      });
    }

    await this.logBootSummary(userId, latestInsight, strategiesActivated);

    return strategiesActivated;
  }

  private async activateOptimizedParams(
    userId: string,
    activeParams: Array<{ id: string; strategyId: string; source: string; params: string; backtestMetrics: string }>,
  ): Promise<void> {
    for (const param of activeParams) {
      if (param.source !== 'backtest_optimized') continue;

      try {
        const metrics = JSON.parse(param.backtestMetrics);
        if (metrics.sharpe > 0.5 && metrics.winRate > 35) {
          console.log(`[MorningBoot] Using optimized params for ${param.strategyId}: ${param.params}`);
        }
      } catch {
        // metrics parse error, skip
      }
    }
  }

  private async adjustSignalThresholds(userId: string, since: Date): Promise<void> {
    const recentLedgers = await this.prisma.strategyLedger.findMany({
      where: { userId, date: { gte: since } },
      orderBy: { date: 'desc' },
      take: 7,
    });

    if (recentLedgers.length === 0) return;

    const avgWinRate = recentLedgers.reduce((s, l) => s + l.winRate, 0) / recentLedgers.length;

    const agentConfig = await this.prisma.aIAgentConfig.findUnique({
      where: { userId },
    });

    if (!agentConfig) return;

    let newMinScore = agentConfig.minSignalScore;
    if (avgWinRate < 40) {
      newMinScore = Math.min(0.85, agentConfig.minSignalScore + 0.05);
    } else if (avgWinRate > 60) {
      newMinScore = Math.max(0.55, agentConfig.minSignalScore - 0.05);
    }

    if (newMinScore !== agentConfig.minSignalScore) {
      await this.prisma.aIAgentConfig.update({
        where: { userId },
        data: { minSignalScore: round2(newMinScore) },
      });
      console.log(`[MorningBoot] Adjusted minSignalScore for user ${userId}: ${agentConfig.minSignalScore} → ${round2(newMinScore)} (avg win rate: ${round2(avgWinRate)}%)`);
    }
  }

  private async adjustBotStrategies(
    userId: string,
    insight: { marketRegime: string; topWinningStrategies: string; topLosingStrategies: string } | null,
  ): Promise<number> {
    if (!insight) return 0;

    const bots = await this.prisma.tradingBot.findMany({
      where: { userId, isActive: true },
    });

    if (bots.length === 0) return 0;

    let preMarketSummary = '';
    try {
      const indices = await this.marketData.getIndices().catch(() => []);
      const vix = await this.marketData.getVIX().catch(() => ({ value: 0, change: 0 }));
      preMarketSummary = `Pre-market: VIX=${(vix as any).value}, Indices=${JSON.stringify(indices.slice(0, 3))}`;
    } catch {
      preMarketSummary = 'Pre-market data unavailable';
    }

    let topWinners: string[] = [];
    let topLosers: string[] = [];
    try { topWinners = JSON.parse(insight.topWinningStrategies); } catch { /* empty */ }
    try { topLosers = JSON.parse(insight.topLosingStrategies); } catch { /* empty */ }

    let gptRecommendation: { activate: string[]; pause: string[] };
    try {
      gptRecommendation = await chatCompletionJSON<{ activate: string[]; pause: string[] }>({
        messages: [
          {
            role: 'system',
            content: `You are a strategy allocation advisor. Based on yesterday's learnings and today's pre-market data, decide which strategies to activate and which to pause.
Return JSON: { "activate": ["strategy1", ...], "pause": ["strategy2", ...] }
Available strategies: ema-crossover, supertrend, sma_crossover, mean_reversion, momentum, rsi_reversal, orb`,
          },
          {
            role: 'user',
            content: `Yesterday's regime: ${insight.marketRegime}
Top winners: ${JSON.stringify(topWinners)}
Top losers: ${JSON.stringify(topLosers)}
${preMarketSummary}
Currently active bots: ${bots.map(b => `${b.name} (${b.assignedStrategy || 'none'})`).join(', ')}`,
          },
        ],
        maxTokens: 300,
        temperature: 0.3,
      });
    } catch {
      gptRecommendation = {
        activate: topWinners,
        pause: topLosers,
      };
    }

    let activated = 0;
    for (const bot of bots) {
      const strategy = bot.assignedStrategy || '';
      if (gptRecommendation.pause.includes(strategy) && bot.status === 'RUNNING') {
        await this.prisma.tradingBot.update({
          where: { id: bot.id },
          data: { status: 'IDLE', lastAction: `Paused by MorningBoot (strategy ${strategy} underperformed)` },
        });
      } else if (gptRecommendation.activate.includes(strategy)) {
        activated++;
      }
    }

    return activated;
  }

  private async applyRegimeAdaptation(
    userId: string,
    insight: { marketRegime: string } | null,
  ): Promise<void> {
    const regime = insight?.marketRegime ?? 'UNKNOWN';
    const mapping = REGIME_STRATEGY_MAP[regime] ?? REGIME_STRATEGY_MAP.UNKNOWN;

    const bots = await this.prisma.tradingBot.findMany({
      where: { userId, isActive: true },
    });

    for (const bot of bots) {
      const strategy = bot.assignedStrategy || '';
      if (mapping.avoid.includes(strategy) && bot.status === 'RUNNING') {
        await this.prisma.tradingBot.update({
          where: { id: bot.id },
          data: {
            status: 'IDLE',
            lastAction: `Regime-paused: ${strategy} not suited for ${regime} regime`,
          },
        });
      }

      if (mapping.preferred.includes(strategy) && bot.status === 'IDLE') {
        const ledger = await this.prisma.strategyLedger.findFirst({
          where: { userId, strategyId: strategy },
          orderBy: { date: 'desc' },
        });

        if (!ledger || ledger.winRate > 30) {
          await this.prisma.tradingBot.update({
            where: { id: bot.id },
            data: {
              status: 'RUNNING',
              lastAction: `Regime-activated: ${strategy} preferred for ${regime} regime`,
            },
          });
        }
      }
    }
  }

  private async logBootSummary(
    userId: string,
    insight: { marketRegime: string; narrative: string } | null,
    strategiesActivated: number,
  ): Promise<void> {
    const bots = await this.prisma.tradingBot.findMany({
      where: { userId, isActive: true },
      take: 1,
    });
    if (bots.length === 0) return;

    const regime = insight?.marketRegime ?? 'unknown';
    const message = [
      `🌅 **Morning Boot Complete**`,
      `Market Regime: ${regime}`,
      `Strategies activated: ${strategiesActivated}`,
      insight?.narrative ? `\n📊 Yesterday's Summary:\n${insight.narrative.substring(0, 500)}` : '',
    ].filter(Boolean).join('\n');

    await this.prisma.botMessage.create({
      data: {
        fromBotId: bots[0].id,
        userId,
        messageType: 'MORNING_BOOT',
        content: message,
      },
    });
  }
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
