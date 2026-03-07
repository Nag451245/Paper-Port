import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TradeService, TradeError } from '../services/trade.service.js';
import { ExitCoordinator } from '../services/exit-coordinator.service.js';
import { DecisionAuditService } from '../services/decision-audit.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';

const placeOrderSchema = z.object({
  portfolio_id: z.string().uuid(),
  symbol: z.string().min(1),
  side: z.enum(['BUY', 'SELL']),
  order_type: z.enum(['MARKET', 'LIMIT', 'SL_M', 'SL_LIMIT', 'BRACKET', 'COVER', 'GTC', 'AMO']).default('MARKET'),
  qty: z.number().int().positive(),
  price: z.number().positive().optional(),
  trigger_price: z.number().positive().optional(),
  instrument_token: z.string().default(''),
  exchange: z.enum(['NSE', 'BSE', 'MCX', 'CDS']).default('NSE'),
  strategy_tag: z.string().optional(),
});

const closePositionSchema = z.object({
  exit_price: z.number().positive(),
});

export async function tradeRoutes(app: FastifyInstance): Promise<void> {
  const service = new TradeService(getPrisma());

  app.addHook('preHandler', authenticate);

  app.post('/orders', async (request, reply) => {
    const parsed = placeOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const order = await service.placeOrder(userId, {
        portfolioId: parsed.data.portfolio_id,
        symbol: parsed.data.symbol,
        side: parsed.data.side,
        orderType: parsed.data.order_type,
        qty: parsed.data.qty,
        price: parsed.data.price,
        triggerPrice: parsed.data.trigger_price,
        instrumentToken: parsed.data.instrument_token,
        exchange: parsed.data.exchange,
        strategyTag: parsed.data.strategy_tag,
      });
      return reply.code(201).send(order);
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/orders', async (request, reply) => {
    const query = request.query as { status?: string; page?: string; limit?: string };
    const userId = getUserId(request);
    const result = await service.listOrders(userId, {
      status: query.status,
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
    });
    return reply.send(result);
  });

  app.get('/orders/:orderId', async (request, reply) => {
    try {
      const { orderId } = request.params as { orderId: string };
      const userId = getUserId(request);
      const order = await service.getOrder(orderId, userId);
      return reply.send(order);
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // Modify a pending order (price, qty, trigger)
  app.put('/orders/:orderId', async (request, reply) => {
    const modifySchema = z.object({
      price: z.number().positive().optional(),
      trigger_price: z.number().positive().optional(),
      qty: z.number().int().positive().optional(),
    });

    const parsed = modifySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { orderId } = request.params as { orderId: string };
      const userId = getUserId(request);
      const prisma = getPrisma();

      const order = await prisma.order.findUnique({ where: { id: orderId } });
      if (!order) return reply.code(404).send({ error: 'Order not found' });

      const portfolio = await prisma.portfolio.findUnique({ where: { id: order.portfolioId } });
      if (!portfolio || portfolio.userId !== userId) {
        return reply.code(403).send({ error: 'Not authorized' });
      }

      if (order.status !== 'PENDING') {
        return reply.code(400).send({ error: `Cannot modify order in ${order.status} status` });
      }

      const updated = await prisma.order.update({
        where: { id: orderId },
        data: {
          price: parsed.data.price ?? order.price,
          triggerPrice: parsed.data.trigger_price ?? order.triggerPrice,
          qty: parsed.data.qty ?? order.qty,
        },
      });

      return reply.send(updated);
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/orders/:orderId', async (request, reply) => {
    try {
      const { orderId } = request.params as { orderId: string };
      const userId = getUserId(request);
      const order = await service.cancelOrder(orderId, userId);
      return reply.send(order);
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/positions', async (request, reply) => {
    const userId = getUserId(request);
    const query = request.query as { strategy_tag?: string };
    const positions = await service.listPositions(userId, query.strategy_tag);
    return reply.send(positions);
  });

  app.get('/strategies', async (request, reply) => {
    const userId = getUserId(request);
    const strategies = await service.listActiveStrategies(userId);
    return reply.send(strategies);
  });

  app.post('/strategies/exit-legs', async (request, reply) => {
    const exitSchema = z.object({
      position_ids: z.array(z.string().uuid()).min(1).max(20),
    });

    const parsed = exitSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const result = await service.exitStrategyLegs(userId, parsed.data.position_ids);
      return reply.send(result);
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/strategies/exit-all', async (request, reply) => {
    const exitAllSchema = z.object({
      strategy_tag: z.string().min(1),
    });

    const parsed = exitAllSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const positions = await service.listPositions(userId, parsed.data.strategy_tag);
      if (positions.length === 0) {
        return reply.code(404).send({ error: 'No open positions for this strategy' });
      }
      const positionIds = positions.map(p => p.id);
      const result = await service.exitStrategyLegs(userId, positionIds);
      return reply.send({ ...result, strategyTag: parsed.data.strategy_tag });
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/positions/:positionId', async (request, reply) => {
    try {
      const { positionId } = request.params as { positionId: string };
      const userId = getUserId(request);
      const position = await service.getPosition(positionId, userId);
      return reply.send(position);
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/positions/:positionId/close', async (request, reply) => {
    const parsed = closePositionSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { positionId } = request.params as { positionId: string };
      const userId = getUserId(request);
      const prisma = getPrisma();
      const result = await ExitCoordinator.closePosition({
        positionId,
        userId,
        exitPrice: parsed.data.exit_price,
        reason: 'Manual close via API',
        source: 'MANUAL_API',
        decisionType: 'POSITION_CLOSED',
        prisma,
        tradeService: service,
        decisionAudit: new DecisionAuditService(prisma),
      });
      if (!result.success) {
        return reply.code(result.alreadyClosing ? 409 : 400).send({ error: result.error });
      }
      return reply.send({ success: true, pnl: result.pnl });
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  // Execute a multi-leg options strategy
  app.post('/execute-strategy', async (request, reply) => {
    const strategySchema = z.object({
      portfolio_id: z.string().uuid(),
      symbol: z.string().min(1),
      expiry: z.string().min(1),
      strategy_name: z.string().optional(),
      legs: z.array(z.object({
        type: z.enum(['CE', 'PE']),
        strike: z.number().positive(),
        action: z.enum(['BUY', 'SELL']),
        qty: z.number().int().positive(),
        premium: z.number().min(0).optional(),
      })).min(1).max(10),
    });

    const parsed = strategySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const { portfolio_id, symbol, expiry, strategy_name, legs } = parsed.data;
      const tag = strategy_name ? `STRAT:${strategy_name}` : 'STRATEGY';

      const results: { leg: number; order: any; error?: string }[] = [];

      for (let i = 0; i < legs.length; i++) {
        const leg = legs[i];
        const optSymbol = `${symbol}${expiry.replace(/-/g, '')}${leg.strike}${leg.type}`;
        try {
          const order = await service.placeOrder(userId, {
            portfolioId: portfolio_id,
            symbol: optSymbol,
            side: leg.action,
            orderType: 'MARKET',
            qty: leg.qty,
            price: leg.premium && leg.premium > 0 ? leg.premium : undefined,
            instrumentToken: `${symbol}-NFO-${leg.strike}-${leg.type}`,
            exchange: 'NFO',
            strategyTag: tag,
          });
          results.push({ leg: i + 1, order });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ leg: i + 1, order: null, error: msg });
        }
      }

      const filled = results.filter(r => r.order?.status === 'FILLED').length;
      const pending = results.filter(r => r.order?.status === 'PENDING').length;
      const failed = results.filter(r => r.error).length;

      return reply.code(201).send({
        strategy: strategy_name || 'Custom',
        symbol,
        expiry,
        totalLegs: legs.length,
        filled,
        pending,
        failed,
        results,
      });
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/trades', async (request, reply) => {
    const query = request.query as { page?: string; limit?: string; from_date?: string; to_date?: string; symbol?: string };
    const userId = getUserId(request);
    const result = await service.listTrades(userId, {
      page: query.page ? Number(query.page) : undefined,
      limit: query.limit ? Number(query.limit) : undefined,
      fromDate: query.from_date,
      toDate: query.to_date,
      symbol: query.symbol,
    });
    return reply.send(result);
  });

  app.get('/trades/:tradeId', async (request, reply) => {
    try {
      const { tradeId } = request.params as { tradeId: string };
      const userId = getUserId(request);
      const trade = await service.getTrade(tradeId, userId);
      return reply.send(trade);
    } catch (err) {
      if (err instanceof TradeError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });
}
