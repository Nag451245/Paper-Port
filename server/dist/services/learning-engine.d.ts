import type { PrismaClient } from '@prisma/client';
export declare class LearningEngine {
    private prisma;
    private marketData;
    private learningStore;
    private running;
    private marketMemory;
    private featurePipeline;
    private lessonsEngine;
    private fusionService;
    private intradayWinTracker;
    private weeklyRetrainTimer;
    constructor(prisma: PrismaClient);
    /**
     * Runs every minute, checking if it's Saturday 11:00 IST. When it is,
     * pulls outcome data from the Rust Performance Engine and retrains
     * both XGBoost and LightGBM models on the merged training data.
     */
    private scheduleWeeklyRetrain;
    runWeeklyMLRetrain(): Promise<void>;
    runNightlyLearning(): Promise<{
        usersProcessed: number;
        insights: number;
    }>;
    private processUserLearning;
    private computeStrategyLedgers;
    private tagSignalOutcomes;
    private autoPopulateJournals;
    private getMarketContext;
    private generateLearningInsight;
    private runParameterOptimization;
    private analyzeFalsePositives;
    private trackRegimeAndAdjust;
    getRegimeTransitionStats(): Promise<{
        currentRegime: string | null;
        currentDuration: number;
        recentTransitions: Array<{
            from: string;
            to: string;
            date: string;
            duration: number;
        }>;
        regimeDurations: Record<string, {
            avgDays: number;
            count: number;
        }>;
    }>;
    private trackStrategyEvolution;
    private trackAlphaDecay;
    private retrainMLScorer;
    private optimizeStrategyAllocation;
    private consecutiveLosses;
    private intradayTradeCount;
    private lastRegimeCheck;
    /**
     * Intraday Bayesian update — called on each POSITION_CLOSED event during trading hours.
     * Updates per-strategy Thompson sampling alpha/beta, adjusts confidence,
     * persists state to Redis, and triggers regime re-detection every 5 trades.
     */
    runIntradayUpdate(trade: {
        strategyTag: string;
        netPnl: number;
        userId: string;
        symbol: string;
    }): Promise<void>;
    private persistThompsonState;
    private intradayRegimeRecheck;
    private intradayAlphaDecayCheck;
    /**
     * Reset intraday learning state at market open.
     * Called by the server orchestrator at 9:15 IST.
     */
    private autoCalibrate;
    resetIntradayState(): void;
}
//# sourceMappingURL=learning-engine.d.ts.map