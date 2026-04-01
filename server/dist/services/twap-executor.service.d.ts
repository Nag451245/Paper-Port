import type { PrismaClient } from '@prisma/client';
export interface TWAPPlaceOrderInput {
    portfolioId: string;
    symbol: string;
    side: string;
    orderType: string;
    qty: number;
    price?: number;
    triggerPrice?: number;
    instrumentToken: string;
    exchange?: string;
    strategyTag?: string;
}
interface OrderExecutor {
    placeOrder(userId: string, input: TWAPPlaceOrderInput): Promise<any>;
}
export interface TWAPConfig {
    totalQty: number;
    numSlices: number;
    durationMinutes: number;
    maxDeviationPct: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    exchange: string;
    portfolioId: string;
    userId: string;
    strategyTag?: string;
}
export interface VWAPConfig extends TWAPConfig {
    volumeProfile?: number[];
}
interface SliceResult {
    sliceIndex: number;
    qty: number;
    price: number;
    status: 'FILLED' | 'PARTIAL' | 'FAILED';
    timestamp: string;
}
export declare class TWAPExecutor {
    private prisma;
    private tradeService;
    private marketData;
    private calendar;
    private activeExecutions;
    constructor(prisma: PrismaClient);
    setTradeService(ts: OrderExecutor): void;
    executeTWAP(config: TWAPConfig): Promise<{
        executionId: string;
        slices: SliceResult[];
        avgFillPrice: number;
        totalFilled: number;
        idealPrice: number;
        slippageBps: number;
    }>;
    executeVWAP(config: VWAPConfig): Promise<ReturnType<TWAPExecutor['executeTWAP']>>;
    private getDefaultVolumeProfile;
    cancelExecution(executionId: string): boolean;
    getActiveExecutions(): string[];
    /**
     * Compute implementation shortfall: the cost of execution vs. decision price.
     * IS = (Execution VWAP - Decision Price) / Decision Price * 10000 (in bps)
     * Decomposed into: delay cost + market impact + timing cost
     */
    computeImplementationShortfall(decisionPrice: number, arrivalPrice: number, executionVwap: number, totalQty: number, avgDailyVolume: number): {
        totalShortfallBps: number;
        delayCostBps: number;
        marketImpactBps: number;
        timingCostBps: number;
        participationRate: number;
    };
    /**
     * Square-root market impact model: Impact = σ * sqrt(Q / V) * constant
     * Based on Almgren-Chriss framework, simplified for Indian equities.
     */
    estimateMarketImpact(qty: number, price: number, avgDailyVolume: number): number;
}
export declare function selectOrderType(params: {
    qty: number;
    ltp: number;
    avgDailyVolume: number;
    confidence: number;
    spreadPct: number;
    urgency?: number;
    stealth?: boolean;
}): {
    orderType: 'MARKET' | 'LIMIT' | 'TWAP' | 'VWAP' | 'IS' | 'POV' | 'ICEBERG' | 'SNIPER';
    reason: string;
    estimatedImpactBps: number;
};
export {};
//# sourceMappingURL=twap-executor.service.d.ts.map