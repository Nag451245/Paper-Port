import type { PrismaClient } from '@prisma/client';
import { wsHub } from '../lib/websocket.js';

type NotificationType = 'info' | 'warning' | 'critical' | 'trade' | 'signal' | 'alert';

export class NotificationService {
  constructor(private prisma: PrismaClient) {}

  async create(
    userId: string,
    title: string,
    message: string,
    type: NotificationType = 'info',
    metadata?: Record<string, unknown>,
  ): Promise<void> {
    const notification = await this.prisma.notification.create({
      data: {
        userId,
        title,
        message,
        type,
        metadata: metadata ? JSON.stringify(metadata) : null,
      },
    });

    wsHub.broadcastNotification(userId, {
      title,
      message,
      notificationType: type,
    });
  }

  async getUnread(userId: string, limit = 50): Promise<any[]> {
    return this.prisma.notification.findMany({
      where: { userId, isRead: false },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async getAll(userId: string, limit = 100): Promise<any[]> {
    return this.prisma.notification.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async markRead(userId: string, notificationId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { id: notificationId, userId },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async markAllRead(userId: string): Promise<void> {
    await this.prisma.notification.updateMany({
      where: { userId, isRead: false },
      data: { isRead: true, readAt: new Date() },
    });
  }

  async getUnreadCount(userId: string): Promise<number> {
    return this.prisma.notification.count({
      where: { userId, isRead: false },
    });
  }

  // Convenience methods for common notifications
  async notifyTradeExecuted(
    userId: string,
    symbol: string,
    side: string,
    qty: number,
    price: number,
    source: string,
  ): Promise<void> {
    await this.create(
      userId,
      `${side} Order Executed`,
      `${side} ${qty} ${symbol} @ ₹${price.toFixed(2)} via ${source}`,
      'trade',
      { symbol, side, qty, price, source },
    );
  }

  async notifySignalGenerated(
    userId: string,
    symbol: string,
    direction: string,
    confidence: number,
    source: string,
  ): Promise<void> {
    await this.create(
      userId,
      `${direction} Signal: ${symbol}`,
      `${source} detected ${direction} opportunity for ${symbol} (${(confidence * 100).toFixed(0)}% confidence)`,
      'signal',
      { symbol, direction, confidence, source },
    );
  }

  async notifyRiskAlert(
    userId: string,
    ruleType: string,
    details: string,
  ): Promise<void> {
    await this.create(userId, `Risk Alert: ${ruleType}`, details, 'critical', { ruleType });
  }
}
