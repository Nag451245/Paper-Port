import type { BacktestTrade } from './backtest-engine.service.js';
export interface DistributionStats {
    mean: number;
    median: number;
    stdev: number;
    p5: number;
    p10: number;
    p25: number;
    p75: number;
    p90: number;
    p95: number;
    p99: number;
}
export interface ConfidenceInterval {
    level: number;
    lowerReturn: number;
    upperReturn: number;
    maxDrawdown: number;
}
export interface MonteCarloResult {
    iterations: number;
    returnDistribution: DistributionStats;
    maxDrawdownDistribution: DistributionStats;
    ruinProbability: number;
    confidenceIntervals: ConfidenceInterval[];
    medianFinalEquity: number;
    worstCase: number;
    bestCase: number;
}
export interface MonteCarloConfig {
    trades: BacktestTrade[];
    initialCapital: number;
    iterations?: number;
    confidenceLevels?: number[];
}
export declare class MonteCarloSimulator {
    run(config: MonteCarloConfig): MonteCarloResult;
    private simulateEquityCurve;
}
//# sourceMappingURL=monte-carlo.service.d.ts.map