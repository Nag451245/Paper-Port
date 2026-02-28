import type { PrismaClient } from '@prisma/client';

export interface RiskConfig {
  maxPositionPct: number;       // max % of capital in a single position (default 10)
  maxDailyDrawdownPct: number;  // max daily loss % before circuit breaker (default 3)
  maxOpenPositions: number;     // max simultaneous open positions (default 10)
  maxSymbolConcentration: number; // max positions in same symbol (default 2)
  maxOrderValue: number;        // max single order value in INR (default 500000)
}

const DEFAULT_CONFIG: RiskConfig = {
  maxPositionPct: 10,
  maxDailyDrawdownPct: 3,
  maxOpenPositions: 10,
  maxSymbolConcentration: 2,
  maxOrderValue: 500_000,
};

export interface RiskCheck {
  allowed: boolean;
  violations: string[];
  warnings: string[];
}

export class RiskService {
  constructor(private prisma: PrismaClient) {}

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

    const portfolio = portfolios[0];
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

    const portfolio = portfolios[0];
    const capital = Number(portfolio.initialCapital);

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const todayTrades = await this.prisma.trade.findMany({
      where: { portfolioId: portfolio.id, exitTime: { gte: todayStart } },
      select: { netPnl: true },
    });
    const dayPnl = todayTrades.reduce((sum, t) => sum + Number(t.netPnl), 0);
    const dayDrawdownPct = capital > 0 ? Math.abs(Math.min(dayPnl, 0)) / capital * 100 : 0;

    const positions = await this.prisma.position.findMany({
      where: { portfolioId: portfolio.id, status: 'OPEN' },
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
}
