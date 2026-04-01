import { getPrisma } from '../lib/prisma.js';
import { NotificationService } from '../services/notification.service.js';
import { TelegramService } from '../services/telegram.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
export async function notificationRoutes(app) {
    const prisma = getPrisma();
    const notifService = new NotificationService(prisma);
    const telegram = new TelegramService(prisma);
    app.addHook('onRequest', authenticate);
    app.get('/', async (request) => {
        const userId = getUserId(request);
        const notifications = await notifService.getAll(userId);
        return { data: notifications };
    });
    app.get('/unread', async (request) => {
        const userId = getUserId(request);
        const notifications = await notifService.getUnread(userId);
        const count = await notifService.getUnreadCount(userId);
        return { data: notifications, count };
    });
    app.post('/:id/read', async (request) => {
        const userId = getUserId(request);
        const { id } = request.params;
        await notifService.markRead(userId, id);
        return { success: true };
    });
    app.post('/read-all', async (request) => {
        const userId = getUserId(request);
        await notifService.markAllRead(userId);
        return { success: true };
    });
    // ── Telegram Integration ──
    app.get('/telegram/status', async (request) => {
        const userId = getUserId(request);
        const user = await prisma.user.findUnique({
            where: { id: userId },
            select: { telegramChatId: true, notifyTelegram: true, phoneNumber: true },
        });
        const botInfo = await telegram.getBotInfo();
        return {
            configured: telegram.isConfigured,
            connected: !!user?.telegramChatId,
            notificationsEnabled: user?.notifyTelegram ?? false,
            phoneNumber: user?.phoneNumber ?? null,
            botUsername: botInfo?.username ?? null,
            botName: botInfo?.name ?? null,
        };
    });
    app.post('/telegram/connect', async (request) => {
        const userId = getUserId(request);
        const { chatId } = request.body;
        if (!chatId) {
            return app.httpErrors.badRequest('Telegram Chat ID is required');
        }
        const verification = await telegram.verifyConnection(chatId);
        if (!verification.success) {
            return app.httpErrors.badRequest('Could not send message to this Telegram Chat ID. Make sure you have started a conversation with the bot first.');
        }
        await prisma.user.update({
            where: { id: userId },
            data: { telegramChatId: chatId, notifyTelegram: true },
        });
        return { success: true, message: 'Telegram connected! Check your chat for a confirmation message.' };
    });
    app.post('/telegram/disconnect', async (request) => {
        const userId = getUserId(request);
        await prisma.user.update({
            where: { id: userId },
            data: { telegramChatId: null, notifyTelegram: false },
        });
        return { success: true };
    });
    app.put('/telegram/preferences', async (request) => {
        const userId = getUserId(request);
        const body = request.body;
        const updateData = {};
        if (body.notifyTelegram !== undefined)
            updateData.notifyTelegram = body.notifyTelegram;
        if (body.notifyEmail !== undefined)
            updateData.notifyEmail = body.notifyEmail;
        if (body.phoneNumber !== undefined)
            updateData.phoneNumber = body.phoneNumber;
        await prisma.user.update({
            where: { id: userId },
            data: updateData,
        });
        return { success: true };
    });
    app.post('/telegram/test', async (request) => {
        const userId = getUserId(request);
        const sent = await telegram.notifyUser(userId, '🔔 Test Notification', 'This is a test notification from PaperPort. If you see this, your Telegram integration is working correctly!');
        return { success: sent, message: sent ? 'Test message sent!' : 'Failed to send. Check your Telegram connection.' };
    });
}
//# sourceMappingURL=notifications.js.map