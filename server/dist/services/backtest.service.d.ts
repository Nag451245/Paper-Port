import type { PrismaClient } from '@prisma/client';
import type { BacktestResult } from '@prisma/client';
export declare class BacktestError extends Error {
    readonly statusCode: number;
    constructor(message: string, statusCode?: number);
}
export interface RunBacktestInput {
    strategyId: string;
    symbol: string;
    startDate: string;
    endDate: string;
    initialCapital: number;
    parameters?: Record<string, unknown>;
}
export declare class BacktestService {
    private readonly prisma;
    private marketService;
    constructor(prisma: PrismaClient);
    run(userId: string, input: RunBacktestInput): Promise<BacktestResult>;
    listResults(userId: string): Promise<BacktestResult[]>;
    getResult(resultId: string, userId: string): Promise<BacktestResult>;
    compare(userId: string, resultIds: string[]): Promise<BacktestResult[]>;
}
//# sourceMappingURL=backtest.service.d.ts.map