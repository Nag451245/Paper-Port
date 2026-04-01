/**
 * Data Pipeline Service — Redis Streams-based event-driven data flow.
 *
 * Implements the 5.2 data flow architecture:
 *   Breeze WebSocket → Redis Stream → Feature Compute (Rust)
 *     → Feature Store (DB) → ML Scoring (Python) → Signal
 *     → Risk Check → OMS → Order → Broker → Position Monitor
 *
 * Uses Redis Streams for durable, ordered event delivery between stages.
 */
export declare class DataPipelineService {
    private running;
    private pollIntervalMs;
    initialize(): Promise<boolean>;
    /**
     * Publish a tick event into the pipeline.
     * Called by price feed / WebSocket handler.
     */
    publishTick(symbol: string, ltp: number, volume: number, timestamp: number): Promise<void>;
    /**
     * Publish computed features into the pipeline.
     */
    publishFeatures(symbol: string, features: Record<string, number>): Promise<void>;
    /**
     * Publish a scored signal into the pipeline.
     */
    publishSignal(signal: {
        symbol: string;
        direction: string;
        confidence: number;
        strategy: string;
        mlScore?: number;
        riskApproved?: boolean;
    }): Promise<void>;
    /**
     * Process ticks: compute features via Rust engine, publish to feature stream.
     * This is the Feature Compute stage of the pipeline.
     */
    processTickBatch(ticks: Array<{
        symbol: string;
        candles: unknown[];
    }>): Promise<void>;
    /**
     * Score features using Python ML service, then pass through risk check.
     * This is the ML Scoring → Risk Check stage.
     */
    scoreAndFilter(features: Array<{
        symbol: string;
        featureMap: Record<string, number>;
    }>, riskCheckFn?: (symbol: string, direction: string) => Promise<boolean>): Promise<Array<{
        symbol: string;
        direction: string;
        confidence: number;
        mlScore: number;
        strategy: string;
    }>>;
    /**
     * Read recent entries from a stream for monitoring/debugging.
     */
    readStream(stream: string, count?: number): Promise<unknown[]>;
    /**
     * Get pipeline statistics.
     */
    getStats(): Promise<{
        tickStreamLen: number;
        featureStreamLen: number;
        signalStreamLen: number;
        orderStreamLen: number;
        redisAvailable: boolean;
    }>;
    /**
     * Start a consumer loop that reads ticks from Redis Streams, computes features,
     * and runs ML scoring. This connects the pipeline end-to-end.
     */
    startConsumer(intervalMs?: number): void;
    stopConsumer(): void;
    private tickBuffer?;
    /**
     * Persist candles to DB via CandleStore model. Upserts on conflict (symbol+exchange+interval+timestamp).
     */
    persistCandles(symbol: string, interval: string, candles: Array<{
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
        timestamp?: string | number;
    }>, exchange?: string): Promise<number>;
    /**
     * Load historical candles from DB to bootstrap tick buffer on restart.
     */
    loadHistoricalCandles(symbol: string, interval: string, since: Date, exchange?: string): Promise<Array<{
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>>;
    /**
     * Bootstrap tick buffers from DB for all recently-traded symbols.
     */
    bootstrapFromDB(symbols: string[], interval?: string): Promise<void>;
}
//# sourceMappingURL=data-pipeline.service.d.ts.map