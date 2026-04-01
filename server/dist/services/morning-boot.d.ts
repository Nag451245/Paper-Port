import type { PrismaClient } from '@prisma/client';
export declare class MorningBoot {
    private prisma;
    private marketData;
    private running;
    constructor(prisma: PrismaClient);
    runMorningBoot(): Promise<{
        usersProcessed: number;
        strategiesActivated: number;
    }>;
    private processUserBoot;
    private activateOptimizedParams;
    private adjustSignalThresholds;
    private adjustBotStrategies;
    private applyRegimeAdaptation;
    private loadMLWeights;
    private configureRegimeRiskLimits;
    private precomputeWatchlistSignals;
    private loadRegimeHistory;
    private logBootSummary;
}
//# sourceMappingURL=morning-boot.d.ts.map