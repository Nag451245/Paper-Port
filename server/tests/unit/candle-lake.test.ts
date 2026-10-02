import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  aggregate, readBars, writeDaily, writeIntraday, readManifest, lakeSize, lakeInterval,
} from '../../src/lib/candle-lake.js';
import { CandleLakeSync, LAKE_LIMITS } from '../../src/services/candle-lake-sync.service.js';

/** A day of 5-minute candles, 09:15 to 15:25 IST, price stepping up by 1. */
function session(day: string, start = 100) {
  return Array.from({ length: 75 }, (_, i) => {
    const m = 9 * 60 + 15 + i * 5;
    const p = start + i;
    return {
      timestamp: `${day} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`,
      open: p, high: p + 0.5, low: p - 0.5, close: p + 0.25, volume: 100,
    };
  });
}

let dir: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-'));
  process.env.MARKET_DATA_DIR = dir;
});
afterEach(() => {
  delete process.env.MARKET_DATA_DIR;
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('candle lake files', () => {
  it('builds 15-minute and 1-hour candles aligned to the 09:15 open', () => {
    const day = session('2025-03-03');
    const q = aggregate(day, 15);
    expect(q).toHaveLength(25);
    expect(q[0]).toMatchObject({ timestamp: '2025-03-03 09:15:00', open: 100, high: 102.5, low: 99.5, close: 102.25, volume: 300 });
    const h = aggregate(day, 60);
    expect(h.map((b) => b.timestamp.slice(11, 16))).toEqual(['09:15', '10:15', '11:15', '12:15', '13:15', '14:15', '15:15']);
    expect(h[6].volume).toBe(300);                         // 15:15–15:30 is a short last hour
  });

  it('round-trips candles across months and merges re-fetched days', () => {
    writeIntraday('TCS', [...session('2025-02-28'), ...session('2025-03-03')]);
    writeIntraday('TCS', session('2025-03-03', 200));          // a corrected re-fetch replaces the day
    const bars = readBars('TCS', '5m', '2025-02-28', '2025-03-03');
    expect(bars).toHaveLength(150);
    expect(bars[0]).toMatchObject({ timestamp: '2025-02-28 09:15:00', open: 100 });
    expect(bars[75].open).toBe(200);
    expect(fs.readdirSync(path.join(dir, '5m', 'TCS')).sort()).toEqual(['2025-02.csv.gz', '2025-03.csv.gz']);
    expect(readBars('TCS', '1h', '2025-03-03', '2025-03-03')).toHaveLength(7);
    expect(readBars('TCS', '5m', '2025-03-04', '2025-03-31')).toEqual([]);
  });

  it('keeps daily candles by date and serves a date range', () => {
    writeDaily('TCS', [{ timestamp: '2025-03-03', open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 }]);
    writeDaily('TCS', [{ timestamp: '2025-03-04', open: 2, high: 3, low: 1.5, close: 2.5, volume: 9 }]);
    expect(readBars('TCS', '1d', '2025-03-01', '2025-03-31').map((b) => b.timestamp)).toEqual(['2025-03-03', '2025-03-04']);
  });

  it('stores a session in a few kilobytes', () => {
    writeIntraday('TCS', session('2025-03-03'));
    expect(lakeSize()).toBeLessThan(3_000);
  });

  it('maps app interval names', () => {
    expect([lakeInterval('5minute'), lakeInterval('15m'), lakeInterval('1hour'), lakeInterval('day'), lakeInterval('1minute')])
      .toEqual(['5m', '15m', '1h', '1d', null]);
  });
});

describe('CandleLakeSync', () => {
  const now = () => new Date('2026-10-05T12:00:00Z');                 // 17:30 IST, Monday
  const noSleep = async () => {};

  it('walks 5-minute history backwards window by window and stops when the broker runs dry', async () => {
    const fetch = vi.fn(async (_s: string, interval: string, from: string, to: string) => {
      if (interval !== '5minute') return { bars: [{ timestamp: '2020-01-01', open: 1, high: 1, low: 1, close: 1, volume: 1 }], source: 'upstox' as const, brokerConnected: true };
      // This broker only has history from 2026-08-01.
      return to < '2026-08-01'
        ? { bars: [], source: null, brokerConnected: true }
        : { bars: session(from < '2026-08-01' ? '2026-08-03' : from), source: 'upstox' as const, brokerConnected: true };
    });
    const sync = new CandleLakeSync(fetch, () => ['TCS'], now, noSleep);
    await sync.backfill(50);
    const m = readManifest().TCS;
    expect(m).toMatchObject({ dailyComplete: true, intradayComplete: true });
    const windows = fetch.mock.calls.filter((c) => c[1] === '5minute');
    // windows tile backwards with no gaps
    for (let i = 1; i < windows.length; i++) {
      const dayAfter = new Date(Date.parse(`${windows[i][3]}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);
      expect(dayAfter).toBe(windows[i - 1][2]);
    }
    expect(windows.slice(-LAKE_LIMITS.emptyWindowsToStop).every((c) => c[3] < '2026-08-01')).toBe(true);
  });

  it('pauses without marking anything complete when no broker is logged in', async () => {
    const fetch = vi.fn(async () => ({ bars: [], source: null, brokerConnected: false }));
    const sync = new CandleLakeSync(fetch as any, () => ['TCS'], now, noSleep);
    await sync.backfill(50);
    expect(readManifest().TCS?.intradayComplete).toBeUndefined();
    expect(fetch.mock.calls.filter((c: any) => c[1] === '5minute')).toHaveLength(1);
  });

  it('respects the per-run budget', async () => {
    const fetch = vi.fn(async (_s: string, _i: string, from: string) => ({ bars: session(from), source: 'upstox' as const, brokerConnected: true }));
    const sync = new CandleLakeSync(fetch, () => ['A', 'B', 'C'], now, noSleep);
    const r = await sync.backfill(5);
    expect(r?.requests).toBe(5);
    expect(fetch).toHaveBeenCalledTimes(5);
  });

  it('syncs recent sessions for every stock after the close', async () => {
    const fetch = vi.fn(async (_s: string, interval: string) => (interval === '5minute'
      ? { bars: session('2026-10-05'), source: 'upstox' as const, brokerConnected: true }
      : { bars: [{ timestamp: '2026-10-05', open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 }], source: 'upstox' as const, brokerConnected: true }));
    const sync = new CandleLakeSync(fetch, () => ['TCS', 'INFY'], now, noSleep);
    expect(await sync.sync()).toMatchObject({ symbols: 2, stoppedEarly: false });
    expect(readBars('INFY', '15m', '2026-10-05', '2026-10-05')).toHaveLength(25);
    expect(sync.status()).toMatchObject({ stocks: 2, withIntraday: 2 });
  });
});
