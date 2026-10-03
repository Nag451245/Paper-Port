import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { OptionHistory, expiryRule, expiryCandidates, barDay } from '../../src/services/option-history.service.js';

import { fakeMarket } from '../helpers/fake-option-market.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'opthist-')); });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); });

describe('expiry rules (first guesses)', () => {
  it('follows the SEBI changes', () => {
    expect(expiryRule('NIFTY', '2025-06-10').weekly).toBe(4);            // Thursday
    expect(expiryRule('NIFTY', '2025-10-07').weekly).toBe(2);            // Tuesday
    expect(expiryRule('BANKNIFTY', '2024-06-10').weekly).toBe(3);        // Wednesday
    expect(expiryRule('BANKNIFTY', '2025-06-10').weekly).toBeNull();     // monthly only
    expect(expiryRule('SENSEX', '2024-06-10').weekly).toBe(5);
  });

  it('weekly candidates try the guess first, then earlier days of the week', () => {
    const c = expiryCandidates('NIFTY', '2025-06-09', '2025-06-13', 'weekly');
    expect(c).toEqual([{ key: '2025-06-09', tries: ['2025-06-12', '2025-06-11', '2025-06-10', '2025-06-09', '2025-06-13'] }]);
  });

  it('monthly-only periods give one candidate per month', () => {
    const c = expiryCandidates('BANKNIFTY', '2025-10-01', '2025-11-30', 'weekly');
    expect(c.map((x) => x.tries[0])).toEqual(['2025-10-28', '2025-11-25']);   // last Tuesdays
  });
});

describe('OptionHistory', () => {
  it('fetches a contract once, then serves it from disk', async () => {
    const m = fakeMarket(new Set(['2026-09-29']));
    const h = new OptionHistory(m as any, dir, () => new Date('2026-10-03T12:00:00Z'), 0);
    const a = await h.contract('NIFTY', '2026-09-29', 22400, 'CE', '2026-09-24', '2026-09-29');
    const b = await h.contract('NIFTY', '2026-09-29', 22400, 'CE', '2026-09-25', '2026-09-29');
    expect(a.fresh).toBe(true);
    expect(b.fresh).toBe(false);
    expect(m.breezeOptionHistory).toHaveBeenCalledTimes(1);
    expect(new Set(b.bars.map((x) => barDay(x[0])))).toEqual(new Set(['2026-09-25', '2026-09-28', '2026-09-29']));
    expect(h.budget().used).toBe(1);
  });

  it('does not cache a failed fetch', async () => {
    const m = fakeMarket(new Set(['2026-09-29']), { fail: true });
    const h = new OptionHistory(m as any, dir, () => new Date('2026-10-03T12:00:00Z'), 0);
    const r = await h.contract('NIFTY', '2026-09-29', 22400, 'CE', '2026-09-24', '2026-09-29');
    expect(r.error).toMatch(/not connected/);
    await h.contract('NIFTY', '2026-09-29', 22400, 'CE', '2026-09-24', '2026-09-29');
    expect(m.breezeOptionHistory).toHaveBeenCalledTimes(2);
    expect(h.budget().used).toBe(0);                            // failed requests are not counted
  });

  it('stops at the daily request limit', async () => {
    const m = fakeMarket(new Set(['2026-09-29']));
    const h = new OptionHistory(m as any, dir, () => new Date('2026-10-03T12:00:00Z'), 0, 1);
    await h.contract('NIFTY', '2026-09-29', 22400, 'CE', '2026-09-24', '2026-09-29');
    const r = await h.contract('NIFTY', '2026-09-29', 22450, 'CE', '2026-09-24', '2026-09-29');
    expect(r.error).toMatch(/limit/);
  });

  it('finds a holiday-shifted expiry by checking the data, and remembers it', async () => {
    // Week of 2 Oct 2025: Tuesday expiry moved to Monday 29 Sep? Here: Tuesday 30 Sep is a holiday → Monday.
    const m = fakeMarket(new Set(['2025-09-29']), { holidays: new Set(['2025-09-30']) });
    const h = new OptionHistory(m as any, dir, () => new Date('2026-10-03T12:00:00Z'), 0);
    const r = await h.expiries('NIFTY', '2025-09-29', '2025-10-03', 'weekly');
    expect(r.expiries).toEqual(['2025-09-29']);
    const calls = m.calls.length;
    const again = await h.expiries('NIFTY', '2025-09-29', '2025-10-03', 'weekly');
    expect(again.expiries).toEqual(['2025-09-29']);
    expect(m.calls.length).toBe(calls);                         // remembered, no new requests
    expect(h.knownExpiries('NIFTY')).toEqual(['2025-09-29']);
  });

  it('reports periods it could not check instead of guessing', async () => {
    const m = fakeMarket(new Set(['2025-09-30']), { fail: true });
    const h = new OptionHistory(m as any, dir, () => new Date('2026-10-03T12:00:00Z'), 0);
    const r = await h.expiries('NIFTY', '2025-09-29', '2025-10-10', 'weekly');
    expect(r.expiries).toEqual([]);
    expect(r.unchecked.length).toBe(2);
    expect(r.error).toMatch(/not connected/);
  });

  it('works out the index from put-call parity when it has no index candles', async () => {
    const m = fakeMarket(new Set(['2026-09-29']));
    const h = new OptionHistory(m as any, dir, () => new Date('2026-10-03T12:00:00Z'), 0);
    const ce = (await h.contract('NIFTY', '2026-09-29', 22400, 'CE', '2026-09-29', '2026-09-29')).bars;
    const pe = (await h.contract('NIFTY', '2026-09-29', 22400, 'PE', '2026-09-29', '2026-09-29')).bars;
    const spot = await h.spotAt('NIFTY', '2026-09-29', 9 * 60 + 20, { strike: 22400, ce, pe });
    expect(spot).toBe(22400 + 99.5 - 100);                     // second candle: call 99.5, put 100
  });
});
