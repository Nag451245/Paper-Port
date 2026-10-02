import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { MtfShadowScan } from '../../src/services/mtf-shadow.service.js';
import { writeIntraday, writeDaily } from '../../src/lib/candle-lake.js';
import { istDaysAgo } from '../../src/lib/ist.js';

const session = (day: string) => Array.from({ length: 75 }, (_, i) => {
  const m = 9 * 60 + 15 + i * 5;
  return { timestamp: `${day} ${String(Math.floor(m / 60)).padStart(2, '0')}:${String(m % 60).padStart(2, '0')}:00`, open: 100, high: 101, low: 99, close: 100, volume: 10 };
});

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'lake-')); process.env.MARKET_DATA_DIR = dir; });
afterEach(() => { delete process.env.MARKET_DATA_DIR; fs.rmSync(dir, { recursive: true, force: true }); });

describe('MtfShadowScan', () => {
  it('feeds the engine every timeframe from the lake plus today, and records its signals as "mtf"', async () => {
    const days = [5, 4, 3, 2, 1].map((n) => istDaysAgo(n));
    writeIntraday('TCS', days.flatMap(session));
    writeDaily('TCS', Array.from({ length: 80 }, (_, i) => ({ timestamp: istDaysAgo(80 - i), open: 1, high: 2, low: 0.5, close: 1.5, volume: 9 })));
    const market = { getHistory: vi.fn(async () => []) };
    const record = vi.fn(async (sigs: any[]) => sigs.length);
    const scan = vi.fn(async () => ({ signals: [
      { symbol: 'TCS', direction: 'LONG', confidence: 0.6, entry: 100, stop_loss: 98, target: 103 },
      { symbol: 'TCS', direction: 'NEUTRAL', confidence: 0.6, entry: 100, stop_loss: 98, target: 103 },
    ] }));
    const mtf = new MtfShadowScan(market as any, { record } as any, scan);

    const today = session(istDaysAgo(0)).slice(0, 20);
    expect(await mtf.run([{ symbol: 'TCS', bars5m: today }])).toBe(1);

    const input = (scan.mock.calls[0] as any[])[0].symbols[0];
    expect(input.candles_5m).toHaveLength(150);
    expect(input.candles_15m.length).toBeGreaterThanOrEqual(120);
    expect(input.candles_1h.length).toBe(5 * 7 + 2);              // five full sessions + today's first 100 minutes
    expect(input.candles_daily.length).toBeGreaterThanOrEqual(60);
    expect(market.getHistory).not.toHaveBeenCalled();             // the lake had everything
    expect(record.mock.calls[0][0]).toEqual([expect.objectContaining({ symbol: 'TCS', direction: 'BUY', strategy: 'mtf', stop_loss: 98 })]);
  });

  it('runs at most every 15 minutes and fetches what the lake lacks once a day', async () => {
    let now = new Date('2026-10-05T05:00:00Z');
    const market = { getHistory: vi.fn(async () => []) };
    const scan = vi.fn(async () => ({ signals: [] }));
    const mtf = new MtfShadowScan(market as any, { record: vi.fn(async () => 0) } as any, scan, () => now);
    await mtf.run([{ symbol: 'INFY', bars5m: [] }]);
    now = new Date('2026-10-05T05:05:00Z');
    await mtf.run([{ symbol: 'INFY', bars5m: [] }]);
    expect(scan).toHaveBeenCalledTimes(1);
    now = new Date('2026-10-05T05:16:00Z');
    await mtf.run([{ symbol: 'INFY', bars5m: [] }]);
    expect(scan).toHaveBeenCalledTimes(2);
    expect(market.getHistory).toHaveBeenCalledTimes(2);            // 5-minute + daily, once for the day
  });
});
