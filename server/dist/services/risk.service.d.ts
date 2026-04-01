import type { PrismaClient } from '@prisma/client';
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
export declare const AGGRESSIVE_CONFIG: Partial<RiskConfig>;
export interface RiskCheck {
    allowed: boolean;
    violations: string[];
    warnings: string[];
}
export declare class RiskService {
    private prisma;
    private targetTracker;
    private marginCalculator;
    private positionLimits;
    constructor(prisma: PrismaClient);
    enforceTargetRisk(userId: string, orderValue: number, symbol: string, side: string): Promise<RiskCheck>;
    /**
     * Load regime-adjusted risk limits from Redis (set by MorningBoot).
     * Returns a partial RiskConfig override or empty object if unavailable.
     */
    private getRegimeRiskOverrides;
    preTradeCheck(userId: string, symbol: string, side: string, qty: number, price: number, config?: Partial<RiskConfig>): Promise<RiskCheck>;
    getDailyRiskSummary(userId: string): Promise<{
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
        largestPosition: {
            symbol: string;
            value: number;
        } | null;
        largestPositionPct: number;
        circuitBreakerActive: boolean;
        consecutiveLosses: number;
        riskScore: number;
    }>;
    getPortfolioVaR(userId: string, confidenceLevel?: number, holdingDays?: number): Promise<{
        parametricVaR: number;
        historicalVaR: number;
        var95: number;
        var99: number;
        expectedShortfall: number;
        portfolioValue: number;
        positions: Array<{
            symbol: string;
            value: number;
            weight: number;
            dailyVol: number;
        }>;
    }>;
    getSectorConcentration(userId: string): Promise<{
        sectors: Array<{
            sector: string;
            value: number;
            pct: number;
            symbols: string[];
        }>;
        violations: string[];
    }>;
    getMarginUtilization(userId: string): Promise<{
        totalMarginUsed: number;
        totalMarginAvailable: number;
        totalCapital: number;
        utilizationPct: number;
        utilizationPercent: number;
        positions: Array<{
            symbol: string;
            marginUsed: number;
            marginPercent: number;
        }>;
        shortPositions: Array<{
            symbol: string;
            marginBlocked: number;
        }>;
        warning: string | null;
    }>;
    /**
     * Position size calculator per 4.3 risk architecture:
     * position_size = risk_amount / (entry - stop_loss)
     * where risk_amount = capital * maxStopLossPctPerPosition / 100
     */
    computePositionSize(capital: number, entryPrice: number, stopLossPrice: number, config?: Partial<RiskConfig>): {
        qty: number;
        riskAmount: number;
        riskPct: number;
        positionValue: number;
    };
    /**
     * Check if position sizing should be reduced due to drawdown conditions.
     * Returns a multiplier (0.5 = half size, 1.0 = full size).
     */
    getSizeMultiplier(userId: string): Promise<number>;
    getComprehensiveRisk(userId: string): Promise<{
        daily: Awaited<ReturnType<RiskService['getDailyRiskSummary']>>;
        var95: Awaited<ReturnType<RiskService['getPortfolioVaR']>>;
        sectors: Awaited<ReturnType<RiskService['getSectorConcentration']>>;
        margin: Awaited<ReturnType<RiskService['getMarginUtilization']>>;
    }>;
    /**
     * Force-close all open positions when daily loss limit is breached.
     * Called by IntradayManager or a circuit-breaker cron.
     */
    forceCloseOnDailyLossLimit(userId: string, closePositionFn: (positionId: string, userId: string, exitPrice: number) => Promise<unknown>): Promise<{
        triggered: boolean;
        closedCount: number;
        dayLossPct: number;
    }>;
    /**
     * Check and enforce the consecutive-loss pause.
     * Returns the pause end time if active, null if trading is allowed.
     */
    private pauseUntilMap;
    checkConsecutiveLossPause(userId: string): Promise<{
        paused: boolean;
        pauseUntil: Date | null;
        consecutiveLosses: number;
    }>;
}
//# sourceMappingURL=risk.service.d.ts.map