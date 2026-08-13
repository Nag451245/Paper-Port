import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';
import {
  fingerprintFailure,
  normalizeCause,
  classifyFailure,
  shouldBlock,
  FAILURE_POLICY,
  type FailureClass,
  type FailureShape,
} from '../lib/failure-fingerprint.js';

const log = createChildLogger('FailureRegistry');

export interface OrderShape {
  segment: string;
  instrumentType: string;
  underlying: string;
}

export interface BlockVerdict {
  blocked: boolean;
  fingerprint?: string;
  failureClass?: string;
  occurrences?: number;
  reason?: string;
}

/**
 * Remembers execution failures so the same one is not attempted twice.
 *
 * The registry is deliberately narrow. It does NOT learn from losing trades — a
 * losing trade is usually a draw from a distribution, not a mistake, and
 * suppressing those would remove the setups a profitable system depends on. It
 * records failures that could not have succeeded: a payload the broker rejects, a
 * contract with no expiry, a spread that filled only half its legs.
 */
export class FailureRegistryService {
  constructor(private prisma: PrismaClient) {}

  /**
   * Record one failure. Idempotent per fingerprint — repeats increment a counter
   * rather than creating rows, which is what lets policy depend on recurrence.
   *
   * `blocked` is recomputed from the class policy on every occurrence, so a
   * BLOCK_AFTER_REPEAT class arms itself once it has actually repeated.
   */
  async record(input: {
    failureClass?: FailureClass;
    cause: string;
    order: OrderShape;
  }): Promise<{ fingerprint: string; blocked: boolean; occurrences: number }> {
    const failureClass = input.failureClass ?? classifyFailure(input.cause);
    const shape: FailureShape = {
      failureClass,
      segment: input.order.segment,
      instrumentType: input.order.instrumentType,
      underlying: input.order.underlying,
      cause: input.cause,
    };
    const fingerprint = fingerprintFailure(shape);
    const now = new Date();

    const existing = await this.prisma.failureMode.findUnique({ where: { fingerprint } });
    const occurrences = (existing?.occurrences ?? 0) + 1;
    const blocked = shouldBlock(failureClass, occurrences);

    await this.prisma.failureMode.upsert({
      where: { fingerprint },
      create: {
        fingerprint,
        failureClass,
        segment: String(input.order.segment ?? '').toUpperCase(),
        instrumentType: String(input.order.instrumentType ?? '').toUpperCase(),
        underlying: String(input.order.underlying ?? '').toUpperCase(),
        normalizedCause: normalizeCause(input.cause),
        sampleCause: String(input.cause ?? '').slice(0, 500),
        occurrences: 1,
        blocked,
        firstSeenAt: now,
        lastSeenAt: now,
      },
      update: {
        occurrences: { increment: 1 },
        blocked,
        lastSeenAt: now,
      },
    });

    const logPayload = { fingerprint, failureClass, occurrences, blocked, policy: FAILURE_POLICY[failureClass] };
    if (blocked) {
      log.error(logPayload, 'Execution failure recorded and now BLOCKING matching orders');
    } else {
      log.warn(logPayload, 'Execution failure recorded');
    }

    return { fingerprint, blocked, occurrences };
  }

  /**
   * Pre-trade check. Refuses an order whose shape matches a blocked failure.
   *
   * Matching is on shape, never on the exact contract: the point is to catch the
   * NEXT weekly expiry of the same broken pattern, not only the one that failed.
   * Only rows already marked `blocked` are consulted, so recording a failure is
   * always safe and never by itself stops trading.
   */
  async checkBlocked(order: OrderShape): Promise<BlockVerdict> {
    const rows = await this.prisma.failureMode.findMany({
      where: {
        blocked: true,
        segment: String(order.segment ?? '').toUpperCase(),
        instrumentType: String(order.instrumentType ?? '').toUpperCase(),
        underlying: String(order.underlying ?? '').toUpperCase(),
      },
      orderBy: { lastSeenAt: 'desc' },
      take: 1,
    });

    const hit = rows[0];
    if (!hit) return { blocked: false };

    return {
      blocked: true,
      fingerprint: hit.fingerprint,
      failureClass: hit.failureClass,
      occurrences: hit.occurrences,
      reason:
        `KNOWN FAILURE (${hit.failureClass}): this order shape has failed ` +
        `${hit.occurrences} time(s) and is blocked. Cause: ${hit.sampleCause}. ` +
        `Clear it with failureRegistry.unblock('${hit.fingerprint}') once the ` +
        `underlying defect is fixed.`,
    };
  }

  /**
   * Lift a block. Required as an explicit operator action rather than a timeout —
   * a block that expires on its own would let a fixed-forever defect return
   * silently, which is the failure mode this registry exists to prevent.
   */
  async unblock(fingerprint: string, notes?: string): Promise<boolean> {
    try {
      await this.prisma.failureMode.update({
        where: { fingerprint },
        data: { blocked: false, notes: notes ?? null },
      });
      log.warn({ fingerprint, notes }, 'Failure block lifted by operator');
      return true;
    } catch {
      return false;
    }
  }

  /** Everything currently blocking, for an operator view. */
  async listBlocked(): Promise<Array<{
    fingerprint: string; failureClass: string; underlying: string;
    occurrences: number; sampleCause: string; lastSeenAt: Date;
  }>> {
    return this.prisma.failureMode.findMany({
      where: { blocked: true },
      select: {
        fingerprint: true, failureClass: true, underlying: true,
        occurrences: true, sampleCause: true, lastSeenAt: true,
      },
      orderBy: { lastSeenAt: 'desc' },
    });
  }
}
