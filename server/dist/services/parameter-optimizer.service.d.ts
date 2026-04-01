import type { Strategy, Bar } from './strategy-sdk.js';
export interface GridParamRange {
    name: string;
    values: number[];
}
export interface RandomParamRange {
    name: string;
    min: number;
    max: number;
}
export type ParamRange = GridParamRange | RandomParamRange;
export interface OptimizationResult {
    params: Record<string, number>;
    sharpe: number;
    returns: number;
    maxDrawdown: number;
    winRate: number;
    trades: number;
    overfitScore: number;
}
export declare class ParameterOptimizerService {
    gridSearch(strategy: Strategy, bars: Bar[], paramRanges: GridParamRange[], initialCapital: number): OptimizationResult[];
    randomSearch(strategy: Strategy, bars: Bar[], paramRanges: RandomParamRange[], initialCapital: number, iterations: number): OptimizationResult[];
}
//# sourceMappingURL=parameter-optimizer.service.d.ts.map