import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { MarketDataService } from '../services/market-data.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';

const symbolParam = z.string().min(1).max(30).regex(/^[A-Z0-9&_-]+$/i, 'Invalid symbol');
const intervalParam = z.string().regex(/^(1d|1day|day|daily|1h|1hour|hour|5m|5min|5minute|15m|15min|15minute|30m|30min|30minute)$/i).default('1day');
const dateParam = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

export async function marketRoutes(app: FastifyInstance): Promise<void> {
  const service = new MarketDataService();

  app.get('/quote/:symbol', async (request, reply) => {
    const sym = symbolParam.safeParse((request.params as any).symbol);
    if (!sym.success) return reply.code(400).send({ error: 'Invalid symbol' });
    const query = request.query as { exchange?: string };
    const quote = await service.getQuote(sym.data, query.exchange ?? 'NSE');
    return reply.send(quote);
  });

  app.get('/history/:symbol', { preHandler: [authenticate] }, async (request, reply) => {
    const sym = symbolParam.safeParse((request.params as any).symbol);
    if (!sym.success) return reply.code(400).send({ error: 'Invalid symbol' });
    const query = request.query as { interval?: string; from_date?: string; to_date?: string; exchange?: string };
    const userId = getUserId(request);

    const now = new Date();
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);
    const interval = intervalParam.safeParse(query.interval ?? '1day');

    const bars = await service.getHistory(
      sym.data,
      interval.success ? interval.data : '1day',
      query.from_date ?? thirtyDaysAgo.toISOString().split('T')[0],
      query.to_date ?? now.toISOString().split('T')[0],
      userId,
      query.exchange ?? 'NSE',
    );

    if (bars.length === 0) {
      return reply.send({ error: 'No historical data. Configure Breeze API credentials and session token in Settings.', data: [] });
    }

    return reply.send(bars);
  });

  app.get('/search', async (request, reply) => {
    const query = request.query as { q?: string; limit?: string; exchange?: string };
    const q = (query.q ?? '').replace(/[^a-zA-Z0-9& ]/g, '').slice(0, 30);
    const limit = Math.min(Math.max(Number(query.limit) || 10, 1), 50);
    const results = await service.search(q, limit, query.exchange);
    return reply.send(results);
  });

  app.get('/indices', async (request, reply) => {
    const query = request.query as { exchange?: string };
    const indices = query.exchange
      ? await service.getIndicesForExchange(query.exchange)
      : await service.getIndices();
    return reply.send(indices);
  });

  app.get('/vix', async (_request, reply) => {
    const vix = await service.getVIX();
    return reply.send(vix);
  });

  app.get('/fii-dii', async (_request, reply) => {
    const data = await service.getFIIDII();
    return reply.send(data);
  });

  app.get('/options-chain/:symbol', async (request, reply) => {
    const sym = symbolParam.safeParse((request.params as any).symbol);
    if (!sym.success) return reply.code(400).send({ error: 'Invalid symbol' });
    try {
      const data = await service.getOptionsChain(sym.data);
      return reply.send(data);
    } catch {
      return reply.send({ symbol: sym.data, expiry: '', strikes: [], message: 'Options data temporarily unavailable' });
    }
  });

  app.get('/market-depth/:symbol', async (request, reply) => {
    const sym = symbolParam.safeParse((request.params as any).symbol);
    if (!sym.success) return reply.code(400).send({ error: 'Invalid symbol' });
    return reply.send({ symbol: sym.data, bids: [], asks: [] });
  });
}
