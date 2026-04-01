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
export declare class TargetTracker {
    private prisma;
    constructor(prisma: PrismaClient);
    getActiveTarget(userId: string): Promise<{
        type: string;
        status: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        capitalBase: number;
        profitTargetPct: number;
        maxLossPct: number;
        instruments: string;
        currentPnl: number;
        consecutiveLossDays: number;
        lastReviewDate: Date | null;
        startDate: Date;
        endDate: Date | null;
    } | null>;
    createTarget(userId: string, data: {
        type: string;
        capitalBase: number;
        profitTargetPct: number;
        maxLossPct?: number;
        instruments?: string;
    }): Promise<{
        type: string;
        status: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        capitalBase: number;
        profitTargetPct: number;
        maxLossPct: number;
        instruments: string;
        currentPnl: number;
        consecutiveLossDays: number;
        lastReviewDate: Date | null;
        startDate: Date;
        endDate: Date | null;
    }>;
    pauseTarget(userId: string): Promise<boolean>;
    resumeTarget(userId: string): Promise<boolean>;
    updateProgress(userId: string): Promise<TargetProgress | null>;
    computeTodayPnl(userId: string): Promise<number>;
    recordDailyPnl(userId: string): Promise<void>;
    resetDailyTarget(userId: string): Promise<void>;
    getRecentPnlRecords(userId: string, days?: number): Promise<{
        status: string;
        id: string;
        createdAt: Date;
        userId: string;
        date: Date;
        grossPnl: number;
        netPnl: number;
        tradeCount: number;
        winCount: number;
        lossCount: number;
    }[]>;
    private computeAggression;
    private isTradingAllowed;
}
//# sourceMappingURL=target-tracker.service.d.ts.map