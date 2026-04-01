export declare function ingestTick(symbol: string, tick: {
    price: number;
    volume: number;
    timestamp?: string;
}): void;
export declare function processRegimeDetection(candles: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}>): Promise<void>;
export declare function processAnomalyDetection(candles: Array<{
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}>, symbol: string): Promise<void>;
export declare function getActiveBuffers(): string[];
//# sourceMappingURL=tick-processor.d.ts.map