import type { BacktestMetrics } from './backtest-engine.service.js';
import type { Strategy, Bar } from './strategy-sdk.js';
export interface ParamRange {
    name: string;
    values: number[];
}
export interface WindowResult {
    windowIndex: number;
    inSampleStart: Date;
    inSampleEnd: Date;
    outOfSampleStart: Date;
    outOfSampleEnd: Date;
    bestParams: Record<string, number>;
    inSampleSharpe: number;
    outOfSampleSharpe: number;
    outOfSampleReturn: number;
    degradation: number;
}
export interface WalkForwardResult {
    windows: WindowResult[];
    aggregateMetrics: BacktestMetrics;
    overfitRatio: number;
    robustnessScore: number;
    bestParams: Record<string, number>[];
    isOOSProfitable: boolean;
}
export interface WalkForwardConfig {
    strategy: Strategy;
    bars: Bar[];
    paramRanges: ParamRange[];
    symbol: string;
    initialCapital: number;
    windowCount?: number;
    inSampleRatio?: number;
    anchoredStart?: boolean;
}
export declare class WalkForwardOptimizer {
    private engine;
    run(config: WalkForwardConfig): WalkForwardResult;
    private cloneStrategyWithParams;
    private computeAggregateMetrics;
}
//# sourceMappingURL=walk-forward.service.d.ts.map