import { CacheService } from '../lib/redis.js';
export interface MarketQuote {
    symbol: string;
    exchange: string;
    ltp: number;
    change: number;
    changePercent: number;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
    bidPrice: number;
    askPrice: number;
    bidQty: number;
    askQty: number;
    timestamp: string;
}
export interface HistoricalBar {
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export declare class MarketDataService {
    private cache;
    private cookies;
    private cookieExpiry;
    private cookieFetchPromise;
    private activeNseRequests;
    constructor(cache?: CacheService);
    private fetchLiveFromBreezeBridge;
    private fetchFromYahoo;
    private fetchHistoryFromYahoo;
    private mapIntervalToYahoo;
    getQuote(symbol: string, exchange?: string): Promise<MarketQuote>;
    getMarketDepth(symbol: string, exchange?: string): Promise<{
        symbol: string;
        bids: Array<{
            price: number;
            qty: number;
            orders: number;
        }>;
        asks: Array<{
            price: number;
            qty: number;
            orders: number;
        }>;
        totalBidQty: number;
        totalAskQty: number;
        imbalanceRatio: number;
    }>;
    private ensureNseCookies;
    getHistory(symbol: string, interval: string, fromDate: string, toDate: string, userId?: string, exchange?: string): Promise<HistoricalBar[]>;
    private validateCandles;
    /**
     * Check if data is fresh enough for live trading (not stale during market hours).
     */
    isDataFresh(timestamp: string | Date, maxAgeMs?: number): boolean;
    private backfillCandleStore;
    getTopMovers(count?: number): Promise<{
        gainers: MarketMover[];
        losers: MarketMover[];
    }>;
    private fetchTopMoversFromYahoo;
    getIndices(): Promise<{
        name: string;
        value: number;
        change: number;
        changePercent: number;
    }[]>;
    getVIX(): Promise<{
        value: number;
        change: number;
        changePercent: number;
    }>;
    getFIIDII(): Promise<any>;
    getAvailableExpiries(symbol: string): Promise<{
        expiries: string[];
        sessionError?: boolean;
        message?: string;
    }>;
    getOptionsChain(symbol: string, expiry?: string): Promise<any>;
    private fetchOptionsChainFromNiftyTrader;
    search(query: string, limit?: number, exchange?: string): Promise<any[]>;
    private searchAllExchanges;
    private searchViaYahoo;
    private searchViaNSE;
    getIndicesForExchange(exchange: string): Promise<{
        name: string;
        value: number;
        change: number;
        changePercent: number;
    }[]>;
    private ensureCookies;
    private nseFetch;
    private fetchFromNSE;
    private getBreezeSDK;
    private _initBreezeSDK;
    private fetchFromBreeze;
    private getAnyBreezeCredentials;
    private mapInterval;
    private generateSimulatedHistory;
    diagnoseBreezeConnection(): Promise<Record<string, any>>;
    private buildBreezePayload;
    private buildBreezeHeaders;
    private ensureBreezeBridgeSession;
    private _bridgeInitPromise;
    private autoInitBreezeBridge;
    private _doAutoInitBreezeBridge;
    private fetchFromBreezeBridge;
    private fetchOptionsChainFromBreeze;
    private fetchExpiryDatesFromBreeze;
    private getNextExpiry;
    private parseOptionsChain;
    private getMCXQuote;
    private getCDSQuote;
    private fetchFnOQuote;
    private emptyQuote;
    private fallbackMovers;
    getLotSizes(): Promise<{
        lotSizes: Record<string, number>;
        source: string;
    }>;
}
export interface MarketMover {
    symbol: string;
    name: string;
    ltp: number;
    change: number;
    changePercent: number;
    volume: number;
    open: number;
    high: number;
    low: number;
    previousClose: number;
}
//# sourceMappingURL=market-data.service.d.ts.map