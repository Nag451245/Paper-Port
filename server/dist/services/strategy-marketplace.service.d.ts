import type { PrismaClient } from '@prisma/client';
export interface PublishedStrategy {
    id: string;
    name: string;
    description: string;
    authorId: string;
    authorName: string;
    parameters: Record<string, unknown>;
    indicators: string[];
    backtestResults?: {
        cagr: number;
        sharpeRatio: number;
        maxDrawdown: number;
        winRate: number;
        totalTrades: number;
    };
    rating: number;
    subscriberCount: number;
    version: string;
    isPublic: boolean;
    createdAt: Date;
    updatedAt: Date;
}
export declare class StrategyMarketplaceService {
    private prisma;
    constructor(prisma: PrismaClient);
    getPublicStrategies(): Promise<PublishedStrategy[]>;
    getStrategyById(id: string): Promise<PublishedStrategy | null>;
    getTopStrategies(limit?: number): Promise<PublishedStrategy[]>;
    searchStrategies(query: string): Promise<PublishedStrategy[]>;
}
//# sourceMappingURL=strategy-marketplace.service.d.ts.map