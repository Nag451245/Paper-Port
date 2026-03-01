import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../lib/prisma.js';
import { NotificationService } from '../services/notification.service.js';
import { TelegramService } from '../services/telegram.service.js';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();
  const notifService = new NotificationService(prisma);
  const telegram = new TelegramService(prisma);

  app.addHook('onRequest', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized('Invalid or missing token');
    }
  });

  app.get('/', async (request) => {
    const userId = (request.user as any).id;
    const notifications = await notifService.getAll(userId);
    return { data: notifications };
  });

  app.get('/unread', async (request) => {
    const userId = (request.user as any).id;
    const notifications = await notifService.getUnread(userId);
    const count = await notifService.getUnreadCount(userId);
    return { data: notifications, count };
  });

  app.post('/:id/read', async (request) => {
    const userId = (request.user as any).id;
    const { id } = request.params as { id: string };
    await notifService.markRead(userId, id);
    return { success: true };
  });

  app.post('/read-all', async (request) => {
    const userId = (request.user as any).id;
    await notifService.markAllRead(userId);
    return { success: true };
  });

  // ── Telegram Integration ──

  app.get('/telegram/status', async (request) => {
    const userId = (request.user as any).id;
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
    const userId = (request.user as any).id;
    const { chatId } = request.body as { chatId: string };

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
    const userId = (request.user as any).id;

    await prisma.user.update({
      where: { id: userId },
      data: { telegramChatId: null, notifyTelegram: false },
    });

    return { success: true };
  });

  app.put('/telegram/preferences', async (request) => {
    const userId = (request.user as any).id;
    const body = request.body as {
      notifyTelegram?: boolean;
      notifyEmail?: boolean;
      phoneNumber?: string;
    };

    const updateData: Record<string, unknown> = {};
    if (body.notifyTelegram !== undefined) updateData.notifyTelegram = body.notifyTelegram;
    if (body.notifyEmail !== undefined) updateData.notifyEmail = body.notifyEmail;
    if (body.phoneNumber !== undefined) updateData.phoneNumber = body.phoneNumber;

    await prisma.user.update({
      where: { id: userId },
      data: updateData,
    });

    return { success: true };
  });

  app.post('/telegram/test', async (request) => {
    const userId = (request.user as any).id;
    const sent = await telegram.notifyUser(userId, '🔔 Test Notification', 'This is a test notification from PaperPort. If you see this, your Telegram integration is working correctly!');
    return { success: sent, message: sent ? 'Test message sent!' : 'Failed to send. Check your Telegram connection.' };
  });
}
