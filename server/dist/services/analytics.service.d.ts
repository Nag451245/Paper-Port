import type { PrismaClient } from '@prisma/client';
interface TradeStats {
    totalTrades: number;
    winCount: number;
    lossCount: number;
    winRate: number;
    totalPnl: number;
    avgWin: number;
    avgLoss: number;
    avgRR: number;
    profitFactor: number;
    largestWin: number;
    largestLoss: number;
    avgHoldDuration: string;
    sharpeRatio: number;
    maxDrawdown: number;
}
interface SymbolBreakdown {
    symbol: string;
    trades: number;
    pnl: number;
    winRate: number;
}
interface StrategyBreakdown {
    strategy: string;
    trades: number;
    pnl: number;
    winRate: number;
    sharpe: number;
}
export declare class AnalyticsService {
    private prisma;
    constructor(prisma: PrismaClient);
    getTradeStats(userId: string, fromDate?: string, toDate?: string): Promise<TradeStats>;
    getSymbolBreakdown(userId: string): Promise<SymbolBreakdown[]>;
    getStrategyBreakdown(userId: string): Promise<StrategyBreakdown[]>;
    getEquityCurve(userId: string): Promise<Array<{
        date: string;
        pnl: number;
        cumPnl: number;
    }>>;
    exportTradesCSV(userId: string): Promise<string>;
    private emptyStats;
    private avgDuration;
}
export {};
//# sourceMappingURL=analytics.service.d.ts.map