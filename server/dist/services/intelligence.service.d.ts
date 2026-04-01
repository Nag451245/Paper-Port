import { CacheService } from '../lib/redis.js';
export declare class IntelligenceService {
    private cache;
    private chainInflight;
    constructor(cache?: CacheService);
    private fetchOptionsChainDeduped;
    getFIIDII(): Promise<{
        date: any;
        fiiNet: any;
        diiNet: any;
        fiiBuy: any;
        fiiSell: any;
        diiBuy: any;
        diiSell: any;
        niftyPrice: any;
        niftyChange: any;
        niftyChangePct: any;
        source: string;
        message?: undefined;
    } | {
        date: any;
        fiiNet: number;
        diiNet: number;
        fiiBuy: number;
        fiiSell: number;
        diiBuy: number;
        diiSell: number;
        source: string;
        niftyPrice?: undefined;
        niftyChange?: undefined;
        niftyChangePct?: undefined;
        message?: undefined;
    } | {
        date: string;
        fiiNet: number;
        diiNet: number;
        fiiBuy: number;
        fiiSell: number;
        diiBuy: number;
        diiSell: number;
        message: string;
        niftyPrice?: undefined;
        niftyChange?: undefined;
        niftyChangePct?: undefined;
        source?: undefined;
    }>;
    getFIIDIITrend(days?: number): Promise<any>;
    getPCR(symbol: string): Promise<{
        symbol: string;
        pcr: any;
        interpretation: string;
    }>;
    getOIHeatmap(symbol: string): Promise<{
        symbol: string;
        strikes: any;
        message?: undefined;
    } | {
        symbol: string;
        strikes: never[];
        message: string;
    }>;
    getMaxPain(symbol: string): Promise<{
        symbol: string;
        maxPain: any;
        maxPainStrike: any;
        callOI: any;
        putOI: any;
        message?: undefined;
    } | {
        symbol: string;
        maxPain: number;
        maxPainStrike: number;
        callOI: number;
        putOI: number;
        message: string;
    }>;
    getIVPercentile(symbol: string): Promise<{
        symbol: string;
        currentIV: number;
        ivPercentile: number;
        ivRank: number;
        message?: undefined;
    } | {
        symbol: string;
        currentIV: number;
        ivPercentile: number;
        ivRank: number;
        message: string;
    }>;
    getSectorPerformance(): Promise<any>;
    getSectorHeatmap(): Promise<{
        sector: any;
        change: any;
        value: number;
    }[]>;
    getSectorRRG(): Promise<{
        sector: string;
        rsRatio: number;
        rsMomentum: number;
        quadrant: "Leading" | "Weakening" | "Lagging" | "Improving";
    }[]>;
    getSectorRotationAlerts(): Promise<{
        sector: string;
        alert: string;
        severity: string;
    }[]>;
    getGlobalIndices(): Promise<any[]>;
    getFXRates(): Promise<any[]>;
    getCommodities(): Promise<any[]>;
    getUSSummary(): Promise<{
        marketStatus: string;
        sp500: {
            value: number;
            change: number;
        };
        nasdaq: {
            value: number;
            change: number;
        };
        vix: {
            value: number;
            change: number;
        };
    }>;
    getSGXNifty(): Promise<{
        value: number;
        change: number;
        changePercent: number;
        lastUpdated: string;
    }>;
    getEarningsCalendar(): Promise<{
        symbol: any;
        company: any;
        date: any;
        quarter: string;
        description: any;
    }[]>;
    getRBIMPC(): Promise<{
        nextDate: string;
        lastDecision: string;
        currentRate: number;
    }>;
    getMacroEvents(): Promise<{
        event: string;
        date: string;
        country: string;
        impact: string;
    }[]>;
    getBlackout(symbol: string): Promise<{
        symbol: string;
        isBlackoutPeriod: boolean;
        reason: string;
    }>;
    getEventImpact(): Promise<{
        event: string;
        date: string;
        expectedImpact: string;
        affectedSectors: string[];
        historicalMoveAvg: number;
    }[]>;
    getBlockDeals(): Promise<any>;
    getSmartMoney(): Promise<{
        symbol: string;
        netFlow: number;
        direction: string;
        buyValue: number;
        sellValue: number;
        topBuyers: string[];
        topSellers: string[];
    }[]>;
    getInsiderTransactions(): Promise<any>;
    getClusterBuys(): Promise<{
        symbol: string;
        insiderBuyCount: number;
        totalValue: number;
        insiders: string[];
        signal: string;
    }[]>;
    getInsiderSelling(symbol: string): Promise<{
        symbol: string;
        transactions: any[];
        hasRecentSelling: boolean;
        totalSellValue: any;
    }>;
    private getBreezeCredentials;
    private breezeRequest;
    private fetchOptionsChainFromBreeze;
    private fetchOptionsChain;
    private jsBlackScholes;
    private normCdf;
    getGreeks(symbol: string): Promise<{
        symbol: string;
        delta: number;
        gamma: number;
        theta: number;
        vega: number;
        rho: number;
        price: number;
        source: string;
        atmStrike?: undefined;
        call?: undefined;
        put?: undefined;
    } | {
        symbol: string;
        atmStrike: any;
        call: {
            price: any;
            delta: any;
            gamma: any;
            theta: any;
            vega: any;
            rho: any;
            iv: any;
        };
        put: {
            price: any;
            delta: any;
            gamma: any;
            theta: any;
            vega: any;
            rho: any;
            iv: any;
        };
        delta: any;
        gamma: any;
        theta: any;
        vega: any;
        rho: any;
        price: any;
        source: string;
    }>;
    private cached;
}
//# sourceMappingURL=intelligence.service.d.ts.map