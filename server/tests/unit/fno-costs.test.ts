import { describe, it, expect } from 'vitest';
import { calculateCosts, resolveInstrumentKind } from '../../src/lib/costs.js';

/**
 * Unlike tests/unit/transaction-costs.test.ts, which reimplements the cost
 * formula locally, this suite imports the real `calculateCosts` — so it fails
 * if the shipped implementation drifts.
 */
describe('resolveInstrumentKind', () => {
  it('treats cash-segment exchanges as equity', () => {
    expect(resolveInstrumentKind('NSE', 'RELIANCE')).toBe('EQUITY');
    expect(resolveInstrumentKind('BSE', 'TCS')).toBe('EQUITY');
    expect(resolveInstrumentKind('MCX', 'GOLD')).toBe('EQUITY');
    expect(resolveInstrumentKind('CDS', 'USDINR')).toBe('EQUITY');
  });

  it('detects options from an explicit optionType', () => {
    expect(resolveInstrumentKind('NFO', 'BANKNIFTY', 'CE')).toBe('OPTIONS');
    expect(resolveInstrumentKind('NFO', 'BANKNIFTY', 'PE')).toBe('OPTIONS');
  });

  it('falls back to the symbol suffix when optionType is absent', () => {
    // Positions carry no optionType column, so exit costs rely on the symbol
    expect(resolveInstrumentKind('NFO', 'NIFTY26AUG24000CE')).toBe('OPTIONS');
    expect(resolveInstrumentKind('BFO', 'SENSEX26AUG80000PE')).toBe('OPTIONS');
  });

  it('treats other derivatives symbols as futures', () => {
    expect(resolveInstrumentKind('NFO', 'NIFTY26AUGFUT')).toBe('FUTURES');
    expect(resolveInstrumentKind('NFO', 'RELIANCE26AUG')).toBe('FUTURES');
  });

  it('is case-insensitive on the exchange', () => {
    expect(resolveInstrumentKind('nfo', 'NIFTY26AUG24000CE')).toBe('OPTIONS');
  });
});

describe('F&O transaction costs', () => {
  // 750 qty (10 NIFTY lots) at a premium of 120 => 90,000 premium turnover
  const OPT_QTY = 750;
  const OPT_PREMIUM = 120;
  const OPT_TURNOVER = OPT_QTY * OPT_PREMIUM;

  it('charges flat brokerage on options rather than a percentage', () => {
    const costs = calculateCosts(OPT_QTY, OPT_PREMIUM, 'BUY', 'NFO', 'OPTIONS');
    expect(costs.brokerage).toBe(20);
  });

  it('charges options STT at 0.15% of premium on the sell side only (from 1 Apr 2026)', () => {
    const sell = calculateCosts(OPT_QTY, OPT_PREMIUM, 'SELL', 'NFO', 'OPTIONS');
    const buy = calculateCosts(OPT_QTY, OPT_PREMIUM, 'BUY', 'NFO', 'OPTIONS');
    expect(sell.stt).toBeCloseTo(OPT_TURNOVER * 0.0015, 2);
    expect(buy.stt).toBe(0);
  });

  it('charges options stamp duty on the buy side only', () => {
    const buy = calculateCosts(OPT_QTY, OPT_PREMIUM, 'BUY', 'NFO', 'OPTIONS');
    const sell = calculateCosts(OPT_QTY, OPT_PREMIUM, 'SELL', 'NFO', 'OPTIONS');
    expect(buy.stampDuty).toBeCloseTo(OPT_TURNOVER * 0.00003, 2);
    expect(sell.stampDuty).toBe(0);
  });

  it('does not apply the equity stamp-duty rate to option premium', () => {
    // Regression: NFO used to fall through to the equity branch, which charges
    // 0.015% stamp duty — 5x the F&O rate — on premium turnover.
    const opt = calculateCosts(OPT_QTY, OPT_PREMIUM, 'BUY', 'NFO', 'OPTIONS');
    const equity = calculateCosts(OPT_QTY, OPT_PREMIUM, 'BUY', 'NSE', 'EQUITY');
    expect(opt.stampDuty).toBeLessThan(equity.stampDuty);
  });

  // 25 qty (1 NIFTY lot) at 24,000 => 600,000 notional
  const FUT_QTY = 25;
  const FUT_PRICE = 24_000;
  const FUT_TURNOVER = FUT_QTY * FUT_PRICE;

  it('charges futures STT at 0.05% of notional on the sell side only (from 1 Apr 2026)', () => {
    const sell = calculateCosts(FUT_QTY, FUT_PRICE, 'SELL', 'NFO', 'FUTURES');
    const buy = calculateCosts(FUT_QTY, FUT_PRICE, 'BUY', 'NFO', 'FUTURES');
    expect(sell.stt).toBeCloseTo(FUT_TURNOVER * 0.0005, 2);
    expect(buy.stt).toBe(0);
  });

  it('caps futures brokerage at Rs 20', () => {
    const costs = calculateCosts(FUT_QTY, FUT_PRICE, 'BUY', 'NFO', 'FUTURES');
    expect(costs.brokerage).toBe(20);
  });

  it('charges futures far less than options on the same turnover', () => {
    // Options STT is 5x the futures rate, so a sell must cost materially more
    const fut = calculateCosts(1, 100_000, 'SELL', 'NFO', 'FUTURES');
    const opt = calculateCosts(1, 100_000, 'SELL', 'NFO', 'OPTIONS');
    expect(opt.totalCost).toBeGreaterThan(fut.totalCost);
  });

  it('applies GST at 18% of brokerage + exchange + SEBI charges', () => {
    const c = calculateCosts(OPT_QTY, OPT_PREMIUM, 'BUY', 'NFO', 'OPTIONS');
    expect(c.gst).toBeCloseTo((c.brokerage + c.exchangeCharges + c.sebiCharges) * 0.18, 2);
  });

  it('totals to the sum of its components', () => {
    for (const kind of ['OPTIONS', 'FUTURES'] as const) {
      for (const side of ['BUY', 'SELL']) {
        const c = calculateCosts(100, 500, side, 'NFO', kind);
        const sum = c.brokerage + c.stt + c.exchangeCharges + c.gst + c.sebiCharges + c.stampDuty;
        expect(c.totalCost).toBeCloseTo(sum, 1);
      }
    }
  });

  it('routes NFO through the F&O branch even without an explicit kind', () => {
    const inferred = calculateCosts(OPT_QTY, OPT_PREMIUM, 'SELL', 'NFO');
    const equity = calculateCosts(OPT_QTY, OPT_PREMIUM, 'SELL', 'NSE');
    expect(inferred.exchangeCharges).not.toBeCloseTo(equity.exchangeCharges, 2);
  });

  it('leaves cash-segment costs unchanged', () => {
    // Guards against the F&O branch capturing equity/MCX/CDS trades
    const nse = calculateCosts(100, 2500, 'BUY', 'NSE');
    expect(nse.stampDuty).toBeCloseTo(100 * 2500 * 0.00015, 2);

    const mcx = calculateCosts(10, 60_000, 'SELL', 'MCX');
    expect(mcx.stt).toBeCloseTo(10 * 60_000 * 0.0001, 2);

    const cds = calculateCosts(1000, 83.5, 'BUY', 'CDS');
    expect(cds.stt).toBe(0);
  });

  it('handles zero quantity without producing NaN', () => {
    const c = calculateCosts(0, 120, 'BUY', 'NFO', 'OPTIONS');
    for (const v of Object.values(c)) expect(Number.isFinite(v)).toBe(true);
  });
});
