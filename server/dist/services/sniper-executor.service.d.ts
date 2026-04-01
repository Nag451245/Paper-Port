export interface SniperConfig {
    totalQty: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    exchange: string;
    portfolioId: string;
    userId: string;
    depthThresholdMultiplier: number;
    maxDurationMinutes: number;
    pollIntervalMs: number;
    maxSlicePct: number;
    strategyTag?: string;
}
interface SniperSlice {
    sliceIndex: number;
    qty: number;
    price: number;
    status: 'FILLED' | 'PARTIAL' | 'FAILED' | 'WAITING';
    timestamp: string;
    depthScore: number;
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
        totalBuyQty?: number;
        totalSellQty?: number;
    }>;
}
export declare class SniperExecutorService {
    private tradeService;
    private marketData;
    private activeExecutions;
    setTradeService(ts: OrderExecutor): void;
    setMarketData(md: MarketDataProvider): void;
    execute(config: SniperConfig): Promise<{
        executionId: string;
        slices: SniperSlice[];
        avgFillPrice: number;
        totalFilled: number;
        opportunitiesFound: number;
        opportunitiesTaken: number;
    }>;
    private computeMedian;
    cancel(executionId: string): boolean;
    getActiveExecutions(): string[];
}
export {};
//# sourceMappingURL=sniper-executor.service.d.ts.map