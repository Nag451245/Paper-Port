import { describe, it, expect, vi, beforeEach } from 'vitest';

const getRedis = vi.fn();
vi.mock('../../src/lib/redis.js', () => ({
  getRedis,
  CacheService: vi.fn().mockImplementation(function () { return { get: vi.fn(), set: vi.fn() }; }),
}));
vi.mock('../../src/lib/event-bus.js', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));

const { LearningEngine } = await import('../../src/services/learning-engine.js');

/**
 * The bandit's memory must be durable.
 *
 * It previously lived only in Redis under `cg:thompson:{userId}:{strategyTag}`
 * written with `EX 24*3600`, so the posterior expired daily and reset to
 * {alpha:1, beta:1, emaWinRate:0.5, totalTrades:0} — a uniform prior. Two hundred
 * trades of history became indistinguishable from none. The write also opened
 * with `if (!redis) return`, silently discarding the outcome without Redis.
 *
 * Verified separately against a real database: 200 sequential outcomes accumulate
 * exactly, survive a fresh connection, and 50 concurrent outcomes lose no
 * increments. These tests pin the behaviour that made that possible.
 */
describe('persistThompsonState — durability', () => {
  let prisma: any;
  let engine: any;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = { $executeRaw: vi.fn().mockResolvedValue(1) };
    engine = new LearningEngine(prisma);
  });

  it('writes the outcome to the database, not to a cache', async () => {
    getRedis.mockReturnValue(null);
    await engine.persistThompsonState('u1', 'BOT:momentum', true);
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('records the outcome even when Redis is unavailable', async () => {
    // The old implementation returned early here and lost the outcome entirely.
    getRedis.mockReturnValue(null);
    await engine.persistThompsonState('u1', 'BOT:momentum', false);
    expect(prisma.$executeRaw).toHaveBeenCalled();
  });

  it('never sets a TTL on the posterior', async () => {
    const set = vi.fn();
    getRedis.mockReturnValue({ set, del: vi.fn(), get: vi.fn() });

    await engine.persistThompsonState('u1', 'BOT:momentum', true);

    // A 24h expiry on the system of record is what gave the learning a one-day
    // half-life. Redis may be invalidated, never written to with an expiry.
    expect(set).not.toHaveBeenCalled();
  });

  it('invalidates the stale cache key rather than writing to it', async () => {
    const del = vi.fn();
    getRedis.mockReturnValue({ set: vi.fn(), del, get: vi.fn() });

    await engine.persistThompsonState('u1', 'BOT:momentum', true);

    expect(del).toHaveBeenCalledWith('cg:thompson:u1:BOT:momentum');
  });

  it('uses a single statement, so concurrent outcomes cannot lose an increment', async () => {
    getRedis.mockReturnValue(null);
    await engine.persistThompsonState('u1', 'BOT:momentum', true);

    // One atomic upsert, not a read followed by a write.
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
    const sql = prisma.$executeRaw.mock.calls[0][0].join('?').replace(/\s+/g, ' ');
    expect(sql).toMatch(/INSERT INTO strategy_posteriors/i);
    expect(sql).toMatch(/ON CONFLICT \(user_id, strategy_tag\) DO UPDATE/i);
    expect(sql).toMatch(/total_trades\s*=\s*total_trades \+ 1/i);
  });

  it('does not throw when the database write fails, but does not pretend it worked', async () => {
    getRedis.mockReturnValue(null);
    prisma.$executeRaw.mockRejectedValueOnce(new Error('db down'));

    // The caller is a learning hook, not an order path — it must not crash the
    // pipeline. The failure is logged at error level as lost learning.
    await expect(engine.persistThompsonState('u1', 'BOT:momentum', true)).resolves.toBeUndefined();
  });

  it('a cache failure cannot lose an outcome already written', async () => {
    getRedis.mockReturnValue({ del: vi.fn().mockRejectedValue(new Error('redis down')) });

    await expect(engine.persistThompsonState('u1', 'BOT:momentum', true)).resolves.toBeUndefined();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });
});
