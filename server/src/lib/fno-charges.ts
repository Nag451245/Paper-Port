/**
 * NSE/BSE futures & options charges, with the rates that applied on each date,
 * so a backtest of 2024 pays 2024's STT and today's trade pays today's.
 *
 * Statutory changes encoded here:
 *  - STT, options premium (sell side): 0.0625% from 1 Apr 2023, 0.1% from
 *    1 Oct 2024, 0.15% from 1 Apr 2026 (Union Budget 2026-27).
 *  - STT, options exercised in the money (buyer, on intrinsic value): 0.125%,
 *    0.15% from 1 Apr 2026.
 *  - STT, futures (sell side): 0.0125%, 0.02% from 1 Oct 2024, 0.05% from 1 Apr 2026.
 *  - NSE transaction charges: options 0.0503% → 0.03503% and futures 0.0019% →
 *    0.00173% from 1 Oct 2024 (uniform slab). BSE options 0.0325%.
 *  - Stamp duty (buy side) options 0.003%, futures 0.002%. SEBI ₹10 per crore.
 *    GST 18% on brokerage + exchange + SEBI charges.
 * Brokerage is the broker's, not the law's: ₹20 per executed order by default.
 */

export interface FnoRates {
  /** All as fractions of turnover (0.0015 = 0.15%). */
  sttOptionSell: number;
  sttOptionExercise: number;
  sttFutureSell: number;
  exchangeOption: number;
  exchangeFuture: number;
  stampOptionBuy: number;
  stampFutureBuy: number;
  sebi: number;
  gst: number;
  /** Rupees per executed order. */
  brokeragePerOrder: number;
}

export const DEFAULT_BROKERAGE_PER_ORDER = 20;

const BSE_UNDERLYINGS = new Set(['SENSEX', 'BANKEX']);

/** Rates in force on `day` (YYYY-MM-DD, IST). */
export function fnoRatesOn(day: string, opts: { underlying?: string; brokeragePerOrder?: number } = {}): FnoRates {
  const bse = BSE_UNDERLYINGS.has((opts.underlying ?? '').toUpperCase());
  const afterOct24 = day >= '2024-10-01';
  const afterApr26 = day >= '2026-04-01';
  return {
    sttOptionSell: afterApr26 ? 0.0015 : afterOct24 ? 0.001 : day >= '2023-04-01' ? 0.000625 : 0.0005,
    sttOptionExercise: afterApr26 ? 0.0015 : 0.00125,
    sttFutureSell: afterApr26 ? 0.0005 : afterOct24 ? 0.0002 : 0.000125,
    exchangeOption: bse ? 0.000325 : afterOct24 ? 0.0003503 : 0.000503,
    exchangeFuture: bse ? 0 : afterOct24 ? 0.0000173 : 0.000019,
    stampOptionBuy: 0.00003,
    stampFutureBuy: 0.00002,
    sebi: 0.000001,
    gst: 0.18,
    brokeragePerOrder: opts.brokeragePerOrder ?? DEFAULT_BROKERAGE_PER_ORDER,
  };
}

export interface ChargeBreakdown {
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  totalCost: number;
}

const r2 = (n: number) => Math.round(n * 100) / 100;

/** Charges for one executed option order: `price` is the premium per unit. */
export function optionOrderCharges(rates: FnoRates, side: 'BUY' | 'SELL', price: number, qty: number): ChargeBreakdown {
  const turnover = Math.max(0, price) * Math.abs(qty);
  const brokerage = rates.brokeragePerOrder;
  const stt = side === 'SELL' ? turnover * rates.sttOptionSell : 0;
  const exchangeCharges = turnover * rates.exchangeOption;
  const sebiCharges = turnover * rates.sebi;
  const stampDuty = side === 'BUY' ? turnover * rates.stampOptionBuy : 0;
  const gst = (brokerage + exchangeCharges + sebiCharges) * rates.gst;
  return {
    brokerage: r2(brokerage), stt: r2(stt), exchangeCharges: r2(exchangeCharges), gst: r2(gst),
    sebiCharges: r2(sebiCharges), stampDuty: r2(stampDuty),
    totalCost: r2(brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty),
  };
}

/** Charges for one executed futures order at `price`. */
export function futureOrderCharges(rates: FnoRates, side: 'BUY' | 'SELL', price: number, qty: number): ChargeBreakdown {
  const turnover = Math.max(0, price) * Math.abs(qty);
  const brokerage = Math.min(turnover * 0.0003, rates.brokeragePerOrder);
  const stt = side === 'SELL' ? turnover * rates.sttFutureSell : 0;
  const exchangeCharges = turnover * rates.exchangeFuture;
  const sebiCharges = turnover * rates.sebi;
  const stampDuty = side === 'BUY' ? turnover * rates.stampFutureBuy : 0;
  const gst = (brokerage + exchangeCharges + sebiCharges) * rates.gst;
  return {
    brokerage: r2(brokerage), stt: r2(stt), exchangeCharges: r2(exchangeCharges), gst: r2(gst),
    sebiCharges: r2(sebiCharges), stampDuty: r2(stampDuty),
    totalCost: r2(brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty),
  };
}

/** STT charged to the holder of a long option that expires in the money (cash-settled index options). */
export function exerciseStt(rates: FnoRates, intrinsic: number, qty: number): number {
  return r2(Math.max(0, intrinsic) * Math.abs(qty) * rates.sttOptionExercise);
}

export function sumCharges(parts: ChargeBreakdown[]): ChargeBreakdown {
  const out = { brokerage: 0, stt: 0, exchangeCharges: 0, gst: 0, sebiCharges: 0, stampDuty: 0, totalCost: 0 };
  for (const p of parts) for (const k of Object.keys(out) as (keyof ChargeBreakdown)[]) out[k] += p[k];
  for (const k of Object.keys(out) as (keyof ChargeBreakdown)[]) out[k] = r2(out[k]);
  return out;
}
