export interface POVConfig {
    totalQty: number;
    targetPct: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    exchange: string;
    portfolioId: string;
    userId: string;
    maxDurationMinutes: number;
    pollIntervalMs: number;
    minSliceQty: number;
    strategyTag?: string;
}
interface POVSlice {
    sliceIndex: number;
    qty: number;
    price: number;
    status: 'FILLED' | 'PARTIAL' | 'FAILED' | 'SKIPPED';
    timestamp: string;
    marketVolumeDelta: number;
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
export declare class POVExecutorService {
    private tradeService;
    private marketData;
    private activeExecutions;
    setTradeService(ts: OrderExecutor): void;
    setMarketData(md: MarketDataProvider): void;
    execute(config: POVConfig): Promise<{
        executionId: string;
        slices: POVSlice[];
        avgFillPrice: number;
        totalFilled: number;
        effectiveParticipationPct: number;
    }>;
    cancel(executionId: string): boolean;
    getActiveExecutions(): string[];
}
export {};
//# sourceMappingURL=pov-executor.service.d.ts.map