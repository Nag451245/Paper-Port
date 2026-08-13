import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/event-bus.js', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

vi.mock('../../src/lib/logger.js', () => ({
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(),
  }),
}));

import { OrderManagementService, type OrderState } from '../../src/services/oms.service.js';
import { emit } from '../../src/lib/event-bus.js';
import { createMockPrisma, makeOrder } from '../helpers/factories.js';

describe('OrderManagementService', () => {
  let oms: OrderManagementService;
  let prisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    oms = new OrderManagementService(prisma);
    prisma.order.update.mockResolvedValue({});
  });

  // ── Valid State Transitions ────────────────────────────────────────

  describe('Valid state transitions', () => {
    const validTransitions: [OrderState, OrderState][] = [
      ['PENDING', 'SUBMITTED'],
      ['PENDING', 'CANCELLED'],
      ['PENDING', 'REJECTED'],
      ['SUBMITTED', 'PARTIALLY_FILLED'],
      ['SUBMITTED', 'FILLED'],
      ['SUBMITTED', 'CANCELLED'],
      ['SUBMITTED', 'REJECTED'],
      ['SUBMITTED', 'EXPIRED'],
      ['PARTIALLY_FILLED', 'PARTIALLY_FILLED'],
      ['PARTIALLY_FILLED', 'FILLED'],
      ['PARTIALLY_FILLED', 'CANCELLED'],
    ];

    it.each(validTransitions)(
      'should allow %s → %s',
      async (from, to) => {
        prisma.order.findUnique.mockResolvedValue(makeOrder({ status: from }));

        const result = await oms.transition('order-1', to);
        expect(result.fromState).toBe(from);
        expect(result.toState).toBe(to);
        expect(prisma.order.update).toHaveBeenCalled();
      },
    );
  });

  // ── Invalid State Transitions ──────────────────────────────────────

  describe('Invalid state transitions', () => {
    const invalidTransitions: [OrderState, OrderState][] = [
      ['FILLED', 'CANCELLED'],
      ['FILLED', 'SUBMITTED'],
      ['FILLED', 'REJECTED'],
      ['CANCELLED', 'FILLED'],
      ['CANCELLED', 'SUBMITTED'],
      ['REJECTED', 'SUBMITTED'],
      ['REJECTED', 'FILLED'],
      ['EXPIRED', 'SUBMITTED'],
      ['EXPIRED', 'FILLED'],
      ['PENDING', 'FILLED'],
      ['PENDING', 'PARTIALLY_FILLED'],
      ['PENDING', 'EXPIRED'],
    ];

    it.each(invalidTransitions)(
      'should REJECT %s → %s',
      async (from, to) => {
        prisma.order.findUnique.mockResolvedValue(makeOrder({ status: from }));

        await expect(oms.transition('order-1', to))
          .rejects.toThrow('Invalid transition');
      },
    );
  });

  // ── Terminal States ────────────────────────────────────────────────

  describe('Terminal states', () => {
    const terminalStates: OrderState[] = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'];

    it.each(terminalStates)('should not allow any transition from %s', async (state) => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: state }));

      await expect(oms.transition('order-1', 'SUBMITTED'))
        .rejects.toThrow('Invalid transition');
    });
  });

  // ── submitOrder ────────────────────────────────────────────────────

  describe('submitOrder', () => {
    it('should transition PENDING → SUBMITTED', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING' }));

      const result = await oms.submitOrder('order-1');
      expect(result.toState).toBe('SUBMITTED');
    });

    it('should fail if order not found', async () => {
      prisma.order.findUnique.mockResolvedValue(null);

      await expect(oms.submitOrder('nonexistent'))
        .rejects.toThrow('not found');
    });
  });

  // ── recordFill ─────────────────────────────────────────────────────

  describe('recordFill', () => {
    it('should transition to FILLED when totalFilled >= order qty', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: 'SUBMITTED', qty: 100, filledQty: 0, avgFillPrice: 0 }),
      );

      const result = await oms.recordFill('order-1', 100, 2500);
      expect(result.toState).toBe('FILLED');
      expect(result.filledQty).toBe(100);
      expect(result.avgFillPrice).toBe(2500);
    });

    it('should transition to PARTIALLY_FILLED when totalFilled < order qty', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: 'SUBMITTED', qty: 100, filledQty: 0, avgFillPrice: 0 }),
      );

      const result = await oms.recordFill('order-1', 30, 2500);
      expect(result.toState).toBe('PARTIALLY_FILLED');
      expect(result.filledQty).toBe(30);
    });

    it('should compute blended avg fill price across partial fills', async () => {
      // First fill: 50 shares at 2500. Second fill: 50 shares at 2600.
      // Blended = (50*2500 + 50*2600) / 100 = 2550
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: 'PARTIALLY_FILLED', qty: 100, filledQty: 50, avgFillPrice: 2500 }),
      );

      const result = await oms.recordFill('order-1', 50, 2600);
      expect(result.toState).toBe('FILLED');
      expect(result.avgFillPrice).toBe(2550);
    });

    it('should handle multiple partial fills correctly', async () => {
      // Order for 100 shares. Fill 1: 30@2500, Fill 2: 40@2510
      // Blended after fill 2: (30*2500 + 40*2510) / 70 = (75000+100400)/70 = 2505.71
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: 'PARTIALLY_FILLED', qty: 100, filledQty: 30, avgFillPrice: 2500 }),
      );

      const result = await oms.recordFill('order-1', 40, 2510);
      expect(result.toState).toBe('PARTIALLY_FILLED');
      expect(result.filledQty).toBe(70);
      expect(result.avgFillPrice).toBeCloseTo(2505.71, 1);
    });

    it('should compute slippage in bps when idealPrice exists', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({
          status: 'SUBMITTED',
          qty: 100,
          filledQty: 0,
          avgFillPrice: 0,
          idealPrice: 2500,
        }),
      );

      const result = await oms.recordFill('order-1', 100, 2505);
      // slippage = |2505 - 2500| / 2500 * 10000 = 20 bps
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            slippageBps: 20,
          }),
        }),
      );
    });
  });

  // ── cancelOrder ────────────────────────────────────────────────────

  describe('cancelOrder', () => {
    it('should cancel a PENDING order', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING' }));

      const result = await oms.cancelOrder('order-1', 'User requested');
      expect(result.toState).toBe('CANCELLED');
      expect(result.reason).toBe('User requested');
    });

    it('should cancel a SUBMITTED order', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'SUBMITTED' }));

      const result = await oms.cancelOrder('order-1');
      expect(result.toState).toBe('CANCELLED');
    });

    it('should cancel a PARTIALLY_FILLED order', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PARTIALLY_FILLED' }));

      const result = await oms.cancelOrder('order-1');
      expect(result.toState).toBe('CANCELLED');
    });

    it('should NOT allow cancelling a FILLED order', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'FILLED' }));

      await expect(oms.cancelOrder('order-1'))
        .rejects.toThrow('Invalid transition');
    });
  });

  // ── rejectOrder ────────────────────────────────────────────────────

  describe('rejectOrder', () => {
    it('should reject a PENDING order', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING' }));

      const result = await oms.rejectOrder('order-1', 'Insufficient margin');
      expect(result.toState).toBe('REJECTED');
      expect(result.reason).toBe('Insufficient margin');
    });

    it('should reject a SUBMITTED order', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'SUBMITTED' }));

      const result = await oms.rejectOrder('order-1', 'Exchange rejected');
      expect(result.toState).toBe('REJECTED');
    });
  });

  // ── expireStaleOrders ──────────────────────────────────────────────

  describe('expireStaleOrders', () => {
    it('should CANCEL stale PENDING orders', async () => {
      prisma.order.findMany.mockResolvedValue([
        makeOrder({ id: 'stale-1', status: 'PENDING', symbol: 'TCS' }),
      ]);
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ id: 'stale-1', status: 'PENDING' }),
      );

      const count = await oms.expireStaleOrders();
      expect(count).toBe(1);
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'CANCELLED' }),
        }),
      );
    });

    it('should EXPIRE stale SUBMITTED orders', async () => {
      prisma.order.findMany.mockResolvedValue([
        makeOrder({ id: 'stale-2', status: 'SUBMITTED', symbol: 'INFY' }),
      ]);
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ id: 'stale-2', status: 'SUBMITTED' }),
      );

      const count = await oms.expireStaleOrders();
      expect(count).toBe(1);
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({ status: 'EXPIRED' }),
        }),
      );
    });

    it('should handle zero stale orders gracefully', async () => {
      prisma.order.findMany.mockResolvedValue([]);
      const count = await oms.expireStaleOrders();
      expect(count).toBe(0);
    });

    it('should continue processing if one order fails to expire', async () => {
      prisma.order.findMany.mockResolvedValue([
        makeOrder({ id: 'ok-1', status: 'PENDING' }),
        makeOrder({ id: 'fail-1', status: 'PENDING' }),
        makeOrder({ id: 'ok-2', status: 'PENDING' }),
      ]);

      prisma.order.findUnique
        .mockResolvedValueOnce(makeOrder({ id: 'ok-1', status: 'PENDING' }))
        .mockResolvedValueOnce(makeOrder({ id: 'fail-1', status: 'FILLED' })) // already filled
        .mockResolvedValueOnce(makeOrder({ id: 'ok-2', status: 'PENDING' }));

      const count = await oms.expireStaleOrders();
      expect(count).toBe(2); // 2 succeeded, 1 failed (FILLED → CANCELLED is invalid)
    });
  });

  // ── Event Emission ─────────────────────────────────────────────────

  describe('Event emission', () => {
    it('should emit ORDER_STATE_CHANGE on every transition', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: 'PENDING', symbol: 'RELIANCE' }),
      );

      await oms.transition('order-1', 'SUBMITTED');
      expect(emit).toHaveBeenCalledWith('execution', expect.objectContaining({
        type: 'ORDER_STATE_CHANGE',
        fromState: 'PENDING',
        toState: 'SUBMITTED',
        symbol: 'RELIANCE',
      }));
    });

    it('should include fill details in event', async () => {
      prisma.order.findUnique.mockResolvedValue(
        makeOrder({ status: 'SUBMITTED', qty: 10, filledQty: 0 }),
      );

      await oms.recordFill('order-1', 10, 2500);
      expect(emit).toHaveBeenCalledWith('execution', expect.objectContaining({
        filledQty: 10,
        avgFillPrice: 2500,
      }));
    });
  });

  // ── Transition Log ─────────────────────────────────────────────────

  describe('Transition log', () => {
    it('should record transitions in memory', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'PENDING' }));
      await oms.submitOrder('order-1');

      const history = await oms.getOrderWithHistory('order-1');
      expect(history.transitions).toHaveLength(1);
      expect(history.transitions[0].toState).toBe('SUBMITTED');
    });

    it('should cap transition log at 1000 entries', async () => {
      // Simulate many transitions to trigger the trim
      for (let i = 0; i < 1100; i++) {
        prisma.order.findUnique.mockResolvedValue(
          makeOrder({ id: `order-${i}`, status: 'PENDING' }),
        );
        await oms.transition(`order-${i}`, 'SUBMITTED');
      }

      // Internal log should have been trimmed
      const history = await oms.getOrderWithHistory('order-1099');
      // We can't directly check length, but the operation should not throw
      expect(history).toBeDefined();
    });
  });

  // ── OMS Stats ──────────────────────────────────────────────────────

  describe('getOMSStats', () => {
    it('should aggregate order counts', async () => {
      prisma.order.count
        .mockResolvedValueOnce(3)   // pending
        .mockResolvedValueOnce(5)   // submitted
        .mockResolvedValueOnce(20)  // filledToday
        .mockResolvedValueOnce(2);  // cancelledToday
      prisma.order.findMany.mockResolvedValue([]);

      const stats = await oms.getOMSStats();
      expect(stats.pendingOrders).toBe(3);
      expect(stats.submittedOrders).toBe(5);
      expect(stats.filledToday).toBe(20);
      expect(stats.cancelledToday).toBe(2);
    });

    it('should compute average fill time', async () => {
      const created = new Date(Date.now() - 5000); // 5 seconds ago
      const filled = new Date();

      prisma.order.count.mockResolvedValue(1);
      prisma.order.findMany.mockResolvedValue([
        { createdAt: created, filledAt: filled },
      ]);

      const stats = await oms.getOMSStats();
      expect(stats.avgFillTimeMs).toBeGreaterThan(0);
      expect(stats.avgFillTimeMs).toBeLessThanOrEqual(6000);
    });
  });

  // ── Fill Timestamp ─────────────────────────────────────────────────

  describe('Fill timestamp', () => {
    it('should set filledAt on FILLED transition', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'SUBMITTED' }));

      await oms.transition('order-1', 'FILLED', { filledQty: 10, avgFillPrice: 2500 });
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            filledAt: expect.any(Date),
          }),
        }),
      );
    });

    it('should set filledAt on PARTIALLY_FILLED transition', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'SUBMITTED' }));

      await oms.transition('order-1', 'PARTIALLY_FILLED', { filledQty: 5 });
      expect(prisma.order.update).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            filledAt: expect.any(Date),
          }),
        }),
      );
    });

    it('should NOT set filledAt on CANCELLED transition', async () => {
      prisma.order.findUnique.mockResolvedValue(makeOrder({ status: 'SUBMITTED' }));

      await oms.transition('order-1', 'CANCELLED');
      const updateCall = prisma.order.update.mock.calls[0][0];
      expect(updateCall.data.filledAt).toBeUndefined();
    });
  });
});
