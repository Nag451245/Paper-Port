export interface RLConfig {
    totalQty: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    exchange: string;
    portfolioId: string;
    userId: string;
    decisionPrice: number;
    durationMinutes: number;
    avgDailyVolume: number;
    pollIntervalMs: number;
    strategyTag?: string;
}
interface RLSlice {
    sliceIndex: number;
    qty: number;
    price: number;
    status: 'FILLED' | 'FAILED' | 'SKIPPED';
    timestamp: string;
    rlAction: number;
    mode: string;
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
export declare class RLExecutorService {
    private tradeService;
    private marketData;
    private activeExecutions;
    setTradeService(ts: OrderExecutor): void;
    setMarketData(md: MarketDataProvider): void;
    execute(config: RLConfig): Promise<{
        executionId: string;
        slices: RLSlice[];
        avgFillPrice: number;
        totalFilled: number;
        rlMode: string;
        avgRLAction: number;
    }>;
    cancel(executionId: string): boolean;
    getActiveExecutions(): string[];
}
export {};
//# sourceMappingURL=rl-executor.service.d.ts.map