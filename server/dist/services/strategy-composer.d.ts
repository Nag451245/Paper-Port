import type { PrismaClient } from '@prisma/client';
import { type WalkForwardResult } from '../lib/rust-engine.js';
interface StrategyWeight {
    strategyId: string;
    weight: number;
    capitalAllocation: number;
    maxDrawdownLimit: number;
    correlationGroup: string;
}
interface CompositionResult {
    strategies: StrategyWeight[];
    totalCapital: number;
    diversificationScore: number;
    expectedSharpe: number;
    rebalanceNeeded: boolean;
}
interface KellyResult {
    kellyFraction: number;
    halfKelly: number;
    suggestedAllocation: number;
    winRate: number;
    avgWinLossRatio: number;
}
export declare class StrategyComposer {
    private prisma;
    constructor(prisma: PrismaClient);
    composePortfolio(userId: string): Promise<CompositionResult>;
    computeKelly(winRate: number, avgWin: number, avgLoss: number): KellyResult;
    validateWithWalkForward(userId: string, strategyId: string, candles: Array<{
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>): Promise<{
        robust: boolean;
        overfitScore: number;
        result: WalkForwardResult;
    }>;
    private getCorrelationGroup;
    private computeDiversification;
    private defaultComposition;
}
export {};
//# sourceMappingURL=strategy-composer.d.ts.map