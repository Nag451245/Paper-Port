import { FillSimulatorService } from './fill-simulator.service.js';
import type { MarketState } from './fill-simulator.service.js';
export declare enum OrderPriority {
    MARKET = 1,
    LIMIT = 2,
    GTC = 3
}
export interface ExecutionOrder {
    orderId: string;
    symbol: string;
    exchange: string;
    side: 'BUY' | 'SELL';
    orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
    qty: number;
    price?: number;
    triggerPrice?: number;
    portfolioId: string;
    userId: string;
    strategyTag?: string;
    priority: OrderPriority;
    mode: 'PAPER' | 'LIVE';
    submittedAt: Date;
    retryCount?: number;
}
export type ExecutionStatus = 'FILLED' | 'PARTIALLY_FILLED' | 'REJECTED' | 'TIMEOUT';
export interface ExecutionResult {
    orderId: string;
    status: ExecutionStatus;
    fillPrice: number;
    fillQty: number;
    latency: {
        submitToAckMs: number;
        ackToFillMs: number;
        totalMs: number;
    };
    exchange: string;
    brokerOrderId?: string;
    rejectionReason?: string;
}
export declare class ExecutionEngineService {
    private queue;
    private latencyWindow;
    private processing;
    private fillSimulator;
    private marketStateProvider?;
    constructor(fillSimulator: FillSimulatorService, marketStateProvider?: (symbol: string) => MarketState | undefined);
    submit(order: ExecutionOrder): Promise<ExecutionResult>;
    getQueueDepth(): number;
    getLatencyStats(): {
        avgMs: number;
        p50Ms: number;
        p95Ms: number;
        p99Ms: number;
        count: number;
    };
    cancelOrder(orderId: string): boolean;
    private enqueue;
    private processOrder;
    private executePaper;
    private executeLive;
    private validate;
    private removeFromQueue;
    private recordLatency;
    private sleep;
}
//# sourceMappingURL=execution-engine.service.d.ts.map