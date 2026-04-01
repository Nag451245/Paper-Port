import { AuditTrailService } from './audit-trail.service.js';
export interface RecoveryReport {
    totalRecovered: number;
    orphanedExpired: number;
    stuckRejected: number;
    activeOrders: string[];
    recoveredAt: Date;
    errors: string[];
}
export declare class OMSRecoveryService {
    private audit;
    constructor(audit: AuditTrailService);
    recover(): Promise<RecoveryReport>;
    gracefulShutdown(): Promise<void>;
}
//# sourceMappingURL=oms-recovery.service.d.ts.map