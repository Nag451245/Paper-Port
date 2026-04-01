import { PrismaClient } from '@prisma/client';
import { OrderManagementService } from './oms.service.js';
interface StopLossConfig {
    symbol: string;
    positionId: string;
    portfolioId: string;
    userId: string;
    side: 'LONG' | 'SHORT';
    qty: number;
    entryPrice: number;
    stopLossPrice: number;
    trailingStopPct?: number;
    takeProfitPrice?: number;
    timeBasedExitAt?: string;
}
export declare class StopLossMonitor {
    private prisma;
    private monitoredPositions;
    private intervalHandle;
    private reloadHandle;
    private marketData;
    private tradeService;
    private decisionAudit;
    private checkIntervalMs;
    constructor(prisma: PrismaClient, oms?: OrderManagementService);
    start(): Promise<void>;
    stop(): void;
    addPosition(config: StopLossConfig): void;
    removePosition(positionId: string): void;
    updateStopLoss(positionId: string, newStopPrice: number): void;
    getMonitoredCount(): number;
    getMonitoredPositions(): Array<{
        positionId: string;
        symbol: string;
        side: string;
        qty: number;
        entryPrice: number;
        stopLoss: number;
        takeProfit: number;
        currentPrice: number;
        unrealizedPnl: number;
        distanceToStop: number;
        distanceToTarget: number;
        trailingStop: number;
    }>;
    /**
     * Periodically sync with DB: add new positions, remove closed ones,
     * update qty/entryPrice for pyramided positions, and refresh unrealizedPnl.
     */
    private syncOpenPositions;
    private buildConfig;
    private loadOpenPositions;
    private runChecks;
    private executeStopLossExit;
}
export {};
//# sourceMappingURL=stop-loss-monitor.service.d.ts.map