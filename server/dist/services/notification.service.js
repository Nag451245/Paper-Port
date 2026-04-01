import { wsHub } from '../lib/websocket.js';
import { TelegramService } from './telegram.service.js';
export class NotificationService {
    prisma;
    telegram;
    constructor(prisma) {
        this.prisma = prisma;
        this.telegram = new TelegramService(prisma);
    }
    async create(userId, title, message, type = 'info', metadata) {
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
        if (type === 'critical' || type === 'trade' || type === 'signal') {
            this.telegram.notifyUser(userId, title, message).catch(() => { });
        }
    }
    async getUnread(userId, limit = 50) {
        return this.prisma.notification.findMany({
            where: { userId, isRead: false },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
    async getAll(userId, limit = 100) {
        return this.prisma.notification.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
    async markRead(userId, notificationId) {
        await this.prisma.notification.updateMany({
            where: { id: notificationId, userId },
            data: { isRead: true, readAt: new Date() },
        });
    }
    async markAllRead(userId) {
        await this.prisma.notification.updateMany({
            where: { userId, isRead: false },
            data: { isRead: true, readAt: new Date() },
        });
    }
    async getUnreadCount(userId) {
        return this.prisma.notification.count({
            where: { userId, isRead: false },
        });
    }
    // Convenience methods for common notifications
    async notifyTradeExecuted(userId, symbol, side, qty, price, source) {
        await this.create(userId, `${side} Order Executed`, `${side} ${qty} ${symbol} @ ₹${price.toFixed(2)} via ${source}`, 'trade', { symbol, side, qty, price, source });
    }
    async notifySignalGenerated(userId, symbol, direction, confidence, source) {
        await this.create(userId, `${direction} Signal: ${symbol}`, `${source} detected ${direction} opportunity for ${symbol} (${(confidence * 100).toFixed(0)}% confidence)`, 'signal', { symbol, direction, confidence, source });
    }
    async notifyRiskAlert(userId, ruleType, details) {
        await this.create(userId, `Risk Alert: ${ruleType}`, details, 'critical', { ruleType });
    }
}
//# sourceMappingURL=notification.service.js.map