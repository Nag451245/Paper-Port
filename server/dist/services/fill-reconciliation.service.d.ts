import type { PrismaClient } from '@prisma/client';
import { OrderManagementService } from './oms.service.js';
export declare class FillReconciliationService {
    private prisma;
    private oms;
    private handle;
    private broker;
    constructor(prisma: PrismaClient, oms: OrderManagementService);
    start(): void;
    stop(): void;
    reconcilePendingOrders(): Promise<{
        checked: number;
        updated: number;
        errors: number;
    }>;
    /**
     * Startup reconciliation: compare broker positions vs DB positions
     * to detect orphaned positions from crashes.
     */
    startupReconciliation(): Promise<{
        orphanedBrokerPositions: number;
        missingBrokerPositions: number;
        qtyMismatches: number;
    }>;
    private normalizeBrokerStatus;
}
//# sourceMappingURL=fill-reconciliation.service.d.ts.map