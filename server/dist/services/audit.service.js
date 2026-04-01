export class AuditService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async log(action, entity, entityId, userId, details, ipAddress) {
        try {
            await this.prisma.auditLog.create({
                data: {
                    userId,
                    action,
                    entity,
                    entityId,
                    details: details ? JSON.stringify(details) : null,
                    ipAddress,
                },
            });
        }
        catch { /* non-critical — never block main flow */ }
    }
    async getRecent(userId, limit = 50) {
        return this.prisma.auditLog.findMany({
            where: userId ? { userId } : undefined,
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
    async getForEntity(entity, entityId, limit = 20) {
        return this.prisma.auditLog.findMany({
            where: { entity, entityId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
    // Convenience methods
    async logLogin(userId, ip) {
        await this.log('LOGIN', 'User', userId, userId, undefined, ip);
    }
    async logOrderPlaced(userId, orderId, details, ip) {
        await this.log('ORDER_PLACED', 'Order', orderId, userId, details, ip);
    }
    async logOrderModified(userId, orderId, changes) {
        await this.log('ORDER_MODIFIED', 'Order', orderId, userId, changes);
    }
    async logOrderCancelled(userId, orderId) {
        await this.log('ORDER_CANCELLED', 'Order', orderId, userId);
    }
    async logTradeExecuted(userId, tradeId, details) {
        await this.log('TRADE_EXECUTED', 'Trade', tradeId, userId, details);
    }
    async logPositionClosed(userId, positionId, details) {
        await this.log('POSITION_CLOSED', 'Position', positionId, userId, details);
    }
    async logConfigChanged(userId, entity, entityId, changes) {
        await this.log('CONFIG_CHANGED', entity, entityId, userId, changes);
    }
    async logBotAction(userId, botId, action, details) {
        await this.log(action, 'Bot', botId, userId, details);
    }
}
//# sourceMappingURL=audit.service.js.map