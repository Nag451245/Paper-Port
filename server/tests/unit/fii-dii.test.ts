import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { parseNseFiiDii, parseNsdlFpi, latestFiiDii, readFiiDiiHistory, NSE_FII_DII_URL } from '../../src/lib/fii-dii.js';

// What NSE returned on 3 Oct 2026 (values in ₹ crore).
const NSE = [
  { buyValue: '25420.04', category: 'DII', date: '01-Oct-2026', netValue: '10041.84', sellValue: '15378.2' },
  { buyValue: '12260.26', category: 'FII/FPI', date: '01-Oct-2026', netValue: '-9484.22', sellValue: '21744.48' },
];
// The head of NSDL's daily FPI table on the same day.
const NSDL = `<table><tr><th>Reporting Date</th><th>Debt/Debt-VRR/Equity/Hybrid</th><th>Investment Route</th><th>Gross Purchases</th><th>Gross Sales</th><th>Net</th></tr>
<tr><td rowspan="3">01-Oct-2026</td><td>Equity</td><td>Stock Exchange</td><td>17667.90</td><td>27237.47</td><td>(9569.57)</td><td>(997.00)</td></tr>
<tr><td>Primary market &amp; others</td><td>337.70</td><td>0.01</td><td>337.69</td></tr></table>`;

let dir: string;
const before = process.env.MARKET_DATA_DIR;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fiidii-')); process.env.MARKET_DATA_DIR = dir; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); process.env.MARKET_DATA_DIR = before; });

describe('FII/DII from official sources', () => {
  it('reads NSE rows by their current names, in crore, with the trading date', () => {
    expect(parseNseFiiDii(NSE)).toMatchObject({ date: '2026-10-01', fiiNet: -9484.22, diiNet: 10041.84, fiiBuy: 12260.26, source: 'nse' });
    expect(parseNseFiiDii({ error: 'blocked' })).toBeNull();
  });

  it('reads NSDL foreign-investor equity flows, brackets as outflows, and no DII', () => {
    expect(parseNsdlFpi(NSDL)).toMatchObject({ date: '2026-10-01', fiiBuy: 17667.9, fiiSell: 27237.47, fiiNet: -9569.57, diiNet: null, source: 'nsdl' });
  });

  it('falls back NSE all-exchanges → NSE only → NSDL, saves each day, and shows the last saved day when all are down', async () => {
    const first = await latestFiiDii(async (url) => (url === NSE_FII_DII_URL ? null : NSE), async () => null);
    expect(first?.source).toBe('nse-only');
    const viaNsdl = await latestFiiDii(async () => null, async () => NSDL);
    expect(viaNsdl?.source).toBe('nsdl');
    // The NSE figures for that day are kept: NSDL never overwrites a better source.
    expect(readFiiDiiHistory()[0].source).toBe('nse-only');
    const down = await latestFiiDii(async () => null, async () => null);
    expect(down).toMatchObject({ date: '2026-10-01', stale: true, source: 'nse-only' });
  });

  it('returns nothing rather than zeros when no source has ever answered', async () => {
    expect(await latestFiiDii(async () => null, async () => null)).toBeNull();
  });
});
