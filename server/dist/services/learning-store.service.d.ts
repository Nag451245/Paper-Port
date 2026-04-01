import type { PrismaClient } from '@prisma/client';
export declare class LearningStoreService {
    constructor();
    writeDailyReport(date: Date, data: unknown): Promise<void>;
    writeTradeReview(date: Date, tradeId: string, data: unknown): Promise<void>;
    writeFalsePositives(date: Date, data: unknown): Promise<void>;
    writeStrategyEvolution(strategyId: string, data: unknown): Promise<void>;
    writeRegimeLog(date: Date, regime: string, data: unknown): Promise<void>;
    readDailyReport(date: Date): Promise<unknown | null>;
    readRecentFalsePositives(days?: number): Array<{
        date: string;
        signals: Array<{
            symbol: string;
            type: string;
            confidence: number;
            status: string;
            outcome: string | null;
        }>;
    }>;
    getTotalSize(): number;
    getMetaSummary(): {
        totalSizeMB: number;
        fileCount: number;
        oldestDate: string | null;
    };
    exportAll(userId: string, prisma: PrismaClient): Promise<Buffer>;
    importAll(userId: string, prisma: PrismaClient, gzBuffer: Buffer): Promise<{
        filesRestored: number;
        dbRecords: number;
    }>;
    private collectFiles;
    private checkAndPrune;
    private pruneDirectory;
    private dirSize;
}
//# sourceMappingURL=learning-store.service.d.ts.map