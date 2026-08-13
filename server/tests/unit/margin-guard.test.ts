import { describe, it, expect } from 'vitest';
import { checkMarginSupported, BLOCK_UNTIL_REAL_SPAN } from '../../src/lib/margin-guard.js';
import { parseInstrumentSymbol, buildOptionSymbol, buildFuturesSymbol } from '../../src/lib/instrument.js';

/**
 * The guard exists because `shortMarginRequired` charges a flat 25% of TRADE
 * VALUE, and an option's trade value is its premium while its margin is set
 * against notional — an error of roughly sixty times, in the direction that
 * makes premium selling look free.
 */
describe('checkMarginSupported', () => {
  it('is armed', () => {
    // If this flips to false the block is off and short-option paper results
    // become meaningless again. It should only change when real SPAN lands.
    expect(BLOCK_UNTIL_REAL_SPAN).toBe(true);
  });

  it('blocks short options', () => {
    const verdict = checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'SELL', symbol: 'NIFTY2026082824000CE', exchange: 'NFO',
    });
    expect(verdict.allowed).toBe(false);
    expect(verdict.reason).toMatch(/short options are blocked/i);
  });

  it('allows long options, whose premium debit is already correct', () => {
    const verdict = checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'BUY', symbol: 'NIFTY2026082824000CE', exchange: 'NFO',
    });
    expect(verdict.allowed).toBe(true);
  });

  it('blocks futures on both sides', () => {
    for (const side of ['BUY', 'SELL']) {
      const verdict = checkMarginSupported({
        instrumentType: 'FUTURES', side, symbol: 'NIFTY20260828FUT', exchange: 'NFO',
      });
      expect(verdict.allowed).toBe(false);
      expect(verdict.reason).toMatch(/futures are blocked/i);
    }
  });

  it('blocks commodity futures too — MCX is not a special case', () => {
    const verdict = checkMarginSupported({
      instrumentType: 'FUTURES', side: 'BUY', symbol: 'CRUDEOIL20260819FUT', exchange: 'MCX',
    });
    expect(verdict.allowed).toBe(false);
  });

  it('allows a SELL that closes a long option — exits must never be trapped', () => {
    const verdict = checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'SELL', symbol: 'NIFTY2026082824000CE',
      exchange: 'NFO', qty: 75, reducingQty: 75,
    });
    expect(verdict.allowed).toBe(true);
  });

  it('allows a partial close of a long option', () => {
    expect(checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'SELL', symbol: 'NIFTY2026082824000CE',
      exchange: 'NFO', qty: 25, reducingQty: 75,
    }).allowed).toBe(true);
  });

  it('blocks a SELL that exceeds the long held, since the excess opens a short', () => {
    expect(checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'SELL', symbol: 'NIFTY2026082824000CE',
      exchange: 'NFO', qty: 150, reducingQty: 75,
    }).allowed).toBe(false);
  });

  it('blocks a short when nothing is held', () => {
    expect(checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'SELL', symbol: 'NIFTY2026082824000CE',
      exchange: 'NFO', qty: 75, reducingQty: 0,
    }).allowed).toBe(false);
  });

  it('does not treat a missing qty as a reducing trade', () => {
    // qty unknown cannot be proven to be within the held amount.
    expect(checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'SELL', symbol: 'NIFTY2026082824000CE',
      exchange: 'NFO', reducingQty: 75,
    }).allowed).toBe(false);
  });

  it('allows closing an existing long futures position', () => {
    expect(checkMarginSupported({
      instrumentType: 'FUTURES', side: 'SELL', symbol: 'NIFTY20260828FUT',
      exchange: 'NFO', qty: 75, reducingQty: 75,
    }).allowed).toBe(true);
  });

  it('does not let a BUY ride the reducing exemption', () => {
    // Buying more futures is opening exposure regardless of what is held.
    expect(checkMarginSupported({
      instrumentType: 'FUTURES', side: 'BUY', symbol: 'NIFTY20260828FUT',
      exchange: 'NFO', qty: 75, reducingQty: 75,
    }).allowed).toBe(false);
  });

  it('leaves equity untouched on both sides', () => {
    for (const side of ['BUY', 'SELL']) {
      expect(checkMarginSupported({
        instrumentType: 'EQUITY', side, symbol: 'RELIANCE', exchange: 'NSE',
      }).allowed).toBe(true);
    }
  });
});

describe('checkMarginSupported — driven by real parsed symbols', () => {
  // Pins that the guard and the parser agree on what an instrument is; a
  // classification mismatch between them would silently unblock a short option.
  it('classifies and blocks a short option built from the canonical builder', () => {
    const symbol = buildOptionSymbol('BANKNIFTY', '2026-08-26', 54000, 'PE');
    const spec = parseInstrumentSymbol(symbol);

    expect(spec.instrumentType).toBe('OPTIONS');
    expect(checkMarginSupported({
      instrumentType: spec.instrumentType, side: 'SELL', symbol, exchange: spec.exchange,
    }).allowed).toBe(false);
  });

  it('classifies and blocks a commodity future built from the canonical builder', () => {
    const symbol = buildFuturesSymbol('GOLD', '2026-10-05');
    const spec = parseInstrumentSymbol(symbol);

    expect(spec.instrumentType).toBe('FUTURES');
    expect(spec.exchange).toBe('MCX');
    expect(checkMarginSupported({
      instrumentType: spec.instrumentType, side: 'BUY', symbol, exchange: spec.exchange,
    }).allowed).toBe(false);
  });

  it('does not block an equity symbol that merely looks derivative-ish', () => {
    const spec = parseInstrumentSymbol('RELIANCE');
    expect(checkMarginSupported({
      instrumentType: spec.instrumentType, side: 'SELL', symbol: 'RELIANCE',
    }).allowed).toBe(true);
  });
});
