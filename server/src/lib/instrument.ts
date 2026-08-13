/**
 * Canonical instrument identity for equity, F&O and commodity contracts.
 *
 * There is exactly one symbol grammar in this system, and it is the one the live
 * quote path already depends on (`MarketDataService.parseOptionSymbol` →
 * `fetchFnOQuote` → the bridge's `/option-chain/{underlying}?expiry=`):
 *
 *     option   {UNDERLYING}{YYYYMMDD}{STRIKE}{CE|PE}   NIFTY2026082824000CE
 *     future   {UNDERLYING}{YYYYMMDD}FUT               CRUDEOIL20260819FUT
 *     equity   {SYMBOL}                                RELIANCE
 *
 * `routes/trades.ts` already emits the option form. `bot-engine.ts` did not — it
 * built `NIFTY24000CE` with no expiry at all, which has two consequences that
 * are worth stating because they are easy to mistake for unrelated bugs:
 *
 *   1. It does not parse, so `fetchFnOQuote` returns null and the position can
 *      never be priced. Any "current price" for it is fabricated upstream.
 *   2. Position netting keys on the symbol, so this week's and next week's
 *      24000CE collapse into one row with a blended average entry price.
 *
 * Contract identity is authoritative in the database COLUMNS (segment, expiry,
 * strike, optionType, ...). The symbol is a derived display and quote-lookup
 * key. Where the two could disagree — a fractional strike cannot be represented
 * in the grammar above — the column wins and the builder refuses to invent a
 * symbol rather than silently naming a different contract.
 */
import { istDateStr } from './ist.js';

export type Segment = 'EQ' | 'FO' | 'CD' | 'COM';
export type InstrumentType = 'EQUITY' | 'FUTURES' | 'OPTIONS';
export type OptionType = 'CE' | 'PE';

export interface InstrumentSpec {
  /** Canonical tradingsymbol — display and quote lookup, never the source of truth. */
  symbol: string;
  exchange: string;
  segment: Segment;
  instrumentType: InstrumentType;
  /** The spot this contract is priced against: NIFTY, CRUDEOIL, RELIANCE. */
  underlying: string;
  /** Expiry at IST midnight, or null for equity. */
  expiry: Date | null;
  strike: number | null;
  optionType: OptionType | null;
}

export class InstrumentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InstrumentError';
  }
}

// `&` is included for underlyings like M&M. The underlying is non-greedy so the
// following 8 digits bind to the date rather than being eaten as part of a name.
const OPTION_REGEX = /^([A-Z&]+?)(\d{4})(\d{2})(\d{2})(\d+)(CE|PE)$/;
const FUTURES_REGEX = /^([A-Z&]+?)(\d{4})(\d{2})(\d{2})FUT$/;
const UNDERLYING_REGEX = /^[A-Z&]+$/;

/**
 * Commodity and currency underlyings, used to infer the exchange when a caller
 * supplies a contract symbol without one. Single source of truth: BotEngine's
 * private `detectExchange` used to carry its own copy of these lists.
 */
const MCX_UNDERLYINGS = new Set([
  'GOLD', 'GOLDM', 'GOLDPETAL', 'GOLDGUINEA', 'SILVER', 'SILVERM', 'SILVERMIC',
  'CRUDEOIL', 'CRUDEOILM', 'NATURALGAS', 'NATGASMINI', 'COPPER', 'ZINC', 'ZINCMINI',
  'LEAD', 'LEADMINI', 'ALUMINIUM', 'ALUMINI', 'NICKEL', 'COTTON', 'MENTHAOIL',
  'CASTORSEED', 'CPO', 'KAPAS',
]);

const CDS_UNDERLYINGS = new Set([
  'USDINR', 'EURINR', 'GBPINR', 'JPYINR', 'AUDINR', 'CADINR', 'CHFINR',
  'SGDINR', 'HKDINR', 'CNHINR', 'EURUSD', 'GBPUSD', 'USDJPY',
]);

/** Exchange for an underlying when the caller did not specify one. */
export function detectExchange(underlying: string, instrumentType: InstrumentType = 'EQUITY'): string {
  const u = underlying.toUpperCase();
  if (MCX_UNDERLYINGS.has(u)) return 'MCX';
  if (CDS_UNDERLYINGS.has(u)) return 'CDS';
  return instrumentType === 'EQUITY' ? 'NSE' : 'NFO';
}

export function segmentForExchange(exchange: string): Segment {
  switch (exchange.toUpperCase()) {
    case 'NFO':
    case 'BFO':
      return 'FO';
    case 'MCX':
      return 'COM';
    case 'CDS':
      return 'CD';
    default:
      return 'EQ';
  }
}

/** YYYY-MM-DD (IST calendar date) from a Date or an already-formatted string. */
function toExpiryDateStr(expiry: Date | string): string {
  if (expiry instanceof Date) {
    if (Number.isNaN(expiry.getTime())) throw new InstrumentError('Expiry is an invalid Date');
    return istDateStr(expiry);
  }
  const trimmed = expiry.trim();
  if (!/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) {
    throw new InstrumentError(`Expiry must be YYYY-MM-DD, got "${expiry}"`);
  }
  return trimmed;
}

/**
 * A calendar date at IST midnight.
 *
 * Built from an explicit +05:30 offset rather than `new Date(y, m, d)` so the
 * stored instant does not shift with the host machine's timezone — this box runs
 * in IST but Render does not.
 */
export function expiryToDate(expiry: Date | string): Date {
  const dateStr = toExpiryDateStr(expiry);
  const d = new Date(`${dateStr}T00:00:00+05:30`);
  if (Number.isNaN(d.getTime())) throw new InstrumentError(`Expiry is not a real date: "${dateStr}"`);
  return d;
}

function assertUnderlying(underlying: string): string {
  const u = underlying.trim().toUpperCase();
  if (!UNDERLYING_REGEX.test(u)) {
    throw new InstrumentError(
      `Underlying "${underlying}" must be letters only — digits would make the ` +
      `expiry in the symbol ambiguous.`,
    );
  }
  return u;
}

export function buildOptionSymbol(
  underlying: string,
  expiry: Date | string,
  strike: number,
  optionType: OptionType,
): string {
  const u = assertUnderlying(underlying);
  if (!Number.isFinite(strike) || strike <= 0) {
    throw new InstrumentError(`Strike must be a positive number, got ${strike}`);
  }
  // A fractional strike (7.5, 12.5 — low-priced F&O names) cannot be encoded in
  // this grammar without ambiguity. Refuse rather than truncate: truncating 7.5
  // to 7 produces a symbol that names a DIFFERENT, real, tradeable contract.
  // The `strike` column carries the exact value; extend the grammar here if
  // fractional-strike underlyings are ever needed.
  if (!Number.isInteger(strike)) {
    throw new InstrumentError(
      `Fractional strike ${strike} cannot be encoded in the symbol grammar. ` +
      `Truncating would name a different contract.`,
    );
  }
  return `${u}${toExpiryDateStr(expiry).replace(/-/g, '')}${strike}${optionType}`;
}

export function buildFuturesSymbol(underlying: string, expiry: Date | string): string {
  const u = assertUnderlying(underlying);
  return `${u}${toExpiryDateStr(expiry).replace(/-/g, '')}FUT`;
}

/**
 * Parse a symbol into full contract identity.
 *
 * `exchange` is honoured when supplied — it is the only way to distinguish an
 * NFO future from an MCX one for an underlying not in the lists above. When
 * omitted it is inferred, and for a derivative that inference defaults to NFO.
 *
 * Anything that is not a recognisable derivative is treated as equity rather
 * than rejected, so equity symbols pass through untouched.
 */
export function parseInstrumentSymbol(symbol: string, exchange?: string): InstrumentSpec {
  const raw = symbol.trim().toUpperCase();
  if (!raw) throw new InstrumentError('Symbol is empty');

  const option = raw.match(OPTION_REGEX);
  if (option) {
    const [, underlying, y, m, d, strikeStr, optionType] = option;
    const ex = exchange?.toUpperCase() ?? detectExchange(underlying, 'OPTIONS');
    return {
      symbol: raw,
      exchange: ex,
      segment: segmentForExchange(ex),
      instrumentType: 'OPTIONS',
      underlying,
      expiry: expiryToDate(`${y}-${m}-${d}`),
      strike: Number(strikeStr),
      optionType: optionType as OptionType,
    };
  }

  const future = raw.match(FUTURES_REGEX);
  if (future) {
    const [, underlying, y, m, d] = future;
    const ex = exchange?.toUpperCase() ?? detectExchange(underlying, 'FUTURES');
    return {
      symbol: raw,
      exchange: ex,
      segment: segmentForExchange(ex),
      instrumentType: 'FUTURES',
      underlying,
      expiry: expiryToDate(`${y}-${m}-${d}`),
      strike: null,
      optionType: null,
    };
  }

  const ex = exchange?.toUpperCase() ?? detectExchange(raw, 'EQUITY');
  return {
    symbol: raw,
    exchange: ex,
    segment: segmentForExchange(ex),
    instrumentType: 'EQUITY',
    underlying: raw,
    expiry: null,
    strike: null,
    optionType: null,
  };
}

/** True when the symbol is a derivative this module can fully identify. */
export function isDerivativeSymbol(symbol: string): boolean {
  const raw = symbol.trim().toUpperCase();
  return OPTION_REGEX.test(raw) || FUTURES_REGEX.test(raw);
}

/**
 * Stable identity key for netting and de-duplication.
 *
 * Two rows share a key only when they are genuinely the same contract. Keying on
 * the symbol alone was what merged different expiries into one position.
 */
export function contractKey(spec: Pick<InstrumentSpec,
  'underlying' | 'exchange' | 'instrumentType' | 'expiry' | 'strike' | 'optionType'>): string {
  const expiry = spec.expiry ? istDateStr(spec.expiry) : '-';
  return [
    spec.exchange,
    spec.instrumentType,
    spec.underlying,
    expiry,
    spec.strike ?? '-',
    spec.optionType ?? '-',
  ].join('|');
}
