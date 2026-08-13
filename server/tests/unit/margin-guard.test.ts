import { describe, it, expect } from 'vitest';
import { checkMarginSupported, BLOCK_UNTIL_REAL_SPAN, derivativeNotional, computeDerivativeMargin, NO_MARGIN_POLICY } from '../../src/lib/margin-guard.js';
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

describe('derivativeNotional', () => {
  it('uses STRIKE x qty for options, not premium x qty', () => {
    // The original bug in one assertion: a short NIFTY 24000CE at Rs120 premium,
    // lot 75, has Rs18,00,000 of exposure — not Rs9,000 of "trade value".
    expect(derivativeNotional({ instrumentType: 'OPTIONS', qty: 75, price: 120, strike: 24000 }))
      .toBe(1_800_000);
  });

  it('uses price x qty for futures', () => {
    expect(derivativeNotional({ instrumentType: 'FUTURES', qty: 75, price: 24000 })).toBe(1_800_000);
  });

  it('refuses an option with no strike rather than falling back to premium', () => {
    expect(() => derivativeNotional({ instrumentType: 'OPTIONS', qty: 75, price: 120 })).toThrow(/strike/i);
  });
});

describe('computeDerivativeMargin', () => {
  const policy = { source: 'USER_SUPPLIED' as const, shortOptionNotionalPct: 0.12, futuresNotionalPct: 0.15 };

  it('charges the rate against notional and reports implied leverage', () => {
    const m = computeDerivativeMargin({
      instrumentType: 'OPTIONS', side: 'SELL', qty: 75, price: 120, strike: 24000, policy,
    })!;
    expect(m.notional).toBe(1_800_000);
    expect(m.margin).toBeCloseTo(216_000, 0);
    expect(m.impliedLeverage).toBeCloseTo(8.33, 1);
    expect(m.source).toBe('USER_SUPPLIED');
  });

  it('makes an aggressive rate visible as leverage rather than hiding it', () => {
    const thin = { source: 'USER_SUPPLIED' as const, shortOptionNotionalPct: 0.005 };
    const m = computeDerivativeMargin({
      instrumentType: 'OPTIONS', side: 'SELL', qty: 75, price: 120, strike: 24000, policy: thin,
    })!;
    // 0.5% of notional reads as a small number until it is shown as 200x.
    expect(m.impliedLeverage).toBe(200);
  });

  it('returns null with no policy, leaving the position blocked', () => {
    expect(computeDerivativeMargin({
      instrumentType: 'OPTIONS', side: 'SELL', qty: 75, price: 120, strike: 24000,
      policy: NO_MARGIN_POLICY,
    })).toBeNull();
  });

  it('returns null for a class the policy does not cover', () => {
    const optionsOnly = { source: 'USER_SUPPLIED' as const, shortOptionNotionalPct: 0.12 };
    expect(computeDerivativeMargin({
      instrumentType: 'FUTURES', side: 'BUY', qty: 75, price: 24000, policy: optionsOnly,
    })).toBeNull();
  });

  it('does not apply a short-option rate to a long option', () => {
    expect(computeDerivativeMargin({
      instrumentType: 'OPTIONS', side: 'BUY', qty: 75, price: 120, strike: 24000, policy,
    })).toBeNull();
  });
});

describe('checkMarginSupported with a policy', () => {
  const policy = { source: 'USER_SUPPLIED' as const, shortOptionNotionalPct: 0.12, futuresNotionalPct: 0.15 };

  it('unblocks a short option once a margin rate is supplied', () => {
    const v = checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'SELL', symbol: 'NIFTY2026082824000CE',
      exchange: 'NFO', qty: 75, price: 120, strike: 24000, policy,
    });
    expect(v.allowed).toBe(true);
  });

  it('unblocks futures once a rate is supplied', () => {
    expect(checkMarginSupported({
      instrumentType: 'FUTURES', side: 'BUY', symbol: 'NIFTY20260828FUT',
      exchange: 'NFO', qty: 75, price: 24000, policy,
    }).allowed).toBe(true);
  });

  it('stays blocked when the policy omits that class', () => {
    expect(checkMarginSupported({
      instrumentType: 'FUTURES', side: 'BUY', symbol: 'NIFTY20260828FUT', exchange: 'NFO',
      qty: 75, price: 24000, policy: { source: 'USER_SUPPLIED', shortOptionNotionalPct: 0.12 },
    }).allowed).toBe(false);
  });

  it('stays blocked when an option policy cannot be applied for want of a strike', () => {
    expect(checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'SELL', symbol: 'NIFTYWEEKLY', exchange: 'NFO',
      qty: 75, price: 120, policy,
    }).allowed).toBe(false);
  });

  it('still blocks with an explicit NONE policy', () => {
    expect(checkMarginSupported({
      instrumentType: 'OPTIONS', side: 'SELL', symbol: 'NIFTY2026082824000CE',
      exchange: 'NFO', qty: 75, price: 120, strike: 24000, policy: NO_MARGIN_POLICY,
    }).allowed).toBe(false);
  });
});
