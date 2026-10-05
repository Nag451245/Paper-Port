import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { TradeService, TradeError } from '../services/trade.service.js';
import { ExitCoordinator } from '../services/exit-coordinator.service.js';
import { DecisionAuditService } from '../services/decision-audit.service.js';
import { OrderManagementService } from '../services/oms.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { buildOptionSymbol } from '../lib/instrument.js';
import { MarketDataService } from '../services/market-data.service.js';
import { StrategyExitPlanService } from '../services/strategy-exit-plan.service.js';
import { ValuationService } from '../services/valuation.service.js';
import { buildStrategyCard, isDerivativeGroup } from '../lib/strategy-book.js';
import { isUserPlaced } from '../lib/order-source.js';

const placeOrderSchema = z.object({
  portfolio_id: z.string().uuid(),
  symbol: z.string().min(1).max(60).regex(/^[A-Za-z0-9&._ -]+$/, 'Invalid symbol'),
  side: z.enum(['BUY', 'SELL']),
  order_type: z.enum(['MARKET', 'LIMIT', 'SL_M', 'SL_LIMIT', 'BRACKET', 'COVER', 'GTC', 'AMO']).default('MARKET'),
  qty: z.number().int().positive(),
  price: z.number().positive().optional(),
  trigger_price: z.number().positive().optional(),
  instrument_token: z.string().default(''),
  exchange: z.enum(['NSE', 'BSE', 'NFO', 'MCX', 'CDS']).default('NSE'),
  strategy_tag: z.string().optional(),
  /** Idempotency key; the Idempotency-Key header takes precedence. */
  client_order_id: z.string().min(8).max(128).optional(),
  expiry: z.string().optional(),
  strike: z.number().positive().optional(),
  option_type: z.enum(['CE', 'PE']).optional(),
});

const closePositionSchema = z.object({
  // Ignored: the server prices the exit itself. Kept so older clients still validate.
  exit_price: z.number().positive().optional(),
});

export async function tradeRoutes(app: FastifyInstance): Promise<void> {
  const oms = (app as any).oms as OrderManagementService | undefined;
  const service = new TradeService(getPrisma(), oms ?? undefined);
  const quotes = new MarketDataService();
  const exitPlans = new StrategyExitPlanService(getPrisma(), (sym, ex) => quotes.getQuote(sym, ex));

  app.addHook('preHandler', authenticate);

  app.post('/orders', async (request, reply) => {
    const parsed = placeOrderSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      // Idempotency-Key header (standard) or client_order_id in the body.
      // Retrying with the same key returns the original order rather than
      // placing a second one.
      const idempotencyKey =
        (request.headers['idempotency-key'] as string | undefined)?.trim() ||
        parsed.data.client_order_id;

      const order = await service.placeOrder(userId, {
        clientOrderId: idempotencyKey || undefined,
        portfolioId: parsed.data.portfolio_id,
        symbol: parsed.data.symbol,
        side: parsed.data.side,
        orderType: parsed.data.order_type,
        qty: parsed.data.qty,
        // A market order fills at the market: a price sent with it is ignored,
        // or anyone could fill a paper trade at a price of their choosing.
        price: parsed.data.order_type === 'MARKET' ? undefined : parsed.data.price,
        triggerPrice: parsed.data.trigger_price,
        instrumentToken: parsed.data.instrument_token,
        exchange: parsed.data.exchange,
        strategyTag: parsed.data.strategy_tag,
        expiry: parsed.data.expiry,
        strike: parsed.data.strike,
        optionType: parsed.data.option_type,
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

      if (order.status !== 'PENDING' && order.status !== 'SUBMITTED') {
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
    // Each row carries the price and gain or loss from the one valuation the
    // Dashboard and Risk page use, so the rows add up to the totals shown there.
    const live = (app as any).priceFeedService?.getAllLastPrices?.() ?? {};
    const valued = await new ValuationService(getPrisma()).forUser(userId, live).catch(() => null);
    const byId = new Map((valued?.positions ?? []).map((p) => [p.id, p]));
    return reply.send(positions.map((p) => {
      const v = byId.get(p.id);
      return v ? { ...p, lastPrice: v.price, unrealizedPnl: v.pnl, priceSource: v.priceSource, capitalInUse: v.capitalInUse } : p;
    }));
  });

  app.get('/strategies', async (request, reply) => {
    const userId = getUserId(request);
    const strategies = await service.listActiveStrategies(userId);
    // P&L after charges paid and the cost of closing now, and any automatic exit.
    const plans = new Map((await exitPlans.plansFor(userId)).filter(p => p.status === 'ACTIVE').map(p => [p.strategyTag, p]));
    const withNet = await Promise.all(strategies.map(async (s) => {
      const pnl = await exitPlans.pnl(userId, s.strategyTag).catch(() => null);
      const plan = plans.get(s.strategyTag);
      return {
        ...s,
        netPnl: pnl?.netPnl ?? null, chargesPaid: pnl?.chargesPaid ?? null, exitChargesEstimate: pnl?.exitChargesEstimate ?? null,
        exitPlan: plan ? { target: plan.targetRupees, stop: plan.stopRupees, exitAt: plan.exitAt } : null,
      };
    }));
    return reply.send(withNet);
  });

  // ── My Strategies: open option/futures strategies with payoff, Greeks and a reading ──
  const legSchema = z.object({
    type: z.enum(['CE', 'PE']), strike: z.number().positive(), action: z.enum(['BUY', 'SELL']),
    qty: z.number().int().positive(), premium: z.number().min(0),
  });

  const strategyBook = async (userId: string, live: Record<string, number>, only?: string, extra?: z.infer<typeof legSchema>[]) => {
    const groups = (await service.listActiveStrategies(userId))
      .filter((g) => isDerivativeGroup(g.legs as any) && (!only || g.strategyTag === only));
    if (groups.length === 0) return [];
    const valued = await new ValuationService(getPrisma()).forUser(userId, live).catch(() => null);
    const byId = new Map((valued?.positions ?? []).map((p) => [p.id, { price: p.price, pnl: p.pnl, priceSource: p.priceSource }]));
    const plans = new Map((await exitPlans.plansFor(userId)).filter((p) => p.status === 'ACTIVE').map((p) => [p.strategyTag, p]));
    // One spot lookup per underlying, however many strategies share it.
    const spots = new Map<string, Promise<number | null>>();
    const spotOf = (u: string | null) => {
      if (!u) return Promise.resolve(null);
      if (!spots.has(u)) spots.set(u, quotes.getQuote(u, 'NSE').then((q) => (Number(q.ltp) > 0 ? Number(q.ltp) : null)).catch(() => null));
      return spots.get(u)!;
    };
    return Promise.all(groups.map(async (g) => {
      const pnl = await exitPlans.pnl(userId, g.strategyTag).catch(() => null);
      const probe = buildStrategyCard({ strategyTag: g.strategyTag, positions: g.legs as any, valued: byId, spot: null });
      const card = buildStrategyCard({
        strategyTag: g.strategyTag, positions: g.legs as any, valued: byId,
        spot: await spotOf(probe.underlying), chargesPaid: pnl?.chargesPaid ?? 0, extra,
      });
      const plan = plans.get(g.strategyTag);
      return {
        ...card,
        // When the exit-plan pricing has no quote, fall back to the valuation's
        // prices (the ones in the leg table) rather than showing a false zero.
        netPnl: pnl?.priced ? pnl.netPnl : card.openPnl != null ? Math.round((card.openPnl - (pnl?.chargesPaid ?? 0)) * 100) / 100 : null,
        chargesPaid: pnl?.chargesPaid ?? null, exitChargesEstimate: pnl?.priced ? pnl.exitChargesEstimate : null,
        exitPlan: plan ? { target: plan.targetRupees, stop: plan.stopRupees, exitAt: plan.exitAt } : null,
      };
    }));
  };

  app.get('/strategy-book', async (request, reply) => {
    const live = (app as any).priceFeedService?.getAllLastPrices?.() ?? {};
    return reply.send(await strategyBook(getUserId(request), live));
  });

  // What the strategy would look like with more legs, before anything is placed.
  app.post('/strategy-book/preview', async (request, reply) => {
    const parsed = z.object({ strategy_tag: z.string().min(1), legs: z.array(legSchema).min(1).max(6) }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    const live = (app as any).priceFeedService?.getAllLastPrices?.() ?? {};
    const [card] = await strategyBook(getUserId(request), live, parsed.data.strategy_tag, parsed.data.legs);
    if (!card) return reply.code(404).send({ error: 'No open positions for this strategy' });
    return reply.send(card);
  });

  // Set or change the automatic exit of a strategy that is already open.
  app.put('/strategies/exit-plan', async (request, reply) => {
    const parsed = z.object({
      strategy_tag: z.string().min(1),
      target: z.number().positive().optional(),
      stop: z.number().positive().optional(),
      exit_at: z.string().datetime({ offset: true }).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    const { strategy_tag, target, stop, exit_at } = parsed.data;
    if (target == null && stop == null && !exit_at) return reply.code(400).send({ error: 'Give a target, a stop or an exit time.' });
    const userId = getUserId(request);
    if ((await service.listPositions(userId, strategy_tag)).length === 0) return reply.code(404).send({ error: 'No open positions for this strategy' });
    await exitPlans.setPlan(userId, strategy_tag, { target, stop, exitAt: exit_at ? new Date(exit_at) : undefined });
    return reply.send({ ok: true });
  });

  app.delete('/strategies/exit-plan', async (request, reply) => {
    const q = z.object({ strategy_tag: z.string().min(1) }).safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'strategy_tag is required' });
    await exitPlans.cancel(getUserId(request), q.data.strategy_tag);
    return reply.send({ ok: true });
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
      // The exit is priced here from a live quote, never from the browser (its
      // price can be minutes old, or typed in).
      const position = await prisma.position.findFirst({
        where: { id: positionId, portfolio: { userId } },
        select: { symbol: true, exchange: true },
      });
      if (!position) return reply.code(404).send({ error: 'Position not found' });
      const quote = await new MarketDataService().getQuote(position.symbol, position.exchange ?? 'NSE').catch(() => null);
      if (!quote || !(quote.ltp > 0)) {
        return reply.code(503).send({ error: `Could not get a live price for ${position.symbol}. Try again in a moment.` });
      }
      const result = await ExitCoordinator.closePosition({
        positionId,
        userId,
        exitPrice: quote.ltp,
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
      symbol: z.string().min(1).max(60).regex(/^[A-Za-z0-9&._ -]+$/, 'Invalid symbol'),
      expiry: z.string().min(1),
      strategy_name: z.string().optional(),
      /** Add these legs to a strategy that is already open (its tag), instead of starting a new one. */
      add_to: z.string().min(1).optional(),
      legs: z.array(z.object({
        type: z.enum(['CE', 'PE']),
        strike: z.number().positive(),
        action: z.enum(['BUY', 'SELL']),
        qty: z.number().int().positive(),
        premium: z.number().min(0).optional(),
      })).min(1).max(10),
      /** Close every leg automatically: P&L after charges reaches target / stop, or at exit_at. */
      exit_plan: z.object({
        target: z.number().positive().optional(),
        stop: z.number().positive().optional(),
        exit_at: z.string().datetime({ offset: true }).optional(),
      }).optional(),
    });

    const parsed = strategySchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const userId = getUserId(request);
      const { portfolio_id, symbol, expiry, strategy_name, legs } = parsed.data;
      // Each placement gets its own tag (name + time), so two straddles placed
      // the same day are tracked, charged and exited separately.
      const placedAt = new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false });
      let tag = `STRAT:${strategy_name || 'Custom'} · ${placedAt}`;
      const addTo = parsed.data.add_to;
      if (addTo) {
        // Only the user's own open strategy can be added to.
        if (!isUserPlaced(addTo) || (await service.listPositions(userId, addTo)).length === 0) {
          return reply.code(404).send({ error: 'That strategy is not open, or is not one you placed.' });
        }
        tag = addTo;
      }

      const results: { leg: number; order: any; error?: string }[] = [];

      // Buy the protecting legs first, as a trader would: a sold option placed
      // after its protection is margined as a spread, not as a naked sale.
      const order = legs.map((_, i) => i).sort((a, b) => Number(legs[a].action === 'SELL') - Number(legs[b].action === 'SELL'));
      for (const i of order) {
        const leg = legs[i];
        // Same grammar as before, but built by the shared helper so the format
        // lives in exactly one place.
        const optSymbol = buildOptionSymbol(symbol, expiry, leg.strike, leg.type);
        try {
          const order = await service.placeOrder(userId, {
            portfolioId: portfolio_id,
            symbol: optSymbol,
            side: leg.action,
            orderType: 'MARKET',
            qty: leg.qty,
            price: leg.premium && leg.premium > 0 ? leg.premium : undefined,
            instrumentToken: optSymbol,
            exchange: 'NFO',
            strategyTag: tag,
            expiry,
            strike: leg.strike,
            optionType: leg.type as 'CE' | 'PE',
          });
          results.push({ leg: i + 1, order });
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          results.push({ leg: i + 1, order: null, error: msg });
        }
      }
      results.sort((x, y) => x.leg - y.leg);                   // reported in the order the legs were given

      // A leg that came back REJECTED/CANCELLED without throwing is just as
      // absent from the structure as one that threw, so it counts against the
      // balance check too — otherwise a rejected wing reads as "not failed".
      const DEAD = new Set(['REJECTED', 'CANCELLED', 'EXPIRED', 'FAILED']);
      const filled = results.filter(r => r.order?.status === 'FILLED').length;
      const rejected = results.filter(r => r.order && DEAD.has(r.order.status)).length;
      const pending = results.filter(r => r.order && r.order.status !== 'FILLED' && !DEAD.has(r.order.status)).length;
      const failed = results.filter(r => r.error).length;

      // Legs that are working or done vs. legs that will never exist.
      const opened = filled + pending;
      const missing = failed + rejected;

      const payload = {
        strategy: strategy_name || 'Custom',
        symbol,
        expiry,
        totalLegs: legs.length,
        filled,
        pending,
        failed,
        rejected,
        results,
      };

      if (missing === 0) {
        const plan = parsed.data.exit_plan;
        if (plan) await exitPlans.setPlan(userId, tag, { target: plan.target, stop: plan.stop, exitAt: plan.exit_at ? new Date(plan.exit_at) : undefined });
        return reply.code(201).send({ ...payload, strategyTag: tag, exitPlan: plan ?? null, unbalanced: false });
      }

      // A partially-filled defined-risk structure is NOT a success. An iron
      // condor that places its two shorts and loses its two wings is a naked
      // strangle — bounded risk silently became unbounded — so this must not
      // come back as a 2xx a caller can read as a clean entry. Mirrors
      // BotEngine.executeMultiLegStrategy, which returns success:false here.
      const reasons = results.filter(r => r.error).map(r => `leg ${r.leg}: ${r.error}`);
      for (const r of results) {
        if (r.order && DEAD.has(r.order.status)) reasons.push(`leg ${r.leg}: ${r.order.status}`);
      }

      const error = opened > 0
        ? `${payload.strategy}: UNBALANCED — ${opened} of ${legs.length} legs open, ` +
          `${missing} not placed (${reasons.join('; ')}). Open legs need manual review.`
        : `${payload.strategy}: no legs were placed — ${missing} of ${legs.length} failed ` +
          `(${reasons.join('; ')}). Nothing is open.`;

      // 409: the resulting book conflicts with the structure that was asked for.
      // Distinguishable from 400 (bad request) and 500 (server fault); the body
      // still carries the full per-leg breakdown so a caller can reconcile.
      return reply.code(409).send({ ...payload, unbalanced: opened > 0, error });
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
