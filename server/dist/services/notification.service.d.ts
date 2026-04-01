import type { PrismaClient } from '@prisma/client';
type NotificationType = 'info' | 'warning' | 'critical' | 'trade' | 'signal' | 'alert';
export declare class NotificationService {
    private prisma;
    private telegram;
    constructor(prisma: PrismaClient);
    create(userId: string, title: string, message: string, type?: NotificationType, metadata?: Record<string, unknown>): Promise<void>;
    getUnread(userId: string, limit?: number): Promise<any[]>;
    getAll(userId: string, limit?: number): Promise<any[]>;
    markRead(userId: string, notificationId: string): Promise<void>;
    markAllRead(userId: string): Promise<void>;
    getUnreadCount(userId: string): Promise<number>;
    notifyTradeExecuted(userId: string, symbol: string, side: string, qty: number, price: number, source: string): Promise<void>;
    notifySignalGenerated(userId: string, symbol: string, direction: string, confidence: number, source: string): Promise<void>;
    notifyRiskAlert(userId: string, ruleType: string, details: string): Promise<void>;
}
export {};
//# sourceMappingURL=notification.service.d.ts.map