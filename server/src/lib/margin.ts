/**
 * Margin a broker would block, in rupees — an estimate of exchange SPAN +
 * exposure margin, not the exchange's own calculation (that needs its daily
 * risk files). The aim is the right order of magnitude so paper trading
 * teaches realistic position sizes.
 *
 *  Sold option, nothing protecting it ("naked"):
 *    index:  11.5% of the underlying's value, less the amount it is out of the
 *            money, never under 6%           (NIFTY ATM, 65 lot ≈ ₹1.7 lakh)
 *    stock:  20%, less the out-of-the-money amount, never under 10%
 *  Sold option protected by a bought option of the same type and expiry
 *  (a spread): the most the pair can lose (strike gap × quantity) + 2%
 *    exposure margin, never more than the naked figure.
 *  Sold call and sold put together (straddle / strangle): only one side can
 *    lose, so the second leg adds just the 2% exposure margin.
 *  Futures, bought or sold: 12% of contract value (index), 20% (stock),
 *    10% (commodity), 5% (currency).
 *  Shares sold short intraday: 25% (unchanged).
 *
 * Bought options are paid for in full and need no margin.
 */

export type MarginInstrument = 'EQUITY' | 'FUTURES' | 'OPTIONS';

const INDEX_UNDERLYINGS = new Set([
  'NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX', 'BANKEX',
]);
export const isIndexUnderlying = (u?: string | null) => !!u && INDEX_UNDERLYINGS.has(u.toUpperCase());

export const EXPOSURE_RATE = 0.02;

/** The old flat rule, still used for shares sold short and for positions opened before margins were stored. */
export function legacyShortMargin(price: number, qty: number, exchange: string): number {
  const rate = exchange === 'MCX' ? 0.10 : exchange === 'CDS' ? 0.05 : 0.25;
  return price * qty * rate;
}

export function futuresMargin(price: number, qty: number, exchange: string, underlying?: string | null): number {
  const ex = (exchange ?? '').toUpperCase();
  const rate = ex === 'MCX' ? 0.10 : ex === 'CDS' ? 0.05 : isIndexUnderlying(underlying) ? 0.12 : 0.20;
  return price * qty * rate;
}

export interface ShortOption {
  underlying?: string | null;
  exchange?: string;
  optionType: 'CE' | 'PE';
  strike: number;
  qty: number;
  /** Price of the underlying now; the strike is used when it is not known (the costliest case). */
  spot?: number | null;
}

/** A sold option with nothing protecting it. */
export function nakedOptionMargin(o: ShortOption): number {
  const s = o.spot && o.spot > 0 ? o.spot : o.strike;
  const otm = Math.max(0, o.optionType === 'CE' ? o.strike - s : s - o.strike);
  const [rate, floor] = (o.exchange ?? '').toUpperCase() === 'MCX' ? [0.12, 0.06]
    : isIndexUnderlying(o.underlying) ? [0.115, 0.06] : [0.20, 0.10];
  return Math.max(rate * s - otm, floor * s) * o.qty;
}

/** Exposure margin alone: the second leg of a straddle, or a fully covered short. */
export function exposureMargin(o: ShortOption): number {
  const s = o.spot && o.spot > 0 ? o.spot : o.strike;
  return EXPOSURE_RATE * s * o.qty;
}

/** A sold option protected by a bought option of the same type and expiry at `longStrike`. */
export function spreadMargin(o: ShortOption, longStrike: number): number {
  const gap = o.optionType === 'CE' ? longStrike - o.strike : o.strike - longStrike;
  return Math.min(nakedOptionMargin(o), Math.max(0, gap) * o.qty + exposureMargin(o));
}

/**
 * Margin for a set of option legs placed together (bought legs first, as the
 * server places them): each sold leg is margined as a spread when a bought
 * leg of the same type covers it, as the second leg of a straddle when a sold
 * leg of the other type came before it, and otherwise alone.
 */
export function strategyMargin(
  legs: { type: 'CE' | 'PE'; action: 'BUY' | 'SELL'; strike: number; qty: number }[],
  spot: number, underlying?: string | null, exchange?: string,
): number {
  let total = 0;
  const alone: Record<'CE' | 'PE', boolean> = { CE: false, PE: false };
  for (const l of legs.filter((x) => x.action === 'SELL')) {
    const short: ShortOption = { underlying, exchange, optionType: l.type, strike: l.strike, qty: l.qty, spot };
    const naked = nakedOptionMargin(short);
    const protectedBy = legs.filter((b) => b.action === 'BUY' && b.type === l.type && b.qty >= l.qty)
      .map((b) => spreadMargin(short, b.strike));
    const spread = protectedBy.length ? Math.min(...protectedBy) : naked;
    if (spread < naked) total += spread;
    else if (alone[l.type === 'CE' ? 'PE' : 'CE']) total += exposureMargin(short);
    else { alone[l.type] = true; total += naked; }
  }
  return total;
}

/** Capital a position ties up: what was blocked for it, or the old rule for positions from before that was stored. */
export function capitalBlocked(pos: {
  side: string; qty: number; avgEntryPrice: unknown; exchange?: string | null; marginBlocked?: unknown;
}): number {
  if (pos.marginBlocked != null) return Number(pos.marginBlocked);
  const entry = Number(pos.avgEntryPrice);
  return pos.side === 'LONG' ? entry * pos.qty : legacyShortMargin(entry, pos.qty, pos.exchange ?? 'NSE');
}
