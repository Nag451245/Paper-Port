import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';

const engine = vi.hoisted(() => ({
  calls: [] as any[],
  available: true,
}));
vi.mock('../../src/lib/rust-engine.js', () => ({
  isEngineAvailable: () => engine.available,
  engineOptionsBacktest: vi.fn(async (input: any) => {
    engine.calls.push(input);
    const trades = input.cycles.map((c: any) => ({ id: c.id, net: 100 }));
    return { trades, skipped: [], summary: { trades: input.prior_trades.length + trades.length } };
  }),
}));

import { OptionHistory } from '../../src/services/option-history.service.js';
import { OptionsLab, type BacktestParams } from '../../src/services/options-lab.service.js';
import { fakeMarket } from '../helpers/fake-option-market.js';

let dir: string;
beforeEach(() => { dir = fs.mkdtempSync(path.join(os.tmpdir(), 'optlab-')); engine.calls = []; engine.available = true; });
afterEach(() => { fs.rmSync(dir, { recursive: true, force: true }); vi.useRealTimers(); });

const base: BacktestParams = {
  underlying: 'NIFTY', from: '2026-09-21', to: '2026-10-02', expiryKind: 'weekly',
  entryDaysBefore: 1, entryTime: '09:20', exitDaysBefore: 0, exitTime: '15:15', holdToExpiry: false,
  legs: [
    { type: 'CE', action: 'SELL', lots: 2, strikeMode: 'atm', offset: 0 },
    { type: 'PE', action: 'BUY', lots: 1, strikeMode: 'atm', offset: -2 },
  ],
  lotSize: 65, slippagePct: 0.5, brokeragePerOrder: 20,
};

describe('OptionsLab.backtest', () => {
  it('builds one trade per expiry: entry the trading day before, strikes from the index at entry, real lots, that day\'s charges', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const m = fakeMarket(new Set(['2026-09-22', '2026-09-29']));
    const lab = new OptionsLab(new OptionHistory(m as any, dir, () => new Date('2026-10-03T12:00:00Z'), 0));
    const r: any = await lab.backtest('u1', base);

    expect(r.expiriesTested).toEqual(['2026-09-22', '2026-09-29']);
    const cycles = engine.calls.flatMap((c) => c.cycles);
    expect(cycles).toHaveLength(2);
    const c = cycles.find((x: any) => x.expiry === '2026-09-29');
    // Entry on Monday 28 Sep (one trading day before), 09:20 IST.
    expect(new Date(c.entry_ts * 1000).toISOString()).toBe('2026-09-28T03:50:00.000Z');
    // Index from parity at 22400: 22400 + 99.5 - 100 → ATM 22400; PE two strikes below.
    expect(c.legs.map((l: any) => [l.label, l.qty])).toEqual([['22400 CE', -130], ['22300 PE', 65]]);
    expect(c.rates.stt_sell).toBe(0.0015);
    expect(c.legs[0].bars.length).toBe(150);                    // two days of 5-minute candles
    expect(r.summary.trades).toBe(2);
  });

  it('refuses an exit before the entry, and says plainly when the engine is down', async () => {
    const lab = new OptionsLab(new OptionHistory(fakeMarket(new Set()) as any, dir, () => new Date(), 0));
    await expect(lab.backtest('u1', { ...base, entryDaysBefore: 0, exitDaysBefore: 0, entryTime: '14:00', exitTime: '10:00' }))
      .rejects.toThrow(/exit must come after/);
    engine.available = false;
    await expect(lab.backtest('u1', base)).rejects.toThrow(/Rust engine is not running/);
  });

  it('stops early and says why when ICICI is not connected', async () => {
    const lab = new OptionsLab(new OptionHistory(fakeMarket(new Set(['2026-09-29']), { fail: true }) as any, dir, () => new Date('2026-10-03T12:00:00Z'), 0));
    await expect(lab.backtest('u1', base)).rejects.toThrow(/not connected/);
  });
});

describe('OptionsLab.replayDay', () => {
  it('returns the day\'s chain around the money with the index from parity and that day\'s rates', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-10-03T12:00:00Z'));
    const m = fakeMarket(new Set(['2026-09-29']));
    const lab = new OptionsLab(new OptionHistory(m as any, dir, () => new Date('2026-10-03T12:00:00Z'), 0));
    const r: any = await lab.replayDay('NIFTY', '2026-09-25', { each: 3 });
    expect(r.expiry).toBe('2026-09-29');
    expect(r.spotSource).toBe('parity');
    expect(r.chain.map((s: any) => s.strike)).toEqual([22250, 22300, 22350, 22400, 22450, 22500, 22550]);
    expect(r.chain[3].ce.length).toBe(75);
    expect(r.rates.sttOptionSell).toBe(0.0015);
  });
});
