import { getPrisma } from '../lib/prisma.js';
import { authenticate, getUserId } from '../middleware/auth.js';
export async function alertRoutes(app) {
    const prisma = getPrisma();
    app.addHook('onRequest', authenticate);
    app.get('/', async (request) => {
        const userId = getUserId(request);
        const alerts = await prisma.priceAlert.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
            take: 100,
        });
        return { data: alerts };
    });
    app.post('/', async (request) => {
        const userId = getUserId(request);
        const body = request.body;
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
        const userId = getUserId(request);
        const { id } = request.params;
        await prisma.priceAlert.deleteMany({
            where: { id, userId },
        });
        return { success: true };
    });
    app.put('/:id/toggle', async (request) => {
        const userId = getUserId(request);
        const { id } = request.params;
        const alert = await prisma.priceAlert.findFirst({
            where: { id, userId },
        });
        if (!alert)
            throw app.httpErrors.notFound('Alert not found');
        const updated = await prisma.priceAlert.update({
            where: { id },
            data: { isActive: !alert.isActive },
        });
        return { data: updated };
    });
}
//# sourceMappingURL=alerts.js.map