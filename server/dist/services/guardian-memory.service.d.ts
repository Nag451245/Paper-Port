import type { GuardianMemory, PrismaClient } from '@prisma/client';
export type GuardianMemoryType = 'conversation' | 'market_opinion' | 'trade_lesson' | 'user_preference' | 'evolving_view' | 'pattern_observed';
export type GuardianMemorySummary = Record<GuardianMemoryType, number>;
export interface StoreMemoryOptions {
    importance?: number;
    sentiment?: number;
    expiresAt?: Date | null;
}
export declare class GuardianMemoryService {
    private readonly prisma;
    constructor(prisma: PrismaClient);
    storeMemory(userId: string, type: GuardianMemoryType, subject: string, content: string, opts?: StoreMemoryOptions): Promise<GuardianMemory>;
    recallRelevant(userId: string, query: string, limit?: number): Promise<GuardianMemory[]>;
    getRecentConversationContext(userId: string, limit?: number): Promise<GuardianMemory[]>;
    getActiveOpinions(userId: string): Promise<GuardianMemory[]>;
    evolveView(userId: string, subject: string, newContent: string, sentiment?: number): Promise<GuardianMemory>;
    storeTradeLesson(userId: string, symbol: string, lesson: string, importance?: number): Promise<GuardianMemory>;
    getUserPreferences(userId: string): Promise<GuardianMemory[]>;
    pruneExpired(): Promise<number>;
    getMemorySummary(userId: string): Promise<GuardianMemorySummary>;
}
//# sourceMappingURL=guardian-memory.service.d.ts.map