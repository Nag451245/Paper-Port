export declare class TickStoreService {
    private buffer;
    private flushHandle;
    private flushing;
    append(symbol: string, exchange: string, ltp: number, bid: number | undefined, ask: number | undefined, bidQty: number | undefined, askQty: number | undefined, volume: number | bigint, timestamp: Date): void;
    flush(): Promise<number>;
    query(symbol: string, from: Date, to: Date, limit?: number): Promise<{
        symbol: string;
        id: bigint;
        timestamp: Date;
        exchange: string;
        volume: bigint;
        ltp: number;
        bid: number | null;
        ask: number | null;
        bidQty: number | null;
        askQty: number | null;
    }[]>;
    getLatestTick(symbol: string): Promise<{
        symbol: string;
        id: bigint;
        timestamp: Date;
        exchange: string;
        volume: bigint;
        ltp: number;
        bid: number | null;
        ask: number | null;
        bidQty: number | null;
        askQty: number | null;
    } | null>;
    startAutoFlush(): void;
    stopAutoFlush(): void;
    getBufferSize(): number;
}
//# sourceMappingURL=tick-store.service.d.ts.map