import { type Job } from 'bullmq';
export type MarketDataEvent = {
    type: 'TICK_RECEIVED';
    symbol: string;
    ltp: number;
    change: number;
    volume: number;
    timestamp: string;
} | {
    type: 'CANDLE_CLOSED';
    symbol: string;
    interval: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
} | {
    type: 'DATA_GAP_DETECTED';
    symbol: string;
    interval: string;
    gapMinutes: number;
    lastTimestamp: string;
} | {
    type: 'DATA_QUALITY_REPORT';
    symbol: string;
    interval: string;
    issues: string[];
    barCount: number;
    lastTimestamp: string;
};
export type SignalEvent = {
    type: 'SIGNAL_GENERATED';
    userId: string;
    botId?: string;
    symbol: string;
    direction: string;
    confidence: number;
    entry: number;
    stopLoss: number;
    target: number;
    source: string;
} | {
    type: 'SIGNAL_VALIDATED';
    userId: string;
    symbol: string;
    direction: string;
    approved: boolean;
    reason: string;
} | {
    type: 'SIGNAL_EXPIRED';
    userId: string;
    symbol: string;
    signalId: string;
} | {
    type: 'PIPELINE_SIGNAL';
    symbol: string;
    direction: 'BUY' | 'SELL';
    confidence: number;
    strategy: string;
    mlScore: number;
    source: string;
};
export type ExecutionEvent = {
    type: 'ORDER_PLACED';
    userId: string;
    orderId: string;
    symbol: string;
    side: string;
    qty: number;
    orderType: string;
} | {
    type: 'ORDER_FILLED';
    userId: string;
    orderId: string;
    symbol: string;
    fillPrice: number;
    qty: number;
    slippageBps: number;
} | {
    type: 'POSITION_OPENED';
    userId: string;
    positionId: string;
    symbol: string;
    side: string;
    qty: number;
    entryPrice: number;
} | {
    type: 'POSITION_CLOSED';
    userId: string;
    positionId: string;
    symbol: string;
    pnl: number;
    exitPrice: number;
    strategyTag?: string;
    entryPrice?: number;
    confidence?: number;
} | {
    type: 'ORDER_STATE_CHANGE';
    orderId: string;
    symbol: string;
    fromState: string;
    toState: string;
    filledQty?: number;
    avgFillPrice?: number;
};
export type RiskEvent = {
    type: 'RISK_CHECK_PASSED';
    userId: string;
    symbol: string;
    checks: string[];
} | {
    type: 'RISK_VIOLATION';
    userId: string;
    symbol: string;
    violations: string[];
    severity: 'warning' | 'critical';
} | {
    type: 'CIRCUIT_BREAKER_TRIGGERED';
    userId: string;
    reason: string;
    drawdownPct: number;
} | {
    type: 'RECONCILIATION_MISMATCH';
    mismatches: unknown[];
    timestamp: string;
};
export type SystemEvent = {
    type: 'MARKET_OPEN';
    exchange: string;
    timestamp: string;
} | {
    type: 'MARKET_CLOSE';
    exchange: string;
    timestamp: string;
} | {
    type: 'PHASE_CHANGE';
    from: string;
    to: string;
    timestamp: string;
} | {
    type: 'KILL_SWITCH_ACTIVATED';
    userId: string;
    timestamp: string;
} | {
    type: 'KILL_SWITCH_DEACTIVATED';
    userId: string;
    timestamp: string;
} | {
    type: 'LEARNING_UPDATE';
    userId: string;
    symbol: string;
    outcome: string;
    intradayWinRate: number;
    totalIntradayTrades: number;
} | {
    type: 'ML_WEIGHTS_UPDATED';
    userId: string;
    version: string;
    timestamp: string;
};
export type AppEvent = MarketDataEvent | SignalEvent | ExecutionEvent | RiskEvent | SystemEvent;
declare const QUEUES: {
    readonly 'market-data': "cg-market-data";
    readonly signals: "cg-signals";
    readonly execution: "cg-execution";
    readonly risk: "cg-risk";
    readonly system: "cg-system";
};
type QueueCategory = keyof typeof QUEUES;
export declare function emit(category: QueueCategory, event: AppEvent): Promise<void>;
export declare function on(eventType: string, handler: (event: AppEvent) => void): void;
export declare function onCategory(category: QueueCategory, handler: (event: AppEvent) => void): void;
export declare function off(eventType: string, handler: (event: AppEvent) => void): void;
type EventHandler = (job: Job<AppEvent>) => Promise<void>;
export declare function registerWorker(category: QueueCategory, handler: EventHandler, opts?: {
    concurrency?: number;
}): void;
export declare function shutdownEventBus(): Promise<void>;
export {};
//# sourceMappingURL=event-bus.d.ts.map