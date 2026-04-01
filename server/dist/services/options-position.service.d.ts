import { PrismaClient } from '@prisma/client';
interface Greeks {
    delta: number;
    gamma: number;
    theta: number;
    vega: number;
    rho: number;
    iv: number;
}
export interface OptionsLeg {
    symbol: string;
    strikePrice: number;
    optionType: 'CE' | 'PE';
    side: 'BUY' | 'SELL';
    qty: number;
    entryPrice: number;
    currentPrice: number;
    expiry: string;
    positionId?: string;
}
export interface PortfolioGreeks {
    netDelta: number;
    netGamma: number;
    netTheta: number;
    netVega: number;
    netRho: number;
    legs: Array<OptionsLeg & {
        greeks: Greeks;
        pnl: number;
        marginRequired: number;
    }>;
    totalPnl: number;
    totalMarginRequired: number;
    daysToExpiry: number;
}
export declare class OptionsPositionService {
    private prisma;
    private marketData;
    constructor(prisma: PrismaClient);
    getOptionsPortfolioGreeks(userId: string, spotPrice?: number): Promise<PortfolioGreeks>;
    rollPosition(userId: string, positionId: string, newStrike: number, newExpiry: string): Promise<{
        closed: string;
        opened: string;
    }>;
    getExpiringPositions(userId: string, withinDays?: number): Promise<Array<{
        symbol: string;
        positionId: string;
        expiry: string;
        daysLeft: number;
    }>>;
    private emptyGreeks;
}
export {};
//# sourceMappingURL=options-position.service.d.ts.map