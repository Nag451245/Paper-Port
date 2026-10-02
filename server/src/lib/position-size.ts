/**
 * How many shares a bot trade gets, the way a trader sizes: by what is lost
 * if the stop is hit, not by a share of capital alone.
 *
 *  - Never more than `allocation` of capital (the Kelly / strategy cap).
 *  - With a stop: never more than RISK_PER_TRADE of capital lost at the stop,
 *    so a volatile stock with a wide stop gets fewer shares.
 *  - Zero when the allocation is zero (the stock's record shows no edge) or
 *    there is no price to size from. No more "at least 1 share".
 */
export const RISK_PER_TRADE = 0.005;

export function sizePosition(o: { nav: number; ltp: number; allocation: number; stopLoss?: number }): number {
  if (!(o.ltp > 0) || !(o.allocation > 0) || !(o.nav > 0)) return 0;
  let qty = Math.floor((o.nav * o.allocation) / o.ltp);
  const stopDist = o.stopLoss && o.stopLoss > 0 ? Math.abs(o.ltp - o.stopLoss) : 0;
  if (stopDist > 0) qty = Math.min(qty, Math.floor((o.nav * RISK_PER_TRADE) / stopDist));
  return Math.max(0, qty);
}
