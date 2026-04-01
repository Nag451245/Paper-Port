import { emit } from '../lib/event-bus.js';
import { createChildLogger } from '../lib/logger.js';
import { AuditTrailService } from './audit-trail.service.js';
import { MetricsService } from './metrics.service.js';
const log = createChildLogger('OMS');
const VALID_TRANSITIONS = {
    PENDING: ['SUBMITTED', 'CANCELLED', 'REJECTED'],
    SUBMITTED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'],
    PARTIALLY_FILLED: ['PARTIALLY_FILLED', 'FILLED', 'CANCELLED'],
    FILLED: [],
    CANCELLED: [],
    REJECTED: [],
    EXPIRED: [],
};
export class OrderManagementService {
    prisma;
    transitionLog = [];
    auditTrail;
    metrics;
    constructor(prisma) {
        this.prisma = prisma;
        this.auditTrail = new AuditTrailService();
        this.metrics = MetricsService.getInstance();
    }
    /**
     * Validate and execute a state transition on an order.
     */
    async transition(orderId, toState, details) {
        const order = await this.prisma.order.findUnique({ where: { id: orderId }, include: { portfolio: { select: { userId: true } } } });
        if (!order)
            throw new Error(`Order ${orderId} not found`);
        const fromState = order.status;
        const allowed = VALID_TRANSITIONS[fromState] ?? [];
        if (!allowed.includes(toState)) {
            const msg = `Invalid transition: ${fromState} → ${toState} (allowed: ${allowed.join(', ') || 'none'})`;
            log.error({ orderId, fromState, toState }, msg);
            throw new Error(msg);
        }
        const updateData = { status: toState };
        if (details?.filledQty !== undefined) {
            updateData.filledQty = details.filledQty;
        }
        if (details?.avgFillPrice !== undefined) {
            updateData.avgFillPrice = details.avgFillPrice;
        }
        if (details?.slippageBps !== undefined) {
            updateData.slippageBps = details.slippageBps;
        }
        if (toState === 'FILLED' || toState === 'PARTIALLY_FILLED') {
            updateData.filledAt = new Date();
        }
        await this.prisma.order.update({
            where: { id: orderId },
            data: updateData,
        });
        const transition = {
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
        if (toState === 'FILLED') {
            this.metrics.recordOrderFilled(order.side, 'PAPER');
        }
        else if (toState === 'REJECTED') {
            this.metrics.recordOrderRejected(details?.reason ?? 'unknown');
        }
        this.auditTrail.append({
            orderId,
            userId: order.portfolio?.userId ?? 'unknown',
            action: toState === 'FILLED' ? 'ORDER_FILL' : toState === 'CANCELLED' ? 'ORDER_CANCEL' : toState === 'REJECTED' ? 'ORDER_REJECT' : 'ORDER_MODIFY',
            actor: 'SYSTEM',
            beforeState: { status: fromState },
            afterState: { status: toState, ...details },
            reason: details?.reason,
        }).catch(err => log.warn({ err, orderId }, 'Failed to write audit trail'));
        return transition;
    }
    /**
     * Submit an order: PENDING → SUBMITTED
     */
    async submitOrder(orderId) {
        return this.transition(orderId, 'SUBMITTED');
    }
    /**
     * Record a fill (full or partial).
     */
    async recordFill(orderId, filledQty, avgFillPrice) {
        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order)
            throw new Error(`Order ${orderId} not found`);
        const totalFilled = order.filledQty + filledQty;
        const isComplete = totalFilled >= order.qty;
        // Compute blended avg fill price
        const prevValue = Number(order.avgFillPrice ?? 0) * order.filledQty;
        const newValue = avgFillPrice * filledQty;
        const blendedAvg = totalFilled > 0 ? (prevValue + newValue) / totalFilled : avgFillPrice;
        // Compute slippage vs ideal price
        let slippageBps;
        if (order.idealPrice && Number(order.idealPrice) > 0) {
            const idealPrice = Number(order.idealPrice);
            slippageBps = Math.abs(blendedAvg - idealPrice) / idealPrice * 10000;
        }
        return this.transition(orderId, isComplete ? 'FILLED' : 'PARTIALLY_FILLED', {
            filledQty: totalFilled,
            avgFillPrice: Math.round(blendedAvg * 100) / 100,
            slippageBps: slippageBps !== undefined ? Math.round(slippageBps * 100) / 100 : undefined,
        });
    }
    /**
     * Cancel an order.
     */
    async cancelOrder(orderId, reason) {
        return this.transition(orderId, 'CANCELLED', { reason });
    }
    /**
     * Reject an order.
     */
    async rejectOrder(orderId, reason) {
        return this.transition(orderId, 'REJECTED', { reason });
    }
    /**
     * Expire stale orders that have been PENDING or SUBMITTED too long.
     */
    async expireStaleOrders(maxAgeMs = 4 * 60 * 60_000) {
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
                const toState = order.status === 'PENDING' ? 'CANCELLED' : 'EXPIRED';
                await this.transition(order.id, toState, {
                    reason: `Auto-expired after ${Math.round(maxAgeMs / 60_000)}min`,
                });
                expired++;
            }
            catch (err) {
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
    async getOrderWithHistory(orderId) {
        const order = await this.prisma.order.findUnique({ where: { id: orderId } });
        if (!order)
            throw new Error(`Order ${orderId} not found`);
        const transitions = this.transitionLog.filter(t => t.orderId === orderId);
        return {
            order: order,
            transitions,
        };
    }
    /**
     * Get aggregate OMS statistics.
     */
    async getOMSStats() {
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
//# sourceMappingURL=oms.service.js.map