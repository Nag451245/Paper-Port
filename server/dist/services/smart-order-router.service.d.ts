import { OrderBookService } from './order-book.service.js';
export interface RouteDecision {
    exchange: 'NSE' | 'BSE';
    reason: string;
    expectedSpread: number;
    confidence: number;
}
export declare class SmartOrderRouterService {
    private fillStats;
    private orderBookService;
    constructor(orderBookService: OrderBookService);
    route(order: {
        symbol: string;
        exchange?: string;
        side: string;
        qty: number;
        price?: number;
    }): RouteDecision;
    recordFillQuality(exchange: string, slippageBps: number): void;
    getExchangeStats(): Record<string, {
        totalFills: number;
        avgSlippageBps: number;
        recentAvgSlippageBps: number;
        p50SlippageBps: number;
        p95SlippageBps: number;
    }>;
    private getFillQualityScore;
    private getExpectedSpread;
    private computeConfidence;
}
//# sourceMappingURL=smart-order-router.service.d.ts.map