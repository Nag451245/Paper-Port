/**
 * Fail-closed guard on positions whose margin this system cannot yet compute.
 *
 * `TradeService.shortMarginRequired` is a flat percentage of trade value:
 *
 *     price * qty * (MCX ? 0.10 : CDS ? 0.05 : 0.25)
 *
 * For equity that is roughly the right shape. For a SHORT OPTION it is not even
 * the right order of magnitude, because the trade value of an option is its
 * PREMIUM while the margin is set against the NOTIONAL:
 *
 *     short 1 lot NIFTY 24000CE at premium ₹120, lot 75
 *       trade value   = 120 * 75            = ₹9,000
 *       margin taken  = 25% of ₹9,000       = ₹2,250
 *       real SPAN+exposure                  ≈ ₹1,30,000 – ₹1,60,000
 *
 * That is off by a factor of roughly sixty, and it is wrong in the dangerous
 * direction: it makes selling premium look nearly free. A paper account will
 * happily compound a smooth daily return on positions no broker would have let
 * you hold, and the equity curve produced is not a conservative estimate of a
 * real one — it is unrelated to it. Short gamma pays a little every day and
 * takes it all back on one gap, and an under-margined simulator hides exactly
 * that risk.
 *
 * FUTURES are blocked for a different reason: the cash model assumes you pay
 * full notional. `handleBuyFill` debits `fillPrice * qty`, so buying one lot of
 * NIFTY futures debits the entire contract value rather than posting margin,
 * and the STRICT declared-capital check then rejects it outright. The short side
 * uses the same flat 25%. Neither is a margin model.
 *
 * LONG options are allowed: the premium debit that `handleBuyFill` applies is
 * genuinely what a long option costs, so that path is already correct.
 *
 * Remove this guard when a real SPAN + exposure calculation lands, with
 * portfolio-level netting so hedged structures are not charged per naked leg.
 * Deleting `BLOCK_UNTIL_REAL_SPAN` is the only change that should be needed.
 */

export const BLOCK_UNTIL_REAL_SPAN = true;

export interface MarginGuardVerdict {
  allowed: boolean;
  reason?: string;
}

export interface MarginGuardInput {
  /** Contract identity, as resolved by lib/instrument.ts. */
  instrumentType: 'EQUITY' | 'FUTURES' | 'OPTIONS' | string;
  side: 'BUY' | 'SELL' | string;
  symbol: string;
  exchange?: string;
  /** Units being ordered. Required for the reducing-trade exemption below. */
  qty?: number;
  /**
   * Units currently held LONG in this exact contract.
   *
   * A SELL that does not exceed this is closing a long, not opening a short, and
   * must be allowed — otherwise buying a call (which IS permitted, since the
   * premium debit is modelled correctly) would trap the position with no way to
   * exit through the normal order path.
   */
  reducingQty?: number;
}

const ALLOWED: MarginGuardVerdict = { allowed: true };

/** A SELL is a close, not a new short, when it does not exceed the long held. */
function isReducingTrade(input: MarginGuardInput): boolean {
  const held = input.reducingQty ?? 0;
  if (held <= 0) return false;
  const qty = input.qty ?? 0;
  // A missing qty cannot be proven to be reducing, so it is not treated as one.
  return qty > 0 && qty <= held;
}

export function checkMarginSupported(input: MarginGuardInput): MarginGuardVerdict {
  if (!BLOCK_UNTIL_REAL_SPAN) return ALLOWED;

  const type = String(input.instrumentType ?? '').toUpperCase();
  const side = String(input.side ?? '').toUpperCase();

  // Exits are always permitted. Blocking them would strand open positions.
  if (side === 'SELL' && isReducingTrade(input)) return ALLOWED;

  if (type === 'OPTIONS' && side === 'SELL') {
    return {
      allowed: false,
      reason:
        `MARGIN NOT MODELLED: short options are blocked. ${input.symbol} would be ` +
        `margined at 25% of premium, roughly 1/60th of real SPAN+exposure, which ` +
        `makes premium selling look nearly free and would produce a paper equity ` +
        `curve unrelated to a real one. Long options and equity are unaffected.`,
    };
  }

  if (type === 'FUTURES') {
    return {
      allowed: false,
      reason:
        `MARGIN NOT MODELLED: futures are blocked. ${input.symbol} would be charged ` +
        `full notional on the buy side (which the declared-capital check then ` +
        `rejects) and a flat 25% on the sell side. Neither is a margin model. ` +
        `Closing an existing long futures position is still permitted.`,
    };
  }

  return ALLOWED;
}
