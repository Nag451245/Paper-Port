import type { PrismaClient } from '@prisma/client';
import { TargetTracker } from './target-tracker.service.js';
import { getRedis } from '../lib/redis.js';
import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';

const log = createChildLogger('RiskService');

export interface RiskConfig {
  maxPositionPct: number;
  maxDailyDrawdownPct: number;
  maxOpenPositions: number;
  maxSymbolConcentration: number;
  maxOrderValue: number;
  maxSectorConcentrationPct: number;
  maxCorrelatedPositions: number;
  marginUtilizationLimitPct: number;
  maxVolumeParticipationPct: number;
  // 4.3 tight risk limits for 0.5% daily target
  maxStopLossPctPerPosition: number;
  maxSimultaneousRiskPct: number;
  maxSameSectorPositions: number;
  maxCorrelationBetweenPositions: number;
  weeklyLossLimitPct: number;
  consecutiveLossPauseCount: number;
  dailyLossPauseCount: number;
  consecutiveLosingDaysReduceSize: number;
  consecutiveLosingDaysHalt: number;
}

const DEFAULT_CONFIG: RiskConfig = {
  maxPositionPct: 5,         // Max 5% of capital per position
  maxDailyDrawdownPct: 2.0,  // Max 2% daily loss before circuit breaker
  maxOpenPositions: 15,      // Max 15 open positions
  maxSymbolConcentration: 2, // 2 positions per symbol (LONG + SHORT allowed)
  maxOrderValue: 500_000,
  maxSectorConcentrationPct: 30,
  maxCorrelatedPositions: 5,
  marginUtilizationLimitPct: 60,
  maxVolumeParticipationPct: 5,
  maxStopLossPctPerPosition: 2.0,
  maxSimultaneousRiskPct: 5.0,
  maxSameSectorPositions: 5,
  maxCorrelationBetweenPositions: 0.7,
  weeklyLossLimitPct: 3.0,
  consecutiveLossPauseCount: 5,  // 5 consecutive losses → pause 30min
  dailyLossPauseCount: 10,      // 10 losses in a day → stop for the day
  consecutiveLosingDaysReduceSize: 3,
  consecutiveLosingDaysHalt: 7,
};

// Aggressive config that allows wider limits (for users who opt in)
export const AGGRESSIVE_CONFIG: Partial<RiskConfig> = {
  maxPositionPct: 10,
  maxDailyDrawdownPct: 3,
  maxOpenPositions: 10,
  maxSymbolConcentration: 2,
  maxOrderValue: 500_000,
};

const SECTOR_MAP: Record<string, string> = {
  RELIANCE: 'Energy', ONGC: 'Energy', BPCL: 'Energy', IOC: 'Energy', GAIL: 'Energy',
  TCS: 'IT', INFY: 'IT', WIPRO: 'IT', HCLTECH: 'IT', TECHM: 'IT', LTIM: 'IT',
  HDFCBANK: 'Banking', ICICIBANK: 'Banking', SBIN: 'Banking', KOTAKBANK: 'Banking', AXISBANK: 'Banking', BANKBARODA: 'Banking', PNB: 'Banking', INDUSINDBK: 'Banking',
  HINDUNILVR: 'FMCG', ITC: 'FMCG', NESTLEIND: 'FMCG', BRITANNIA: 'FMCG', DABUR: 'FMCG', MARICO: 'FMCG', TATACONSUM: 'FMCG',
  SUNPHARMA: 'Pharma', DRREDDY: 'Pharma', CIPLA: 'Pharma', DIVISLAB: 'Pharma', APOLLOHOSP: 'Pharma',
  TATAMOTORS: 'Auto', MARUTI: 'Auto', M_M: 'Auto', BAJAJ_AUTO: 'Auto', HEROMOTOCO: 'Auto', EICHERMOT: 'Auto',
  TATASTEEL: 'Metals', JSWSTEEL: 'Metals', HINDALCO: 'Metals', VEDL: 'Metals', COALINDIA: 'Metals',
  LT: 'Infra', ADANIENT: 'Infra', ADANIPORTS: 'Infra', ULTRACEMCO: 'Infra', GRASIM: 'Infra',
  NTPC: 'Power', POWERGRID: 'Power', TATAPOWER: 'Power', NHPC: 'Power',
  BAJFINANCE: 'Finance', BAJAJFINSV: 'Finance', SBILIFE: 'Finance', HDFCLIFE: 'Finance',
  TITAN: 'Consumer', ASIANPAINT: 'Consumer', PIDILITIND: 'Consumer', DLF: 'Realty',
  BHARTIARTL: 'Telecom', INDIGO: 'Aviation',
};

export interface RiskCheck {
  allowed: boolean;
  violations: string[];
  warnings: string[];
}

export class RiskService {
  private targetTracker: TargetTracker;

  constructor(private prisma: PrismaClient) {
    this.targetTracker = new TargetTracker(prisma);
  }

  async enforceTargetRisk(
    userId: string,
    orderValue: number,
    symbol: string,
    side: string,
  ): Promise<RiskCheck> {
    const violations: string[] = [];
    const warnings: string[] = [];

    const target = await this.targetTracker.getActiveTarget(userId);
    if (!target) return { allowed: true, violations, warnings };

    const progress = await this.targetTracker.updateProgress(userId);
    if (!progress) return { allowed: true, violations, warnings };

    if (!progress.tradingAllowed) {
      violations.push(progress.reason || 'Trading not allowed by target policy');
      return { allowed: false, violations, warnings };
    }

    if (progress.aggression === 'none') {
      violations.push('Aggression level is NONE — approaching loss limit');
      return { allowed: false, violations, warnings };
    }

    // Scale position if target nearly hit
    if (progress.aggression === 'low') {
      const maxAllowed = target.capitalBase * 0.02;
      if (orderValue > maxAllowed) {
        warnings.push(`Target nearly hit — position capped at ₹${maxAllowed.toFixed(0)}`);
      }
    }

    return { allowed: true, violations, warnings };
  }

  /**
   * Load regime-adjusted risk limits from Redis (set by MorningBoot).
   * Returns a partial RiskConfig override or empty object if unavailable.
   */
  private async getRegimeRiskOverrides(userId: string): Promise<Partial<RiskConfig>> {
    try {
      const redis = getRedis();
      if (!redis) return {};
      const raw = await redis.get(`cg:regime_risk:${userId}`);
      if (!raw) return {};
      const limits = JSON.parse(raw) as {
        positionSizeMultiplier: number;
        maxPositions: number;
        stopLossTighten: number;
        regime: string;
      };

      // Apply multipliers to defaults to produce regime-adjusted limits
      return {
        maxPositionPct: DEFAULT_CONFIG.maxPositionPct * limits.positionSizeMultiplier,
        maxOpenPositions: limits.maxPositions,
        maxStopLossPctPerPosition: Math.max(
          0.1,
          DEFAULT_CONFIG.maxStopLossPctPerPosition * (1 - limits.stopLossTighten),
        ),
        maxSimultaneousRiskPct: DEFAULT_CONFIG.maxSimultaneousRiskPct * limits.positionSizeMultiplier,
      };
    } catch (err) {
      log.warn({ err, userId }, 'Failed to load regime risk overrides');
      return {};
    }
  }

  async preTradeCheck(
    userId: string,
    symbol: string,
    side: string,
    qty: number,
    price: number,
    config?: Partial<RiskConfig>,
  ): Promise<RiskCheck> {
    const regimeOverrides = await this.getRegimeRiskOverrides(userId);
    const cfg = { ...DEFAULT_CONFIG, ...regimeOverrides, ...config };
    const violations: string[] = [];
    const warnings: string[] = [];

    // Rule 0: Check consecutive-loss pause (hard 30-min block)
    const pauseState = await this.checkConsecutiveLossPause(userId);
    if (pauseState.paused && pauseState.pauseUntil) {
      violations.push(`Trading paused until ${pauseState.pauseUntil.toLocaleTimeString('en-IN')} (${pauseState.consecutiveLosses} consecutive losses)`);
      return { allowed: false, violations, warnings };
    }

    const orderValue = qty * price;

    // Rule 1: Max order value
    if (orderValue > cfg.maxOrderValue) {
      violations.push(`Order value ₹${orderValue.toFixed(0)} exceeds max ₹${cfg.maxOrderValue}`);
    }

    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, initialCapital: true, currentNav: true },
    });

    if (portfolios.length === 0) {
      violations.push('No portfolio found');
      return { allowed: false, violations, warnings };
    }

    const portfolio = portfolios.find(p => (p as any).isDefault) ?? portfolios[0];
    const capital = Number(portfolio.initialCapital);
    const nav = Number(portfolio.currentNav);

    // Rule 2: Max position size as % of capital
    const positionPct = (orderValue / capital) * 100;
    if (positionPct > cfg.maxPositionPct) {
      violations.push(`Position size ${positionPct.toFixed(1)}% exceeds max ${cfg.maxPositionPct}%`);
    }

    // Rule 3: Max open positions
    const openPositions = await this.prisma.position.count({
      where: {
        portfolioId: portfolio.id,
        status: 'OPEN',
      },
    });

    if (openPositions >= cfg.maxOpenPositions) {
      violations.push(`Already at max ${cfg.maxOpenPositions} open positions`);
    }

    // Rule 4: Per-symbol concentration
    const symbolPositions = await this.prisma.position.count({
      where: {
        portfolioId: portfolio.id,
        status: 'OPEN',
        symbol,
      },
    });

    if (symbolPositions >= cfg.maxSymbolConcentration) {
      violations.push(`Already ${symbolPositions} open positions in ${symbol} (max ${cfg.maxSymbolConcentration})`);
    }

    // Rule 5: Daily drawdown circuit breaker (IST boundary)
    const nowIST = new Date(Date.now() + 5.5 * 3600_000);
    const todayStart = new Date(Date.UTC(nowIST.getUTCFullYear(), nowIST.getUTCMonth(), nowIST.getUTCDate()) - 5.5 * 3600_000);

    const todayTrades = await this.prisma.trade.findMany({
      where: {
        portfolioId: portfolio.id,
        exitTime: { gte: todayStart },
      },
      select: { netPnl: true },
    });

    const dayPnl = todayTrades.reduce((sum, t) => sum + Number(t.netPnl), 0);
    const dayDrawdownPct = capital > 0 ? Math.abs(Math.min(dayPnl, 0)) / capital * 100 : 0;

    if (dayPnl < 0 && dayDrawdownPct >= cfg.maxDailyDrawdownPct) {
      violations.push(`Daily loss ${dayDrawdownPct.toFixed(1)}% exceeds circuit breaker ${cfg.maxDailyDrawdownPct}%`);
      emit('risk', {
        type: 'CIRCUIT_BREAKER_TRIGGERED', userId,
        reason: `Daily drawdown ${dayDrawdownPct.toFixed(2)}% >= ${cfg.maxDailyDrawdownPct}%`,
        drawdownPct: dayDrawdownPct,
      }).catch(err => log.error({ err, userId }, 'Failed to emit CIRCUIT_BREAKER_TRIGGERED event'));
    }

    // Rule 6: Correlation-aware position limits
    {
      const newSector = SECTOR_MAP[symbol] ?? 'Other';
      const existingPositions = await this.prisma.position.findMany({
        where: { portfolioId: portfolio.id, status: 'OPEN' },
        select: { symbol: true },
      });

      const sameSectorCount = existingPositions.filter(
        p => (SECTOR_MAP[p.symbol] ?? 'Other') === newSector
      ).length;

      if (sameSectorCount >= cfg.maxCorrelatedPositions) {
        violations.push(
          `Already ${sameSectorCount} positions in ${newSector} sector (max ${cfg.maxCorrelatedPositions} correlated). ` +
          `Adding ${symbol} increases concentration risk.`
        );
      }

      if (sameSectorCount >= cfg.maxCorrelatedPositions - 1) {
        warnings.push(
          `${sameSectorCount}/${cfg.maxCorrelatedPositions} correlated positions in ${newSector} sector`
        );
      }
    }

    // Rule 6b: Pairwise return correlation — reject if new position is too correlated with existing
    {
      const existingPositions = await this.prisma.position.findMany({
        where: { portfolioId: portfolio.id, status: 'OPEN' },
        select: { symbol: true },
      });

      if (existingPositions.length > 0) {
        const thirtyDaysAgo = new Date();
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

        const allSymbols = [...new Set([symbol, ...existingPositions.map(p => p.symbol)])];
        const tradesBySymbol = new Map<string, number[]>();

        for (const sym of allSymbols) {
          const trades = await this.prisma.trade.findMany({
            where: { portfolioId: portfolio.id, symbol: sym, exitTime: { gte: thirtyDaysAgo } },
            select: { netPnl: true },
            orderBy: { exitTime: 'asc' },
          });
          if (trades.length >= 5) {
            tradesBySymbol.set(sym, trades.map(t => Number(t.netPnl)));
          }
        }

        const newReturns = tradesBySymbol.get(symbol);
        if (newReturns) {
          for (const pos of existingPositions) {
            const existingReturns = tradesBySymbol.get(pos.symbol);
            if (existingReturns) {
              const corr = pearsonCorr(newReturns, existingReturns);
              if (corr > cfg.maxCorrelationBetweenPositions) {
                violations.push(
                  `${symbol} is too correlated with open position ${pos.symbol} (r=${corr.toFixed(2)}, max ${cfg.maxCorrelationBetweenPositions})`
                );
              } else if (corr > cfg.maxCorrelationBetweenPositions * 0.8) {
                warnings.push(`${symbol}↔${pos.symbol} correlation ${corr.toFixed(2)} approaching limit`);
              }
            }
          }
        }
      }
    }

    // Rule 7: Portfolio heat — total open exposure as % of capital
    {
      const allOpen = await this.prisma.position.findMany({
        where: { portfolioId: portfolio.id, status: 'OPEN' },
        select: { avgEntryPrice: true, qty: true },
      });
      const totalExposure = allOpen.reduce((s, p) => s + Number(p.avgEntryPrice) * p.qty, 0) + orderValue;
      const heatPct = capital > 0 ? (totalExposure / capital) * 100 : 0;
      if (heatPct > 80) {
        violations.push(`Portfolio heat ${heatPct.toFixed(1)}% exceeds 80% limit (exposure ₹${totalExposure.toFixed(0)} on ₹${capital} capital)`);
      } else if (heatPct > 60) {
        warnings.push(`Portfolio heat at ${heatPct.toFixed(1)}% — approaching 80% limit`);
      }
    }

    // Rule 8: Sector concentration by value (% of capital)
    {
      const newSectorForValue = SECTOR_MAP[symbol] ?? 'Other';
      const sectorPositions = await this.prisma.position.findMany({
        where: { portfolioId: portfolio.id, status: 'OPEN' },
        select: { symbol: true, avgEntryPrice: true, qty: true },
      });
      let sectorValue = orderValue;
      for (const p of sectorPositions) {
        if ((SECTOR_MAP[p.symbol] ?? 'Other') === newSectorForValue) {
          sectorValue += Number(p.avgEntryPrice) * p.qty;
        }
      }
      const sectorPct = capital > 0 ? (sectorValue / capital) * 100 : 0;
      if (sectorPct > cfg.maxSectorConcentrationPct) {
        violations.push(`${newSectorForValue} sector concentration ${sectorPct.toFixed(1)}% exceeds ${cfg.maxSectorConcentrationPct}% limit`);
      }
    }

    // Rule 9: Volume participation limits
    {
      const avgDailyVolume = 500_000;
      const participationPct = avgDailyVolume > 0 ? (qty / avgDailyVolume) * 100 : 0;
      if (participationPct > cfg.maxVolumeParticipationPct) {
        violations.push(`Order is ${participationPct.toFixed(1)}% of avg daily volume (max ${cfg.maxVolumeParticipationPct}%)`);
      } else if (participationPct > cfg.maxVolumeParticipationPct * 0.4) {
        warnings.push(`Volume participation at ${participationPct.toFixed(1)}% — approaching limit`);
      }

      const k = 0.10;
      const estVol = 0.018;
      const impactBps = k * Math.sqrt(participationPct / 100) * estVol * 10000;
      if (impactBps > 5) {
        warnings.push(`Estimated market impact: ${impactBps.toFixed(1)}bps`);
      }
    }

    // Rule 10: Stop-loss sizing — position risk must fit within capital risk budget
    {
      const stopLossRisk = orderValue * (cfg.maxStopLossPctPerPosition / 100);
      const maxCapRisk = capital * (cfg.maxStopLossPctPerPosition / 100);
      if (stopLossRisk > maxCapRisk) {
        violations.push(`Position risk ₹${stopLossRisk.toFixed(0)} exceeds max per-trade risk ₹${maxCapRisk.toFixed(0)} (${cfg.maxStopLossPctPerPosition}% of capital)`);
      }
    }

    // Rule 11: Simultaneous risk budget — total open risk must stay under limit
    {
      const allOpen = await this.prisma.position.findMany({
        where: { portfolioId: portfolio.id, status: 'OPEN' },
        select: { avgEntryPrice: true, qty: true },
      });
      const currentRisk = allOpen.reduce((s, p) =>
        s + Number(p.avgEntryPrice) * p.qty * (cfg.maxStopLossPctPerPosition / 100), 0);
      const newRisk = currentRisk + orderValue * (cfg.maxStopLossPctPerPosition / 100);
      const riskPct = capital > 0 ? (newRisk / capital) * 100 : 0;
      if (riskPct > cfg.maxSimultaneousRiskPct) {
        violations.push(`Total simultaneous risk ${riskPct.toFixed(2)}% would exceed ${cfg.maxSimultaneousRiskPct}% limit`);
      }
    }

    // Rule 12: Consecutive loss circuit breakers
    const recentTrades = await this.prisma.trade.findMany({
      where: { portfolioId: portfolio.id, exitTime: { gte: todayStart } },
      select: { netPnl: true, exitTime: true },
      orderBy: { exitTime: 'desc' },
    });

    // 12a: Count today's losses
    const todayLosses = recentTrades.filter(t => Number(t.netPnl) < 0).length;
    if (todayLosses >= cfg.dailyLossPauseCount) {
      violations.push(`${todayLosses} losses today — trading halted (max ${cfg.dailyLossPauseCount})`);
    }

    // 12b: Consecutive losses — hard pause is enforced by Rule 0 above

    // Rule 13: Weekly loss limit (IST boundary)
    const weekNowIST = new Date(Date.now() + 5.5 * 3600_000);
    const weekStart = new Date(Date.UTC(weekNowIST.getUTCFullYear(), weekNowIST.getUTCMonth(), weekNowIST.getUTCDate() - weekNowIST.getUTCDay()) - 5.5 * 3600_000);

    const weekTrades = await this.prisma.trade.findMany({
      where: { portfolioId: portfolio.id, exitTime: { gte: weekStart } },
      select: { netPnl: true },
    });
    const weekPnl = weekTrades.reduce((s, t) => s + Number(t.netPnl), 0);
    const weekLossPct = capital > 0 ? Math.abs(Math.min(weekPnl, 0)) / capital * 100 : 0;
    if (weekLossPct >= cfg.weeklyLossLimitPct) {
      warnings.push(`Weekly loss ${weekLossPct.toFixed(2)}% hit ${cfg.weeklyLossLimitPct}% limit — position sizes should be halved`);
    }

    // Rule 14: Consecutive losing days
    const recentDays = await this.prisma.dailyPnlRecord.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 7,
      select: { netPnl: true },
    });
    let consecutiveLosingDays = 0;
    for (const d of recentDays) {
      if (Number(d.netPnl) < 0) consecutiveLosingDays++;
      else break;
    }
    if (consecutiveLosingDays >= cfg.consecutiveLosingDaysHalt) {
      violations.push(`${consecutiveLosingDays} consecutive losing days — auto-trading halted for manual review`);
    } else if (consecutiveLosingDays >= cfg.consecutiveLosingDaysReduceSize) {
      warnings.push(`${consecutiveLosingDays} consecutive losing days — position sizes reduced by 50%`);
    }

    // Warnings (non-blocking)
    if (dayDrawdownPct >= cfg.maxDailyDrawdownPct * 0.7) {
      warnings.push(`Approaching daily loss limit: ${dayDrawdownPct.toFixed(2)}% of ${cfg.maxDailyDrawdownPct}% max`);
    }

    if (positionPct > cfg.maxPositionPct * 0.7) {
      warnings.push(`Large position: ${positionPct.toFixed(1)}% of capital`);
    }

    if (openPositions >= cfg.maxOpenPositions * 0.8) {
      warnings.push(`${openPositions}/${cfg.maxOpenPositions} positions used`);
    }

    // Log risk event if violations exist
    if (violations.length > 0) {
      await this.prisma.riskEvent.create({
        data: {
          userId,
          ruleType: 'PRE_TRADE_BLOCK',
          severity: 'critical',
          symbol,
          details: JSON.stringify({
            side, qty, price, orderValue,
            violations, dayPnl, dayDrawdownPct, openPositions,
          }),
        },
      }).catch(err => log.error({ err, userId, symbol }, 'Failed to create risk event record'));

      emit('risk', {
        type: 'RISK_VIOLATION', userId, symbol,
        violations, severity: 'critical',
      }).catch(err => log.error({ err, userId, symbol }, 'Failed to emit RISK_VIOLATION event'));
    }

    return {
      allowed: violations.length === 0,
      violations,
      warnings,
    };
  }

  async getDailyRiskSummary(userId: string): Promise<{
    dayPnl: number;
    dayPnlPercent: number;
    dayDrawdownPct: number;
    openPositions: number;
    totalExposure: number;
    maxDrawdown: number;
    dailyLossLimit: number;
    dailyLossUsed: number;
    tradeCount: number;
    avgWinRate: number;
    largestPosition: { symbol: string; value: number } | null;
    largestPositionPct: number;
    circuitBreakerActive: boolean;
    consecutiveLosses: number;
    riskScore: number;
  }> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, initialCapital: true, currentNav: true },
    });

    if (portfolios.length === 0) {
      return {
        dayPnl: 0, dayPnlPercent: 0, dayDrawdownPct: 0, openPositions: 0,
        totalExposure: 0, maxDrawdown: 0, dailyLossLimit: 0, dailyLossUsed: 0,
        tradeCount: 0, avgWinRate: 0, largestPosition: null, largestPositionPct: 0,
        circuitBreakerActive: false, consecutiveLosses: 0, riskScore: 0,
      };
    }

    const capital = portfolios.reduce((s, p) => s + Number(p.initialCapital), 0);
    const portfolioIds = portfolios.map(p => p.id);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayTrades = await this.prisma.trade.findMany({
      where: { portfolioId: { in: portfolioIds }, exitTime: { gte: todayStart } },
      select: { netPnl: true },
    });
    const dayPnl = todayTrades.reduce((sum, t) => sum + Number(t.netPnl), 0);
    const dayPnlPercent = capital > 0 ? (dayPnl / capital) * 100 : 0;
    const dayDrawdownPct = capital > 0 ? Math.abs(Math.min(dayPnl, 0)) / capital * 100 : 0;

    const dailyLossLimit = capital * (DEFAULT_CONFIG.maxDailyDrawdownPct / 100);
    const dailyLossUsed = Math.min(dayPnl, 0);

    const positions = await this.prisma.position.findMany({
      where: { portfolioId: { in: portfolioIds }, status: 'OPEN' },
      select: { symbol: true, qty: true, avgEntryPrice: true },
    });

    let totalExposure = 0;
    let largestPosition: { symbol: string; value: number } | null = null;
    for (const p of positions) {
      const val = Number(p.avgEntryPrice) * p.qty;
      totalExposure += val;
      if (!largestPosition || val > largestPosition.value) {
        largestPosition = { symbol: p.symbol, value: val };
      }
    }
    const largestPositionPct = (largestPosition && capital > 0)
      ? (largestPosition.value / capital) * 100 : 0;

    const circuitBreakerActive = dayDrawdownPct >= DEFAULT_CONFIG.maxDailyDrawdownPct;

    const recentTrades = await this.prisma.trade.findMany({
      where: { portfolioId: { in: portfolioIds } },
      orderBy: { exitTime: 'desc' },
      take: 50,
      select: { netPnl: true },
    });
    const winCount = recentTrades.filter(t => Number(t.netPnl) > 0).length;
    const avgWinRate = recentTrades.length > 0 ? (winCount / recentTrades.length) * 100 : 0;

    let consecutiveLosses = 0;
    for (const t of recentTrades) {
      if (Number(t.netPnl) < 0) consecutiveLosses++;
      else break;
    }

    const drawdownScore = Math.min(dayDrawdownPct / DEFAULT_CONFIG.maxDailyDrawdownPct * 50, 50);
    const positionScore = Math.min(positions.length / DEFAULT_CONFIG.maxOpenPositions * 30, 30);
    const concentrationScore = largestPosition
      ? Math.min((largestPosition.value / capital) / (DEFAULT_CONFIG.maxPositionPct / 100) * 20, 20)
      : 0;

    return {
      dayPnl,
      dayPnlPercent: Number(dayPnlPercent.toFixed(3)),
      dayDrawdownPct,
      openPositions: positions.length,
      totalExposure: Number(totalExposure.toFixed(2)),
      maxDrawdown: Number(dayDrawdownPct.toFixed(3)),
      dailyLossLimit: Number(dailyLossLimit.toFixed(2)),
      dailyLossUsed: Number(dailyLossUsed.toFixed(2)),
      tradeCount: todayTrades.length,
      avgWinRate: Number(avgWinRate.toFixed(1)),
      largestPosition,
      largestPositionPct: Number(largestPositionPct.toFixed(2)),
      circuitBreakerActive,
      consecutiveLosses,
      riskScore: Math.round(drawdownScore + positionScore + concentrationScore),
    };
  }

  async getPortfolioVaR(userId: string, confidenceLevel = 0.95, holdingDays = 1): Promise<{
    parametricVaR: number;
    historicalVaR: number;
    var95: number;
    var99: number;
    expectedShortfall: number;
    portfolioValue: number;
    positions: Array<{ symbol: string; value: number; weight: number; dailyVol: number }>;
  }> {
    const emptyResult = { parametricVaR: 0, historicalVaR: 0, var95: 0, var99: 0, expectedShortfall: 0, portfolioValue: 0, positions: [] as Array<{ symbol: string; value: number; weight: number; dailyVol: number }> };
    const portfolios = await this.prisma.portfolio.findMany({ where: { userId }, select: { id: true, currentNav: true } });
    if (!portfolios.length) return emptyResult;

    const portfolio = portfolios[0];
    const nav = Number(portfolio.currentNav);

    const openPositions = await this.prisma.position.findMany({
      where: { portfolioId: portfolio.id, status: 'OPEN' },
    });

    if (openPositions.length === 0) return { ...emptyResult, portfolioValue: nav };

    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentTrades = await this.prisma.trade.findMany({
      where: { portfolioId: portfolio.id, exitTime: { gte: thirtyDaysAgo } },
      select: { symbol: true, netPnl: true, exitTime: true },
      orderBy: { exitTime: 'asc' },
    });

    const posDetails: Array<{ symbol: string; value: number; weight: number; dailyVol: number }> = [];
    let totalPositionValue = 0;

    for (const pos of openPositions) {
      const value = Number(pos.avgEntryPrice) * pos.qty;
      totalPositionValue += value;
    }

    for (const pos of openPositions) {
      const value = Number(pos.avgEntryPrice) * pos.qty;
      const weight = totalPositionValue > 0 ? value / totalPositionValue : 0;

      const symbolTrades = recentTrades.filter(t => t.symbol === pos.symbol);
      let dailyVol: number;
      if (symbolTrades.length >= 5) {
        const returns = symbolTrades.map(t => Number(t.netPnl) / value);
        const mean = returns.reduce((s, r) => s + r, 0) / returns.length;
        const variance = returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length;
        dailyVol = Math.sqrt(variance);
      } else {
        const sector = SECTOR_MAP[pos.symbol] ?? 'Other';
        const sectorVols: Record<string, number> = {
          Banking: 0.018, IT: 0.016, Energy: 0.020, FMCG: 0.012,
          Pharma: 0.017, Auto: 0.019, Metals: 0.025, Finance: 0.022,
          Other: 0.020,
        };
        dailyVol = sectorVols[sector] ?? 0.020;
      }

      posDetails.push({ symbol: pos.symbol, value, weight, dailyVol });
    }

    const zScores: Record<number, number> = { 0.90: 1.282, 0.95: 1.645, 0.99: 2.326 };

    const computeVaR = (z: number): number => {
      const portfolioVolSq = posDetails.reduce((sum, p) => sum + (p.weight * p.dailyVol) ** 2, 0);
      const portfolioVol = Math.sqrt(portfolioVolSq) * Math.sqrt(holdingDays);
      return z * portfolioVol * totalPositionValue;
    };

    const z = zScores[confidenceLevel] ?? 1.645;
    const parametricVaR = computeVaR(z);
    const var95 = computeVaR(1.645);
    const var99 = computeVaR(2.326);

    const dailyPnls = await this.prisma.dailyPnlRecord.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 60,
      select: { netPnl: true },
    });

    let historicalVaR = parametricVaR;
    let expectedShortfall = var95 * 1.2;
    if (dailyPnls.length >= 10) {
      const sortedLosses = dailyPnls.map(d => Number(d.netPnl)).sort((a, b) => a - b);
      const idx = Math.floor((1 - confidenceLevel) * sortedLosses.length);
      historicalVaR = Math.abs(sortedLosses[idx] ?? parametricVaR);

      const idx95 = Math.floor(0.05 * sortedLosses.length);
      const tailLosses = sortedLosses.slice(0, Math.max(idx95, 1));
      expectedShortfall = Math.abs(tailLosses.reduce((s, v) => s + v, 0) / tailLosses.length);
    }

    return {
      parametricVaR: Number(parametricVaR.toFixed(2)),
      historicalVaR: Number(historicalVaR.toFixed(2)),
      var95: Number(var95.toFixed(2)),
      var99: Number(var99.toFixed(2)),
      expectedShortfall: Number(expectedShortfall.toFixed(2)),
      portfolioValue: nav,
      positions: posDetails,
    };
  }

  async getSectorConcentration(userId: string): Promise<{
    sectors: Array<{ sector: string; value: number; pct: number; symbols: string[] }>;
    violations: string[];
  }> {
    const portfolios = await this.prisma.portfolio.findMany({ where: { userId }, select: { id: true, initialCapital: true } });
    if (!portfolios.length) return { sectors: [], violations: [] };

    const positions = await this.prisma.position.findMany({
      where: { portfolioId: portfolios[0].id, status: 'OPEN' },
      select: { symbol: true, qty: true, avgEntryPrice: true },
    });

    const capital = Number(portfolios[0].initialCapital);
    const sectorAgg: Record<string, { value: number; symbols: string[] }> = {};

    for (const pos of positions) {
      const sector = SECTOR_MAP[pos.symbol] ?? 'Other';
      const value = Number(pos.avgEntryPrice) * pos.qty;
      if (!sectorAgg[sector]) sectorAgg[sector] = { value: 0, symbols: [] };
      sectorAgg[sector].value += value;
      if (!sectorAgg[sector].symbols.includes(pos.symbol)) sectorAgg[sector].symbols.push(pos.symbol);
    }

    const sectors = Object.entries(sectorAgg).map(([sector, data]) => ({
      sector,
      value: Number(data.value.toFixed(2)),
      pct: Number(((data.value / capital) * 100).toFixed(1)),
      symbols: data.symbols,
    })).sort((a, b) => b.value - a.value);

    const violations: string[] = [];
    for (const s of sectors) {
      if (s.pct > DEFAULT_CONFIG.maxSectorConcentrationPct) {
        violations.push(`${s.sector} sector at ${s.pct}% exceeds ${DEFAULT_CONFIG.maxSectorConcentrationPct}% limit`);
      }
    }

    return { sectors, violations };
  }

  async getMarginUtilization(userId: string): Promise<{
    totalMarginUsed: number;
    totalMarginAvailable: number;
    totalCapital: number;
    utilizationPct: number;
    utilizationPercent: number;
    positions: Array<{ symbol: string; marginUsed: number; marginPercent: number }>;
    shortPositions: Array<{ symbol: string; marginBlocked: number }>;
    warning: string | null;
  }> {
    const emptyResult = {
      totalMarginUsed: 0, totalMarginAvailable: 0, totalCapital: 0,
      utilizationPct: 0, utilizationPercent: 0,
      positions: [] as Array<{ symbol: string; marginUsed: number; marginPercent: number }>,
      shortPositions: [] as Array<{ symbol: string; marginBlocked: number }>,
      warning: null as string | null,
    };
    const portfolios = await this.prisma.portfolio.findMany({ where: { userId }, select: { id: true, initialCapital: true, currentNav: true } });
    if (!portfolios.length) return emptyResult;

    const capital = Number(portfolios[0].currentNav);
    const shorts = await this.prisma.position.findMany({
      where: { portfolioId: portfolios[0].id, status: 'OPEN', side: 'SHORT' },
    });

    let totalMarginUsed = 0;
    const shortPositions: Array<{ symbol: string; marginBlocked: number }> = [];
    const positions: Array<{ symbol: string; marginUsed: number; marginPercent: number }> = [];

    for (const pos of shorts) {
      const entryPrice = Number(pos.avgEntryPrice);
      const rate = pos.exchange === 'MCX' ? 0.10 : pos.exchange === 'CDS' ? 0.05 : 0.25;
      const marginBlocked = entryPrice * pos.qty * rate;
      totalMarginUsed += marginBlocked;
      shortPositions.push({ symbol: pos.symbol, marginBlocked: Number(marginBlocked.toFixed(2)) });
    }

    const utilizationPct = capital > 0 ? (totalMarginUsed / capital) * 100 : 0;
    const totalMarginAvailable = Math.max(0, capital - totalMarginUsed);

    for (const sp of shortPositions) {
      positions.push({
        symbol: sp.symbol,
        marginUsed: sp.marginBlocked,
        marginPercent: capital > 0 ? Number(((sp.marginBlocked / capital) * 100).toFixed(1)) : 0,
      });
    }

    let warning: string | null = null;
    if (utilizationPct > DEFAULT_CONFIG.marginUtilizationLimitPct) {
      warning = `Margin utilization at ${utilizationPct.toFixed(1)}% exceeds ${DEFAULT_CONFIG.marginUtilizationLimitPct}% limit`;
    }

    return {
      totalMarginUsed: Number(totalMarginUsed.toFixed(2)),
      totalMarginAvailable: Number(totalMarginAvailable.toFixed(2)),
      totalCapital: Number(capital.toFixed(2)),
      utilizationPct: Number(utilizationPct.toFixed(1)),
      utilizationPercent: Number(utilizationPct.toFixed(1)),
      positions,
      shortPositions,
      warning,
    };
  }

  /**
   * Position size calculator per 4.3 risk architecture:
   * position_size = risk_amount / (entry - stop_loss)
   * where risk_amount = capital * maxStopLossPctPerPosition / 100
   */
  computePositionSize(
    capital: number,
    entryPrice: number,
    stopLossPrice: number,
    config?: Partial<RiskConfig>,
  ): { qty: number; riskAmount: number; riskPct: number; positionValue: number } {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const riskAmount = capital * (cfg.maxStopLossPctPerPosition / 100);
    const riskPerShare = Math.abs(entryPrice - stopLossPrice);

    if (riskPerShare <= 0 || entryPrice <= 0) {
      return { qty: 0, riskAmount: 0, riskPct: 0, positionValue: 0 };
    }

    let qty = Math.floor(riskAmount / riskPerShare);

    // Cap by max position percentage
    const maxPositionValue = capital * (cfg.maxPositionPct / 100);
    const positionValue = qty * entryPrice;
    if (positionValue > maxPositionValue) {
      qty = Math.floor(maxPositionValue / entryPrice);
    }

    // Cap by max order value
    if (qty * entryPrice > cfg.maxOrderValue) {
      qty = Math.floor(cfg.maxOrderValue / entryPrice);
    }

    qty = Math.max(0, qty);
    const finalValue = qty * entryPrice;
    const riskPct = capital > 0 ? (riskPerShare * qty / capital) * 100 : 0;

    return {
      qty,
      riskAmount: Number((riskPerShare * qty).toFixed(2)),
      riskPct: Number(riskPct.toFixed(4)),
      positionValue: Number(finalValue.toFixed(2)),
    };
  }

  /**
   * Check if position sizing should be reduced due to drawdown conditions.
   * Returns a multiplier (0.5 = half size, 1.0 = full size).
   */
  async getSizeMultiplier(userId: string): Promise<number> {
    let multiplier = 1.0;

    // Check weekly loss
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, initialCapital: true },
    });
    if (portfolios.length === 0) return 1.0;
    const capital = Number(portfolios[0].initialCapital);

    const weekStart = new Date();
    weekStart.setDate(weekStart.getDate() - weekStart.getDay());
    weekStart.setHours(0, 0, 0, 0);

    const weekTrades = await this.prisma.trade.findMany({
      where: { portfolioId: portfolios[0].id, exitTime: { gte: weekStart } },
      select: { netPnl: true },
    });
    const weekPnl = weekTrades.reduce((s, t) => s + Number(t.netPnl), 0);
    const weekLossPct = capital > 0 ? Math.abs(Math.min(weekPnl, 0)) / capital * 100 : 0;

    if (weekLossPct >= DEFAULT_CONFIG.weeklyLossLimitPct) {
      multiplier *= 0.5;
    }

    // Check consecutive losing days
    const recentDays = await this.prisma.dailyPnlRecord.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 5,
      select: { netPnl: true },
    });
    let consecutiveLosingDays = 0;
    for (const d of recentDays) {
      if (Number(d.netPnl) < 0) consecutiveLosingDays++;
      else break;
    }
    if (consecutiveLosingDays >= DEFAULT_CONFIG.consecutiveLosingDaysReduceSize) {
      multiplier *= 0.5;
    }

    return multiplier;
  }

  async getComprehensiveRisk(userId: string): Promise<{
    daily: Awaited<ReturnType<RiskService['getDailyRiskSummary']>>;
    var95: Awaited<ReturnType<RiskService['getPortfolioVaR']>>;
    sectors: Awaited<ReturnType<RiskService['getSectorConcentration']>>;
    margin: Awaited<ReturnType<RiskService['getMarginUtilization']>>;
  }> {
    const [daily, var95, sectors, margin] = await Promise.all([
      this.getDailyRiskSummary(userId),
      this.getPortfolioVaR(userId),
      this.getSectorConcentration(userId),
      this.getMarginUtilization(userId),
    ]);

    return { daily, var95, sectors, margin };
  }

  /**
   * Force-close all open positions when daily loss limit is breached.
   * Called by IntradayManager or a circuit-breaker cron.
   */
  async forceCloseOnDailyLossLimit(
    userId: string,
    closePositionFn: (positionId: string, userId: string, exitPrice: number) => Promise<unknown>,
  ): Promise<{ triggered: boolean; closedCount: number; dayLossPct: number }> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, initialCapital: true },
    });
    if (portfolios.length === 0) return { triggered: false, closedCount: 0, dayLossPct: 0 };

    const capital = Number(portfolios[0].initialCapital);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayTrades = await this.prisma.trade.findMany({
      where: { portfolioId: portfolios[0].id, exitTime: { gte: todayStart } },
      select: { netPnl: true },
    });
    const dayPnl = todayTrades.reduce((sum, t) => sum + Number(t.netPnl), 0);
    const dayLossPct = capital > 0 ? Math.abs(Math.min(dayPnl, 0)) / capital * 100 : 0;

    if (dayLossPct < DEFAULT_CONFIG.maxDailyDrawdownPct) {
      return { triggered: false, closedCount: 0, dayLossPct };
    }

    // Force-close all open positions
    const openPositions = await this.prisma.position.findMany({
      where: { portfolioId: portfolios[0].id, status: 'OPEN' },
      select: { id: true, symbol: true, avgEntryPrice: true },
    });

    let closedCount = 0;
    for (const pos of openPositions) {
      try {
        await closePositionFn(pos.id, userId, Number(pos.avgEntryPrice));
        closedCount++;
      } catch (err) {
        log.error({ positionId: pos.id, symbol: pos.symbol, err }, 'Failed to force-close position');
      }
    }

    log.warn({
      userId, dayLossPct, closedCount, total: openPositions.length,
    }, 'CIRCUIT BREAKER: Daily loss limit hit — all positions force-closed');

    await this.prisma.riskEvent.create({
      data: {
        userId,
        ruleType: 'DAILY_LOSS_CIRCUIT_BREAKER',
        severity: 'critical',
        details: JSON.stringify({ dayLossPct, closedCount, dayPnl }),
      },
    }).catch(err => log.error({ err, userId }, 'Failed to create circuit breaker risk event'));

    emit('risk', {
      type: 'RISK_VIOLATION', userId, symbol: 'ALL',
      violations: [`Daily loss ${dayLossPct.toFixed(3)}% breached ${DEFAULT_CONFIG.maxDailyDrawdownPct}% — ${closedCount} positions force-closed`],
      severity: 'critical',
    }).catch(err => log.error({ err, userId }, 'Failed to emit force-close RISK_VIOLATION event'));

    return { triggered: true, closedCount, dayLossPct };
  }

  /**
   * Check and enforce the consecutive-loss pause.
   * Returns the pause end time if active, null if trading is allowed.
   */
  private pauseUntilMap = new Map<string, Date>();

  async checkConsecutiveLossPause(userId: string): Promise<{ paused: boolean; pauseUntil: Date | null; consecutiveLosses: number }> {
    // Check if an existing pause is still active
    const existingPause = this.pauseUntilMap.get(userId);
    if (existingPause && existingPause.getTime() > Date.now()) {
      return { paused: true, pauseUntil: existingPause, consecutiveLosses: 0 };
    }
    // Clear expired pause
    if (existingPause) this.pauseUntilMap.delete(userId);

    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    if (portfolios.length === 0) return { paused: false, pauseUntil: null, consecutiveLosses: 0 };

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const recentTrades = await this.prisma.trade.findMany({
      where: { portfolioId: portfolios[0].id, exitTime: { gte: todayStart } },
      select: { netPnl: true },
      orderBy: { exitTime: 'desc' },
    });

    let consecutiveLosses = 0;
    for (const t of recentTrades) {
      if (Number(t.netPnl) < 0) consecutiveLosses++;
      else break;
    }

    if (consecutiveLosses >= DEFAULT_CONFIG.consecutiveLossPauseCount) {
      const pauseUntil = new Date(Date.now() + 30 * 60_000);
      this.pauseUntilMap.set(userId, pauseUntil);
      log.warn({ userId, consecutiveLosses, pauseUntil }, 'CIRCUIT BREAKER: 30-min pause activated');
      return { paused: true, pauseUntil, consecutiveLosses };
    }

    return { paused: false, pauseUntil: null, consecutiveLosses };
  }
}

function pearsonCorr(x: number[], y: number[]): number {
  const n = Math.min(x.length, y.length);
  if (n < 5) return 0;
  const xSlice = x.slice(0, n);
  const ySlice = y.slice(0, n);
  const xMean = xSlice.reduce((a, b) => a + b, 0) / n;
  const yMean = ySlice.reduce((a, b) => a + b, 0) / n;
  let num = 0, denX = 0, denY = 0;
  for (let i = 0; i < n; i++) {
    const dx = xSlice[i] - xMean;
    const dy = ySlice[i] - yMean;
    num += dx * dy;
    denX += dx * dx;
    denY += dy * dy;
  }
  const den = Math.sqrt(denX * denY);
  return den > 0 ? num / den : 0;
}
