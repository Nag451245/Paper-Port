import { describe, it, expect } from 'vitest';
import { analyzeStrategy, realisedVol } from '../../src/lib/strategy-math.js';
import { fnoRatesOn, optionOrderCharges, exerciseStt } from '../../src/lib/fno-charges.js';

describe('F&O charges by date', () => {
  it('uses the STT in force on the trade date', () => {
    expect(fnoRatesOn('2024-06-14').sttOptionSell).toBe(0.000625);
    expect(fnoRatesOn('2025-06-13').sttOptionSell).toBe(0.001);
    expect(fnoRatesOn('2026-04-01').sttOptionSell).toBe(0.0015);
    expect(fnoRatesOn('2026-03-31').sttFutureSell).toBe(0.0002);
    expect(fnoRatesOn('2026-04-01').sttFutureSell).toBe(0.0005);
  });

  it('charges a sell order STT, a buy order stamp duty, both brokerage and GST', () => {
    const rates = fnoRatesOn('2026-10-03');
    const sell = optionOrderCharges(rates, 'SELL', 100, 65);          // ₹6,500 premium
    const buy = optionOrderCharges(rates, 'BUY', 100, 65);
    expect(sell.stt).toBeCloseTo(6500 * 0.0015, 2);
    expect(buy.stt).toBe(0);
    expect(buy.stampDuty).toBeCloseTo(6500 * 0.00003, 1);
    expect(sell.brokerage).toBe(20);
    expect(sell.gst).toBeCloseTo((20 + 6500 * 0.0003503 + 6500 * 0.000001) * 0.18, 2);
  });

  it('BSE options (SENSEX) use the BSE transaction charge', () => {
    expect(fnoRatesOn('2026-10-03', { underlying: 'SENSEX' }).exchangeOption).toBe(0.000325);
  });

  it('a long option expiring in the money pays exercise STT on its intrinsic value', () => {
    expect(exerciseStt(fnoRatesOn('2026-10-03'), 120, 65)).toBeCloseTo(120 * 65 * 0.0015, 2);
  });
});

describe('analyzeStrategy', () => {
  const straddle = [
    { type: 'CE' as const, action: 'SELL' as const, strike: 22400, qty: 65, premium: 156.1 },
    { type: 'PE' as const, action: 'SELL' as const, strike: 22400, qty: 65, premium: 103.6 },
  ];

  it('short straddle: full credit less charges at the strike, unlimited loss, exact breakevens', () => {
    const a = analyzeStrategy(straddle, 22421.95, { days: 3, sigma: 0.146, fixedCost: 100 });
    expect(a.maxProfit).toBeCloseTo(259.7 * 65 - 100, 1);
    expect(a.unlimitedLoss).toBe(true);
    expect(a.unlimitedProfit).toBe(false);
    expect(a.breakevens[0]).toBeCloseTo(22400 - (259.7 * 65 - 100) / 65, 1);
    expect(a.pop).toBeGreaterThan(0.3);
    expect(a.pop).toBeLessThan(0.8);
    expect(a.margin).toBeCloseTo(22421.95 * 65 * 0.15, 0);
  });

  it('expected P&L turns negative for a seller when the market moves more than the options priced in', () => {
    const calm = analyzeStrategy(straddle, 22421.95, { days: 3, sigma: 0.146, sigmaEv: 0.08 });
    const wild = analyzeStrategy(straddle, 22421.95, { days: 3, sigma: 0.146, sigmaEv: 0.30 });
    expect(calm.expectedPnl).toBeGreaterThan(0);
    expect(wild.expectedPnl).toBeLessThan(0);
  });

  it('iron condor: bounded both ways, margin is the max loss', () => {
    const condor = [
      { type: 'PE' as const, action: 'BUY' as const, strike: 90, qty: 1, premium: 1 },
      { type: 'PE' as const, action: 'SELL' as const, strike: 95, qty: 1, premium: 3 },
      { type: 'CE' as const, action: 'SELL' as const, strike: 105, qty: 1, premium: 3 },
      { type: 'CE' as const, action: 'BUY' as const, strike: 110, qty: 1, premium: 1 },
    ];
    const a = analyzeStrategy(condor, 100, { days: 10, sigma: 0.2 });
    expect([a.maxProfit, a.maxLoss, a.unlimitedLoss, a.unlimitedProfit]).toEqual([4, -1, false, false]);
    expect(a.margin).toBe(1);
  });
});

describe('realisedVol', () => {
  it('annualises daily moves: 1% a day is about 16% a year', () => {
    const closes = [100];
    for (let i = 0; i < 30; i++) closes.push(closes[closes.length - 1] * (i % 2 ? 1.01 : 0.99));
    expect(realisedVol(closes, 20)!).toBeGreaterThan(0.14);
    expect(realisedVol(closes, 20)!).toBeLessThan(0.18);
    expect(realisedVol([100, 101], 20)).toBeNull();
  });
});
