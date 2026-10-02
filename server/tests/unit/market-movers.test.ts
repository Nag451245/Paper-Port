import { describe, it, expect, vi } from 'vitest';

vi.mock('../../src/lib/upstox-session.js', () => ({ activeUpstoxToken: vi.fn().mockResolvedValue(null) }));

import {
  MarketMoversService, parseNseVariations, parseNseVolume, priorAverageVolume, rankPriceMovers,
} from '../../src/services/market-movers.service.js';
import type { BatchQuote, ListedShare } from '../../src/services/upstox.service.js';

// Trimmed from real NSE responses (01-Oct-2026).
const NSE_GAINERS = {
  allSec: {
    timestamp: '01-Oct-2026 16:00:00',
    data: [
      { symbol: 'SMLT', series: 'EQ', open_price: 67, high_price: 74.18, low_price: 66, ltp: 74.18, prev_price: 61.82, net_price: 19.99, trade_quantity: 112524, perChange: 19.99 },
      { symbol: 'PENNY', series: 'EQ', open_price: 3, high_price: 3.6, low_price: 3, ltp: 3.6, prev_price: 3, net_price: 20, trade_quantity: 900000, perChange: 20 },
    ],
  },
  FOSec: {
    timestamp: '01-Oct-2026 16:00:00',
    data: [{ symbol: 'TATASTEEL', series: 'EQ', open_price: 150, high_price: 158, low_price: 149, ltp: 157.5, prev_price: 150, net_price: 5, trade_quantity: 25000000, perChange: 5 }],
  },
};
const NSE_LOSERS = {
  allSec: { timestamp: '01-Oct-2026 16:00:00', data: [{ symbol: 'SUPREMEINF', ltp: 66, prev_price: 73.9, perChange: -10.69, trade_quantity: 282079 }] },
  FOSec: { timestamp: '01-Oct-2026 16:00:00', data: [] },
};
const NSE_VOLUME = {
  timestamp: '01-Oct-2026 16:00:00',
  data: [
    { symbol: 'NIRLON', companyName: 'Nirlon Limited', volume: 2331734, week1AvgVolume: 3957, week1volChange: 589.144060302354, ltp: 605, pChange: 0 },
    { symbol: 'PIXTRANS', companyName: 'Pix Transmissions Limited', volume: 1455118, week1AvgVolume: 248624, week1volChange: 5.852665562370077, ltp: 1774.8, pChange: 2.77 },
  ],
};

describe('NSE list parsing', () => {
  it('reads price movers with the change worked out from the previous close', () => {
    const { rows, asOf } = parseNseVariations(NSE_GAINERS, 'allSec');
    expect(asOf).toBe('01-Oct-2026 16:00:00');
    expect(rows[0]).toMatchObject({ symbol: 'SMLT', ltp: 74.18, change: 12.36, changePercent: 19.99, volume: 112524, previousClose: 61.82 });
  });

  it('reads volume gainers with the weekly average and the multiple', () => {
    const { rows } = parseNseVolume(NSE_VOLUME);
    expect(rows[1]).toMatchObject({ symbol: 'PIXTRANS', name: 'Pix Transmissions Limited', volume: 1455118, avgVolume: 248624, volumeRatio: 5.85, changePercent: 2.77 });
    expect(rows[1].previousClose).toBeCloseTo(1774.8 / 1.0277, 1);
  });

  it('copes with a missing group or an unexpected body', () => {
    expect(parseNseVariations({}, 'NIFTY').rows).toEqual([]);
    expect(parseNseVolume('<html>').rows).toEqual([]);
  });
});

describe('computed movers', () => {
  const shares: ListedShare[] = [
    { key: 'k1', symbol: 'UP', name: 'Up Ltd', group: 'A' },
    { key: 'k2', symbol: 'DOWN', name: 'Down Ltd', group: 'A' },
    { key: 'k3', symbol: 'PENNY', name: 'Penny Ltd', group: 'X' },
    { key: 'k4', symbol: 'FLAT', name: 'Flat Ltd', group: 'B' },
    { key: 'k5', symbol: 'NOTRADE', name: 'No Trade Ltd', group: 'B' },
  ];
  const q = (ltp: number, change: number, volume = 1000): BatchQuote =>
    ({ ltp, change, previousClose: ltp - change, open: 0, high: 0, low: 0, volume, timestamp: null });
  const quotes = new Map([
    ['k1', q(110, 10)], ['k2', q(90, -10)], ['k3', q(2, 1)], ['k4', q(50, 0)], ['k5', q(500, 100, 0)],
  ]);

  it('ranks gainers and losers by % move, leaving out penny stocks, untraded and flat shares', () => {
    expect(rankPriceMovers(shares, quotes, 'gainers', 10).map((r) => r.symbol)).toEqual(['UP']);
    expect(rankPriceMovers(shares, quotes, 'losers', 10).map((r) => r.symbol)).toEqual(['DOWN']);
    expect(rankPriceMovers(shares, quotes, 'gainers', 10)[0].changePercent).toBe(10);
  });

  it('averages only sessions before today', () => {
    const bars = [
      { timestamp: '2026-09-24', volume: 100 }, { timestamp: '2026-09-25', volume: 200 },
      { timestamp: '2026-09-29', volume: 300 }, { timestamp: '2026-09-30', volume: 400 },
      { timestamp: '2026-10-01', volume: 500 }, { timestamp: '2026-10-02', volume: 99999 },
    ];
    expect(priorAverageVolume(bars, '2026-10-02')).toBe(300);
    expect(priorAverageVolume([], '2026-10-02')).toBe(0);
  });
});

describe('MarketMoversService', () => {
  const nseFrom = (lists: Record<string, unknown>) => vi.fn(async (url: string) =>
    url.includes('volume-gainers') ? lists.volume : url.includes('loosers') ? lists.losers : lists.gainers);

  it('serves NSE lists and fetches each NSE list once however many groups ask', async () => {
    const nse = nseFrom({ gainers: NSE_GAINERS, losers: NSE_LOSERS, volume: NSE_VOLUME });
    const svc = new MarketMoversService(nse, {} as any, async () => null);
    const all = await svc.get('NSE', 'gainers', 'allSec');
    const fo = await svc.get('NSE', 'gainers', 'FOSec');
    expect(all).toMatchObject({ source: 'nse', asOf: '01-Oct-2026 16:00:00' });
    expect(fo.rows.map((r) => r.symbol)).toEqual(['TATASTEEL']);
    expect(nse.mock.calls.filter(([u]) => u.includes('index=gainers'))).toHaveLength(1);
  });

  it('falls back to the first group for an unknown one', async () => {
    const svc = new MarketMoversService(nseFrom({ gainers: NSE_GAINERS }), {} as any, async () => null);
    expect((await svc.get('NSE', 'gainers', 'nonsense')).group).toBe('allSec');
  });

  it('explains what is needed when NSE refuses and no Upstox login is active', async () => {
    const svc = new MarketMoversService(vi.fn().mockResolvedValue(null), {} as any, async () => null);
    const nse = await svc.get('NSE', 'gainers');
    expect(nse).toMatchObject({ source: 'none', rows: [] });
    expect(nse.note).toMatch(/Upstox/);
    const bse = await svc.get('BSE', 'volume');
    expect(bse.note).toMatch(/BSE does not allow automated access/);
  });

  it('computes BSE lists from Upstox quotes, sweeping quotes once for all lists', async () => {
    const shares: ListedShare[] = [
      { key: 'BSE_EQ|A1', symbol: 'ALPHA', name: 'Alpha', group: 'A' },
      { key: 'BSE_EQ|B1', symbol: 'BETA', name: 'Beta', group: 'B' },
    ];
    const upstox = {
      instrumentMaps: vi.fn().mockResolvedValue({ listed: { NSE: [], BSE: shares } }),
      quotes: vi.fn().mockResolvedValue(new Map([
        ['BSE_EQ|A1', { ltp: 105, change: 5, previousClose: 100, open: 0, high: 0, low: 0, volume: 5000, timestamp: '2026-10-01T10:00:00Z' }],
        ['BSE_EQ|B1', { ltp: 220, change: 20, previousClose: 200, open: 0, high: 0, low: 0, volume: 3000, timestamp: '2026-10-01T10:00:01Z' }],
      ])),
      history: vi.fn().mockResolvedValue([
        { timestamp: '2020-01-01', volume: 1000 }, { timestamp: '2020-01-02', volume: 1000 },
      ]),
    };
    const svc = new MarketMoversService(vi.fn(), upstox as any, async () => 'token');
    const all = await svc.get('BSE', 'gainers', 'all');
    const groupA = await svc.get('BSE', 'gainers', 'A');
    const volume = await svc.get('BSE', 'volume', 'all');
    expect(all).toMatchObject({ source: 'upstox', asOf: '2026-10-01T10:00:01Z' });
    expect(all.rows.map((r) => r.symbol)).toEqual(['BETA', 'ALPHA']);
    expect(groupA.rows.map((r) => r.symbol)).toEqual(['ALPHA']);
    expect(volume.rows[0]).toMatchObject({ symbol: 'ALPHA', avgVolume: 1000, volumeRatio: 5 });
    expect(upstox.quotes).toHaveBeenCalledTimes(1);
  });

  it('gives the scanner liquid NSE movers, with volume surges filed by price direction', async () => {
    const svc = new MarketMoversService(nseFrom({ gainers: NSE_GAINERS, losers: NSE_LOSERS, volume: NSE_VOLUME }), {} as any, async () => null);
    const { gainers, losers } = await svc.scannerMovers(50);
    // F&O stocks first; ₹3.60 penny stock left out; NIRLON (flat, 589x volume) counts as a gainer.
    expect(gainers.map((m) => m.symbol)).toEqual(['TATASTEEL', 'SMLT', 'NIRLON', 'PIXTRANS']);
    expect(losers.map((m) => m.symbol)).toEqual(['SUPREMEINF']);
  });
});
