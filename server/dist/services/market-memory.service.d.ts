export interface MarketConditions {
    niftyLevel: number;
    vixLevel: number;
    regime: string;
    dayOfWeek: number;
    hourOfDay: number;
    gapPct: number;
    sectorLeadership?: string;
}
export interface MemoryRecordInput {
    userId: string;
    symbol: string;
    strategy: string;
    direction: string;
    confidence: number;
    conditions: MarketConditions;
    fingerprint: string;
    marketSnapshot?: Record<string, unknown>;
}
export interface MemoryRecall {
    similarCases: number;
    historicalWinRate: number;
    avgPnlPct: number;
    bestStrategy: string;
    worstStrategy: string;
    cautionNotes: string[];
    memories: Array<{
        id: string;
        symbol: string;
        strategy: string;
        direction: string;
        outcome: string;
        pnlPct: number;
        regime: string;
        lessonsLearned: string | null;
    }>;
}
export interface SupportResistanceLevel {
    price: number;
    type: 'SUPPORT' | 'RESISTANCE';
    strength: number;
    lastTestedAt: Date;
    held: boolean;
}
export declare class MarketMemoryService {
    private prisma;
    recordMemory(input: MemoryRecordInput): Promise<string>;
    resolveMemory(memoryId: string, outcome: 'WIN' | 'LOSS' | 'BREAKEVEN', pnlPct: number, holdingMinutes: number, lessons?: string): Promise<void>;
    recall(userId: string, conditions: MarketConditions, fingerprint: string, topK?: number): Promise<MemoryRecall>;
    getWinRateForConditions(userId: string, regime: string, niftyBand: string, strategy?: string): Promise<{
        winRate: number;
        totalCases: number;
    }>;
    getSupportResistanceLevels(symbol: string, limit?: number): Promise<SupportResistanceLevel[]>;
    getLessonsForSymbol(userId: string, symbol: string, limit?: number): Promise<string[]>;
    private generateCautionNotes;
    private computePriceBandSize;
}
//# sourceMappingURL=market-memory.service.d.ts.map