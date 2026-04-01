export interface ISConfig {
    totalQty: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    exchange: string;
    portfolioId: string;
    userId: string;
    decisionPrice: number;
    urgency: number;
    avgDailyVolume: number;
    durationMinutes: number;
    numSlices?: number;
    strategyTag?: string;
}
interface ISSlice {
    sliceIndex: number;
    qty: number;
    price: number;
    status: 'FILLED' | 'PARTIAL' | 'FAILED';
    timestamp: string;
    cumulativeShortfallBps: number;
}
interface OrderExecutor {
    placeOrder(userId: string, input: {
        portfolioId: string;
        symbol: string;
        side: string;
        orderType: string;
        qty: number;
        price?: number;
        instrumentToken: string;
        exchange?: string;
        strategyTag?: string;
    }): Promise<any>;
}
interface MarketDataProvider {
    getQuote(symbol: string, exchange?: string): Promise<{
        ltp: number;
        volume?: number;
    }>;
}
export declare class ISExecutorService {
    private tradeService;
    private marketData;
    private activeExecutions;
    setTradeService(ts: OrderExecutor): void;
    setMarketData(md: MarketDataProvider): void;
    execute(config: ISConfig): Promise<{
        executionId: string;
        slices: ISSlice[];
        avgFillPrice: number;
        totalFilled: number;
        totalShortfallBps: number;
        optimalTrajectory: number[];
    }>;
    private computeOptimalTrajectory;
    private computeTradeOffParam;
    cancel(executionId: string): boolean;
    getActiveExecutions(): string[];
}
export {};
//# sourceMappingURL=is-executor.service.d.ts.map