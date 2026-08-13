/**
 * Protective stop-loss resting at the broker.
 *
 * The software StopLossMonitor polls LTP and sends a market order on breach —
 * useless against a gap, and absent entirely while the process is restarting.
 * These tests pin the lifecycle of the broker-side order, with particular
 * attention to the two ways it loses money:
 *   - failing to place/refresh it, leaving a position unprotected;
 *   - leaving one resting after the position is gone, which later sells shares
 *     the account no longer holds.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/logger.js', () => ({
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  }),
}));

import { BrokerStopLossService, type StopIntent } from '../../src/services/broker-stop-loss.service.js';
import { createMockPrisma } from '../helpers/factories.js';

function makeBroker(overrides: Record<string, unknown> = {}) {
  return {
    name: 'mock',
    isConnected: vi.fn().mockReturnValue(true),
    connect: vi.fn().mockResolvedValue(undefined),
    placeOrder: vi.fn().mockResolvedValue({ orderId: 'B1', brokerOrderId: 'B1', status: 'PLACED' }),
    modifyOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'MODIFIED' }),
    cancelOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'CANCELLED' }),
    getOrderStatus: vi.fn().mockResolvedValue({ status: 'SUBMITTED', filledQty: 0, avgPrice: 0 }),
    ...overrides,
  } as any;
}

const intent = (over: Partial<StopIntent> = {}): StopIntent => ({
  positionId: 'pos-1',
  symbol: 'RELIANCE',
  exchange: 'NSE',
  side: 'LONG',
  qty: 100,
  triggerPrice: 2450,
  ...over,
});

describe('BrokerStopLossService — placement', () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    prisma.position.update.mockResolvedValue({});
  });

  it('is disabled — and a no-op — when there is no live broker', async () => {
    const svc = new BrokerStopLossService(prisma as any, null, { liveMode: true });
    expect(svc.isEnabled()).toBe(false);

    const result = await svc.syncStop(intent());
    expect(result.action).toBe('skipped');
    expect(prisma.position.update).not.toHaveBeenCalled();
  });

  it('is disabled in paper mode even though an adapter exists', async () => {
    const broker = makeBroker();
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: false });

    expect(svc.isEnabled()).toBe(false);
    expect((await svc.syncStop(intent())).action).toBe('skipped');
    expect(broker.placeOrder).not.toHaveBeenCalled();
    expect(broker.connect).not.toHaveBeenCalled();
  });

  it('connects its own adapter before placing — it does not assume someone else did', async () => {
    // Regression: getBrokerAdapter() returns a FRESH, unconnected adapter on
    // every call, and only TradeService connects its own instance. Gating on
    // isConnected() at construction would leave protective stops silently
    // disabled in LIVE mode — a safety feature that reports itself as off.
    let connected = false;
    const broker = makeBroker({
      isConnected: vi.fn(() => connected),
      connect: vi.fn().mockImplementation(async () => { connected = true; }),
    });
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ id: 'pos-1', status: 'OPEN', brokerStopOrderId: null });

    expect(svc.isEnabled()).toBe(true);
    const result = await svc.syncStop(intent());

    expect(broker.connect).toHaveBeenCalled();
    expect(result.action).toBe('placed');
  });

  it('skips placement rather than throwing when the broker will not connect', async () => {
    const broker = makeBroker({
      isConnected: vi.fn().mockReturnValue(false),
      connect: vi.fn().mockRejectedValue(new Error('bridge down')),
    });
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });

    const result = await svc.syncStop(intent());
    expect(result).toMatchObject({ action: 'skipped', reason: 'broker not connected' });
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });

  it('does not retry a failed connection on every single call', async () => {
    const broker = makeBroker({
      isConnected: vi.fn().mockReturnValue(false),
      connect: vi.fn().mockRejectedValue(new Error('bridge down')),
    });
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });

    // The 3s monitor loop would otherwise hammer a down bridge continuously
    await svc.syncStop(intent());
    await svc.syncStop(intent());
    await svc.syncStop(intent());

    expect(broker.connect).toHaveBeenCalledTimes(1);
  });

  it('protects a LONG with a SELL stop and a SHORT with a BUY stop', async () => {
    const broker = makeBroker();
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ id: 'pos-1', status: 'OPEN', brokerStopOrderId: null });

    await svc.syncStop(intent({ side: 'LONG' }));
    expect(broker.placeOrder.mock.calls[0][0]).toMatchObject({ side: 'SELL', orderType: 'SL_M', triggerPrice: 2450 });

    broker.placeOrder.mockClear();
    await svc.syncStop(intent({ side: 'SHORT' }));
    expect(broker.placeOrder.mock.calls[0][0]).toMatchObject({ side: 'BUY', orderType: 'SL_M' });
  });

  it('records the broker order id so the stop can be found again', async () => {
    const broker = makeBroker();
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ id: 'pos-1', status: 'OPEN', brokerStopOrderId: null });

    const result = await svc.syncStop(intent());

    expect(result).toMatchObject({ action: 'placed', brokerOrderId: 'B1' });
    expect(prisma.position.update.mock.calls[0][0].data).toMatchObject({
      brokerStopOrderId: 'B1', brokerStopTriggerPrice: 2450, brokerStopQty: 100,
    });
  });

  it('does not place a stop for a position that is not open', async () => {
    const broker = makeBroker();
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ id: 'pos-1', status: 'CLOSED', brokerStopOrderId: null });

    expect((await svc.syncStop(intent())).action).toBe('skipped');
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });

  it('rejects a nonsensical trigger or quantity rather than sending it to the broker', async () => {
    const broker = makeBroker();
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });

    for (const bad of [{ triggerPrice: 0 }, { triggerPrice: -5 }, { qty: 0 }, { qty: -1 }]) {
      expect((await svc.syncStop(intent(bad))).action).toBe('skipped');
    }
    expect(broker.placeOrder).not.toHaveBeenCalled();
  });

  it('reports failure — and does not record a handle — when the broker rejects', async () => {
    const broker = makeBroker({
      placeOrder: vi.fn().mockResolvedValue({ orderId: '', status: 'FAILED', message: 'insufficient margin' }),
    });
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ id: 'pos-1', status: 'OPEN', brokerStopOrderId: null });

    const result = await svc.syncStop(intent());

    expect(result.action).toBe('failed');
    expect(prisma.position.update).not.toHaveBeenCalled();
  });
});

describe('BrokerStopLossService — trailing the stop', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let broker: ReturnType<typeof makeBroker>;
  let svc: BrokerStopLossService;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    prisma.position.update.mockResolvedValue({});
    broker = makeBroker();
    svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({
      id: 'pos-1', status: 'OPEN',
      brokerStopOrderId: 'B1', brokerStopTriggerPrice: 2450, brokerStopQty: 100,
    });
  });

  it('does not touch the broker when the trigger has not moved', async () => {
    const result = await svc.syncStop(intent({ triggerPrice: 2450 }));
    expect(result.action).toBe('unchanged');
    expect(broker.modifyOrder).not.toHaveBeenCalled();
  });

  it('ignores sub-0.1% jitter so a 3s loop does not spam the broker', async () => {
    // 2450 -> 2451 is 0.04%
    const result = await svc.syncStop(intent({ triggerPrice: 2451 }));
    expect(result.action).toBe('unchanged');
    expect(broker.modifyOrder).not.toHaveBeenCalled();
  });

  it('modifies the resting order when the trail moves materially', async () => {
    const result = await svc.syncStop(intent({ triggerPrice: 2500 }));
    expect(result.action).toBe('modified');
    expect(broker.modifyOrder).toHaveBeenCalledWith('B1', { triggerPrice: 2500, qty: 100 });
  });

  it('resizes the stop when the position is partially closed', async () => {
    const result = await svc.syncStop(intent({ triggerPrice: 2450, qty: 40 }));
    expect(result.action).toBe('modified');
    expect(broker.modifyOrder).toHaveBeenCalledWith('B1', { triggerPrice: 2450, qty: 40 });
  });

  it('clears the handle when modify fails, so the next sync re-places the stop', async () => {
    // The resting order may have filled or been cancelled underneath us;
    // retrying modify forever would leave the position unprotected.
    broker.modifyOrder.mockResolvedValue({ orderId: 'B1', status: 'FAILED', message: 'order not found' });

    const result = await svc.syncStop(intent({ triggerPrice: 2500 }));

    expect(result.action).toBe('failed');
    expect(prisma.position.update.mock.calls[0][0].data).toMatchObject({ brokerStopOrderId: null });
  });
});

describe('BrokerStopLossService — cancellation and orphan safety', () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    prisma.position.update.mockResolvedValue({});
  });

  it('cancels the resting order and clears the handle', async () => {
    const broker = makeBroker();
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ brokerStopOrderId: 'B1' });

    expect(await svc.cancelStop('pos-1')).toBe(true);
    expect(broker.cancelOrder).toHaveBeenCalledWith('B1');
    expect(prisma.position.update.mock.calls[0][0].data).toMatchObject({ brokerStopOrderId: null });
  });

  it('is a no-op when no stop is resting', async () => {
    const broker = makeBroker();
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ brokerStopOrderId: null });

    expect(await svc.cancelStop('pos-1')).toBe(true);
    expect(broker.cancelOrder).not.toHaveBeenCalled();
  });

  it('treats an already-terminal order as successfully cancelled', async () => {
    const broker = makeBroker({
      cancelOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'FAILED', message: 'already filled' }),
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'FILLED', filledQty: 100, avgPrice: 2450 }),
    });
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ brokerStopOrderId: 'B1' });

    expect(await svc.cancelStop('pos-1')).toBe(true);
  });

  it('reports failure when cancel fails and the order is STILL resting', async () => {
    // This is the orphan case: returning true here would strand a live stop
    // order that later sells shares the account no longer holds.
    const broker = makeBroker({
      cancelOrder: vi.fn().mockResolvedValue({ orderId: 'B1', status: 'FAILED', message: 'network' }),
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'SUBMITTED', filledQty: 0, avgPrice: 0 }),
    });
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ brokerStopOrderId: 'B1' });

    expect(await svc.cancelStop('pos-1')).toBe(false);
    expect(prisma.position.update).not.toHaveBeenCalled();
  });

  it('refuses to silently drop a stop it cannot reach the broker to cancel', async () => {
    const svc = new BrokerStopLossService(prisma as any, null, { liveMode: true });
    prisma.position.findUnique.mockResolvedValue({ brokerStopOrderId: 'B1' });

    expect(await svc.cancelStop('pos-1')).toBe(false);
    expect(prisma.position.update).not.toHaveBeenCalled();
  });
});

describe('BrokerStopLossService — reconciliation', () => {
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    prisma.position.update.mockResolvedValue({});
  });

  it('detects a stop that fired at the broker while the DB still shows OPEN', async () => {
    const broker = makeBroker({
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'FILLED', filledQty: 100, avgPrice: 2450 }),
    });
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findMany.mockResolvedValue([
      { id: 'pos-1', status: 'OPEN', symbol: 'RELIANCE', qty: 100, brokerStopOrderId: 'B1' },
    ]);

    const result = await svc.reconcile();

    // Returns the fill detail the caller needs to book the close, not just an id
    expect(result.fired).toHaveLength(1);
    expect(result.fired[0]).toMatchObject({
      positionId: 'pos-1', brokerOrderId: 'B1', fillPrice: 2450, filledQty: 100,
    });
    // The stop is spent — the handle must be cleared so nothing tries to
    // cancel or modify an order that already executed.
    expect(prisma.position.update.mock.calls[0][0].data).toMatchObject({ brokerStopOrderId: null });
  });

  it('cancels an orphan left by a close path that bypassed this service', async () => {
    // Manual close, intraday square-off, capital recovery and the circuit
    // breaker all close positions without going through cancelStop.
    const broker = makeBroker();
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findMany.mockResolvedValue([
      { id: 'pos-9', status: 'CLOSED', symbol: 'TCS', qty: 0, brokerStopOrderId: 'B9' },
    ]);
    prisma.position.findUnique.mockResolvedValue({ brokerStopOrderId: 'B9' });

    const result = await svc.reconcile();
    expect(result.orphansCancelled).toEqual(['pos-9']);
    expect(broker.cancelOrder).toHaveBeenCalledWith('B9');
  });

  it('flags an open position whose stop is no longer resting, and clears the handle', async () => {
    const broker = makeBroker({
      getOrderStatus: vi.fn().mockResolvedValue({ status: 'CANCELLED', filledQty: 0, avgPrice: 0 }),
    });
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findMany.mockResolvedValue([
      { id: 'pos-1', status: 'OPEN', symbol: 'RELIANCE', qty: 100, brokerStopOrderId: 'B1' },
    ]);

    const result = await svc.reconcile();

    expect(result.unresolved).toEqual(['pos-1']);
    // Handle cleared so the next syncStop re-protects the position
    expect(prisma.position.update.mock.calls[0][0].data).toMatchObject({ brokerStopOrderId: null });
  });

  it('reports a position as unresolved rather than assuming it is fine when the broker is unreachable', async () => {
    const broker = makeBroker({
      getOrderStatus: vi.fn().mockRejectedValue(new Error('bridge down')),
    });
    const svc = new BrokerStopLossService(prisma as any, broker, { liveMode: true });
    prisma.position.findMany.mockResolvedValue([
      { id: 'pos-1', status: 'OPEN', symbol: 'RELIANCE', qty: 100, brokerStopOrderId: 'B1' },
    ]);

    const result = await svc.reconcile();
    expect(result.unresolved).toEqual(['pos-1']);
    expect(result.fired).toEqual([]);
  });

  it('does nothing when disabled', async () => {
    const svc = new BrokerStopLossService(prisma as any, null, { liveMode: true });
    const result = await svc.reconcile();
    expect(result).toEqual({ fired: [], orphansCancelled: [], unresolved: [] });
    expect(prisma.position.findMany).not.toHaveBeenCalled();
  });
});
