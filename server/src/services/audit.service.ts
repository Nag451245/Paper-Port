import type { PrismaClient } from '@prisma/client';

export class AuditService {
  constructor(private prisma: PrismaClient) {}

  async log(
    action: string,
    entity: string,
    entityId?: string,
    userId?: string,
    details?: Record<string, unknown>,
    ipAddress?: string,
  ): Promise<void> {
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
    } catch { /* non-critical — never block main flow */ }
  }

  async getRecent(userId?: string, limit = 50): Promise<any[]> {
    return this.prisma.auditLog.findMany({
      where: userId ? { userId } : undefined,
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getForEntity(entity: string, entityId: string, limit = 20): Promise<any[]> {
    return this.prisma.auditLog.findMany({
      where: { entity, entityId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  // Convenience methods
  async logLogin(userId: string, ip?: string): Promise<void> {
    await this.log('LOGIN', 'User', userId, userId, undefined, ip);
  }

  async logOrderPlaced(userId: string, orderId: string, details: Record<string, unknown>, ip?: string): Promise<void> {
    await this.log('ORDER_PLACED', 'Order', orderId, userId, details, ip);
  }

  async logOrderModified(userId: string, orderId: string, changes: Record<string, unknown>): Promise<void> {
    await this.log('ORDER_MODIFIED', 'Order', orderId, userId, changes);
  }

  async logOrderCancelled(userId: string, orderId: string): Promise<void> {
    await this.log('ORDER_CANCELLED', 'Order', orderId, userId);
  }

  async logTradeExecuted(userId: string, tradeId: string, details: Record<string, unknown>): Promise<void> {
    await this.log('TRADE_EXECUTED', 'Trade', tradeId, userId, details);
  }

  async logPositionClosed(userId: string, positionId: string, details: Record<string, unknown>): Promise<void> {
    await this.log('POSITION_CLOSED', 'Position', positionId, userId, details);
  }

  async logConfigChanged(userId: string, entity: string, entityId: string, changes: Record<string, unknown>): Promise<void> {
    await this.log('CONFIG_CHANGED', entity, entityId, userId, changes);
  }

  async logBotAction(userId: string, botId: string, action: string, details?: Record<string, unknown>): Promise<void> {
    await this.log(action, 'Bot', botId, userId, details);
  }
}
