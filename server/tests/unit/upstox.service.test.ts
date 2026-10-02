import { describe, it, expect, vi, onTestFinished } from 'vitest';
import { gzipSync } from 'zlib';
import { UpstoxService, buildMaps, resolveKey, upstoxInterval, mapOptionChain } from '../../src/services/upstox.service.js';

const MASTER = [
  { segment: 'NSE_EQ', instrument_type: 'EQ', trading_symbol: 'RELIANCE', instrument_key: 'NSE_EQ|INE002A01018' },
  { segment: 'BSE_EQ', instrument_type: 'EQ', trading_symbol: 'RELIANCE', instrument_key: 'BSE_EQ|INE002A01018' },
  // 2026-10-29 23:59:59 IST
  { segment: 'NSE_FO', instrument_type: 'CE', underlying_symbol: 'NIFTY', expiry: Date.parse('2026-10-29T23:59:59+05:30'), strike_price: 24000.0, instrument_key: 'NSE_FO|111' },
  { segment: 'NSE_FO', instrument_type: 'FUT', underlying_symbol: 'NIFTY', expiry: Date.parse('2026-10-29T23:59:59+05:30'), strike_price: 0, instrument_key: 'NSE_FO|222' },
];

const json = (body: unknown, ok = true, status = 200) =>
  ({ ok, status, json: () => Promise.resolve(body), arrayBuffer: () => Promise.resolve(new ArrayBuffer(0)) }) as any;

function fakeFetch(handler: (url: string) => any) {
  return vi.fn(async (url: any) => {
    const u = String(url);
    if (u.includes('instruments/exchange/')) {
      const gz = gzipSync(Buffer.from(JSON.stringify(u.includes('NSE') ? MASTER : [])));
      return { ok: true, status: 200, arrayBuffer: () => Promise.resolve(gz.buffer.slice(gz.byteOffset, gz.byteOffset + gz.byteLength)) } as any;
    }
    return handler(u);
  });
}

describe('instrument keys', () => {
  const maps = buildMaps(MASTER);

  it('maps stocks by exchange, indices by name, and contracts by their full identity', () => {
    expect(resolveKey(maps, 'reliance')).toBe('NSE_EQ|INE002A01018');
    expect(resolveKey(maps, 'RELIANCE', 'BSE')).toBe('BSE_EQ|INE002A01018');
    expect(resolveKey(maps, 'NIFTY')).toBe('NSE_INDEX|Nifty 50');
    expect(resolveKey(maps, 'NIFTY2026102924000CE')).toBe('NSE_FO|111');
    expect(resolveKey(maps, 'NIFTY20261029FUT')).toBe('NSE_FO|222');
  });

  it('answers null for what Upstox is not asked for', () => {
    expect(resolveKey(maps, 'NIFTY2026102924000PE')).toBeNull();
    expect(resolveKey(maps, 'CRUDEOIL', 'MCX')).toBeNull();
    expect(resolveKey(maps, 'NOSUCH')).toBeNull();
  });

  it('maps app intervals to Upstox units with their range limits', () => {
    expect(upstoxInterval('5minute')).toEqual({ unit: 'minutes', n: 5, windowDays: 28 });
    expect(upstoxInterval('1hour')).toEqual({ unit: 'hours', n: 1, windowDays: 85 });
    expect(upstoxInterval('1day')).toEqual({ unit: 'days', n: 1, windowDays: 3600 });
    expect(upstoxInterval('7minute')).toBeNull();
  });
});

describe('history', () => {
  it('splits a long range into allowed windows and returns candles oldest first in Indian time', async () => {
    const f = fakeFetch(() => json({ status: 'success', data: { candles: [
      ['2026-09-01T09:20:00+05:30', 101, 102, 100, 101.5, 900, 0],
      ['2026-09-01T09:15:00+05:30', 100, 101, 99, 100.5, 1000, 0],
    ] } }));
    const bars = await new UpstoxService(f).history('tok', 'RELIANCE', '5minute', '2026-08-01', '2026-09-30');

    const calls = f.mock.calls.map((c) => String(c[0])).filter((u) => u.includes('historical-candle'));
    expect(calls).toHaveLength(3);                                    // 61 days in 28-day windows
    expect(calls[0]).toContain('/v3/historical-candle/NSE_EQ%7CINE002A01018/minutes/5/2026-08-28/2026-08-01');
    expect(bars.map((b) => b.timestamp)).toEqual(['2026-09-01 09:15:00', '2026-09-01 09:20:00']);
    expect(f.mock.calls.find((c) => String(c[0]).includes('historical'))![1].headers.Authorization).toBe('Bearer tok');
  });

  it('returns nothing rather than a series with a hole when a window fails', async () => {
    let n = 0;
    const f = fakeFetch(() => (++n === 2
      ? json({ status: 'error', errors: [{ message: 'Invalid token' }] }, false, 401)
      : json({ status: 'success', data: { candles: [['2026-08-02T09:15:00+05:30', 1, 1, 1, 1, 1, 0]] } })));
    expect(await new UpstoxService(f).history('tok', 'RELIANCE', '5minute', '2026-08-01', '2026-09-30')).toEqual([]);
  });
});

describe('quote', () => {
  it('maps the full quote, with change measured from the previous close', async () => {
    const f = fakeFetch(() => json({ status: 'success', data: { 'NSE_EQ:RELIANCE': {
      last_price: 1210, net_change: 10, volume: 5000, ohlc: { open: 1201, high: 1215, low: 1199, close: 1210 },
      depth: { buy: [{ price: 1209.9, quantity: 50 }], sell: [{ price: 1210.1, quantity: 40 }] },
      timestamp: '2026-10-01T10:00:00.000+05:30',
    } } }));
    const q = await new UpstoxService(f).quote('tok', 'RELIANCE');
    expect(q).toMatchObject({ ltp: 1210, change: 10, close: 1200, changePercent: 0.83, bidPrice: 1209.9, askQty: 40 });
  });
});

describe('rejected login', () => {
  it('reports a token Upstox refuses, once per failed call, and serves nothing from it', async () => {
    const f = fakeFetch(() => json({ status: 'error', errors: [{ message: 'Invalid token used to access API' }] }, false, 401));
    const svc = new UpstoxService(f);
    const rejected: string[] = [];
    svc.onAuthFailure = (t) => rejected.push(t);
    expect(await svc.quote('stale-token', 'RELIANCE')).toBeNull();
    expect(rejected).toEqual(['stale-token']);
  });

  it('does not treat other failures as a bad login', async () => {
    const f = fakeFetch(() => json({ status: 'error', errors: [{ message: 'Too many requests' }] }, false, 429));
    const svc = new UpstoxService(f);
    const rejected: string[] = [];
    svc.onAuthFailure = (t) => rejected.push(t);
    await svc.quote('tok', 'RELIANCE');
    expect(rejected).toEqual([]);
  });
});

describe('option chain', () => {
  const row = (strike: number, callOI: number, putOI: number) => ({
    strike_price: strike, underlying_spot_price: 24010, expiry: '2026-10-29',
    call_options: { instrument_key: 'NSE_FO|1', market_data: { ltp: 120, volume: 10, oi: callOI, close_price: 100, bid_price: 119, ask_price: 121, prev_oi: callOI - 5 }, option_greeks: { iv: 14.2, delta: 0.52, gamma: 0.001, theta: -9, vega: 12 } },
    put_options: { instrument_key: 'NSE_FO|2', market_data: { ltp: 95, volume: 20, oi: putOI, close_price: 110, bid_price: 94, ask_price: 96, prev_oi: putOI + 10 }, option_greeks: { iv: 15.1, delta: -0.48, gamma: 0.001, theta: -8, vega: 11 } },
  });

  it('maps Upstox rows into the app\'s chain, with the right max pain', () => {
    const chain = mapOptionChain('nifty', '2026-10-29', ['2026-10-29'], 75, [row(24100, 50, 900), row(23900, 900, 50), row(24000, 300, 300)]);
    expect(chain.strikes.map((s) => s.strike)).toEqual([23900, 24000, 24100]);
    expect(chain.strikes[1]).toMatchObject({ callLTP: 120, callOIChange: 5, callNetChange: 20, callIV: 14.2, putOIChange: -10, putNetChange: -15, putDelta: -0.48 });
    expect(chain).toMatchObject({ symbol: 'NIFTY', spotPrice: 24010, lotSize: 75, source: 'upstox', pcr: 1 });
    expect(mapOptionChain('X', 'e', [], 1, [row(100, 0, 1000), row(200, 10, 10), row(300, 500, 0)]).maxPain).toBe(200);
  });

  it('asks for the nearest upcoming expiry by default', async () => {
    vi.useFakeTimers({ toFake: ['Date'], now: new Date('2026-10-02T10:00:00+05:30') });   // before the 29 Oct expiry
    onTestFinished(() => vi.useRealTimers());
    const f = fakeFetch(() => json({ status: 'success', data: [row(24000, 1, 1)] }));
    const chain = await new UpstoxService(f).optionChain('tok', 'NIFTY');
    const url = f.mock.calls.map((c) => String(c[0])).find((u) => u.includes('/option/chain'))!;
    expect(url).toContain('instrument_key=NSE_INDEX%7CNifty%2050');
    expect(url).toContain('expiry_date=2026-10-29');
    expect(chain?.expiries).toEqual(['2026-10-29']);
  });
});
