export interface IcebergConfig {
    totalQty: number;
    showQty: number;
    randomizePct: number;
    symbol: string;
    side: 'BUY' | 'SELL';
    exchange: string;
    portfolioId: string;
    userId: string;
    price?: number;
    strategyTag?: string;
    maxDurationMinutes: number;
    pollIntervalMs: number;
}
interface IcebergSlice {
    sliceIndex: number;
    qty: number;
    price: number;
    status: 'FILLED' | 'PARTIAL' | 'FAILED';
    timestamp: string;
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
export declare class IcebergExecutor {
    private tradeService;
    private activeIcebergs;
    setTradeService(ts: OrderExecutor): void;
    execute(config: IcebergConfig): Promise<{
        executionId: string;
        slices: IcebergSlice[];
        avgFillPrice: number;
        totalFilled: number;
        totalShown: number;
    }>;
    cancel(executionId: string): boolean;
    getActiveIcebergs(): string[];
}
export {};
//# sourceMappingURL=iceberg-executor.service.d.ts.map