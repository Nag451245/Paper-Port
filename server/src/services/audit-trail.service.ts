import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';

const log = createChildLogger('AuditTrail');

export type AuditAction =
  | 'ORDER_PLACE'
  | 'ORDER_MODIFY'
  | 'ORDER_CANCEL'
  | 'ORDER_FILL'
  | 'ORDER_REJECT'
  | 'POSITION_OPEN'
  | 'POSITION_CLOSE'
  | 'STOP_LOSS_UPDATE'
  | 'KILL_SWITCH'
  | 'RISK_VIOLATION'
  | 'CONFIG_CHANGE';

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

const BUFFER_CAPACITY = 50;
const FLUSH_INTERVAL_MS = 2_000;

export class AuditTrailService {
  private buffer: AuditAppend[] = [];
  private flushTimer: ReturnType<typeof setInterval> | null = null;
  private flushing = false;

  constructor() {
    this.flushTimer = setInterval(() => {
      this.flush().catch((err) =>
        log.error({ err }, 'Periodic audit flush failed'),
      );
    }, FLUSH_INTERVAL_MS);
  }

  async append(entry: AuditAppend): Promise<void> {
    this.buffer.push(entry);

    if (this.buffer.length >= BUFFER_CAPACITY) {
      await this.flush();
    }
  }

  async flush(): Promise<void> {
    if (this.flushing || this.buffer.length === 0) return;

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
          beforeState: e.beforeState !== undefined ? (e.beforeState as any) : undefined,
          afterState: e.afterState !== undefined ? (e.afterState as any) : undefined,
          reason: e.reason ?? null,
          metadata: e.metadata !== undefined ? (e.metadata as any) : undefined,
        })),
      });

      log.debug({ count: batch.length }, 'Audit entries flushed');
    } catch (err) {
      this.buffer.unshift(...batch);
      log.error({ err, count: batch.length }, 'Audit flush failed, entries re-queued');
    } finally {
      this.flushing = false;
    }
  }

  async queryByOrder(orderId: string, limit = 100): Promise<unknown[]> {
    const prisma = getPrisma();
    return prisma.auditEntry.findMany({
      where: { orderId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async queryByUser(
    userId: string,
    from?: Date,
    to?: Date,
    limit = 100,
  ): Promise<unknown[]> {
    const prisma = getPrisma();
    const createdAt: Record<string, Date> = {};
    if (from) createdAt.gte = from;
    if (to) createdAt.lte = to;

    return prisma.auditEntry.findMany({
      where: {
        userId,
        ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async queryByAction(
    action: AuditAction,
    from?: Date,
    to?: Date,
    limit = 100,
  ): Promise<unknown[]> {
    const prisma = getPrisma();
    const createdAt: Record<string, Date> = {};
    if (from) createdAt.gte = from;
    if (to) createdAt.lte = to;

    return prisma.auditEntry.findMany({
      where: {
        action,
        ...(Object.keys(createdAt).length > 0 ? { createdAt } : {}),
      },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  }

  async destroy(): Promise<void> {
    if (this.flushTimer) {
      clearInterval(this.flushTimer);
      this.flushTimer = null;
    }
    await this.flush();
    log.info('AuditTrailService destroyed, final flush complete');
  }
}
