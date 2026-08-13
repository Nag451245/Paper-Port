/**
 * Single-writer election.
 *
 * Failure mode this guards: two instances each running the cron-driven order
 * matcher, bot ticks and the 15:15 square-off. Both place the full order, so
 * position size doubles while each process's risk limits — which are evaluated
 * per-process — see only half the true exposure.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// vi.mock factories are hoisted above module-level consts, so anything they
// close over must be created with vi.hoisted().
const { redisMock, envMock, state } = vi.hoisted(() => ({
  redisMock: { set: vi.fn(), get: vi.fn(), del: vi.fn(), pexpire: vi.fn() },
  envMock: { REQUIRE_LEADER_LOCK: false },
  state: { redisEnabled: true },
}));

vi.mock('../../src/lib/redis.js', () => ({
  getRedis: vi.fn(() => (state.redisEnabled ? redisMock : null)),
}));

vi.mock('../../src/lib/logger.js', () => ({
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  }),
}));

vi.mock('../../src/config.js', () => ({ env: envMock }));

import { LeaderElection } from '../../src/lib/leader-election.js';

describe('LeaderElection with Redis', () => {
  let el: LeaderElection;

  beforeEach(() => {
    vi.clearAllMocks();
    state.redisEnabled = true;
    envMock.REQUIRE_LEADER_LOCK = false;
    el = new LeaderElection();
  });

  afterEach(async () => { await el.stop(); });

  it('becomes leader when it wins the lease', async () => {
    redisMock.set.mockResolvedValue('OK');
    await el.start();

    expect(el.isLeader()).toBe(true);
    // NX so only one instance can win; PX so a dead leader's lease expires
    const args = redisMock.set.mock.calls[0];
    expect(args).toContain('NX');
    expect(args).toContain('PX');
  });

  it('stays a follower when another instance holds the lease', async () => {
    redisMock.set.mockResolvedValue(null);
    await el.start();

    expect(el.isLeader()).toBe(false);
  });

  it('two instances cannot both be leader', async () => {
    const a = new LeaderElection();
    const b = new LeaderElection();
    let held: string | null = null;

    // Model Redis SET NX: first writer wins, others get null
    redisMock.set.mockImplementation(async (_k: string, v: string) => {
      if (held === null) { held = v; return 'OK'; }
      return null;
    });

    await a.start();
    await b.start();

    expect([a.isLeader(), b.isLeader()].filter(Boolean)).toHaveLength(1);
    await a.stop();
    await b.stop();
  });

  it('demotes itself if the lease is no longer its own', async () => {
    redisMock.set.mockResolvedValue('OK');
    await el.start();
    expect(el.isLeader()).toBe(true);

    // Another instance took over while we were paused
    redisMock.get.mockResolvedValue('some-other-instance');
    await (el as any).tryAcquire();

    expect(el.isLeader()).toBe(false);
    expect(redisMock.pexpire).not.toHaveBeenCalled();
  });

  it('renews only while it still owns the lease', async () => {
    redisMock.set.mockResolvedValue('OK');
    await el.start();

    redisMock.get.mockResolvedValue(el.getInstanceId());
    await (el as any).tryAcquire();

    expect(el.isLeader()).toBe(true);
    expect(redisMock.pexpire).toHaveBeenCalled();
  });

  it('stands down when Redis becomes unreachable rather than assuming it is still leader', async () => {
    redisMock.set.mockResolvedValue('OK');
    await el.start();
    expect(el.isLeader()).toBe(true);

    // A partition must not leave two processes both believing they lead
    redisMock.get.mockRejectedValue(new Error('connection lost'));
    await (el as any).tryAcquire().catch(() => { /* expected to rethrow */ });

    expect(el.isLeader()).toBe(false);
  });

  it('releases the lease on shutdown so a successor can take over immediately', async () => {
    redisMock.set.mockResolvedValue('OK');
    await el.start();

    redisMock.get.mockResolvedValue(el.getInstanceId());
    await el.stop();

    expect(redisMock.del).toHaveBeenCalled();
  });

  it('does not delete a successor lease on shutdown', async () => {
    redisMock.set.mockResolvedValue('OK');
    await el.start();

    redisMock.get.mockResolvedValue('a-different-instance');
    await el.stop();

    expect(redisMock.del).not.toHaveBeenCalled();
  });
});

describe('LeaderElection without Redis', () => {
  let el: LeaderElection;

  beforeEach(() => {
    vi.clearAllMocks();
    state.redisEnabled = false;
    el = new LeaderElection();
  });

  afterEach(async () => { await el.stop(); });

  it('assumes leadership so single-instance deployments keep working', async () => {
    envMock.REQUIRE_LEADER_LOCK = false;
    await el.start();

    expect(el.isLeader()).toBe(true);
    // ...but reports that nothing is actually coordinating it
    expect(el.getStatus().coordinated).toBe(false);
  });

  it('refuses to trade when REQUIRE_LEADER_LOCK is set and there is no Redis', async () => {
    envMock.REQUIRE_LEADER_LOCK = true;
    await el.start();

    expect(el.isLeader()).toBe(false);
  });
});
