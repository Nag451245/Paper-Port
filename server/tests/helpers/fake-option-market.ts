import { vi } from 'vitest';

/** A fake ICICI: contracts exist only for `expiries`; 5-minute candles 09:15–15:25 on weekdays. */
export function fakeMarket(expiries: Set<string>, opts: { fail?: boolean; holidays?: Set<string> } = {}) {
  const calls: string[] = [];
  const days = (from: string, to: string) => {
    const out: string[] = [];
    for (let d = from; d <= to; d = new Date(Date.parse(`${d}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10)) {
      const wd = new Date(`${d}T00:00:00Z`).getUTCDay();
      if (wd !== 0 && wd !== 6 && !opts.holidays?.has(d)) out.push(d);
    }
    return out;
  };
  const candles = (from: string, to: string, price: (i: number) => number) => days(from, to).flatMap((d) =>
    Array.from({ length: 75 }, (_, i) => {
      const m = 9 * 60 + 15 + i * 5;
      const ts = `${d} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`;
      const p = price(i);
      return { timestamp: ts, open: p, high: p, low: p, close: p, volume: 10 };
    }));
  return {
    calls,
    optionContractHistory: vi.fn(async (u: string, expiry: string, strike: number, type: 'CE' | 'PE', from: string, to: string) => {
      calls.push(`${u} ${expiry} ${strike}${type}`);
      if (opts.fail) return { bars: [], error: 'ICICI Breeze is not connected' };
      if (!expiries.has(expiry)) return { bars: [] };
      // Calls lose 1 a candle from 100; puts are flat at 100.
      return { bars: candles(from, [to, expiry].sort()[0], (i) => (type === 'CE' ? 100 - i * 0.5 : 100)) };
    }),
    getHistory: vi.fn(async (_u: string, interval: string, from: string, to: string) =>
      interval === '1day' ? days(from, to).map((d) => ({ timestamp: d, open: 22410, high: 22410, low: 22410, close: 22410, volume: 0 })) : []),
  };
}
