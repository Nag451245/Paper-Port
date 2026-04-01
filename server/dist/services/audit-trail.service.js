import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';
const log = createChildLogger('AuditTrail');
const BUFFER_CAPACITY = 50;
const FLUSH_INTERVAL_MS = 2_000;
export class AuditTrailService {
    buffer = [];
    flushTimer = null;
    flushing = false;
    constructor() {
        this.flushTimer = setInterval(() => {
            this.flush().catch((err) => log.error({ err }, 'Periodic audit flush failed'));
        }, FLUSH_INTERVAL_MS);
    }
    async append(entry) {
        this.buffer.push(entry);
        if (this.buffer.length >= BUFFER_CAPACITY) {
            await this.flush();
        }
    }
    async flush() {
        if (this.flushing || this.buffer.length === 0)
            return;
        this.flushing = true;
        const batch = this.buffer.splice(0);
        try {
            const prisma = getPrisma();
            await prisma.auditEntry.createMany({
                data: batch.map((e) => ({
                    orderId: e.orderId ?? null,
                    positionId: e.positionId ?? null,
                    userId: e.userId,
                    action: e.action,
                    actor: e.actor,
                    beforeState: e.beforeState !== undefined ? e.beforeState : undefined,
                    afterState: e.afterState !== undefined ? e.afterState : undefined,
                    reason: e.reason ?? null,
                    metadata: e.metadata !== undefined ? e.metadata : undefined,
                })),
            });
            log.debug({ count: batch.length }, 'Audit entries flushed');
        }
        catch (err) {
            this.buffer.unshift(...batch);
            log.error({ err, count: batch.length }, 'Audit flush failed, entries re-queued');
        }
        finally {
            this.flushing = false;
        }
    }
    async queryByOrder(orderId, limit = 100) {
        const prisma = getPrisma();
        return prisma.auditEntry.findMany({
            where: { orderId },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
    async queryByUser(userId, from, to, limit = 100) {
        const prisma = getPrisma();
        const createdAt = {};
        if (from)
            createdAt.gte = from;
        if (to)
            createdAt.lte = to;
        return prisma.auditEntry.findMany({
            where: {
                userId,
                ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
    async queryByAction(action, from, to, limit = 100) {
        const prisma = getPrisma();
        const createdAt = {};
        if (from)
            createdAt.gte = from;
        if (to)
            createdAt.lte = to;
        return prisma.auditEntry.findMany({
            where: {
                action,
                ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
            },
            orderBy: { createdAt: 'desc' },
            take: limit,
        });
    }
    async destroy() {
        if (this.flushTimer) {
            clearInterval(this.flushTimer);
            this.flushTimer = null;
        }
        await this.flush();
        log.info('AuditTrailService destroyed, final flush complete');
    }
}
//# sourceMappingURL=audit-trail.service.js.map