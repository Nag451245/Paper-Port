import type { Strategy, Bar } from './strategy-sdk.js';
export interface EquityPoint {
    timestamp: Date;
    equity: number;
    drawdown: number;
    drawdownPct: number;
}
export interface BacktestTrade {
    entryDate: Date;
    exitDate: Date;
    symbol: string;
    side: 'BUY' | 'SELL';
    entryPrice: number;
    exitPrice: number;
    qty: number;
    grossPnl: number;
    commission: number;
    slippage: number;
    netPnl: number;
    holdingBars: number;
    mae: number;
    mfe: number;
}
export interface BacktestMetrics {
    totalReturn: number;
    cagr: number;
    sharpeRatio: number;
    sortinoRatio: number;
    maxDrawdown: number;
    maxDrawdownDuration: number;
    winRate: number;
    profitFactor: number;
    avgWin: number;
    avgLoss: number;
    avgHoldingPeriod: number;
    totalTrades: number;
    calmarRatio: number;
    expectancy: number;
    payoffRatio: number;
}
export interface BacktestResult {
    equityCurve: EquityPoint[];
    trades: BacktestTrade[];
    metrics: BacktestMetrics;
    config: {
        symbol: string;
        initialCapital: number;
        startDate: Date;
        endDate: Date;
        totalBars: number;
    };
}
export interface BacktestConfig {
    strategy: Strategy;
    bars: Bar[];
    initialCapital: number;
    commissionPct?: number;
    slippageBps?: number;
    symbol: string;
    exchange?: string;
}
export declare class BacktestEngine {
    run(config: BacktestConfig): BacktestResult;
    private buildContext;
    private applySlippage;
    private computeCommission;
    private executeSignal;
    private checkStopsAndTargets;
    private closeAllPositions;
    private computeEquity;
    private computeMetrics;
}
//# sourceMappingURL=backtest-engine.service.d.ts.map