import type { PrismaClient } from '@prisma/client';
export interface MarginParams {
    symbol: string;
    qty: number;
    price: number;
    side: 'BUY' | 'SELL';
    segment: 'EQ' | 'FO' | 'CD';
    exchange?: string;
    delta?: number;
    underlyingPrice?: number;
}
export interface MarginBreakdown {
    varMargin: number;
    elmMargin: number;
    spanMargin: number;
    totalRequired: number;
    utilizationPct: number;
}
export interface PeakMarginInfo {
    peakUtilizationPct: number;
    currentMarginUsed: number;
    availableMargin: number;
    snapshotAt: Date;
}
export interface MarginSufficiency {
    sufficient: boolean;
    shortfall: number;
    utilizationPct: number;
}
type SymbolGroup = 'I' | 'II' | 'III';
export declare class MarginCalculatorService {
    private prisma;
    private symbolGroupOverrides;
    private varRateOverrides;
    private spanPct;
    constructor(prisma?: PrismaClient);
    private seedDefaultGroups;
    setSymbolGroup(symbol: string, group: SymbolGroup): void;
    setVarRateOverride(symbol: string, rate: number): void;
    setSpanPct(pct: number): void;
    private getVarRate;
    private getElmRate;
    calculateMarginRequired(params: MarginParams): MarginBreakdown;
    getPeakMarginUtilization(userId: string): Promise<PeakMarginInfo>;
    recordMarginSnapshot(userId: string, symbol: string, margin: MarginBreakdown, exchange?: string, segment?: 'EQ' | 'FO' | 'CD'): Promise<void>;
    checkMarginSufficiency(userId: string, requiredMargin: number, availableCapital: number): MarginSufficiency;
}
export {};
//# sourceMappingURL=margin-calculator.service.d.ts.map