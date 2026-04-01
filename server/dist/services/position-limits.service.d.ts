import type { PrismaClient } from '@prisma/client';
export interface PositionLimitCheck {
    symbol: string;
    exchange?: string;
    segment?: string;
    proposedQty: number;
    currentQty: number;
    userId: string;
}
export interface PositionLimitResult {
    allowed: boolean;
    reason?: string;
    currentUtilization: number;
    maxAllowed: number;
    isBanPeriod: boolean;
}
export interface PositionSummary {
    symbol: string;
    currentQty: number;
    maxAllowed: number;
    utilizationPct: number;
    isBanned: boolean;
}
export declare class PositionLimitsService {
    private prisma;
    private mwplLookup;
    private bannedSymbols;
    constructor(prisma?: PrismaClient);
    private seedDefaultMWPL;
    updateMWPL(symbol: string, limit: number): void;
    getMWPL(symbol: string): number;
    setBanPeriod(symbol: string): void;
    clearBanPeriod(symbol: string): void;
    isBanned(symbol: string): boolean;
    private getClientLimitPct;
    checkPositionLimit(params: PositionLimitCheck): PositionLimitResult;
    getPositionSummary(userId: string): Promise<PositionSummary[]>;
    checkAndUpdateBanStatus(symbol: string, aggregateOI: number): boolean;
}
//# sourceMappingURL=position-limits.service.d.ts.map