import type { PrismaClient } from '@prisma/client';
export declare class EODReviewService {
    private prisma;
    private targetTracker;
    private learningStore;
    private marketData;
    private telegram;
    private running;
    constructor(prisma: PrismaClient);
    runReview(userId?: string): Promise<void>;
    private reviewUserDay;
    private triggerDeepReview;
    getReport(userId: string, date?: Date): Promise<{
        id: string;
        createdAt: Date;
        riskEvents: string;
        userId: string;
        marketContext: string;
        totalPnl: number;
        date: Date;
        targetPnl: number;
        targetAchieved: boolean;
        tradesSummary: string;
        falsePositives: string;
        decisionsReview: string;
        improvements: string;
    } | null>;
    getReports(userId: string, limit?: number): Promise<{
        id: string;
        createdAt: Date;
        riskEvents: string;
        userId: string;
        marketContext: string;
        totalPnl: number;
        date: Date;
        targetPnl: number;
        targetAchieved: boolean;
        tradesSummary: string;
        falsePositives: string;
        decisionsReview: string;
        improvements: string;
    }[]>;
}
//# sourceMappingURL=eod-review.service.d.ts.map