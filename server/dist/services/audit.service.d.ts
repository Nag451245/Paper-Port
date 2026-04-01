import type { PrismaClient } from '@prisma/client';
export declare class AuditService {
    private prisma;
    constructor(prisma: PrismaClient);
    log(action: string, entity: string, entityId?: string, userId?: string, details?: Record<string, unknown>, ipAddress?: string): Promise<void>;
    getRecent(userId?: string, limit?: number): Promise<any[]>;
    getForEntity(entity: string, entityId: string, limit?: number): Promise<any[]>;
    logLogin(userId: string, ip?: string): Promise<void>;
    logOrderPlaced(userId: string, orderId: string, details: Record<string, unknown>, ip?: string): Promise<void>;
    logOrderModified(userId: string, orderId: string, changes: Record<string, unknown>): Promise<void>;
    logOrderCancelled(userId: string, orderId: string): Promise<void>;
    logTradeExecuted(userId: string, tradeId: string, details: Record<string, unknown>): Promise<void>;
    logPositionClosed(userId: string, positionId: string, details: Record<string, unknown>): Promise<void>;
    logConfigChanged(userId: string, entity: string, entityId: string, changes: Record<string, unknown>): Promise<void>;
    logBotAction(userId: string, botId: string, action: string, details?: Record<string, unknown>): Promise<void>;
}
//# sourceMappingURL=audit.service.d.ts.map