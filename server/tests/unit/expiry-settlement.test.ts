import { describe, it, expect, vi } from 'vitest';
import { ExpirySettlementService, intrinsicAtExpiry } from '../../src/services/expiry-settlement.service.js';

const now = new Date('2026-10-07T05:00:00Z');                           // 10:30 IST on 7 October
const expired = new Date('2026-10-05T18:30:00Z');                       // 6 October, IST midnight
const today = new Date('2026-10-06T18:30:00Z');                         // 7 October: still trading at 10:30
const pos = (id: string, symbol: string, side: string, over: Record<string, unknown> = {}) => ({
  id, symbol, exchange: 'NFO', side, qty: 65, status: 'OPEN', instrumentType: 'OPTIONS', underlying: 'NIFTY', expiry: expired,
  strike: Number(symbol.slice(-7, -2)), optionType: symbol.slice(-2), portfolio: { userId: 'u1' }, ...over,
});
const service = (rows: unknown[], settle: number | null) => {
  const findMany = vi.fn(async ({ where }: any) => rows.filter((r: any) => r.expiry && r.expiry <= where.expiry.lte));
  const close = vi.fn(async () => ({}));
  const dailyClose = vi.fn(async () => settle);
  return { svc: new ExpirySettlementService({ position: { findMany } } as any, close, dailyClose), close, dailyClose };
};

describe('settlement of expired options', () => {
  it('values an option at what it is worth at expiry', () => {
    expect(intrinsicAtExpiry('CE', 22_550, 22_690.4)).toBe(140.4);
    expect(intrinsicAtExpiry('CE', 22_550, 22_500)).toBe(0);
    expect(intrinsicAtExpiry('PE', 22_350, 22_300)).toBe(50);
    expect(intrinsicAtExpiry('PE', 22_350, 22_690.4)).toBe(0);
  });

  it('settles a short strangle: the call in the money, the put worthless, sold legs before bought ones', async () => {
    const rows = [
      pos('hedge', 'NIFTY2026100622800CE', 'LONG'),
      pos('call', 'NIFTY2026100622550CE', 'SHORT'),
      pos('put', 'NIFTY2026100622350PE', 'SHORT'),
    ];
    const { svc, close, dailyClose } = service(rows, 22_690.4);
    const r = await svc.settleExpired(now);
    expect(close.mock.calls.map((c) => c[0])).toEqual(['call', 'put', 'hedge']);             // sold first
    expect(close.mock.calls.map((c) => c[2])).toEqual([140.4, 0, 0]);
    expect(dailyClose).toHaveBeenCalledTimes(1);                                              // one lookup for the underlying and day
    expect(dailyClose).toHaveBeenCalledWith('NIFTY', '2026-10-06');
    expect(r.settled).toHaveLength(3);
    expect(r.waiting).toHaveLength(0);
  });

  it('leaves alone an option that is still trading today', async () => {
    const { svc, close } = service([pos('live', 'NIFTY2026100722550CE', 'SHORT', { expiry: today })], 22_690);
    expect((await svc.settleExpired(now)).settled).toHaveLength(0);
    expect(close).not.toHaveBeenCalled();
    // The same option is settled once its last trading day has ended.
    const after = service([pos('live', 'NIFTY2026100722550CE', 'SHORT', { expiry: today })], 22_690);
    expect((await after.svc.settleExpired(new Date('2026-10-07T10:12:00Z'))).settled).toHaveLength(1);   // 15:42 IST
  });

  it('never settles at a guessed price: without the closing value it waits and says so', async () => {
    const { svc, close } = service([pos('call', 'NIFTY2026100622550CE', 'SHORT')], null);
    const r = await svc.settleExpired(now);
    expect(close).not.toHaveBeenCalled();
    expect(r.waiting[0].why).toMatch(/no closing value for NIFTY on 2026-10-06/);
  });

  it('reports expired futures instead of settling them, and survives a failed close', async () => {
    const failing = service([
      pos('fut', 'NIFTY20261006FUT', 'LONG', { instrumentType: 'FUTURES', optionType: null, strike: null }),
      pos('call', 'NIFTY2026100622550CE', 'SHORT'),
    ], 22_690.4);
    failing.close.mockRejectedValueOnce(new Error('insufficient cash'));
    const r = await failing.svc.settleExpired(now);
    expect(r.settled).toHaveLength(0);
    expect(r.waiting.map((w) => w.why).sort()).toEqual(['could not be closed: insufficient cash', 'not an option: settle it by hand']);
  });
});
