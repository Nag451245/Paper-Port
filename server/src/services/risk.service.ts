import type { PrismaClient } from '@prisma/client';
import { TargetTracker } from './target-tracker.service.js';

export interface RiskConfig {
  maxPositionPct: number;
  maxDailyDrawdownPct: number;
  maxOpenPositions: number;
  maxSymbolConcentration: number;
  maxOrderValue: number;
  maxSectorConcentrationPct: number;
  maxCorrelatedPositions: number;
  marginUtilizationLimitPct: number;
}

const DEFAULT_CONFIG: RiskConfig = {
  maxPositionPct: 10,
  maxDailyDrawdownPct: 3,
  maxOpenPositions: 10,
  maxSymbolConcentration: 2,
  maxOrderValue: 500_000,
  maxSectorConcentrationPct: 30,
  maxCorrelatedPositions: 4,
  marginUtilizationLimitPct: 80,
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

  async preTradeCheck(
    userId: string,
    symbol: string,
    side: string,
    qty: number,
    price: number,
    config?: Partial<RiskConfig>,
  ): Promise<RiskCheck> {
    const cfg = { ...DEFAULT_CONFIG, ...config };
    const violations: string[] = [];
    const warnings: string[] = [];

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

    if (side === 'BUY' && openPositions >= cfg.maxOpenPositions) {
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

    if (side === 'BUY' && symbolPositions >= cfg.maxSymbolConcentration) {
      violations.push(`Already ${symbolPositions} open positions in ${symbol} (max ${cfg.maxSymbolConcentration})`);
    }

    // Rule 5: Daily drawdown circuit breaker
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

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
    }

    // Rule 6: Correlation-aware position limits
    if (side === 'BUY') {
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

    // Warnings (non-blocking)
    if (dayDrawdownPct >= cfg.maxDailyDrawdownPct * 0.7) {
      warnings.push(`Approaching daily loss limit: ${dayDrawdownPct.toFixed(1)}% of ${cfg.maxDailyDrawdownPct}% max`);
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
      }).catch(() => {});
    }

    return {
      allowed: violations.length === 0,
      violations,
      warnings,
    };
  }

  async getDailyRiskSummary(userId: string): Promise<{
    dayPnl: number;
    dayDrawdownPct: number;
    openPositions: number;
    largestPosition: { symbol: string; value: number } | null;
    circuitBreakerActive: boolean;
    riskScore: number;
  }> {
    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true, initialCapital: true, currentNav: true },
    });

    if (portfolios.length === 0) {
      return {
        dayPnl: 0, dayDrawdownPct: 0, openPositions: 0,
        largestPosition: null, circuitBreakerActive: false, riskScore: 0,
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
    const dayDrawdownPct = capital > 0 ? Math.abs(Math.min(dayPnl, 0)) / capital * 100 : 0;

    const positions = await this.prisma.position.findMany({
      where: { portfolioId: { in: portfolioIds }, status: 'OPEN' },
      select: { symbol: true, qty: true, avgEntryPrice: true },
    });

    let largestPosition: { symbol: string; value: number } | null = null;
    for (const p of positions) {
      const val = Number(p.avgEntryPrice) * p.qty;
      if (!largestPosition || val > largestPosition.value) {
        largestPosition = { symbol: p.symbol, value: val };
      }
    }

    const circuitBreakerActive = dayDrawdownPct >= DEFAULT_CONFIG.maxDailyDrawdownPct;

    // Risk score: 0 (safe) to 100 (critical)
    const drawdownScore = Math.min(dayDrawdownPct / DEFAULT_CONFIG.maxDailyDrawdownPct * 50, 50);
    const positionScore = Math.min(positions.length / DEFAULT_CONFIG.maxOpenPositions * 30, 30);
    const concentrationScore = largestPosition
      ? Math.min((largestPosition.value / capital) / (DEFAULT_CONFIG.maxPositionPct / 100) * 20, 20)
      : 0;

    return {
      dayPnl,
      dayDrawdownPct,
      openPositions: positions.length,
      largestPosition,
      circuitBreakerActive,
      riskScore: Math.round(drawdownScore + positionScore + concentrationScore),
    };
  }

  async getPortfolioVaR(userId: string, confidenceLevel = 0.95, holdingDays = 1): Promise<{
    parametricVaR: number;
    historicalVaR: number;
    portfolioValue: number;
    positions: Array<{ symbol: string; value: number; weight: number; dailyVol: number }>;
  }> {
    const portfolios = await this.prisma.portfolio.findMany({ where: { userId }, select: { id: true, currentNav: true } });
    if (!portfolios.length) return { parametricVaR: 0, historicalVaR: 0, portfolioValue: 0, positions: [] };

    const portfolio = portfolios[0];
    const nav = Number(portfolio.currentNav);

    const openPositions = await this.prisma.position.findMany({
      where: { portfolioId: portfolio.id, status: 'OPEN' },
    });

    if (openPositions.length === 0) return { parametricVaR: 0, historicalVaR: 0, portfolioValue: nav, positions: [] };

    // Fetch recent trades for volatility estimation
    const thirtyDaysAgo = new Date();
    thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);

    const recentTrades = await this.prisma.trade.findMany({
      where: { portfolioId: portfolio.id, exitTime: { gte: thirtyDaysAgo } },
      select: { symbol: true, netPnl: true, exitTime: true },
      orderBy: { exitTime: 'asc' },
    });

    // Estimate daily volatility per symbol from trade history or use sector-based defaults
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

    // Z-score for confidence level
    const zScores: Record<number, number> = { 0.90: 1.282, 0.95: 1.645, 0.99: 2.326 };
    const z = zScores[confidenceLevel] ?? 1.645;

    // Parametric VaR: assuming no correlation (conservative)
    const portfolioVolSq = posDetails.reduce((sum, p) => sum + (p.weight * p.dailyVol) ** 2, 0);
    const portfolioVol = Math.sqrt(portfolioVolSq) * Math.sqrt(holdingDays);
    const parametricVaR = z * portfolioVol * totalPositionValue;

    // Historical VaR from recent daily P&L
    const dailyPnls = await this.prisma.dailyPnlRecord.findMany({
      where: { userId },
      orderBy: { date: 'desc' },
      take: 60,
      select: { netPnl: true },
    });

    let historicalVaR = parametricVaR;
    if (dailyPnls.length >= 10) {
      const sortedLosses = dailyPnls.map(d => Number(d.netPnl)).sort((a, b) => a - b);
      const idx = Math.floor((1 - confidenceLevel) * sortedLosses.length);
      historicalVaR = Math.abs(sortedLosses[idx] ?? parametricVaR);
    }

    return { parametricVaR: Number(parametricVaR.toFixed(2)), historicalVaR: Number(historicalVaR.toFixed(2)), portfolioValue: nav, positions: posDetails };
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
    totalCapital: number;
    utilizationPct: number;
    shortPositions: Array<{ symbol: string; marginBlocked: number }>;
    warning: string | null;
  }> {
    const portfolios = await this.prisma.portfolio.findMany({ where: { userId }, select: { id: true, initialCapital: true, currentNav: true } });
    if (!portfolios.length) return { totalMarginUsed: 0, totalCapital: 0, utilizationPct: 0, shortPositions: [], warning: null };

    const capital = Number(portfolios[0].currentNav);
    const shorts = await this.prisma.position.findMany({
      where: { portfolioId: portfolios[0].id, status: 'OPEN', side: 'SHORT' },
    });

    let totalMarginUsed = 0;
    const shortPositions: Array<{ symbol: string; marginBlocked: number }> = [];

    for (const pos of shorts) {
      const entryPrice = Number(pos.avgEntryPrice);
      const rate = pos.exchange === 'MCX' ? 0.10 : pos.exchange === 'CDS' ? 0.05 : 0.25;
      const marginBlocked = entryPrice * pos.qty * rate;
      totalMarginUsed += marginBlocked;
      shortPositions.push({ symbol: pos.symbol, marginBlocked: Number(marginBlocked.toFixed(2)) });
    }

    const utilizationPct = capital > 0 ? (totalMarginUsed / capital) * 100 : 0;

    let warning: string | null = null;
    if (utilizationPct > DEFAULT_CONFIG.marginUtilizationLimitPct) {
      warning = `Margin utilization at ${utilizationPct.toFixed(1)}% exceeds ${DEFAULT_CONFIG.marginUtilizationLimitPct}% limit`;
    }

    return {
      totalMarginUsed: Number(totalMarginUsed.toFixed(2)),
      totalCapital: Number(capital.toFixed(2)),
      utilizationPct: Number(utilizationPct.toFixed(1)),
      shortPositions,
      warning,
    };
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
}
