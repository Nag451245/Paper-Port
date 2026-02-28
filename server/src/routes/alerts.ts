import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../lib/prisma.js';

export async function alertRoutes(app: FastifyInstance): Promise<void> {
  const prisma = getPrisma();

  app.addHook('onRequest', async (request) => {
    try {
      await request.jwtVerify();
    } catch {
      throw app.httpErrors.unauthorized('Invalid or missing token');
    }
  });

  app.get('/', async (request) => {
    const userId = (request.user as any).id;
    const alerts = await prisma.priceAlert.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: 100,
    });
    return { data: alerts };
  });

  app.post('/', async (request) => {
    const userId = (request.user as any).id;
    const body = request.body as {
      symbol: string;
      condition: string;
      targetPrice: number;
      notifyEmail?: boolean;
    };

    const alert = await prisma.priceAlert.create({
      data: {
        userId,
        symbol: body.symbol,
        condition: body.condition,
        targetPrice: body.targetPrice,
        notifyEmail: body.notifyEmail ?? false,
      },
    });

    return { data: alert };
  });

  app.delete('/:id', async (request) => {
    const userId = (request.user as any).id;
    const { id } = request.params as { id: string };
    await prisma.priceAlert.deleteMany({
      where: { id, userId },
    });
    return { success: true };
  });

  app.put('/:id/toggle', async (request) => {
    const userId = (request.user as any).id;
    const { id } = request.params as { id: string };

    const alert = await prisma.priceAlert.findFirst({
      where: { id, userId },
    });
    if (!alert) throw app.httpErrors.notFound('Alert not found');

    const updated = await prisma.priceAlert.update({
      where: { id },
      data: { isActive: !alert.isActive },
    });
    return { data: updated };
  });
}
