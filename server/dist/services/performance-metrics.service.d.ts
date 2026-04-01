import type { PrismaClient } from '@prisma/client';
export interface DailyMetrics {
    date: string;
    dailySharpe: number;
    winRate: number;
    avgWinLossRatio: number;
    maxDailyDrawdownPct: number;
    signalHitRate: number;
    strategyCorrelation: number;
    timeToFirstTradeMin: number | null;
    avgSlippageBps: number;
    tradesCount: number;
    netPnl: number;
    grossPnl: number;
}
export interface TargetProgress {
    dailyReturnPct: number;
    targetReturnPct: number;
    onTrack: boolean;
    projectedAnnualReturn: number;
    daysAboveTarget: number;
    daysBelowTarget: number;
    streakDays: number;
    streakType: 'winning' | 'losing' | 'none';
}
export declare class PerformanceMetricsService {
    private prisma;
    constructor(prisma: PrismaClient);
    computeDailyMetrics(userId: string, date?: Date): Promise<DailyMetrics>;
    getTargetProgress(userId: string, targetDailyPct?: number): Promise<TargetProgress>;
    getMetricsSummary(userId: string, days?: number): Promise<{
        metrics: DailyMetrics[];
        averages: Record<string, number>;
        targetProgress: TargetProgress;
    }>;
}
//# sourceMappingURL=performance-metrics.service.d.ts.map