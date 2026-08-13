import { describe, it, expect, vi, beforeEach } from 'vitest';
import { OptionChainStoreService } from '../../src/services/option-chain-store.service.js';

/**
 * Option-chain history, and a real IV percentile.
 *
 * The percentile that existed before was computed from the IVs across strikes in
 * the CURRENT chain, because no history was stored. That measures position within
 * today's volatility SMILE, not within the underlying's own vol history — and
 * since a smile's wings carry higher IV than ATM, it returned a systematically
 * low number whatever the regime. A rule gated on "IV percentile is high" would
 * essentially never have fired.
 */
function makePrisma(rows: any[] = []) {
  return {
    optionChainSnapshot: {
      createMany: vi.fn().mockImplementation(async ({ data }: any) => ({ count: data.length })),
      findMany: vi.fn().mockResolvedValue(rows),
      findFirst: vi.fn().mockResolvedValue(null),
      groupBy: vi.fn().mockResolvedValue([]),
    },
  } as any;
}

const CHAIN = {
  underlyingValue: 24000,
  strikes: [
    { strike: 23800, callLTP: 320, callIV: 14.2, callOI: 500000, putLTP: 90, putIV: 15.1, putOI: 300000 },
    { strike: 24000, callLTP: 180, callIV: 13.0, callOI: 900000, putLTP: 175, putIV: 13.2, putOI: 850000 },
    { strike: 24200, callLTP: 85, callIV: 14.8, callOI: 700000, putLTP: 310, putIV: 15.6, putOI: 250000 },
  ],
};

describe('saveSnapshot', () => {
  let prisma: any;
  let store: OptionChainStoreService;

  beforeEach(() => {
    prisma = makePrisma();
    store = new OptionChainStoreService(prisma);
  });

  it('writes one row per strike per right', async () => {
    const res = await store.saveSnapshot('NIFTY', '2026-08-28', CHAIN);
    expect(res.rows).toBe(6); // 3 strikes x CE/PE
  });

  it('records the spot the premiums were priced against', async () => {
    await store.saveSnapshot('NIFTY', '2026-08-28', CHAIN);
    const rows = prisma.optionChainSnapshot.createMany.mock.calls[0][0].data;
    expect(rows.every((r: any) => r.underlyingValue === 24000)).toBe(true);
  });

  it('stores IV in percent, the same unit the live chain reports', async () => {
    await store.saveSnapshot('NIFTY', '2026-08-28', CHAIN);
    const rows = prisma.optionChainSnapshot.createMany.mock.calls[0][0].data;
    const atmCall = rows.find((r: any) => r.strike === 24000 && r.optionType === 'CE');
    expect(atmCall.iv).toBe(13.0);
  });

  it('is idempotent by construction', async () => {
    await store.saveSnapshot('NIFTY', '2026-08-28', CHAIN);
    expect(prisma.optionChainSnapshot.createMany.mock.calls[0][0].skipDuplicates).toBe(true);
  });

  it('skips rows carrying no price, IV or OI', async () => {
    await store.saveSnapshot('NIFTY', '2026-08-28', {
      underlyingValue: 24000,
      strikes: [{ strike: 25000, callLTP: 0, callIV: 0, callOI: 0, putLTP: 5, putIV: 20, putOI: 100 }],
    });
    const rows = prisma.optionChainSnapshot.createMany.mock.calls[0][0].data;
    expect(rows).toHaveLength(1);
    expect(rows[0].optionType).toBe('PE');
  });

  it('writes nothing for an empty chain instead of throwing', async () => {
    expect((await store.saveSnapshot('NIFTY', '2026-08-28', { strikes: [] })).rows).toBe(0);
    expect(prisma.optionChainSnapshot.createMany).not.toHaveBeenCalled();
  });

  it('rejects a malformed expiry', async () => {
    await expect(store.saveSnapshot('NIFTY', '28-08-2026', CHAIN)).rejects.toThrow();
  });
});

describe('getAtmIvHistory', () => {
  it('picks the strike nearest that capture\'s own spot, not a fixed strike', async () => {
    // Spot moves 24000 -> 25000; ATM must follow it.
    const rows = [
      { capturedAt: new Date('2026-08-12T10:00:00Z'), strike: 24000, iv: 13, underlyingValue: 24000 },
      { capturedAt: new Date('2026-08-12T10:00:00Z'), strike: 25000, iv: 17, underlyingValue: 24000 },
      { capturedAt: new Date('2026-08-13T10:00:00Z'), strike: 24000, iv: 19, underlyingValue: 25000 },
      { capturedAt: new Date('2026-08-13T10:00:00Z'), strike: 25000, iv: 12, underlyingValue: 25000 },
    ];
    const store = new OptionChainStoreService(makePrisma(rows));
    const hist = await store.getAtmIvHistory('NIFTY');

    expect(hist).toHaveLength(2);
    // Newest first: on the 13th spot was 25000, so ATM IV is 12, not 19.
    expect(hist[0].iv).toBe(12);
    expect(hist[1].iv).toBe(13);
  });
});

describe('getIvPercentile', () => {
  function historyRows(ivs: number[]) {
    return ivs.map((iv, i) => ({
      capturedAt: new Date(Date.UTC(2026, 6, i + 1, 10)),
      strike: 24000, iv, underlyingValue: 24000,
    }));
  }

  it('returns null when history is too thin, rather than a misleading number', async () => {
    const store = new OptionChainStoreService(makePrisma(historyRows([12, 13, 14])));
    const res = await store.getIvPercentile('NIFTY', 20);

    expect(res.percentile).toBeNull();
    expect(res.source).toBe('INSUFFICIENT_HISTORY');
    expect(res.observations).toBe(3);
  });

  it('computes a percentile from the time series once there is enough history', async () => {
    // 12 observations, 10..21. Current 20 sits above 8 of them.
    const store = new OptionChainStoreService(makePrisma(historyRows([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])));
    const res = await store.getIvPercentile('NIFTY', 20);

    expect(res.source).toBe('HISTORY');
    expect(res.observations).toBe(12);
    expect(res.percentile).toBe(Math.round((10 / 12) * 100));
  });

  it('reports a high percentile when current IV tops its history', async () => {
    const store = new OptionChainStoreService(makePrisma(historyRows([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])));
    const res = await store.getIvPercentile('NIFTY', 99);
    expect(res.percentile).toBe(100);
  });

  it('reports a low percentile when current IV is below its history', async () => {
    const store = new OptionChainStoreService(makePrisma(historyRows([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21])));
    const res = await store.getIvPercentile('NIFTY', 1);
    expect(res.percentile).toBe(0);
  });

  it('refuses a non-positive current IV', async () => {
    const store = new OptionChainStoreService(makePrisma(historyRows([10, 11, 12])));
    expect((await store.getIvPercentile('NIFTY', 0)).percentile).toBeNull();
  });

  it('spans the full range, unlike the smile-based version', async () => {
    // The old approach compared ATM IV against the wings of the SAME chain, so
    // it clustered low. A real percentile must be able to reach both ends.
    const rows = historyRows([10, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21]);
    const store = new OptionChainStoreService(makePrisma(rows));

    const low = await store.getIvPercentile('NIFTY', 9);
    const high = await store.getIvPercentile('NIFTY', 25);
    expect(low.percentile).toBe(0);
    expect(high.percentile).toBe(100);
  });
});

describe('captureEodChains', () => {
  it('captures every underlying and reports row counts', async () => {
    const prisma = makePrisma();
    const store = new OptionChainStoreService(prisma);
    const fetch = vi.fn().mockResolvedValue({ ...CHAIN, expiry: '2026-08-28' });

    const res = await store.captureEodChains(['NIFTY', 'BANKNIFTY'], fetch);

    expect(res.captured).toBe(2);
    expect(res.rows).toBe(12); // 6 rows each
    expect(res.failed).toEqual([]);
  });

  it('keeps going when one underlying fails — a missed day is unrecoverable', async () => {
    const store = new OptionChainStoreService(makePrisma());
    const fetch = vi.fn()
      .mockRejectedValueOnce(new Error('bridge timeout'))
      .mockResolvedValueOnce({ ...CHAIN, expiry: '2026-08-28' });

    const res = await store.captureEodChains(['NIFTY', 'BANKNIFTY'], fetch);

    expect(res.captured).toBe(1);
    expect(res.failed).toHaveLength(1);
    expect(res.failed[0]).toMatch(/NIFTY.*bridge timeout/);
  });

  it('records a chain with no expiry as failed rather than guessing one', async () => {
    const store = new OptionChainStoreService(makePrisma());
    const res = await store.captureEodChains(['NIFTY'], vi.fn().mockResolvedValue({ ...CHAIN }));

    expect(res.captured).toBe(0);
    expect(res.failed[0]).toMatch(/no expiry/);
  });
});

describe('pruneOlderThan', () => {
  it('deletes only rows past the retention window', async () => {
    const prisma = makePrisma();
    prisma.optionChainSnapshot.deleteMany = vi.fn().mockResolvedValue({ count: 7 });
    const store = new OptionChainStoreService(prisma);

    const res = await store.pruneOlderThan(400);

    expect(res.deleted).toBe(7);
    const cutoff = prisma.optionChainSnapshot.deleteMany.mock.calls[0][0].where.capturedAt.lt as Date;
    const days = (Date.now() - cutoff.getTime()) / 86_400_000;
    expect(days).toBeGreaterThan(399);
    expect(days).toBeLessThan(401);
  });

  it('defaults to 400 days, covering the 52 weeks an IV rank needs', async () => {
    const prisma = makePrisma();
    prisma.optionChainSnapshot.deleteMany = vi.fn().mockResolvedValue({ count: 0 });
    const store = new OptionChainStoreService(prisma);

    await store.pruneOlderThan();

    const cutoff = prisma.optionChainSnapshot.deleteMany.mock.calls[0][0].where.capturedAt.lt as Date;
    expect((Date.now() - cutoff.getTime()) / 86_400_000).toBeGreaterThan(399);
  });

  it('refuses a nonsensical window instead of deleting everything', async () => {
    const store = new OptionChainStoreService(makePrisma());
    await expect(store.pruneOlderThan(0)).rejects.toThrow(/at least 1 day/);
    await expect(store.pruneOlderThan(-5)).rejects.toThrow();
  });
});
