import { describe, it, expect } from 'vitest';
import {
  buildOptionSymbol,
  buildFuturesSymbol,
  parseInstrumentSymbol,
  isDerivativeSymbol,
  contractKey,
  detectExchange,
  segmentForExchange,
  expiryToDate,
  InstrumentError,
} from '../../src/lib/instrument.js';

/**
 * The grammar these tests pin is not arbitrary — it is the one the live quote
 * path already requires. `MarketDataService.parseOptionSymbol` feeds
 * `fetchFnOQuote`, which looks the contract up on the bridge by underlying +
 * expiry and then matches the strike. A symbol this module builds that the quote
 * path cannot parse is a position that can never be priced.
 */
const QUOTE_PATH_REGEX = /^([A-Z]+?)(\d{4})(\d{2})(\d{2})(\d+)(CE|PE)$/;

describe('buildOptionSymbol', () => {
  it('builds the canonical form for a monthly index option', () => {
    expect(buildOptionSymbol('NIFTY', '2026-08-28', 24000, 'CE')).toBe('NIFTY2026082824000CE');
  });

  it('builds weekly and monthly contracts that differ only by expiry', () => {
    const weekly = buildOptionSymbol('NIFTY', '2026-08-20', 24000, 'CE');
    const monthly = buildOptionSymbol('NIFTY', '2026-08-28', 24000, 'CE');
    expect(weekly).not.toBe(monthly);
  });

  it('handles a long underlying and a put', () => {
    expect(buildOptionSymbol('BANKNIFTY', '2026-08-26', 54000, 'PE')).toBe('BANKNIFTY2026082654000PE');
  });

  it('accepts a Date and normalises it to the IST calendar date', () => {
    // 2026-08-28 18:30 UTC is already 2026-08-29 in IST.
    const built = buildOptionSymbol('NIFTY', new Date('2026-08-28T18:30:00Z'), 24000, 'CE');
    expect(built).toBe('NIFTY2026082924000CE');
  });

  it('emits symbols the live quote path can parse', () => {
    for (const sym of [
      buildOptionSymbol('NIFTY', '2026-08-28', 24000, 'CE'),
      buildOptionSymbol('BANKNIFTY', '2026-08-26', 54000, 'PE'),
      buildOptionSymbol('RELIANCE', '2026-09-24', 1500, 'CE'),
    ]) {
      expect(QUOTE_PATH_REGEX.test(sym)).toBe(true);
    }
  });

  it('refuses a fractional strike rather than naming a different contract', () => {
    // Truncating 7.5 to 7 would produce a symbol for a real, different, tradeable
    // contract. Failing loudly is the whole point.
    expect(() => buildOptionSymbol('IDEA', '2026-08-28', 7.5, 'CE')).toThrow(InstrumentError);
    expect(() => buildOptionSymbol('IDEA', '2026-08-28', 7.5, 'CE')).toThrow(/fractional strike/i);
  });

  it('rejects non-positive strikes', () => {
    expect(() => buildOptionSymbol('NIFTY', '2026-08-28', 0, 'CE')).toThrow(InstrumentError);
    expect(() => buildOptionSymbol('NIFTY', '2026-08-28', -100, 'CE')).toThrow(InstrumentError);
  });

  it('rejects an underlying containing digits, which would make the expiry ambiguous', () => {
    expect(() => buildOptionSymbol('NIFTY50', '2026-08-28', 24000, 'CE')).toThrow(InstrumentError);
  });

  it('rejects a malformed expiry', () => {
    expect(() => buildOptionSymbol('NIFTY', '28-08-2026', 24000, 'CE')).toThrow(InstrumentError);
    expect(() => buildOptionSymbol('NIFTY', 'next week', 24000, 'CE')).toThrow(InstrumentError);
  });
});

describe('buildFuturesSymbol', () => {
  it('builds an index future', () => {
    expect(buildFuturesSymbol('NIFTY', '2026-08-28')).toBe('NIFTY20260828FUT');
  });

  it('builds a commodity future', () => {
    expect(buildFuturesSymbol('CRUDEOIL', '2026-08-19')).toBe('CRUDEOIL20260819FUT');
  });
});

describe('parseInstrumentSymbol — options', () => {
  it('round-trips a built option symbol', () => {
    const symbol = buildOptionSymbol('NIFTY', '2026-08-28', 24000, 'CE');
    const spec = parseInstrumentSymbol(symbol);

    expect(spec.instrumentType).toBe('OPTIONS');
    expect(spec.underlying).toBe('NIFTY');
    expect(spec.strike).toBe(24000);
    expect(spec.optionType).toBe('CE');
    expect(spec.exchange).toBe('NFO');
    expect(spec.segment).toBe('FO');
    expect(spec.expiry).toEqual(expiryToDate('2026-08-28'));
  });

  it('does not mistake the strike for part of the expiry', () => {
    const spec = parseInstrumentSymbol('BANKNIFTY2026082654000PE');
    expect(spec.underlying).toBe('BANKNIFTY');
    expect(spec.strike).toBe(54000);
    expect(spec.optionType).toBe('PE');
    expect(spec.expiry).toEqual(expiryToDate('2026-08-26'));
  });

  it('rejects an out-of-range date rather than silently producing a bad expiry', () => {
    expect(() => parseInstrumentSymbol('NIFTY2026134524000CE')).toThrow(InstrumentError);
  });
});

describe('parseInstrumentSymbol — futures', () => {
  it('round-trips an index future to NFO', () => {
    const spec = parseInstrumentSymbol(buildFuturesSymbol('NIFTY', '2026-08-28'));
    expect(spec.instrumentType).toBe('FUTURES');
    expect(spec.underlying).toBe('NIFTY');
    expect(spec.strike).toBeNull();
    expect(spec.optionType).toBeNull();
    expect(spec.exchange).toBe('NFO');
    expect(spec.segment).toBe('FO');
  });

  it('infers MCX for a commodity underlying', () => {
    const spec = parseInstrumentSymbol(buildFuturesSymbol('CRUDEOIL', '2026-08-19'));
    expect(spec.exchange).toBe('MCX');
    expect(spec.segment).toBe('COM');
  });

  it('honours an explicit exchange over inference', () => {
    const spec = parseInstrumentSymbol('CRUDEOIL20260819FUT', 'NFO');
    expect(spec.exchange).toBe('NFO');
    expect(spec.segment).toBe('FO');
  });
});

describe('parseInstrumentSymbol — equity and non-contracts', () => {
  it('passes equity symbols through untouched', () => {
    const spec = parseInstrumentSymbol('RELIANCE');
    expect(spec.instrumentType).toBe('EQUITY');
    expect(spec.underlying).toBe('RELIANCE');
    expect(spec.exchange).toBe('NSE');
    expect(spec.segment).toBe('EQ');
    expect(spec.expiry).toBeNull();
    expect(spec.strike).toBeNull();
  });

  it('does not treat the old expiry-less bot format as a contract', () => {
    // bot-engine.ts built `NIFTY24000CE`. It carries no expiry, so it cannot
    // identify a contract and must not be mistaken for one.
    expect(isDerivativeSymbol('NIFTY24000CE')).toBe(false);
    expect(parseInstrumentSymbol('NIFTY24000CE').instrumentType).toBe('EQUITY');
  });

  it('recognises well-formed derivatives', () => {
    expect(isDerivativeSymbol('NIFTY2026082824000CE')).toBe(true);
    expect(isDerivativeSymbol('CRUDEOIL20260819FUT')).toBe(true);
    expect(isDerivativeSymbol('RELIANCE')).toBe(false);
  });

  it('rejects an empty symbol', () => {
    expect(() => parseInstrumentSymbol('   ')).toThrow(InstrumentError);
  });
});

describe('contractKey', () => {
  it('distinguishes two expiries at the same strike', () => {
    // This is the merge that blended a weekly and a monthly into one position row.
    const weekly = parseInstrumentSymbol(buildOptionSymbol('NIFTY', '2026-08-20', 24000, 'CE'));
    const monthly = parseInstrumentSymbol(buildOptionSymbol('NIFTY', '2026-08-28', 24000, 'CE'));
    expect(contractKey(weekly)).not.toBe(contractKey(monthly));
  });

  it('distinguishes calls from puts and strike from strike', () => {
    const call = parseInstrumentSymbol('NIFTY2026082824000CE');
    const put = parseInstrumentSymbol('NIFTY2026082824000PE');
    const other = parseInstrumentSymbol('NIFTY2026082824500CE');
    expect(contractKey(call)).not.toBe(contractKey(put));
    expect(contractKey(call)).not.toBe(contractKey(other));
  });

  it('is stable for the same contract', () => {
    const a = parseInstrumentSymbol('NIFTY2026082824000CE');
    const b = parseInstrumentSymbol('nifty2026082824000ce');
    expect(contractKey(a)).toBe(contractKey(b));
  });
});

describe('exchange and segment helpers', () => {
  it('maps exchanges to segments', () => {
    expect(segmentForExchange('NFO')).toBe('FO');
    expect(segmentForExchange('BFO')).toBe('FO');
    expect(segmentForExchange('MCX')).toBe('COM');
    expect(segmentForExchange('CDS')).toBe('CD');
    expect(segmentForExchange('NSE')).toBe('EQ');
    expect(segmentForExchange('BSE')).toBe('EQ');
  });

  it('detects commodity and currency underlyings', () => {
    expect(detectExchange('GOLD')).toBe('MCX');
    expect(detectExchange('CRUDEOIL')).toBe('MCX');
    expect(detectExchange('USDINR')).toBe('CDS');
    expect(detectExchange('RELIANCE')).toBe('NSE');
    expect(detectExchange('NIFTY', 'OPTIONS')).toBe('NFO');
  });
});

describe('expiryToDate', () => {
  it('anchors to IST midnight regardless of host timezone', () => {
    // 2026-08-28T00:00:00+05:30 is 2026-08-27T18:30:00Z.
    expect(expiryToDate('2026-08-28').toISOString()).toBe('2026-08-27T18:30:00.000Z');
  });

  it('refuses a day the month does not have instead of rolling into the next month', () => {
    // new Date('2025-02-30...') is 2 March; that would name a different contract.
    expect(() => expiryToDate('2025-02-30')).toThrow(InstrumentError);
    expect(() => parseInstrumentSymbol('NIFTY20250230FUT')).toThrow(InstrumentError);
    expect(() => expiryToDate('2025-04-31')).toThrow(InstrumentError);
    expect(expiryToDate('2024-02-29').toISOString()).toBe('2024-02-28T18:30:00.000Z');   // leap day is real
  });
});
