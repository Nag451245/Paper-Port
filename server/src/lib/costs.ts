import { fnoRatesOn, optionOrderCharges, futureOrderCharges } from './fno-charges.js';
import { istDateStr } from './ist.js';

export interface CostBreakdown {
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  totalCost: number;
}

export type InstrumentKind = 'EQUITY' | 'FUTURES' | 'OPTIONS';

/**
 * Work out whether an NFO/BFO trade is a future or an option.
 *
 * Positions in the DB carry no optionType/strike column, so for exit-cost
 * calculations the symbol suffix is the only signal available. Callers that
 * do know (order placement) should pass `optionType` explicitly.
 */
export function resolveInstrumentKind(
  exchange: string,
  symbol?: string,
  optionType?: string,
): InstrumentKind {
  const ex = (exchange ?? '').toUpperCase();
  if (ex !== 'NFO' && ex !== 'BFO') return 'EQUITY';
  if (optionType === 'CE' || optionType === 'PE') return 'OPTIONS';
  if (symbol && /(CE|PE)$/i.test(symbol.trim())) return 'OPTIONS';
  return 'FUTURES';
}


/** NSE/BSE F&O charges at today's statutory rates (lib/fno-charges.ts keeps the dated table).
 * Options are charged on premium turnover, futures on notional. */
function calculateFnoCosts(turnover: number, side: string, kind: 'FUTURES' | 'OPTIONS'): CostBreakdown {
  const rates = fnoRatesOn(istDateStr());
  const s = side === 'SELL' ? 'SELL' : 'BUY';
  return kind === 'OPTIONS' ? optionOrderCharges(rates, s, turnover, 1) : futureOrderCharges(rates, s, turnover, 1);
}

export function calculateCosts(
  qty: number,
  price: number,
  side: string,
  exchange: string = 'NSE',
  instrument?: InstrumentKind,
): CostBreakdown {
  const turnover = qty * price;

  const kind = instrument ?? resolveInstrumentKind(exchange);
  if (kind === 'FUTURES' || kind === 'OPTIONS') {
    return calculateFnoCosts(turnover, side, kind);
  }

  if (exchange === 'MCX') {
    const brokerage = Math.min(turnover * 0.0003, 20);
    const ctt = side === 'SELL' ? turnover * 0.0001 : 0;
    const exchangeCharges = turnover * 0.000026;
    const gst = (brokerage + exchangeCharges) * 0.18;
    const sebiCharges = turnover * 0.000001;
    const stampDuty = side === 'BUY' ? turnover * 0.00002 : 0;
    const totalCost = brokerage + ctt + exchangeCharges + gst + sebiCharges + stampDuty;
    return {
      brokerage: Number(brokerage.toFixed(2)),
      stt: Number(ctt.toFixed(2)),
      exchangeCharges: Number(exchangeCharges.toFixed(2)),
      gst: Number(gst.toFixed(2)),
      sebiCharges: Number(sebiCharges.toFixed(2)),
      stampDuty: Number(stampDuty.toFixed(2)),
      totalCost: Number(totalCost.toFixed(2)),
    };
  }

  if (exchange === 'CDS') {
    const brokerage = Math.min(turnover * 0.0003, 20);
    const stt = 0;
    const exchangeCharges = turnover * 0.000035;
    const gst = (brokerage + exchangeCharges) * 0.18;
    const sebiCharges = turnover * 0.000001;
    const stampDuty = side === 'BUY' ? turnover * 0.00001 : 0;
    const totalCost = brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty;
    return {
      brokerage: Number(brokerage.toFixed(2)),
      stt: Number(stt.toFixed(2)),
      exchangeCharges: Number(exchangeCharges.toFixed(2)),
      gst: Number(gst.toFixed(2)),
      sebiCharges: Number(sebiCharges.toFixed(2)),
      stampDuty: Number(stampDuty.toFixed(2)),
      totalCost: Number(totalCost.toFixed(2)),
    };
  }

  const brokerage = Math.min(turnover * 0.0003, 20);
  const stt = side === 'SELL' ? turnover * 0.001 : 0;
  const exchangeCharges = turnover * 0.0000345;
  const gst = (brokerage + exchangeCharges) * 0.18;
  const sebiCharges = turnover * 0.000001;
  const stampDuty = side === 'BUY' ? turnover * 0.00015 : 0;
  const totalCost = brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty;

  return {
    brokerage: Number(brokerage.toFixed(2)),
    stt: Number(stt.toFixed(2)),
    exchangeCharges: Number(exchangeCharges.toFixed(2)),
    gst: Number(gst.toFixed(2)),
    sebiCharges: Number(sebiCharges.toFixed(2)),
    stampDuty: Number(stampDuty.toFixed(2)),
    totalCost: Number(totalCost.toFixed(2)),
  };
}
