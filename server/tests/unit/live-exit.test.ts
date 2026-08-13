/**
 * LIVE-mode position exit.
 *
 * `closePosition` is pure bookkeeping — it writes an Order row, marks it FILLED
 * and moves NAV, without ever contacting the broker. In LIVE mode that meant
 * closing a position updated our records and left the position wide open at the
 * broker, invisible until EOD reconciliation.
 *
 * The rules pinned here:
 *   - a definite broker rejection restores the position to OPEN and books nothing
 *   - an indeterminate outcome (timeout, partial-then-terminated) leaves the
 *     position in CLOSING and books nothing, because an order may still be live
 *   - the broker's actual fill price drives the books, not the caller's estimate
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: vi.fn().mockImplementation(() => ({ isMarketOpen: vi.fn().mockReturnValue(true) })),
}));
vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({ getQuote: vi.fn().mockResolvedValue({ ltp: 2500 }) })),
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

const POSITION = {
  id: 'pos-1', portfolioId: 'p1', symbol: 'RELIANCE', exchange: 'NSE',
  side: 'LONG', qty: 100, avgEntryPrice: 2400, status: 'OPEN',
  instrumentToken: 'RELIANCE', openedAt: new Date(),
  portfolio: { id: 'p1', userId: 'user1', currentNav: 1_000_000, initialCapital: 1_000_000 },
};

function makePrisma() {
  const orderState = { qty: 100, filledQty: 0, status: 'PENDING', avgFillPrice: null as number | null };
  const prisma: any = {
    position: {
      findUnique: vi.fn().mockResolvedValue(POSITION),
      findFirst: vi.fn().mockResolvedValue(null),
      findMany: vi.fn().mockResolvedValue([]),
      update: vi.fn().mockResolvedValue({}),
      updateMany: vi.fn().mockResolvedValue({ count: 1 }),
      count: vi.fn().mockResolvedValue(0),
      create: vi.fn().mockResolvedValue({}),
    },
    portfolio: {
      findUnique: vi.fn().mockResolvedValue(POSITION.portfolio),
      findMany: vi.fn().mockResolvedValue([POSITION.portfolio]),
      update: vi.fn().mockResolvedValue({}),
    },
    // The OMS enforces a state machine (PENDING -> SUBMITTED -> FILLED) and
    // re-reads the order before each transition, so the mock has to remember
    // what it last wrote rather than always replying PENDING.
    order: {
      create: vi.fn().mockImplementation(async () => { orderState.status = 'PENDING'; return { id: 'o1', ...orderState }; }),
      update: vi.fn().mockImplementation(async ({ data }: any) => {
        if (data?.status) orderState.status = data.status;
        if (data?.filledQty !== undefined) orderState.filledQty = data.filledQty;
        return { id: 'o1', ...orderState };
      }),
      findUnique: vi.fn().mockImplementation(async () => ({ id: 'o1', ...orderState })),
      findMany: vi.fn().mockResolvedValue([]),
    },
    trade: { create: vi.fn().mockResolvedValue({ id: 't1', netPnl: 100 }), findMany: vi.fn().mockResolvedValue([]) },
    $transaction: vi.fn().mockImplementation(async (fn: any) => fn(prisma)),
  };
  return prisma;
}

/** A TradeService forced into LIVE mode with a stub broker. */
function liveService(prisma: any, broker: any) {
  const svc = new TradeService(prisma);
  (svc as any).broker = broker;
  vi.spyOn(svc, 'isLiveMode').mockReturnValue(true);
  // Protective-stop cancellation is exercised in broker-stop-loss.test.ts
  (svc as any).brokerStops = { cancelStop: vi.fn().mockResolvedValue(true), isEnabled: () => true };
  return svc;
}

describe('closePosition in LIVE mode', () => {
  let prisma: any;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    prisma = makePrisma();
  });

  it('sends a market exit on the opposite side and books the broker fill price', async () => {
    const broker = {
      placeOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'PLACED' }),
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'FILLED', filledQty: 100, avgPrice: 2455.5 }),
    };
    const svc = liveService(prisma, broker);

    // Caller's estimate is 2500; the broker actually filled at 2455.50
    await svc.closePosition('pos-1', 'user1', 2500);

    expect(broker.placeOrder).toHaveBeenCalledWith(expect.objectContaining({
      symbol: 'RELIANCE', side: 'SELL', orderType: 'MARKET', qty: 100,
    }));
    // The books must use what actually happened, not the estimate
    const tradeArgs = prisma.trade.create.mock.calls[0][0].data;
    expect(Number(tradeArgs.exitPrice)).toBe(2455.5);
  });

  it('exits a SHORT with a BUY', async () => {
    prisma.position.findUnique.mockResolvedValue({ ...POSITION, side: 'SHORT' });
    const broker = {
      placeOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'PLACED' }),
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'FILLED', filledQty: 100, avgPrice: 2350 }),
    };
    const svc = liveService(prisma, broker);

    await svc.closePosition('pos-1', 'user1', 2350);

    expect(broker.placeOrder).toHaveBeenCalledWith(expect.objectContaining({ side: 'BUY' }));
  });

  it('restores the position to OPEN and books NOTHING when the broker rejects', async () => {
    const broker = {
      placeOrder: vi.fn().mockResolvedValue({ orderId: '', status: 'FAILED', message: 'insufficient holdings' }),
      getOrderStatus: vi.fn(),
    };
    const svc = liveService(prisma, broker);

    await expect(svc.closePosition('pos-1', 'user1', 2500)).rejects.toThrow(TradeError);

    // No trade, no NAV movement
    expect(prisma.trade.create).not.toHaveBeenCalled();
    // Position put back so it stays visible, protected and counted by risk
    const restore = prisma.position.updateMany.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'OPEN',
    );
    expect(restore).toBeDefined();
  });

  it('leaves the position CLOSING and books nothing when the outcome is unknown', async () => {
    vi.useFakeTimers();
    const broker = {
      placeOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'PLACED' }),
      // Never reaches a terminal state
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'SUBMITTED', filledQty: 0, avgPrice: 0 }),
    };
    const svc = liveService(prisma, broker);

    const promise = svc.closePosition('pos-1', 'user1', 2500).catch((e: TradeError) => e);
    // 30 polls x 2s, so 70s covers the whole budget without runAllTimersAsync
    // tripping its infinite-loop guard on the poll chain.
    await vi.advanceTimersByTimeAsync(70_000);
    const err = await promise as TradeError;
    vi.useRealTimers();

    expect(err).toBeInstanceOf(TradeError);
    expect(err.statusCode).toBe(504);
    expect(prisma.trade.create).not.toHaveBeenCalled();
    // Must NOT be restored to OPEN — an order may still be live at the broker,
    // and re-entering or re-exiting would double up.
    const restore = prisma.position.updateMany.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'OPEN',
    );
    expect(restore).toBeUndefined();
  });

  it('treats a partial fill that then terminated as indeterminate, not success', async () => {
    const broker = {
      placeOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'PLACED' }),
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'CANCELLED', filledQty: 40, avgPrice: 2450 }),
    };
    const svc = liveService(prisma, broker);

    const err = await svc.closePosition('pos-1', 'user1', 2500).catch((e: TradeError) => e) as TradeError;

    expect(err.statusCode).toBe(504);
    expect(err.message).toMatch(/partial fill of 40\/100/);
    expect(prisma.trade.create).not.toHaveBeenCalled();
  });

  it('treats a clean rejection with nothing filled as recoverable (502)', async () => {
    const broker = {
      placeOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'PLACED' }),
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'REJECTED', filledQty: 0, avgPrice: 0, message: 'price band' }),
    };
    const svc = liveService(prisma, broker);

    const err = await svc.closePosition('pos-1', 'user1', 2500).catch((e: TradeError) => e) as TradeError;

    expect(err.statusCode).toBe(502);
    const restore = prisma.position.updateMany.mock.calls.find(
      (c: any[]) => c[0]?.data?.status === 'OPEN',
    );
    expect(restore).toBeDefined();
  });

  it('cancels the resting protective stop before exiting, to avoid a double exit', async () => {
    const broker = {
      placeOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'PLACED' }),
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'FILLED', filledQty: 100, avgPrice: 2455 }),
    };
    const svc = liveService(prisma, broker);

    await svc.closePosition('pos-1', 'user1', 2500);

    const stops = (svc as any).brokerStops;
    expect(stops.cancelStop).toHaveBeenCalledWith('pos-1');
    // ...and before the order went out
    expect(stops.cancelStop.mock.invocationCallOrder[0])
      .toBeLessThan(broker.placeOrder.mock.invocationCallOrder[0]);
  });
});

describe('closePosition in PAPER mode', () => {
  it('never contacts a broker', async () => {
    vi.clearAllMocks();
    const prisma = makePrisma();
    const svc = new TradeService(prisma);
    const broker = { placeOrder: vi.fn(), getOrderStatus: vi.fn() };
    (svc as any).broker = broker;
    // isLiveMode() is false by default (TRADING_MODE is PAPER in tests)

    await svc.closePosition('pos-1', 'user1', 2500);

    expect(broker.placeOrder).not.toHaveBeenCalled();
    expect(prisma.trade.create).toHaveBeenCalled();
  });
});
