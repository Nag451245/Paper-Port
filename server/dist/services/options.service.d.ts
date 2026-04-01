import { PrismaClient } from '@prisma/client';
export interface OptionLeg {
    type: 'CE' | 'PE';
    strike: number;
    action: 'BUY' | 'SELL';
    qty: number;
    premium: number;
    expiry?: string;
}
export interface StrategyPayoff {
    spotPrice: number;
    pnl: number;
}
export interface Greeks {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
}
export interface StrategyGreeks extends Greeks {
    netPremium: number;
    maxProfit: number;
    maxLoss: number;
    breakevens: number[];
}
export interface StrategyTemplate {
    id: string;
    name: string;
    category: 'bullish' | 'bearish' | 'neutral' | 'volatile';
    legs: Omit<OptionLeg, 'premium'>[];
    description: string;
    idealCondition: string;
    riskLevel: 'low' | 'medium' | 'high';
}
export interface MaxPainResult {
    maxPainStrike: number;
    callOI: Record<number, number>;
    putOI: Record<number, number>;
    painByStrike: {
        strike: number;
        totalPain: number;
    }[];
}
export interface OIAnalysis {
    strike: number;
    callOI: number;
    putOI: number;
    callOIChange: number;
    putOIChange: number;
    callIV: number;
    putIV: number;
    pcr: number;
    signal: 'bullish' | 'bearish' | 'neutral';
}
export declare function calculateGreeks(spot: number, strike: number, timeToExpiry: number, volatility: number, riskFreeRate: number, type: 'CE' | 'PE'): Greeks;
export declare function calculateOptionPrice(spot: number, strike: number, timeToExpiry: number, volatility: number, riskFreeRate: number, type: 'CE' | 'PE'): number;
export declare function calculatePayoffCurve(legs: OptionLeg[], spotRange: [number, number], steps?: number): StrategyPayoff[];
export declare function calculateStrategyGreeks(legs: OptionLeg[], spot: number, timeToExpiry: number, volatility: number, riskFreeRate: number): StrategyGreeks;
export declare function calculateMaxPain(strikes: number[], callOI: Record<number, number>, putOI: Record<number, number>): MaxPainResult;
export declare function calculateIVPercentile(currentIV: number, historicalIVs: number[]): number;
export declare function analyzeOIData(strikes: number[], callOI: Record<number, number>, putOI: Record<number, number>, callOIChange: Record<number, number>, putOIChange: Record<number, number>, callIV: Record<number, number>, putIV: Record<number, number>): OIAnalysis[];
export declare class OptionsService {
    private prisma;
    constructor(prisma: PrismaClient);
    getTemplates(): StrategyTemplate[];
    getTemplateById(id: string): StrategyTemplate | undefined;
    getTemplatesByCategory(category: string): StrategyTemplate[];
    computePayoff(legs: OptionLeg[], spotPrice: number): {
        payoffCurve: StrategyPayoff[];
        greeks: StrategyGreeks;
    };
    computeMaxPain(optionChainData: {
        strikes: number[];
        callOI: Record<number, number>;
        putOI: Record<number, number>;
    }): MaxPainResult;
    generateAIExplanation(context: {
        strategyName: string;
        legs: OptionLeg[];
        greeks: StrategyGreeks;
        spotPrice: number;
        marketCondition?: string;
    }): string;
    scenarioSimulation(legs: OptionLeg[], spotPrice: number, scenarios: {
        spotChange: number;
        ivChange: number;
        daysElapsed: number;
    }[]): {
        label: string;
        spotPrice: number;
        pnl: number;
    }[];
}
export declare class OptionsError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number);
}
//# sourceMappingURL=options.service.d.ts.map