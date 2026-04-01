import type { OrderBookSnapshot } from './order-book.service.js';
export interface FillSimOrder {
    symbol: string;
    exchange: string;
    side: string;
    orderType: string;
    qty: number;
    price?: number;
    triggerPrice?: number;
}
export interface MarketState {
    ltp: number;
    bid?: number;
    ask?: number;
    bidQty?: number;
    askQty?: number;
    avgDailyVolume?: number;
}
export interface FillResult {
    fillPrice: number;
    fillQty: number;
    slippageBps: number;
    marketImpact: number;
    latencyMs: number;
    partial: boolean;
}
export declare class FillSimulatorService {
    simulate(order: FillSimOrder, marketState: MarketState): FillResult;
    simulateWithOrderBook(order: FillSimOrder, orderBook: OrderBookSnapshot): FillResult;
    private walkBook;
    private computeMarketImpact;
    private computePartialFill;
    private simulateLatency;
}
//# sourceMappingURL=fill-simulator.service.d.ts.map