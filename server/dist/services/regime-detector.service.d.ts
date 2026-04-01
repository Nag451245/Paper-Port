import type { PrismaClient } from '@prisma/client';
import type { Bar, MarketRegime } from './strategy-sdk.js';
export interface RegimeIndicators {
    adx: number;
    atr: number;
    atrPercentile: number;
    bbWidth: number;
    trendStrength: number;
    volatilityRank: number;
}
export interface RegimeResult {
    regime: MarketRegime;
    confidence: number;
    indicators: RegimeIndicators;
}
export declare class RegimeDetectorService {
    private prisma;
    constructor(prisma: PrismaClient);
    detect(bars: Bar[], vix?: number): RegimeResult;
    detectFromHistory(symbol: string, exchange: string, days: number): Promise<RegimeResult>;
    detectHybrid(bars: Bar[], vix?: number): Promise<{
        regime: MarketRegime;
        confidence: number;
        indicators: RegimeIndicators;
        source: 'rule_based' | 'hybrid' | 'ml';
        ruleBasedRegime: MarketRegime;
        mlRegime?: string;
    }>;
    detectAndStore(bars: Bar[], vix?: number, symbol?: string, exchange?: string): Promise<{
        regime: MarketRegime;
        confidence: number;
        source: string;
    }>;
}
//# sourceMappingURL=regime-detector.service.d.ts.map