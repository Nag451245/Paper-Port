import { randomUUID } from 'crypto';
import { getRedis } from './redis.js';
import { env } from '../config.js';
import { createChildLogger } from './logger.js';

const log = createChildLogger('LeaderElection');

/**
 * Single-writer election for scheduled/automated work.
 *
 * Every automated action in this system — cron-driven order matching, bot
 * ticks, stop-loss exits, the 15:15 square-off — assumes exactly one process is
 * running it. Nothing enforced that. Two instances (a rolling deploy overlap, a
 * scaled web service, a stray local process pointed at prod) would each place
 * the full order, doubling position size and defeating every per-position risk
 * limit, which are evaluated per-process.
 *
 * Implementation is a Redis lease: SET NX PX, renewed on a timer, released on
 * shutdown. Losing the lease demotes the instance immediately, so a paused or
 * partitioned process stops acting rather than acting on stale belief.
 *
 * Read paths (the HTTP API) are deliberately NOT gated — followers still serve
 * requests. Only the automated writers are restricted.
 */

const LEASE_KEY = 'capital-guard:leader';
const LEASE_TTL_MS = 30_000;
const RENEW_INTERVAL_MS = 10_000;

export class LeaderElection {
  private readonly instanceId = randomUUID();
  private leader = false;
  private timer: ReturnType<typeof setInterval> | null = null;
  private redisAvailable = false;

  /** True when this process may perform automated, order-placing work. */
  isLeader(): boolean {
    return this.leader;
  }

  getInstanceId(): string {
    return this.instanceId;
  }

  getStatus(): { isLeader: boolean; instanceId: string; coordinated: boolean } {
    return { isLeader: this.leader, instanceId: this.instanceId, coordinated: this.redisAvailable };
  }

  async start(): Promise<void> {
    const redis = getRedis();

    if (!redis) {
      // No coordination backend. We cannot detect a second instance, so this is
      // an assumption, not a guarantee — say so rather than implying safety.
      if (env.REQUIRE_LEADER_LOCK) {
        this.leader = false;
        log.error(
          'REQUIRE_LEADER_LOCK is set but Redis is not configured — refusing to run automated trading. ' +
          'Configure REDIS_URL, or unset REQUIRE_LEADER_LOCK to run single-instance.',
        );
        return;
      }
      this.leader = true;
      this.redisAvailable = false;
      log.warn(
        'No Redis — running as leader on the ASSUMPTION this is the only instance. ' +
        'A second process would double every order. Set REDIS_URL for real protection, ' +
        'or REQUIRE_LEADER_LOCK=true to refuse to trade without it.',
      );
      return;
    }

    this.redisAvailable = true;
    await this.tryAcquire();

    this.timer = setInterval(() => {
      this.tryAcquire().catch(err => log.error({ err }, 'Leader lease renewal failed'));
    }, RENEW_INTERVAL_MS);
  }

  private async tryAcquire(): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    try {
      if (this.leader) {
        // Renew only if we still hold it. A blind SET would let an instance
        // that lost the lease (long GC pause, network partition) silently
        // steal it back from the process that legitimately took over.
        const held = await redis.get(LEASE_KEY);
        if (held !== this.instanceId) {
          this.demote('lease no longer held');
          return;
        }
        await redis.pexpire(LEASE_KEY, LEASE_TTL_MS);
        return;
      }

      const acquired = await redis.set(LEASE_KEY, this.instanceId, 'PX', LEASE_TTL_MS, 'NX');
      if (acquired) {
        this.leader = true;
        log.warn({ instanceId: this.instanceId }, 'Became LEADER — this instance runs automated trading');
      }
    } catch (err) {
      // Redis unreachable. Fail closed: an instance that cannot confirm it is
      // the leader must stop acting, or a partition produces two active leaders.
      if (this.leader) this.demote('cannot reach Redis to confirm leadership');
      throw err;
    }
  }

  private demote(reason: string): void {
    if (!this.leader) return;
    this.leader = false;
    log.error({ instanceId: this.instanceId, reason },
      'Lost leadership — automated trading halted on this instance');
  }

  async stop(): Promise<void> {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }

    const redis = getRedis();
    if (redis && this.leader) {
      try {
        // Only release if we still own it, so we never delete a successor's lease.
        const held = await redis.get(LEASE_KEY);
        if (held === this.instanceId) await redis.del(LEASE_KEY);
      } catch { /* lease will expire on its own */ }
    }
    this.leader = false;
  }
}

/** Process-wide instance. */
export const leaderElection = new LeaderElection();
