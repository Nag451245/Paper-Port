import { PrismaClient } from '@prisma/client';
import { OrderManagementService } from './oms.service.js';
interface SquareOffResult {
    symbol: string;
    positionId: string;
    exitPrice: number;
    pnl: number;
    reason: string;
}
export declare class IntradayManager {
    private prisma;
    private marketData;
    private tradeService;
    private riskService;
    private squareOffTime;
    private squareOffHandle;
    private circuitBreakerHandle;
    private circuitBreakerTriggered;
    private maxDrawdownPct;
    private decisionAudit;
    constructor(prisma: PrismaClient, oms?: OrderManagementService);
    setSquareOffTime(time: string): void;
    setMaxDrawdown(pct: number): void;
    isCircuitBreakerActive(): boolean;
    startAutoSquareOff(): void;
    stopAutoSquareOff(): void;
    private checkDailyLossLimitViaRisk;
    private checkIntradayDrawdown;
    /**
     * Square off ALL open positions at EOD. Delivery-tagged positions are excluded
     * (they survive overnight). Everything else — AI-BOT, RUST_ENGINE, ML_SCORED,
     * INTRADAY, etc. — gets closed.
     *
     * @param userId — when provided, only positions belonging to this user are closed.
     *                  When omitted (system calls like EOD timer), all users' positions are closed.
     */
    squareOffAllIntraday(userId?: string): Promise<SquareOffResult[]>;
    /**
     * @param userId — when provided, verifies the position belongs to this user
     *                  before executing. Returns null if ownership check fails.
     */
    squareOffPosition(positionId: string, reason?: string, userId?: string): Promise<SquareOffResult | null>;
    partialExit(positionId: string, exitQty: number, userId: string): Promise<{
        exitedQty: number;
        remainingQty: number;
        pnl: number;
    }>;
    scaleIn(positionId: string, additionalQty: number, price: number, userId: string): Promise<{
        newQty: number;
        newAvgPrice: number;
    }>;
    convertToDelivery(positionId: string, userId: string): Promise<{
        converted: boolean;
    }>;
}
export {};
//# sourceMappingURL=intraday-manager.service.d.ts.map