import type { PrismaClient } from '@prisma/client';
/**
 * Valid order states and their allowed transitions.
 *
 * PENDING → SUBMITTED → PARTIALLY_FILLED → FILLED
 *                     → CANCELLED
 *                     → REJECTED
 * PENDING → CANCELLED (before submission)
 */
export type OrderState = 'PENDING' | 'SUBMITTED' | 'PARTIALLY_FILLED' | 'FILLED' | 'CANCELLED' | 'REJECTED' | 'EXPIRED';
export interface OrderTransition {
    orderId: string;
    fromState: OrderState;
    toState: OrderState;
    filledQty?: number;
    avgFillPrice?: number;
    reason?: string;
    timestamp: Date;
}
export declare class OrderManagementService {
    private prisma;
    private transitionLog;
    private auditTrail;
    private metrics;
    constructor(prisma: PrismaClient);
    /**
     * Validate and execute a state transition on an order.
     */
    transition(orderId: string, toState: OrderState, details?: {
        filledQty?: number;
        avgFillPrice?: number;
        reason?: string;
        slippageBps?: number;
    }): Promise<OrderTransition>;
    /**
     * Submit an order: PENDING → SUBMITTED
     */
    submitOrder(orderId: string): Promise<OrderTransition>;
    /**
     * Record a fill (full or partial).
     */
    recordFill(orderId: string, filledQty: number, avgFillPrice: number): Promise<OrderTransition>;
    /**
     * Cancel an order.
     */
    cancelOrder(orderId: string, reason?: string): Promise<OrderTransition>;
    /**
     * Reject an order.
     */
    rejectOrder(orderId: string, reason: string): Promise<OrderTransition>;
    /**
     * Expire stale orders that have been PENDING or SUBMITTED too long.
     */
    expireStaleOrders(maxAgeMs?: number): Promise<number>;
    /**
     * Get order with full transition history.
     */
    getOrderWithHistory(orderId: string): Promise<{
        order: Record<string, unknown>;
        transitions: OrderTransition[];
    }>;
    /**
     * Get aggregate OMS statistics.
     */
    getOMSStats(): Promise<{
        pendingOrders: number;
        submittedOrders: number;
        filledToday: number;
        cancelledToday: number;
        avgFillTimeMs: number;
    }>;
}
//# sourceMappingURL=oms.service.d.ts.map