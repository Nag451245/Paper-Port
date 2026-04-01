import { PrismaClient } from '@prisma/client';
export interface DecisionRecord {
    userId: string;
    botId?: string;
    symbol: string;
    decisionType: 'ENTRY_SIGNAL' | 'EXIT_SIGNAL' | 'STRATEGY_DEPLOY' | 'RISK_BLOCK' | 'SL_TRIGGER' | 'TP_TRIGGER' | 'ROLLOVER' | 'ML_AB_TEST' | 'POSITION_CLOSED';
    direction?: 'LONG' | 'SHORT' | 'NEUTRAL';
    confidence: number;
    signalSource: string;
    marketDataSnapshot: {
        ltp?: number;
        change?: number;
        volume?: number;
        rsi?: number;
        macd?: number;
        supertrend?: string;
        regime?: string;
        globalSentiment?: string;
        [key: string]: unknown;
    };
    riskChecks?: {
        allowed: boolean;
        violations: string[];
        warnings: string[];
        dayPnl?: number;
        drawdownPct?: number;
    };
    reasoning: string;
    entryPrice?: number;
}
export declare class DecisionAuditService {
    private prisma;
    constructor(prisma: PrismaClient);
    recordDecision(record: DecisionRecord): Promise<string>;
    resolveDecision(auditId: string, outcome: {
        exitPrice: number;
        pnl: number;
        predictionAccuracy?: number;
        outcomeNotes?: string;
    }): Promise<void>;
    getDecisionHistory(userId: string, filters?: {
        symbol?: string;
        botId?: string;
        decisionType?: string;
        fromDate?: string;
        toDate?: string;
        page?: number;
        limit?: number;
    }): Promise<{
        decisions: any[];
        total: number;
    }>;
    getDecisionAnalytics(userId: string, days?: number): Promise<{
        totalDecisions: number;
        entrySignals: number;
        exitSignals: number;
        riskBlocks: number;
        avgConfidence: number;
        accuracyRate: number;
        winRate: number;
        topSymbols: Array<{
            symbol: string;
            count: number;
            avgPnl: number;
        }>;
        signalSourceBreakdown: Array<{
            source: string;
            count: number;
            accuracy: number;
        }>;
    }>;
}
//# sourceMappingURL=decision-audit.service.d.ts.map