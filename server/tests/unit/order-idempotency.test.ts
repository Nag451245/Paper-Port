/**
 * Order idempotency.
 *
 * Without a key, every retry is a new live order: a client timeout followed by
 * a retry, a proxy replay, or a bot cycle re-firing the same signal each place a
 * second real order at the broker. The per-symbol Redis lock only serialises
 * concurrent calls — it does not deduplicate them.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: vi.fn().mockImplementation(function () { return { isMarketOpen: vi.fn().mockReturnValue(true) }; }),
}));
vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(function () { return { getQuote: vi.fn().mockResolvedValue({ ltp: 2500 }) }; }),
}));
vi.mock('../../src/lib/redis.js', () => ({ getRedis: vi.fn().mockReturnValue(null) }));
vi.mock('../../src/lib/event-bus.js', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/lib/websocket.js', () => ({
  wsHub: { broadcastTradeExecution: vi.fn(), broadcastPriceUpdate: vi.fn(), getSubscribedSymbols: vi.fn().mockReturnValue([]) },
}));
vi.mock('../../src/lib/logger.js', () => ({
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  }),
}));
vi.mock('../../src/lib/rust-engine.js', () => ({
  isKillSwitchActive: vi.fn().mockResolvedValue(false),
  isEngineAvailable: vi.fn().mockReturnValue(false),
}));

import { TradeService, TradeError } from '../../src/services/trade.service.js';

const PORTFOLIO = { id: 'p1', userId: 'user1', currentNav: 1_000_000, initialCapital: 1_000_000 };

/** In-memory order table that honours the unique constraint on clientOrderId. */
function makePrisma() {
  const orders = new Map<string, any>();
  let seq = 0;

  const prisma: any = {
    _orders: orders,
    portfolio: {
      findUnique: vi.fn().mockResolvedValue(PORTFOLIO),
      findMany: vi.fn().mockResolvedValue([PORTFOLIO]),
      update: vi.fn().mockResolvedValue({}),
    },
    order: {
      create: vi.fn().mockImplementation(async ({ data }: any) => {
        if (data.clientOrderId) {
          for (const o of orders.values()) {
            if (o.clientOrderId === data.clientOrderId) {
              const err: any = new Error('Unique constraint failed');
              err.code = 'P2002';
              throw err;
            }
          }
        }
        const row = { id: `o${++seq}`, ...data };
        orders.set(row.id, row);
        return row;
      }),
      update: vi.fn().mockImplementation(async ({ where, data }: any) => {
        const row = { ...orders.get(where.id), ...data };
        orders.set(where.id, row);
        return row;
      }),
      findUnique: vi.fn().mockImplementation(async ({ where }: any) => {
        if (where.clientOrderId) {
          for (const o of orders.values()) {
            if (o.clientOrderId === where.clientOrderId) return { ...o, portfolio: { userId: 'user1' } };
          }
          return null;
        }
        return orders.get(where.id) ?? null;
      }),
      findMany: vi.fn().mockResolvedValue([]),
    },
    position: {
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      create: vi.fn().mockResolvedValue({ id: 'pos1' }),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
    },
    trade: { create: vi.fn().mockResolvedValue({ id: 't1', netPnl: 0 }), findMany: vi.fn().mockResolvedValue([]) },
    tradingTarget: { findFirst: vi.fn().mockResolvedValue(null) },
    dailyPnlRecord: { findMany: vi.fn().mockResolvedValue([]) },
    riskEvent: { create: vi.fn().mockResolvedValue({}) },
    strategyParam: { findFirst: vi.fn().mockResolvedValue(null) },
    $transaction: vi.fn().mockImplementation(async (fn: any) => fn(prisma)),
  };
  return prisma;
}

const ORDER = {
  portfolioId: 'p1', symbol: 'RELIANCE', side: 'BUY',
  orderType: 'MARKET', qty: 10, instrumentToken: 'RELIANCE',
} as any;

describe('order idempotency', () => {
  let prisma: any;
  let svc: TradeService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = makePrisma();
    svc = new TradeService(prisma);
  });

  it('places a second order when no key is supplied (unchanged behaviour)', async () => {
    await svc.placeOrder('user1', ORDER);
    await svc.placeOrder('user1', ORDER);

    const created = [...prisma._orders.values()];
    expect(created).toHaveLength(2);
  });

  it('returns the original order on a sequential retry with the same key', async () => {
    const key = 'idem-key-0001';
    const first = await svc.placeOrder('user1', { ...ORDER, clientOrderId: key });
    const second = await svc.placeOrder('user1', { ...ORDER, clientOrderId: key });

    expect((second as any).id).toBe((first as any).id);
    expect((second as any).idempotentReplay).toBe(true);
    // Exactly one order exists — the retry did not reach the broker
    expect([...prisma._orders.values()]).toHaveLength(1);
  });

  it('lets only one of two CONCURRENT calls through', async () => {
    // The realistic case: a client times out and retries while the first is
    // still in flight, so the initial lookup finds nothing for either.
    const key = 'idem-key-race';
    const [a, b] = await Promise.all([
      svc.placeOrder('user1', { ...ORDER, clientOrderId: key }),
      svc.placeOrder('user1', { ...ORDER, clientOrderId: key }),
    ]);

    expect((a as any).id).toBe((b as any).id);
    const withKey = [...prisma._orders.values()].filter(o => o.clientOrderId === key);
    expect(withKey).toHaveLength(1);
  });

  it('treats different keys as different orders', async () => {
    await svc.placeOrder('user1', { ...ORDER, clientOrderId: 'key-a' });
    await svc.placeOrder('user1', { ...ORDER, clientOrderId: 'key-b' });

    expect([...prisma._orders.values()]).toHaveLength(2);
  });

  it('refuses to leak another account\'s order through its key', async () => {
    await svc.placeOrder('user1', { ...ORDER, clientOrderId: 'shared-key' });

    await expect(svc.placeOrder('user2', { ...ORDER, clientOrderId: 'shared-key' }))
      .rejects.toThrow(/another account/i);
  });

  it('marks an abandoned reservation REJECTED so the matcher cannot fill it', async () => {
    // matchPendingOrders sweeps every PENDING order; a reservation left behind
    // by a rejected placement would be filled later as a real trade.
    const key = 'idem-key-rejected';
    prisma.portfolio.findMany.mockRejectedValue(new Error('db down')); // trips the fail-closed risk gate

    await expect(svc.placeOrder('user1', { ...ORDER, clientOrderId: key })).rejects.toThrow(TradeError);

    const reservation = [...prisma._orders.values()].find(o => o.clientOrderId === key);
    expect(reservation).toBeDefined();
    expect(reservation.status).toBe('REJECTED');
  });

  it('reserves the key BEFORE the order is priced or risk-checked', async () => {
    // The reservation must precede any broker interaction, or two concurrent
    // LIVE calls would both send an order before either wrote its row.
    const key = 'idem-key-order';
    await svc.placeOrder('user1', { ...ORDER, clientOrderId: key });

    const firstCreate = prisma.order.create.mock.calls[0][0].data;
    expect(firstCreate.clientOrderId).toBe(key);
    expect(firstCreate.status).toBe('PENDING');
    // The reservation carries no fill data — that arrives via the later update
    expect(firstCreate.avgFillPrice).toBeUndefined();
    expect(prisma.order.update).toHaveBeenCalled();
  });
});
