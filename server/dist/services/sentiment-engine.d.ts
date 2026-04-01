import type { PrismaClient } from '@prisma/client';
interface SentimentSignal {
    source: string;
    symbol: string;
    sentiment: 'BULLISH' | 'BEARISH' | 'NEUTRAL';
    strength: number;
    headline: string;
    timestamp: string;
}
interface FIIDIIFlow {
    date: string;
    fiiBuy: number;
    fiiSell: number;
    fiiNet: number;
    diiBuy: number;
    diiSell: number;
    diiNet: number;
    signal: string;
}
interface CorporateAction {
    symbol: string;
    actionType: string;
    exDate: string;
    details: string;
    impact: 'POSITIVE' | 'NEGATIVE' | 'NEUTRAL';
}
interface SentimentSnapshot {
    overallSentiment: string;
    sentimentScore: number;
    fiiDiiFlow: FIIDIIFlow | null;
    signals: SentimentSignal[];
    corporateActions: CorporateAction[];
    marketBreadth: {
        advancers: number;
        decliners: number;
        unchanged: number;
        ratio: number;
    };
    fearGreedIndex: number;
}
export declare class SentimentEngine {
    private prisma;
    private marketData;
    private cache;
    private cacheExpiry;
    constructor(prisma: PrismaClient);
    getSentimentSnapshot(): Promise<SentimentSnapshot>;
    getAISentimentAnalysis(symbols: string[]): Promise<{
        analysis: string;
        symbolSentiments: Array<{
            symbol: string;
            sentiment: string;
            confidence: number;
            reasoning: string;
        }>;
    }>;
    private fetchFIIDII;
    private fetchMarketBreadth;
    private computeFearGreedIndex;
}
export {};
//# sourceMappingURL=sentiment-engine.d.ts.map