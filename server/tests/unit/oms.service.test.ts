import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/lib/event-bus.js', () => ({
  emit: vi.fn().mockResolvedValue(undefined),
}));

import { OrderManagementService, type OrderState } from '../../src/services/oms.service.js';

function createMockPrisma() {
  return {
    order: {
      findUnique: vi.fn(),
      update: vi.fn().mockResolvedValue({}),
      findMany: vi.fn().mockResolvedValue([]),
      count: vi.fn().mockResolvedValue(0),
    },
  } as any;
}

function mockOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    symbol: 'TCS',
    side: 'BUY',
    qty: 10,
    status: 'PENDING',
    filledQty: 0,
    avgFillPrice: null,
    idealPrice: 2500,
    createdAt: new Date(),
    filledAt: null,
    ...overrides,
  };
}

describe('OrderManagementService', () => {
  let oms: OrderManagementService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    oms = new OrderManagementService(mockPrisma);
  });

  describe('state transitions', () => {
    it('should allow PENDING → SUBMITTED', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder());
      const t = await oms.submitOrder('order-1');
      expect(t.fromState).toBe('PENDING');
      expect(t.toState).toBe('SUBMITTED');
    });

    it('should allow SUBMITTED → FILLED', async () => {
      // recordFill calls findUnique, then transition calls findUnique again
      mockPrisma.order.findUnique
        .mockResolvedValueOnce(mockOrder({ status: 'SUBMITTED', filledQty: 0 }))
        .mockResolvedValueOnce(mockOrder({ status: 'SUBMITTED', filledQty: 0 }));
      const t = await oms.recordFill('order-1', 10, 2505);
      expect(t.toState).toBe('FILLED');
    });

    it('should allow SUBMITTED → PARTIALLY_FILLED', async () => {
      mockPrisma.order.findUnique
        .mockResolvedValueOnce(mockOrder({ status: 'SUBMITTED', filledQty: 0 }))
        .mockResolvedValueOnce(mockOrder({ status: 'SUBMITTED', filledQty: 0 }));
      const t = await oms.recordFill('order-1', 5, 2505);
      expect(t.toState).toBe('PARTIALLY_FILLED');
    });

    it('should allow SUBMITTED → CANCELLED', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder({ status: 'SUBMITTED' }));
      const t = await oms.cancelOrder('order-1', 'user requested');
      expect(t.toState).toBe('CANCELLED');
      expect(t.reason).toBe('user requested');
    });

    it('should reject FILLED → CANCELLED (terminal state)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder({ status: 'FILLED' }));
      await expect(oms.cancelOrder('order-1')).rejects.toThrow('Invalid transition');
    });

    it('should reject CANCELLED → SUBMITTED (terminal state)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder({ status: 'CANCELLED' }));
      await expect(oms.submitOrder('order-1')).rejects.toThrow('Invalid transition');
    });

    it('should reject PENDING → FILLED (must go through SUBMITTED)', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder());
      await expect(
        oms.transition('order-1', 'FILLED' as OrderState)
      ).rejects.toThrow('Invalid transition');
    });
  });

  describe('partial fills', () => {
    it('should compute blended avg fill price across two fills', async () => {
      // recordFill calls findUnique, then transition calls findUnique again
      mockPrisma.order.findUnique
        .mockResolvedValueOnce(mockOrder({ status: 'SUBMITTED', filledQty: 0, avgFillPrice: null }))
        .mockResolvedValueOnce(mockOrder({ status: 'SUBMITTED', filledQty: 0, avgFillPrice: null }));

      const t1 = await oms.recordFill('order-1', 5, 2500);
      expect(t1.toState).toBe('PARTIALLY_FILLED');
      expect(t1.filledQty).toBe(5);

      // Second fill — order now has 5 filled at 2500
      mockPrisma.order.findUnique
        .mockResolvedValueOnce(mockOrder({ status: 'PARTIALLY_FILLED', filledQty: 5, avgFillPrice: 2500 }))
        .mockResolvedValueOnce(mockOrder({ status: 'PARTIALLY_FILLED', filledQty: 5, avgFillPrice: 2500 }));

      const t2 = await oms.recordFill('order-1', 5, 2510);
      expect(t2.toState).toBe('FILLED');
      // Blended price = (5*2500 + 5*2510) / 10 = 2505
      expect(t2.avgFillPrice).toBeCloseTo(2505, 0);
    });
  });

  describe('reject order', () => {
    it('should allow PENDING → REJECTED', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(mockOrder());
      const t = await oms.rejectOrder('order-1', 'insufficient margin');
      expect(t.toState).toBe('REJECTED');
      expect(t.reason).toBe('insufficient margin');
    });
  });

  describe('order not found', () => {
    it('should throw for non-existent order', async () => {
      mockPrisma.order.findUnique.mockResolvedValue(null);
      await expect(oms.submitOrder('nonexistent')).rejects.toThrow('not found');
    });
  });

  describe('getOMSStats', () => {
    it('should return zero counts when empty', async () => {
      mockPrisma.order.count.mockResolvedValue(0);
      mockPrisma.order.findMany.mockResolvedValue([]);
      const stats = await oms.getOMSStats();
      expect(stats.pendingOrders).toBe(0);
      expect(stats.filledToday).toBe(0);
    });
  });
});
