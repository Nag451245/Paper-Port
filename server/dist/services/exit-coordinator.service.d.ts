import type { PrismaClient } from '@prisma/client';
import type { TradeService } from './trade.service.js';
import type { DecisionAuditService } from './decision-audit.service.js';
interface CloseRequest {
    positionId: string;
    userId: string;
    exitPrice: number;
    reason: string;
    source: string;
    decisionType: 'SL_TRIGGER' | 'TP_TRIGGER' | 'EXIT_SIGNAL' | 'POSITION_CLOSED';
    prisma: PrismaClient;
    tradeService: TradeService;
    decisionAudit: DecisionAuditService;
    extraSnapshot?: Record<string, unknown>;
}
interface CloseResult {
    success: boolean;
    pnl?: number;
    error?: string;
    alreadyClosing?: boolean;
}
export declare class ExitCoordinator {
    static closePosition(req: CloseRequest): Promise<CloseResult>;
    static isExiting(positionId: string): boolean;
}
export {};
//# sourceMappingURL=exit-coordinator.service.d.ts.map