import { describe, it, expect, vi } from 'vitest';
import { settle, evidenceFor, INTRADAY_COST, EVIDENCE_RULE, type Bar } from '../../src/lib/shadow-math.js';
import { ShadowBook } from '../../src/services/shadow-book.service.js';

const bar = (hhmm: string, open: number, high: number, low: number, close: number): Bar =>
  ({ timestamp: `2026-10-05 ${hhmm}:00`, open, high, low, close });
const ist = (hhmm: string) => new Date(`2026-10-05T${hhmm}:00+05:30`);
const buy = { side: 'BUY' as const, signalAt: ist('10:02'), stopDist: 2, targetDist: 4 };

describe('settle', () => {
  it('enters at the open of the next candle, never at the signal price', () => {
    const s = settle(buy, [bar('10:00', 99, 101, 98, 100), bar('10:05', 100.5, 101, 100, 100.8)], false);
    expect(s).toMatchObject({ status: 'OPEN', entry: 100.5 });
  });

  it('takes the target, net of costs, measured in R', () => {
    const s = settle(buy, [bar('10:05', 100, 101, 99.5, 100.5), bar('10:10', 101, 104.5, 100.8, 104)], false);
    expect(s).toMatchObject({ status: 'CLOSED', exitReason: 'target', exitPrice: 104 });
    if (s.status === 'CLOSED') expect(s.rMultiple).toBeCloseTo((4 - INTRADAY_COST * 100) / 2, 9);
  });

  it('counts a candle touching both levels as a stop', () => {
    const s = settle(buy, [bar('10:05', 100, 104.5, 97.5, 101)], false);
    expect(s).toMatchObject({ status: 'CLOSED', exitReason: 'stop', exitPrice: 98 });
  });

  it('fills a gap through the stop at the open, worse than the stop', () => {
    const s = settle(buy, [bar('10:05', 100, 100.5, 99.5, 100), bar('10:10', 96, 96.5, 95, 96)], false);
    expect(s).toMatchObject({ status: 'CLOSED', exitReason: 'stop', exitPrice: 96 });
  });

  it('mirrors everything for a short', () => {
    const s = settle({ ...buy, side: 'SELL' }, [bar('10:05', 100, 100.2, 95.5, 96)], false);
    expect(s).toMatchObject({ status: 'CLOSED', exitReason: 'target', exitPrice: 96 });
  });

  it('squares off at 15:15, and voids a trade with no candles once the day is over', () => {
    const s = settle(buy, [bar('10:05', 100, 100.5, 99.5, 100), bar('15:15', 100.7, 101, 100.5, 100.9)], false);
    expect(s).toMatchObject({ status: 'CLOSED', exitReason: 'session-end', exitPrice: 100.7 });
    expect(settle(buy, [], true)).toEqual({ status: 'VOID', exitReason: 'no-data' });
    expect(settle(buy, [], false)).toEqual({ status: 'OPEN' });
  });
});

describe('evidence', () => {
  const many = (n: number, r: (i: number) => number) => Array.from({ length: n }, (_, i) => ({ r: r(i), net: r(i) / 100 }));

  it('stays unproven until there are enough trades, however good they look', () => {
    expect(evidenceFor('orb', many(EVIDENCE_RULE.minTrades - 1, (i) => (i % 2 ? 2 : -0.5))).verdict).toBe('unproven');
  });

  it('proves a clearly positive record and disproves a clearly negative one', () => {
    expect(evidenceFor('orb', many(200, (i) => (i % 2 ? 1.2 : -0.8))).verdict).toBe('proven');
    expect(evidenceFor('composite', many(200, (i) => (i % 2 ? 0.8 : -1.2))).verdict).toBe('disproven');
    expect(evidenceFor('noise', many(200, (i) => (i % 2 ? 1 : -1))).verdict).toBe('unproven');
  });
});

describe('ShadowBook', () => {
  const signal = (over: Partial<any> = {}) => ({
    symbol: 'TCS', direction: 'BUY', confidence: 0.6, entry: 100, stop_loss: 98, target: 104,
    indicators: {}, votes: {}, strategy: 'orb', ...over,
  }) as any;

  function setup(now = ist('10:02')) {
    const rows: any[] = [];
    const prisma = {
      shadowTrade: {
        create: vi.fn(async ({ data }: any) => {
          if (rows.some((r) => r.strategy === data.strategy && r.symbol === data.symbol && r.side === data.side && r.day === data.day)) {
            throw Object.assign(new Error('unique'), { code: 'P2002' });
          }
          rows.push({ id: String(rows.length), status: 'OPEN', entry: null, ...data });
        }),
        findMany: vi.fn(async ({ where }: any) => rows.filter((r) => r.status === where.status)
          .map((r) => ({ ...r, rMultiple: r.rMultiple ?? null, netReturn: r.netReturn ?? null }))),
        update: vi.fn(async ({ where, data }: any) => Object.assign(rows.find((r) => r.id === where.id), data)),
      },
    } as any;
    const market = { getHistory: vi.fn(async () => [bar('10:05', 100, 104.5, 99.5, 104)]) };
    return { rows, market, book: new ShadowBook(prisma, market as any, () => now) };
  }

  it('records one trade per strategy, stock, side and day however often it repeats', async () => {
    const { book, rows } = setup();
    await book.record([signal(), signal(), signal({ strategy: 'composite' }), signal({ direction: 'SELL', stop_loss: 102, target: 96 })]);
    await book.record([signal()]);
    expect(rows.map((r) => `${r.strategy}:${r.side}`)).toEqual(['orb:BUY', 'composite:BUY', 'orb:SELL']);
    expect(rows[0]).toMatchObject({ day: '2026-10-05', stopDist: 2, targetDist: 4, signalPrice: 100 });
  });

  it('skips indices, contracts, option strategies, bad levels and signals outside 09:15–15:00', async () => {
    const { book, rows } = setup();
    await book.record([
      signal({ symbol: 'NIFTY' }), signal({ symbol: 'NIFTY2026102924000CE' }), signal({ strategy: 'expiry_theta' }),
      signal({ stop_loss: 100 }), signal({ direction: 'NEUTRAL' }),
    ]);
    expect(rows).toHaveLength(0);
    const late = setup(ist('15:05'));
    await late.book.record([signal()]);
    expect(late.rows).toHaveLength(0);
  });

  it('settles open trades on 5-minute candles and reports evidence per strategy', async () => {
    const { book, rows } = setup();
    await book.record([signal(), signal({ strategy: 'pairs:TCS_INFY' })]);
    const res = await book.settleOpen();
    expect(res).toEqual({ closed: 2, voided: 0, open: 0 });
    expect(rows[0]).toMatchObject({ status: 'CLOSED', exitReason: 'target', entry: 100, exitPrice: 104 });
    const ev = await book.evidence();
    expect(ev.map((e) => e.strategy).sort()).toEqual(['orb', 'pairs']);
    expect(await book.isProven('orb')).toBe(false);                 // 1 trade proves nothing
  });
});
