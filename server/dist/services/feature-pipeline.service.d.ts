export interface Bar {
    timestamp: Date;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export interface MarketState {
    niftyLtp?: number;
    niftyChange?: number;
    vixLevel?: number;
    vixChange?: number;
    fiiNetBuy?: number;
    advanceDeclineRatio?: number;
    sectorRs?: number;
}
export interface FeatureVector {
    priceAction: {
        returns1d: number;
        returns5d: number;
        returns10d: number;
        returns20d: number;
        gapPct: number;
        rangePct: number;
        closeVsHigh: number;
        closeVsLow: number;
        bodyRatio: number;
        upperShadow: number;
        lowerShadow: number;
    };
    trend: {
        ema9: number;
        ema21: number;
        ema50: number;
        sma200: number;
        priceVsEma20: number;
        adx: number;
        plusDi: number;
        minusDi: number;
    };
    momentum: {
        rsi14: number;
        stochasticK: number;
        stochasticD: number;
        macd: number;
        macdSignal: number;
        macdHistogram: number;
    };
    volatility: {
        atr14: number;
        atrPct: number;
        bbWidth: number;
        bbPosition: number;
        historicalVol20d: number;
        realizedVol5d: number;
    };
    volume: {
        volumeRatio5d: number;
        volumeRatio20d: number;
        obvSlope: number;
        vwapDistance: number;
        volumeTrend: number;
    };
    marketContext: {
        niftyReturn1d: number;
        vixLevel: number;
        vixChange: number;
        fiiFlowDir: number;
        advanceDeclineRatio: number;
        sectorRs: number;
    };
    time: {
        dayOfWeek: number;
        hourOfDay: number;
        isExpiryDay: number;
        daysToExpiry: number;
    };
    memory: {
        memoryWinRate: number;
        memoryAvgPnl: number;
        memorySampleCount: number;
        memoryConfidence: number;
    };
}
export declare class FeaturePipelineService {
    extractFeatures(symbol: string, bars: Bar[], marketState?: MarketState, memoryRecall?: {
        winRate: number;
        avgPnl: number;
        sampleCount: number;
        confidence: number;
    }): FeatureVector;
    toFlatArray(features: FeatureVector): number[];
    getFingerprint(features: FeatureVector): string;
    normalizeFeatures(features: number[], runningMean?: number[], runningStd?: number[]): number[];
    private computeEMA;
    private computeSMA;
    private computeRSI;
    private computeATR;
    private computeADX;
    private computeMACD;
    private computeStochastic;
    private computeBollingerBands;
    private computeOBV;
    private computeVWAP;
    private wilderSmooth;
    private stddev;
    private daysUntilNextThursday;
    private zeroVector;
}
//# sourceMappingURL=feature-pipeline.service.d.ts.map