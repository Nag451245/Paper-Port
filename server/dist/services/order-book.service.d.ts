export interface PriceLevel {
    price: number;
    qty: number;
}
export interface OrderBookSnapshot {
    symbol: string;
    bids: PriceLevel[];
    asks: PriceLevel[];
    spread: number;
    spreadBps: number;
    midPrice: number;
    vwap: number;
    depthImbalance: number;
    lastUpdate: Date;
}
export declare class OrderBookService {
    private books;
    update(symbol: string, bids: PriceLevel[], asks: PriceLevel[]): void;
    updateFromTick(symbol: string, ltp: number, bid?: number, ask?: number, bidQty?: number, askQty?: number, volume?: number): void;
    getSnapshot(symbol: string): OrderBookSnapshot;
    getSpread(symbol: string): number;
    getDepthImbalance(symbol: string): number;
    getMarketImpact(symbol: string, qty: number, side: 'BUY' | 'SELL'): number;
    private getOrCreate;
    private computeImbalance;
    private trackSpread;
    private calibrateLambda;
    private estimateTickSize;
}
//# sourceMappingURL=order-book.service.d.ts.map