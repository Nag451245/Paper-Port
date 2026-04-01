interface GlobalIndex {
    name: string;
    value: number;
    change: number;
    changePercent: number;
}
interface MarketIntelligence {
    timestamp: string;
    giftNifty: {
        value: number;
        change: number;
        changePercent: number;
    } | null;
    globalIndices: GlobalIndex[];
    fiiDii: {
        date: string;
        fiiNet: number;
        diiNet: number;
        fiiBuy: number;
        fiiSell: number;
        diiBuy: number;
        diiSell: number;
    };
    sectorPerformance: {
        sector: string;
        changePercent: number;
    }[];
    aiSummary: string;
    sentiment: 'VERY_BULLISH' | 'BULLISH' | 'NEUTRAL' | 'BEARISH' | 'VERY_BEARISH';
    keyEvents: string[];
    stockFlows: {
        mfTopBuys: string[];
        mfTopSells: string[];
        fiiTopBuys: string[];
        fiiTopSells: string[];
    };
}
export declare class GlobalMarketService {
    private marketData;
    getLatestIntelligence(): MarketIntelligence | null;
    runDailyIntelligenceScan(): Promise<MarketIntelligence>;
    getIntelligenceContextForBots(): string;
    private fetchGiftNifty;
    private fetchYahooChart;
    private fetchGlobalIndices;
    private fetchSectorPerformance;
    private generateRuleBasedSummary;
    private computeRuleBasedSentiment;
    private storeIntelligence;
}
export {};
//# sourceMappingURL=global-market.service.d.ts.map