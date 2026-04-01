import { PrismaClient, type Prisma } from '@prisma/client';
export interface PortfolioSummary {
    totalNav: number;
    dayPnl: number;
    dayPnlPercent: number;
    totalPnl: number;
    totalPnlPercent: number;
    unrealizedPnl: number;
    investedValue: number;
    currentValue: number;
    availableMargin: number;
    usedMargin: number;
}
export declare class PortfolioService {
    private prisma;
    private marketData;
    constructor(prisma: PrismaClient);
    list(userId: string): Promise<{
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        initialCapital: Prisma.Decimal;
        currentNav: Prisma.Decimal;
        isDefault: boolean;
        userId: string;
    }[]>;
    create(userId: string, name: string, initialCapital: number): Promise<{
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        initialCapital: Prisma.Decimal;
        currentNav: Prisma.Decimal;
        isDefault: boolean;
        userId: string;
    }>;
    getById(portfolioId: string, userId: string): Promise<{
        positions: {
            symbol: string;
            status: string;
            id: string;
            exchange: string;
            portfolioId: string;
            instrumentToken: string;
            qty: number;
            avgEntryPrice: Prisma.Decimal;
            side: string;
            positionType: string;
            unrealizedPnl: Prisma.Decimal | null;
            realizedPnl: Prisma.Decimal | null;
            stopLoss: Prisma.Decimal | null;
            target: Prisma.Decimal | null;
            strategyTag: string | null;
            openedAt: Date;
            closedAt: Date | null;
        }[];
    } & {
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        initialCapital: Prisma.Decimal;
        currentNav: Prisma.Decimal;
        isDefault: boolean;
        userId: string;
    }>;
    /**
     * @param priceCache — pre-fetched LTP map (symbol → price) from PriceFeedService.
     *   Symbols found here skip the Breeze bridge round-trip entirely.
     *   Symbols NOT found fall back to individual getQuote() calls with a 5s timeout.
     */
    getSummary(portfolioId: string, userId: string, priceCache?: Record<string, number>): Promise<PortfolioSummary>;
    getEquityCurve(portfolioId: string, userId: string): Promise<{
        date: string;
        value: number;
    }[]>;
    getRiskMetrics(portfolioId: string, userId: string): Promise<{
        sharpeRatio: number;
        maxDrawdown: number;
        maxDrawdownPercent: number;
        winRate: number;
        profitFactor: number;
        beta: number;
        alpha: number;
        sortinoRatio: number;
        calmarRatio: number;
        avgWin: number;
        avgLoss: number;
        totalTrades: number;
    }>;
    getPnlHistory(portfolioId: string, userId: string, days?: number): Promise<{
        date: string;
        totalPnl: number;
    }[]>;
    updateCapital(portfolioId: string, userId: string, virtualCapital: number): Promise<{
        name: string;
        id: string;
        createdAt: Date;
        updatedAt: Date;
        initialCapital: Prisma.Decimal;
        currentNav: Prisma.Decimal;
        isDefault: boolean;
        userId: string;
    }>;
    /**
     * Recalculate currentNav from ground truth:
     *   correctCash = initialCapital
     *                 + sum(all closed trade netPnl)
     *                 - sum(open LONG position entry costs)
     *                 - sum(open SHORT position margin blocked)
     *
     * This fixes drift caused by partial failures in order execution.
     */
    reconcileNav(portfolioId: string, userId: string): Promise<{
        before: number;
        after: number;
        drift: number;
    }>;
    private fetchNiftyDailyReturns;
}
export declare class PortfolioError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number);
}
//# sourceMappingURL=portfolio.service.d.ts.map