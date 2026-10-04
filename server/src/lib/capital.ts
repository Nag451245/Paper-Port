/**
 * Virtual capital limits.
 *  - The user may set a portfolio's capital to at most ₹1 crore.
 *  - When an order the user places needs more money than the portfolio has,
 *    capital is added automatically (if the portfolio allows it) in ₹50,000
 *    steps, up to ₹50 lakh in total. Beyond that the user must raise it.
 * A top-up adds the same amount to the capital and to the cash, so profit and
 * loss (worth − capital) are unchanged by it.
 */
export const MANUAL_CAPITAL_LIMIT = 1_00_00_000;
export const AUTO_TOPUP_LIMIT = 50_00_000;
export const AUTO_TOPUP_STEP = 50_000;

/**
 * Rupees to add so a shortfall is covered, or 0 when it cannot be covered
 * within the automatic limit.
 */
export function autoTopUpAmount(capital: number, shortfall: number): number {
  if (!(shortfall > 0)) return 0;
  const amount = Math.ceil(shortfall / AUTO_TOPUP_STEP) * AUTO_TOPUP_STEP;
  if (capital + amount <= AUTO_TOPUP_LIMIT) return amount;
  // The last step may be smaller than ₹50,000: go exactly to the limit if that is enough.
  const room = AUTO_TOPUP_LIMIT - capital;
  return room >= shortfall ? room : 0;
}
