export interface RustSignalInput {
    symbol: string;
    direction: 'BUY' | 'SELL';
    confidence: number;
    entry: number;
    stopLoss: number;
    target: number;
    indicators: Record<string, number>;
    votes: Record<string, number>;
    strategy?: string;
}
export interface MLScoreInput {
    winProbability: number;
    confidence: number;
    available: boolean;
    expectedReturn?: number;
}
export interface MemoryRecallInput {
    similarCases: number;
    historicalWinRate: number;
    avgPnlPct: number;
    bestStrategy: string;
    cautionNotes: string[];
    lessons: string[];
}
export interface RegimeInput {
    current: string;
    confidence: number;
    source: 'rule_based' | 'hybrid' | 'ml';
}
export interface StrategyHealth {
    isDecaying: boolean;
    consecutiveLosses: number;
    recentWinRate: number;
    thompsonAlpha: number;
    thompsonBeta: number;
}
export interface FusionDecision {
    finalScore: number;
    action: 'EXECUTE' | 'SKIP' | 'WATCH';
    reasoning: string[];
    signalSources: {
        rust: {
            score: number;
            weight: number;
        };
        ml: {
            score: number;
            weight: number;
        };
        memory: {
            score: number;
            weight: number;
            sampleCount: number;
        };
        regime: {
            current: string;
            alignment: number;
        };
    };
    memoryContext: {
        similarCases: number;
        historicalWinRate: number;
        bestStrategy: string;
        cautionNotes: string[];
        lessons: string[];
    };
    confidence: 'HIGH' | 'MEDIUM' | 'LOW';
    adjustments: string[];
}
export declare class DecisionFusionService {
    private minExecuteScore;
    private minWatchScore;
    constructor(minExecuteScore?: number, minWatchScore?: number);
    decide(rustSignal: RustSignalInput, mlScore: MLScoreInput, memoryRecall: MemoryRecallInput, regime: RegimeInput, strategyHealth: StrategyHealth, userId?: string): Promise<FusionDecision>;
    getAdaptiveThresholds(userId: string): Promise<{
        minExecute: number;
        minWatch: number;
    }>;
    updateThresholds(userId: string, adjust: number): Promise<void>;
    private buildReasoning;
}
//# sourceMappingURL=decision-fusion.service.d.ts.map