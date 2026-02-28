import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { WatchlistService, WatchlistError } from '../services/watchlist.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';

const createSchema = z.object({
  name: z.string().min(1),
});

const addItemSchema = z.object({
  symbol: z.string().min(1),
  exchange: z.enum(['NSE', 'BSE', 'MCX', 'CDS']).default('NSE'),
});

export async function watchlistRoutes(app: FastifyInstance): Promise<void> {
  const service = new WatchlistService(getPrisma());

  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    const userId = getUserId(request);
    const watchlists = await service.list(userId);
    return reply.send(watchlists);
  });

  app.post('/', async (request, reply) => {
    const parsed = createSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const userId = getUserId(request);
    const watchlist = await service.create(userId, parsed.data.name);
    return reply.code(201).send(watchlist);
  });

  app.get('/:watchlistId', async (request, reply) => {
    try {
      const { watchlistId } = request.params as { watchlistId: string };
      const userId = getUserId(request);
      const watchlist = await service.getById(watchlistId, userId);
      return reply.send(watchlist);
    } catch (err) {
      if (err instanceof WatchlistError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/:watchlistId/items', async (request, reply) => {
    const parsed = addItemSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { watchlistId } = request.params as { watchlistId: string };
      const userId = getUserId(request);
      const item = await service.addItem(watchlistId, userId, parsed.data.symbol, parsed.data.exchange);
      return reply.code(201).send(item);
    } catch (err) {
      if (err instanceof WatchlistError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/:watchlistId/items/:itemId', async (request, reply) => {
    try {
      const { watchlistId, itemId } = request.params as { watchlistId: string; itemId: string };
      const userId = getUserId(request);
      await service.removeItem(watchlistId, itemId, userId);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof WatchlistError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/:watchlistId', async (request, reply) => {
    try {
      const { watchlistId } = request.params as { watchlistId: string };
      const userId = getUserId(request);
      await service.deleteWatchlist(watchlistId, userId);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof WatchlistError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });
}
