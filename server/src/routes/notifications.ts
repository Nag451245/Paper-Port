import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../lib/prisma.js';
import { NotificationService } from '../services/notification.service.js';

export async function notificationRoutes(app: FastifyInstance): Promise<void> {
  const notifService = new NotificationService(getPrisma());

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
}
