import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

// The candle store is the first place getHistory looks; each test sets what it holds.
const findMany = vi.fn();
vi.mock('../../src/lib/prisma.js', () => ({
  getPrisma: () => ({ candleStore: { findMany, upsert: vi.fn().mockResolvedValue({}) } }),
}));

import {
  MarketDataService, coversRange, barsPerSession, isDailyInterval, formatBarTime, barInstant, type HistoricalBar,
} from '../../src/services/market-data.service.js';

const bar = (timestamp: string, close = 100): HistoricalBar =>
  ({ timestamp, open: close, high: close + 1, low: close - 1, close, volume: 10 });

function bridgeReply(bars: HistoricalBar[]) {
  return vi.fn().mockResolvedValue({ ok: true, json: () => Promise.resolve({ bars }) } as any);
}

describe('history for backtests', () => {
  let service: MarketDataService;
  let originalFetch: typeof globalThis.fetch;

  beforeEach(() => {
    service = new MarketDataService(null as any);
    vi.spyOn(service as any, 'ensureBreezeBridgeSession').mockResolvedValue(true);
    findMany.mockReset().mockResolvedValue([]);
    originalFetch = globalThis.fetch;
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  describe('Breeze request', () => {
    it('asks for daily candles as 1day, not the 5-minute fallback', async () => {
      globalThis.fetch = bridgeReply([bar('2025-01-02'), bar('2025-01-03')]);
      await service.getHistory('RELIANCE', '1d', '2025-01-01', '2025-01-10');
      const url = String((globalThis.fetch as any).mock.calls[0][0]);
      expect(url).toContain('interval=1day');
    });

    it('names an option contract by underlying, product, expiry, strike and right', async () => {
      globalThis.fetch = bridgeReply([bar('2025-02-03 09:15:00'), bar('2025-02-03 09:20:00')]);
      await service.getHistory('NIFTY2025022724000CE', '5minute', '2025-02-01', '2025-02-05');
      const url = new URL(String((globalThis.fetch as any).mock.calls[0][0]));
      expect(url.pathname).toBe('/historical/NIFTY');
      expect(Object.fromEntries(url.searchParams)).toMatchObject({
        interval: '5minute', exchange: 'NFO', product: 'options',
        expiry: '2025-02-27', strike: '24000', right: 'call',
      });
    });

    it('names a future without strike or right', async () => {
      globalThis.fetch = bridgeReply([bar('2025-02-03'), bar('2025-02-04')]);
      await service.getHistory('BANKNIFTY20250227FUT', '1day', '2025-02-01', '2025-02-20');
      const url = new URL(String((globalThis.fetch as any).mock.calls[0][0]));
      expect(url.searchParams.get('product')).toBe('futures');
      expect(url.searchParams.has('strike')).toBe(false);
    });

    it('never falls back to Yahoo for a contract — Yahoo would return the wrong instrument', async () => {
      globalThis.fetch = bridgeReply([]);
      const yahoo = vi.spyOn(service as any, 'fetchHistoryFromYahoo');
      const bars = await service.getHistory('NIFTY2025022724000PE', '1day', '2025-02-01', '2025-02-20');
      expect(bars).toEqual([]);
      expect(yahoo).not.toHaveBeenCalled();
    });

    it('gives a long intraday pull more than the old 15-second budget', async () => {
      const timeouts: number[] = [];
      const realSetTimeout = globalThis.setTimeout;
      vi.spyOn(globalThis, 'setTimeout').mockImplementation(((fn: any, ms?: number) => {
        timeouts.push(ms ?? 0);
        return realSetTimeout(fn, 0x7fffffff);
      }) as any);
      globalThis.fetch = bridgeReply([bar('2024-01-02 09:15:00'), bar('2024-01-02 09:20:00')]);
      await service.getHistory('TCS', '5minute', '2024-01-01', '2024-12-31');
      expect(Math.max(...timeouts)).toBeGreaterThan(60_000);
    });
  });

  describe('candle store', () => {
    it('does not serve a partial range as if it were complete', async () => {
      findMany.mockResolvedValue(Array.from({ length: 10 }, (_, i) => ({
        timestamp: new Date(Date.UTC(2025, 5, 2 + i)), open: 1, high: 1, low: 1, close: 1, volume: 1,
      })));
      globalThis.fetch = bridgeReply([bar('2023-01-02'), bar('2025-06-30')]);
      await service.getHistory('INFY', '1day', '2023-01-01', '2025-06-30');
      expect(globalThis.fetch).toHaveBeenCalled();
    });

    it('serves the store when it covers the whole range', async () => {
      findMany.mockResolvedValue([
        { timestamp: new Date('2025-01-02T00:00:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { timestamp: new Date('2025-01-30T00:00:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ]);
      globalThis.fetch = vi.fn();
      const bars = await service.getHistory('INFY', '1day', '2025-01-01', '2025-01-31');
      expect(bars).toHaveLength(2);
      expect(globalThis.fetch).not.toHaveBeenCalled();
    });
  });

  describe('one timestamp format for every source', () => {
    it('gives Yahoo intraday bars their Indian time, not just the date', async () => {
      vi.spyOn(service as any, 'ensureBreezeBridgeSession').mockResolvedValue(false);
      const t0 = Date.parse('2025-01-02T03:45:00Z');           // 09:15 IST
      globalThis.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ chart: { result: [{
          timestamp: [t0 / 1000, t0 / 1000 + 300],
          indicators: { quote: [{ open: [1, 2], high: [1, 2], low: [1, 2], close: [1, 2], volume: [5, 5] }] },
        }] } }),
      } as any);
      const bars = await service.getHistory('SBIN', '5m', '2025-01-02', '2025-01-02');
      expect(bars.map(b => b.timestamp)).toEqual(['2025-01-02 09:15:00', '2025-01-02 09:20:00']);
    });

    it('does not serve intraday bars an older version saved 5.5 hours late', async () => {
      // 09:15 IST saved as 09:15 UTC reads back as 14:45 and 15:50 IST - the latter is past the close
      findMany.mockResolvedValue([
        { timestamp: new Date('2025-01-02T09:15:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1 },
        { timestamp: new Date('2025-01-31T10:20:00Z'), open: 1, high: 1, low: 1, close: 1, volume: 1 },
      ]);
      globalThis.fetch = bridgeReply([bar('2025-01-02 09:15:00'), bar('2025-01-31 15:25:00')]);
      await service.getHistory('SBIN', '5minute', '2025-01-01', '2025-01-31');
      expect(globalThis.fetch).toHaveBeenCalled();
    });
  });

  describe('candle cleaning', () => {
    it('invents no weekend bars in daily data', async () => {
      const fri = bar('2025-01-03'), mon = bar('2025-01-06');
      globalThis.fetch = bridgeReply([bar('2025-01-02'), fri, mon, bar('2025-01-07')]);
      const bars = await service.getHistory('SBIN', '1day', '2025-01-01', '2025-01-08');
      expect(bars.map(b => b.timestamp)).toEqual(['2025-01-02', '2025-01-03', '2025-01-06', '2025-01-07']);
    });

    it('keeps every bar of a stock that doubled', async () => {
      const trend = Array.from({ length: 60 }, (_, i) =>
        bar(new Date(Date.UTC(2025, 0, 1 + i)).toISOString().slice(0, 10), 100 * 2 ** (i / 59)));
      globalThis.fetch = bridgeReply(trend);
      const bars = await service.getHistory('TITAN', '1day', '2025-01-01', '2025-03-01');
      expect(bars).toHaveLength(60);
    });

    it('drops an isolated bad print in a stock, but not in an option', async () => {
      const series = [bar('2025-01-02', 100), bar('2025-01-03', 180), bar('2025-01-06', 101), bar('2025-01-07', 102)];
      globalThis.fetch = bridgeReply(series);
      const stock = await service.getHistory('ITC', '1day', '2025-01-01', '2025-01-08');
      expect(stock.map(b => b.close)).toEqual([100, 101, 102]);

      globalThis.fetch = bridgeReply(series);
      const option = await service.getHistory('ITC2025013000450CE', '1day', '2025-01-01', '2025-01-08');
      expect(option).toHaveLength(4);
    });
  });
});

describe('history helpers', () => {
  it('reads a zone-less bar time as Indian time and writes it back unchanged', () => {
    const t = barInstant('2025-01-02 09:15:00');
    expect(new Date(t).toISOString()).toBe('2025-01-02T03:45:00.000Z');
    expect(formatBarTime(t, false)).toBe('2025-01-02 09:15:00');
    expect(formatBarTime(barInstant('2025-01-02'), true)).toBe('2025-01-02');
    expect(barInstant('2025-01-02T03:45:00.000Z')).toBe(t);
  });

  it('recognises daily intervals', () => {
    expect(['1d', '1day', 'day', 'daily'].every(isDailyInterval)).toBe(true);
    expect(['5minute', '5m', '1minute'].some(isDailyInterval)).toBe(false);
  });

  it('knows how many candles make a session', () => {
    expect(barsPerSession('5minute')).toBe(75);
    expect(barsPerSession('1minute')).toBe(375);
    expect(barsPerSession('5minute', 'MCX')).toBe(174);
    expect(barsPerSession('1day')).toBe(1);
  });

  it('judges coverage by both ends, allowing for weekends and holidays', () => {
    const b = [bar('2025-01-03'), bar('2025-03-28')];
    expect(coversRange(b, '2025-01-01', '2025-03-31')).toBe(true);
    expect(coversRange(b, '2024-06-01', '2025-03-31')).toBe(false);   // starts months late
    expect(coversRange(b, '2025-01-01', '2025-06-30')).toBe(false);   // stops months early
    expect(coversRange([], '2025-01-01', '2025-01-31')).toBe(false);
  });
});
