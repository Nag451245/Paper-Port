export interface ParameterSpec {
    name: string;
    type: 'number' | 'boolean' | 'string';
    min?: number;
    max?: number;
    step?: number;
    default: unknown;
    description?: string;
}
export interface Bar {
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export interface Tick {
    symbol: string;
    ltp: number;
    bid?: number;
    ask?: number;
    volume: number;
    timestamp: Date;
}
export interface Fill {
    orderId: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    qty: number;
    price: number;
    timestamp: Date;
}
export interface Signal {
    symbol: string;
    direction: 'BUY' | 'SELL';
    confidence: number;
    entryPrice: number;
    stopLoss: number;
    target: number;
    qty: number;
    reason?: string;
}
export type MarketRegime = 'TRENDING_UP' | 'TRENDING_DOWN' | 'MEAN_REVERTING' | 'VOLATILE' | 'QUIET';
export interface StrategyContext {
    portfolio: {
        capital: number;
        investedValue: number;
        availableCash: number;
    };
    positions: Array<{
        symbol: string;
        side: string;
        qty: number;
        avgPrice: number;
        unrealizedPnl: number;
    }>;
    regime: MarketRegime;
    timestamp: Date;
    indicators: Map<string, number>;
}
export declare abstract class Strategy {
    abstract readonly name: string;
    abstract readonly version: string;
    abstract readonly parameters: ParameterSpec[];
    onInit(_context: StrategyContext): void;
    abstract onBar(bar: Bar, context: StrategyContext): Signal | null;
    onTick?(tick: Tick, context: StrategyContext): Signal | null;
    onFill?(fill: Fill, context: StrategyContext): void;
    onExit?(reason: string): void;
    protected getParamValue<T>(params: Record<string, unknown>, name: string): T;
}
export declare class StrategyRegistry {
    private static instance;
    private strategies;
    private constructor();
    static getInstance(): StrategyRegistry;
    register(strategy: Strategy): void;
    get(name: string): Strategy | undefined;
    list(): Strategy[];
    createInstance(name: string, params: Record<string, unknown>): Strategy;
}
export declare class SMACrossoverStrategy extends Strategy {
    readonly name = "SMA_CROSSOVER";
    readonly version = "1.0.0";
    readonly parameters: ParameterSpec[];
    private barHistory;
    private fastPeriod;
    private slowPeriod;
    private prevFastSMA;
    private prevSlowSMA;
    constructor(params?: Record<string, unknown>);
    onInit(_context: StrategyContext): void;
    onBar(bar: Bar, context: StrategyContext): Signal | null;
}
export declare class RSIMeanReversionStrategy extends Strategy {
    readonly name = "RSI_MEAN_REVERSION";
    readonly version = "1.0.0";
    readonly parameters: ParameterSpec[];
    private barHistory;
    private period;
    private oversold;
    private overbought;
    private prevRSI;
    constructor(params?: Record<string, unknown>);
    onInit(_context: StrategyContext): void;
    onBar(bar: Bar, context: StrategyContext): Signal | null;
}
export declare class MomentumBreakoutStrategy extends Strategy {
    readonly name = "MOMENTUM_BREAKOUT";
    readonly version = "1.0.0";
    readonly parameters: ParameterSpec[];
    private barHistory;
    private lookback;
    private atrMultiplier;
    constructor(params?: Record<string, unknown>);
    onInit(_context: StrategyContext): void;
    onBar(bar: Bar, context: StrategyContext): Signal | null;
}
export declare class OUMeanReversionStrategy extends Strategy {
    readonly name = "OU_MEAN_REVERSION";
    readonly version = "1.0.0";
    readonly parameters: ParameterSpec[];
    private barHistory;
    private lookback;
    private entryZ;
    private exitZ;
    private minHL;
    private maxHL;
    constructor(params?: Record<string, unknown>);
    onInit(_context: StrategyContext): void;
    onBar(bar: Bar, context: StrategyContext): Signal | null;
    private estimateOU;
    private computeHurst;
}
//# sourceMappingURL=strategy-sdk.d.ts.map