export type AuditAction = 'ORDER_PLACE' | 'ORDER_MODIFY' | 'ORDER_CANCEL' | 'ORDER_FILL' | 'ORDER_REJECT' | 'POSITION_OPEN' | 'POSITION_CLOSE' | 'STOP_LOSS_UPDATE' | 'KILL_SWITCH' | 'RISK_VIOLATION' | 'CONFIG_CHANGE';
export interface AuditAppend {
    orderId?: string;
    positionId?: string;
    userId: string;
    action: AuditAction;
    actor: 'USER' | 'BOT' | 'SYSTEM';
    beforeState?: unknown;
    afterState?: unknown;
    reason?: string;
    metadata?: unknown;
}
export declare class AuditTrailService {
    private buffer;
    private flushTimer;
    private flushing;
    constructor();
    append(entry: AuditAppend): Promise<void>;
    flush(): Promise<void>;
    queryByOrder(orderId: string, limit?: number): Promise<unknown[]>;
    queryByUser(userId: string, from?: Date, to?: Date, limit?: number): Promise<unknown[]>;
    queryByAction(action: AuditAction, from?: Date, to?: Date, limit?: number): Promise<unknown[]>;
    destroy(): Promise<void>;
}
//# sourceMappingURL=audit-trail.service.d.ts.map