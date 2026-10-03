import type { FastifyInstance } from 'fastify';
import { getPrisma } from '../lib/prisma.js';
import { requireAdmin, getUserId } from '../middleware/auth.js';
import { AdminError, AdminService } from '../services/admin.service.js';

/** Administrator only: approve sign-ups, block / unblock / delete users. */
export async function adminRoutes(app: FastifyInstance): Promise<void> {
  const admin = new AdminService(getPrisma());
  app.addHook('preHandler', requireAdmin);

  const handle = (fn: (adminId: string, userId: string) => Promise<unknown>) =>
    async (request: any, reply: any) => {
      try {
        await fn(getUserId(request), String(request.params.userId ?? ''));
        return reply.send({ ok: true });
      } catch (err) {
        if (err instanceof AdminError) return reply.code(err.statusCode).send({ error: err.message });
        throw err;
      }
    };

  app.get('/users', async () => ({ users: await admin.listUsers() }));
  app.post('/users/:userId/approve', handle((a, u) => admin.approve(a, u)));
  app.post('/users/:userId/block', handle((a, u) => admin.block(a, u)));
  app.post('/users/:userId/unblock', handle((a, u) => admin.unblock(a, u)));
  app.delete('/users/:userId', handle((a, u) => admin.remove(a, u)));
}
