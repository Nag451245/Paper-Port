import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';
import { AuditTrailService } from './audit-trail.service.js';

const log = createChildLogger('OMSRecovery');

const TERMINAL_STATUSES = ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'] as const;
const ORPHAN_THRESHOLD_MS = 4 * 60 * 60_000;
const STUCK_THRESHOLD_MS = 1 * 60 * 60_000;

export interface RecoveryReport {
  totalRecovered: number;
  orphanedExpired: number;
  stuckRejected: number;
  activeOrders: string[];
  recoveredAt: Date;
  errors: string[];
}

export class OMSRecoveryService {
  constructor(private audit: AuditTrailService) {}

  async recover(): Promise<RecoveryReport> {
    const prisma = getPrisma();
    const now = new Date();
    const errors: string[] = [];

    const nonTerminalOrders = await prisma.order.findMany({
      where: {
        status: { notIn: [...TERMINAL_STATUSES] },
      },
      include: { portfolio: { select: { userId: true } } },
      orderBy: { createdAt: 'asc' },
    });

    log.info(
      { count: nonTerminalOrders.length },
      'Non-terminal orders loaded for recovery',
    );

    let orphanedExpired = 0;
    let stuckRejected = 0;
    const activeOrders: string[] = [];

    for (const order of nonTerminalOrders) {
      const ageMs = now.getTime() - order.createdAt.getTime();

      try {
        if (
          order.status === 'SUBMITTED' &&
          ageMs > ORPHAN_THRESHOLD_MS
        ) {
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'EXPIRED' },
          });

          await this.audit.append({
            orderId: order.id,
            userId: order.portfolio.userId,
            action: 'ORDER_REJECT',
            actor: 'SYSTEM',
            beforeState: { status: order.status },
            afterState: { status: 'EXPIRED' },
            reason: 'auto-expired on recovery',
          });

          orphanedExpired++;
          log.warn(
            { orderId: order.id, ageMs },
            'Orphaned SUBMITTED order auto-expired',
          );
          continue;
        }

        if (
          order.status === 'PENDING' &&
          ageMs > STUCK_THRESHOLD_MS
        ) {
          await prisma.order.update({
            where: { id: order.id },
            data: { status: 'REJECTED' },
          });

          await this.audit.append({
            orderId: order.id,
            userId: order.portfolio.userId,
            action: 'ORDER_REJECT',
            actor: 'SYSTEM',
            beforeState: { status: order.status },
            afterState: { status: 'REJECTED' },
            reason: 'stuck PENDING order rejected on recovery',
          });

          stuckRejected++;
          log.warn(
            { orderId: order.id, ageMs },
            'Stuck PENDING order auto-rejected',
          );
          continue;
        }

        activeOrders.push(order.id);
      } catch (err) {
        const msg =
          err instanceof Error ? err.message : String(err);
        errors.push(`Order ${order.id}: ${msg}`);
        log.error({ orderId: order.id, err }, 'Recovery action failed');
      }
    }

    await this.audit.flush();

    const report: RecoveryReport = {
      totalRecovered: nonTerminalOrders.length,
      orphanedExpired,
      stuckRejected,
      activeOrders,
      recoveredAt: now,
      errors,
    };

    log.info(
      {
        totalRecovered: report.totalRecovered,
        orphanedExpired: report.orphanedExpired,
        stuckRejected: report.stuckRejected,
        activeCount: report.activeOrders.length,
        errorCount: report.errors.length,
      },
      'OMS recovery complete',
    );

    return report;
  }

  async gracefulShutdown(): Promise<void> {
    const prisma = getPrisma();

    const pendingOrders = await prisma.order.findMany({
      where: { status: 'PENDING' },
      include: { portfolio: { select: { userId: true } } },
    });

    if (pendingOrders.length > 0) {
      await prisma.order.updateMany({
        where: { status: 'PENDING' },
        data: { status: 'CANCELLED' },
      });

      for (const order of pendingOrders) {
        await this.audit.append({
          orderId: order.id,
          userId: order.portfolio.userId,
          action: 'ORDER_CANCEL',
          actor: 'SYSTEM',
          beforeState: { status: 'PENDING' },
          afterState: { status: 'CANCELLED' },
          reason: 'system shutdown',
        });
      }
    }

    await this.audit.flush();

    log.info(
      { cancelledCount: pendingOrders.length },
      'Graceful shutdown complete',
    );
  }
}
