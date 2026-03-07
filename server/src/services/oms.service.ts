import type { PrismaClient } from '@prisma/client';
import { emit } from '../lib/event-bus.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('OMS');

/**
 * Valid order states and their allowed transitions.
 *
 * PENDING → SUBMITTED → PARTIALLY_FILLED → FILLED
 *                     → CANCELLED
 *                     → REJECTED
 * PENDING → CANCELLED (before submission)
 */
export type OrderState =
  | 'PENDING'
  | 'SUBMITTED'
  | 'PARTIALLY_FILLED'
  | 'FILLED'
  | 'CANCELLED'
  | 'REJECTED'
  | 'EXPIRED';

const VALID_TRANSITIONS: Record<OrderState, OrderState[]> = {
  PENDING:          ['SUBMITTED', 'CANCELLED', 'REJECTED'],
  SUBMITTED:        ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'],
  PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED'],
  FILLED:           [],
  CANCELLED:        [],
  REJECTED:         [],
  EXPIRED:          [],
};

export interface OrderTransition {
  orderId: string;
  fromState: OrderState;
  toState: OrderState;
  filledQty?: number;
  avgFillPrice?: number;
  reason?: string;
  timestamp: Date;
}

export class OrderManagementService {
  private transitionLog: OrderTransition[] = [];

  constructor(private prisma: PrismaClient) {}

  /**
   * Validate and execute a state transition on an order.
   */
  async transition(
    orderId: string,
    toState: OrderState,
    details?: { filledQty?: number; avgFillPrice?: number; reason?: string },
  ): Promise<OrderTransition> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error(`Order ${orderId} not found`);

    const fromState = order.status as OrderState;
    const allowed = VALID_TRANSITIONS[fromState] ?? [];

    if (!allowed.includes(toState)) {
      const msg = `Invalid transition: ${fromState} → ${toState} (allowed: ${allowed.join(', ') || 'none'})`;
      log.error({ orderId, fromState, toState }, msg);
      throw new Error(msg);
    }

    const updateData: Record<string, unknown> = { status: toState };

    if (details?.filledQty !== undefined) {
      updateData.filledQty = details.filledQty;
    }
    if (details?.avgFillPrice !== undefined) {
      updateData.avgFillPrice = details.avgFillPrice;
    }
    if (toState === 'FILLED' || toState === 'PARTIALLY_FILLED') {
      updateData.filledAt = new Date();
    }

    await this.prisma.order.update({
      where: { id: orderId },
      data: updateData,
    });

    const transition: OrderTransition = {
      orderId,
      fromState,
      toState,
      filledQty: details?.filledQty,
      avgFillPrice: details?.avgFillPrice,
      reason: details?.reason,
      timestamp: new Date(),
    };

    this.transitionLog.push(transition);

    // Keep only last 1000 transitions in memory
    if (this.transitionLog.length > 1000) {
      this.transitionLog = this.transitionLog.slice(-500);
    }

    log.info({
      orderId,
      fromState,
      toState,
      filledQty: details?.filledQty,
      symbol: order.symbol,
    }, 'Order state transition');

    emit('execution', {
      type: 'ORDER_STATE_CHANGE',
      orderId,
      symbol: order.symbol,
      fromState,
      toState,
      filledQty: details?.filledQty,
      avgFillPrice: details?.avgFillPrice,
    }).catch(err => log.error({ err, orderId }, 'Failed to emit ORDER_STATE_CHANGE event'));

    return transition;
  }

  /**
   * Submit an order: PENDING → SUBMITTED
   */
  async submitOrder(orderId: string): Promise<OrderTransition> {
    return this.transition(orderId, 'SUBMITTED');
  }

  /**
   * Record a fill (full or partial).
   */
  async recordFill(
    orderId: string,
    filledQty: number,
    avgFillPrice: number,
  ): Promise<OrderTransition> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error(`Order ${orderId} not found`);

    const totalFilled = order.filledQty + filledQty;
    const isComplete = totalFilled >= order.qty;

    // Compute blended avg fill price
    const prevValue = Number(order.avgFillPrice ?? 0) * order.filledQty;
    const newValue = avgFillPrice * filledQty;
    const blendedAvg = totalFilled > 0 ? (prevValue + newValue) / totalFilled : avgFillPrice;

    // Compute slippage vs ideal price
    let slippageBps: number | undefined;
    if (order.idealPrice && Number(order.idealPrice) > 0) {
      const idealPrice = Number(order.idealPrice);
      slippageBps = Math.abs(blendedAvg - idealPrice) / idealPrice * 10000;
    }

    const updateDetails: Record<string, unknown> = {
      filledQty: totalFilled,
      avgFillPrice: Math.round(blendedAvg * 100) / 100,
    };

    if (slippageBps !== undefined) {
      updateDetails.slippageBps = Math.round(slippageBps * 100) / 100;
    }

    return this.transition(
      orderId,
      isComplete ? 'FILLED' : 'PARTIALLY_FILLED',
      { filledQty: totalFilled, avgFillPrice: blendedAvg },
    );
  }

  /**
   * Cancel an order.
   */
  async cancelOrder(orderId: string, reason?: string): Promise<OrderTransition> {
    return this.transition(orderId, 'CANCELLED', { reason });
  }

  /**
   * Reject an order.
   */
  async rejectOrder(orderId: string, reason: string): Promise<OrderTransition> {
    return this.transition(orderId, 'REJECTED', { reason });
  }

  /**
   * Expire stale orders that have been PENDING or SUBMITTED too long.
   */
  async expireStaleOrders(maxAgeMs = 4 * 60 * 60_000): Promise<number> {
    const cutoff = new Date(Date.now() - maxAgeMs);

    const staleOrders = await this.prisma.order.findMany({
      where: {
        status: { in: ['PENDING', 'SUBMITTED'] },
        createdAt: { lt: cutoff },
      },
      select: { id: true, status: true, symbol: true },
    });

    let expired = 0;
    for (const order of staleOrders) {
      try {
        const toState: OrderState = order.status === 'PENDING' ? 'CANCELLED' : 'EXPIRED';
        await this.transition(order.id, toState, {
          reason: `Auto-expired after ${Math.round(maxAgeMs / 60_000)}min`,
        });
        expired++;
      } catch (err) {
        log.warn({ orderId: order.id, err }, 'Failed to expire stale order');
      }
    }

    if (expired > 0) {
      log.info({ expired, total: staleOrders.length }, 'Expired stale orders');
    }

    return expired;
  }

  /**
   * Get order with full transition history.
   */
  async getOrderWithHistory(orderId: string): Promise<{
    order: Record<string, unknown>;
    transitions: OrderTransition[];
  }> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new Error(`Order ${orderId} not found`);

    const transitions = this.transitionLog.filter(t => t.orderId === orderId);

    return {
      order: order as any,
      transitions,
    };
  }

  /**
   * Get aggregate OMS statistics.
   */
  async getOMSStats(): Promise<{
    pendingOrders: number;
    submittedOrders: number;
    filledToday: number;
    cancelledToday: number;
    avgFillTimeMs: number;
  }> {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [pending, submitted, filledToday, cancelledToday] = await Promise.all([
      this.prisma.order.count({ where: { status: 'PENDING' } }),
      this.prisma.order.count({ where: { status: 'SUBMITTED' } }),
      this.prisma.order.count({ where: { status: 'FILLED', filledAt: { gte: todayStart } } }),
      this.prisma.order.count({ where: { status: { in: ['CANCELLED', 'EXPIRED'] }, createdAt: { gte: todayStart } } }),
    ]);

    const filledOrders = await this.prisma.order.findMany({
      where: { status: 'FILLED', filledAt: { gte: todayStart } },
      select: { createdAt: true, filledAt: true },
    });

    let avgFillTimeMs = 0;
    if (filledOrders.length > 0) {
      const totalMs = filledOrders.reduce((s, o) => {
        if (o.filledAt) {
          return s + (o.filledAt.getTime() - o.createdAt.getTime());
        }
        return s;
      }, 0);
      avgFillTimeMs = Math.round(totalMs / filledOrders.length);
    }

    return { pendingOrders: pending, submittedOrders: submitted, filledToday, cancelledToday, avgFillTimeMs };
  }
}
