/**
 * Safety-critical guards for the intraday session.
 *
 * These cover two failure modes that lose real money in a volatile session:
 *  1. The auto square-off silently not firing, leaving intraday positions to
 *     carry overnight into a gap.
 *  2. The drawdown circuit breaker reading stale marks and therefore never
 *     tripping while open positions bleed.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

const getQuote = vi.fn();

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({ getQuote })),
}));

vi.mock('../../src/lib/redis.js', () => ({ getRedis: vi.fn().mockReturnValue(null) }));
vi.mock('../../src/lib/event-bus.js', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/lib/websocket.js', () => ({
  wsHub: {
    broadcastPriceUpdate: vi.fn(),
    broadcastTradeExecution: vi.fn(),
    broadcastToUser: vi.fn(),
    getSubscribedSymbols: vi.fn().mockReturnValue([]),
  },
}));
vi.mock('../../src/lib/logger.js', () => ({
  createChildLogger: vi.fn().mockReturnValue({
    info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn(), fatal: vi.fn(),
  }),
}));

import { istMinutesSinceMidnight, parseHHMM } from '../../src/lib/ist.js';
import { IntradayManager } from '../../src/services/intraday-manager.service.js';
import { createMockPrisma } from '../helpers/factories.js';

describe('IST time helpers', () => {
  it('parseHHMM converts a wall-clock string to minutes', () => {
    expect(parseHHMM('15:15')).toBe(15 * 60 + 15);
    expect(parseHHMM('00:00')).toBe(0);
    expect(parseHHMM('23:59')).toBe(1439);
    expect(parseHHMM('9:05')).toBe(545);
  });

  it('parseHHMM rejects malformed or out-of-range input', () => {
    for (const bad of ['', 'abc', '25:00', '12:60', '1515', '15:1']) {
      expect(parseHHMM(bad)).toBeNull();
    }
  });

  it('istMinutesSinceMidnight always lands in [0, 1439]', () => {
    // The old hand-rolled `(getUTCHours() + 5) % 24 + carry` produced hour 24
    // between 18:30 and 19:00 UTC. Sweep every half hour of a full day.
    for (let h = 0; h < 24; h++) {
      for (const m of [0, 29, 30, 31, 59]) {
        const d = new Date(Date.UTC(2026, 7, 4, h, m));
        const mins = istMinutesSinceMidnight(d);
        expect(Number.isInteger(mins)).toBe(true);
        expect(mins).toBeGreaterThanOrEqual(0);
        expect(mins).toBeLessThanOrEqual(1439);
      }
    }
  });

  it('istMinutesSinceMidnight applies the +5:30 IST offset', () => {
    // 09:15 IST == 03:45 UTC
    expect(istMinutesSinceMidnight(new Date(Date.UTC(2026, 7, 4, 3, 45)))).toBe(9 * 60 + 15);
    // 15:15 IST == 09:45 UTC
    expect(istMinutesSinceMidnight(new Date(Date.UTC(2026, 7, 4, 9, 45)))).toBe(15 * 60 + 15);
    // 00:00 IST == 18:30 UTC previous day — the case that used to yield hour 24
    expect(istMinutesSinceMidnight(new Date(Date.UTC(2026, 7, 3, 18, 30)))).toBe(0);
  });
});

describe('Auto square-off fires on deadline passed, not clock equality', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let manager: IntradayManager;
  let squareOffAll: ReturnType<typeof vi.fn>;

  // 15:15 IST == 09:45 UTC
  const at = (utcH: number, utcM: number) => new Date(Date.UTC(2026, 7, 4, utcH, utcM));

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useRealTimers();
    prisma = createMockPrisma();
    manager = new IntradayManager(prisma as any);
    squareOffAll = vi.fn().mockResolvedValue([]);
    (manager as any).squareOffAllIntraday = squareOffAll;
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  const tickAt = async (d: Date) => {
    vi.useFakeTimers();
    vi.setSystemTime(d);
    const fired = await manager.runSquareOffCheck();
    vi.useRealTimers();
    return fired;
  };

  it('does not fire before the deadline', async () => {
    expect(await tickAt(at(9, 44))).toBe(false); // 15:14 IST
    expect(squareOffAll).not.toHaveBeenCalled();
  });

  it('fires exactly at the deadline', async () => {
    expect(await tickAt(at(9, 45))).toBe(true); // 15:15 IST
    expect(squareOffAll).toHaveBeenCalledTimes(1);
  });

  it('still fires if every tick misses the target minute', async () => {
    // The regression: a drifting timer that never lands inside 15:15 used to
    // skip the square-off entirely. Jumping 15:14 -> 15:17 must still close.
    expect(await tickAt(at(9, 44))).toBe(false);
    expect(await tickAt(at(9, 47))).toBe(true); // 15:17 IST
    expect(squareOffAll).toHaveBeenCalledTimes(1);
  });

  it('fires once per day even though the interval ticks twice a minute', async () => {
    await tickAt(at(9, 45));
    await tickAt(at(9, 45));
    await tickAt(at(10, 30));
    expect(squareOffAll).toHaveBeenCalledTimes(1);
  });

  it('fires again on the next trading day', async () => {
    await tickAt(at(9, 45));
    expect(squareOffAll).toHaveBeenCalledTimes(1);
    // Next day, same time
    vi.useFakeTimers();
    vi.setSystemTime(new Date(Date.UTC(2026, 7, 5, 9, 45)));
    await manager.runSquareOffCheck();
    vi.useRealTimers();
    expect(squareOffAll).toHaveBeenCalledTimes(2);
  });

  it('squares off immediately when armed after the deadline (mid-session restart)', async () => {
    // Restarting at 15:20 must not silently skip the day's square-off
    expect(await tickAt(at(9, 50))).toBe(true); // 15:20 IST
    expect(squareOffAll).toHaveBeenCalledTimes(1);
  });

  it('refuses to run on a malformed square-off time instead of throwing', async () => {
    manager.setSquareOffTime('nonsense');
    expect(await tickAt(at(9, 50))).toBe(false);
    expect(squareOffAll).not.toHaveBeenCalled();
  });
});

describe('Circuit breaker marks positions from live quotes', () => {
  let prisma: ReturnType<typeof createMockPrisma>;
  let manager: IntradayManager;

  beforeEach(() => {
    vi.clearAllMocks();
    prisma = createMockPrisma();
    manager = new IntradayManager(prisma as any);
  });

  const compute = (positions: unknown[]) =>
    (manager as any).computeLiveUnrealized(positions) as Promise<{ unrealizedPnl: number; staleCount: number }>;

  it('prices LONG and SHORT positions from the live quote, ignoring the stored column', () => {
    getQuote.mockResolvedValue({ ltp: 2600 });

    return compute([
      // Stored unrealizedPnl is deliberately wrong — it must not be used.
      { symbol: 'RELIANCE', exchange: 'NSE', side: 'LONG', qty: 100, avgEntryPrice: 2500, unrealizedPnl: 0 },
      { symbol: 'TCS', exchange: 'NSE', side: 'SHORT', qty: 10, avgEntryPrice: 2500, unrealizedPnl: 999999 },
    ]).then(({ unrealizedPnl, staleCount }) => {
      // LONG: (2600-2500)*100 = +10,000 ; SHORT: (2500-2600)*10 = -1,000
      expect(unrealizedPnl).toBe(9_000);
      expect(staleCount).toBe(0);
    });
  });

  it('does NOT report a flat book when the quote feed is dead', async () => {
    // The regression this guards: position.unrealizedPnl is written only by
    // StopLossMonitor/PriceFeedService. If those are not running the column
    // freezes, and a breaker trusting it would compute ~0 drawdown mid-crash.
    getQuote.mockRejectedValue(new Error('feed down'));

    const { unrealizedPnl, staleCount } = await compute([
      { symbol: 'RELIANCE', exchange: 'NSE', side: 'LONG', qty: 100, avgEntryPrice: 2500, unrealizedPnl: -40_000 },
    ]);

    // Falls back to the last known mark rather than silently reporting zero,
    // and flags the position as stale so the caller can alarm.
    expect(unrealizedPnl).toBe(-40_000);
    expect(staleCount).toBe(1);
  });

  it('counts only the positions it could not price', async () => {
    getQuote.mockImplementation(async (symbol: string) => {
      if (symbol === 'TCS') throw new Error('no quote');
      return { ltp: 2400 };
    });

    const { unrealizedPnl, staleCount } = await compute([
      { symbol: 'RELIANCE', exchange: 'NSE', side: 'LONG', qty: 100, avgEntryPrice: 2500, unrealizedPnl: 0 },
      { symbol: 'TCS', exchange: 'NSE', side: 'LONG', qty: 10, avgEntryPrice: 2500, unrealizedPnl: -5_000 },
    ]);

    // RELIANCE live: (2400-2500)*100 = -10,000 ; TCS falls back to -5,000
    expect(unrealizedPnl).toBe(-15_000);
    expect(staleCount).toBe(1);
  });

  it('treats a zero or missing ltp as unpriced rather than a 100% loss', async () => {
    getQuote.mockResolvedValue({ ltp: 0 });

    const { unrealizedPnl, staleCount } = await compute([
      { symbol: 'RELIANCE', exchange: 'NSE', side: 'LONG', qty: 100, avgEntryPrice: 2500, unrealizedPnl: -1_000 },
    ]);

    // A naive (0 - 2500) * 100 would book a fake -250,000 and trip the breaker
    expect(unrealizedPnl).toBe(-1_000);
    expect(staleCount).toBe(1);
  });

  it('handles an empty book without calling the quote feed', async () => {
    const { unrealizedPnl, staleCount } = await compute([]);
    expect(unrealizedPnl).toBe(0);
    expect(staleCount).toBe(0);
    expect(getQuote).not.toHaveBeenCalled();
  });
});
