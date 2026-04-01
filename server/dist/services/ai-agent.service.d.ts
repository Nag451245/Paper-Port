import { PrismaClient } from '@prisma/client';
type AgentMode = string;
type SignalStatus = string;
import { OrderManagementService } from './oms.service.js';
export interface SignalAnalysis {
    signal: 'BUY' | 'SELL' | 'HOLD';
    compositeScore: number;
    gateScores: Record<string, number>;
    rationale: string;
    suggestedEntry: number;
    suggestedSL: number;
    suggestedTarget: number;
}
export declare class AIAgentService {
    private prisma;
    private marketData;
    private optionsService;
    private oms?;
    constructor(prisma: PrismaClient, oms?: OrderManagementService);
    analyzeOptionsOpportunity(userId: string, symbol: string): Promise<{
        signal: string;
        strategy: string;
        confidence: number;
        rationale: string;
        legs?: Array<{
            type: string;
            strike: number;
            action: string;
            qty: number;
        }>;
        greeks?: {
            delta: number;
            gamma: number;
            theta: number;
            vega: number;
        };
        maxPain?: number;
        pcr?: number;
        ivPercentile?: number;
    }>;
    getConfig(userId: string): Promise<{
        id: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        mode: string;
        minSignalScore: number;
        maxDailyTrades: number;
        strategies: string;
        capitalPreservationOverrides: string;
    }>;
    updateConfig(userId: string, data: {
        mode?: AgentMode;
        isActive?: boolean;
        minSignalScore?: number;
        maxDailyTrades?: number;
        strategies?: any;
        capitalPreservationOverrides?: any;
    }): Promise<{
        id: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        mode: string;
        minSignalScore: number;
        maxDailyTrades: number;
        strategies: string;
        capitalPreservationOverrides: string;
    }>;
    startAgent(userId: string): Promise<{
        status: string;
        message: string;
    }>;
    stopAgent(userId: string): Promise<{
        status: string;
        message: string;
    }>;
    getStatus(userId: string): Promise<{
        isActive: boolean;
        mode: string;
        todaySignals: number;
        todayTrades: number;
        uptime: number;
        rustEngine: boolean;
    }>;
    listSignals(userId: string, params?: {
        status?: SignalStatus;
        page?: number;
        limit?: number;
    }): Promise<{
        signals: {
            symbol: string;
            status: string;
            id: string;
            createdAt: Date;
            userId: string;
            exchange: string;
            signalType: string;
            compositeScore: number;
            gateScores: string;
            strategyId: string | null;
            rationale: string | null;
            outcomeTag: string | null;
            outcomeNotes: string | null;
            executedAt: Date | null;
            expiresAt: Date | null;
        }[];
        total: number;
        page: number;
        limit: number;
    }>;
    getSignal(signalId: string, userId: string): Promise<{
        symbol: string;
        status: string;
        id: string;
        createdAt: Date;
        userId: string;
        exchange: string;
        signalType: string;
        compositeScore: number;
        gateScores: string;
        strategyId: string | null;
        rationale: string | null;
        outcomeTag: string | null;
        outcomeNotes: string | null;
        executedAt: Date | null;
        expiresAt: Date | null;
    }>;
    executeSignal(signalId: string, userId: string): Promise<{
        symbol: string;
        status: string;
        id: string;
        createdAt: Date;
        userId: string;
        exchange: string;
        signalType: string;
        compositeScore: number;
        gateScores: string;
        strategyId: string | null;
        rationale: string | null;
        outcomeTag: string | null;
        outcomeNotes: string | null;
        executedAt: Date | null;
        expiresAt: Date | null;
    }>;
    rejectSignal(signalId: string, userId: string): Promise<{
        symbol: string;
        status: string;
        id: string;
        createdAt: Date;
        userId: string;
        exchange: string;
        signalType: string;
        compositeScore: number;
        gateScores: string;
        strategyId: string | null;
        rationale: string | null;
        outcomeTag: string | null;
        outcomeNotes: string | null;
        executedAt: Date | null;
        expiresAt: Date | null;
    }>;
    private cachedBriefing;
    private briefingInProgress;
    getPreMarketBriefing(userId: string): Promise<any>;
    regenerateBriefing(): Promise<any>;
    private fetchMarketNews;
    private getIST;
    private isMarketHours;
    private fallbackBriefing;
    getPostTradeBriefing(userId: string): Promise<{
        date: string;
        summary: string;
        pnlSummary: {
            realizedPnl: number;
            totalPnl: number;
            tradeCount: number;
        };
        topWinners: {
            symbol: any;
            pnl: number;
        }[];
        topLosers: {
            symbol: any;
            pnl: number;
        }[];
        lessonsLearned: never[];
        tomorrowOutlook: string;
    }>;
    getStrategies(): Promise<{
        id: string;
        name: string;
        description: string;
        isActive: boolean;
    }[]>;
    getCapitalRules(userId?: string): Promise<{
        id: string;
        name: string;
        status: string;
        detail: string;
    }[]>;
    private defaultCapitalRules;
}
export declare class AIAgentError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number);
}
export {};
//# sourceMappingURL=ai-agent.service.d.ts.map