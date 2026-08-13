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

function round2(n: number): number {
  return Number(n.toFixed(2));
}

/**
 * NSE/BSE F&O charges. Rates are FY2024-25 (post the 1 Oct 2024 STT revision)
 * for a flat-fee discount broker. These are statutory and change with each
 * budget — revisit when SEBI/exchange circulars land.
 *
 * Note the base differs from equity: options charges are levied on *premium*
 * turnover, futures on notional turnover.
 */
function calculateFnoCosts(
  turnover: number,
  side: string,
  kind: 'FUTURES' | 'OPTIONS',
): CostBreakdown {
  const isSell = side === 'SELL';

  const brokerage = kind === 'OPTIONS'
    ? 20                                       // flat per order on premium
    : Math.min(turnover * 0.0003, 20);

  // STT: options 0.10% on sell premium, futures 0.02% on sell notional
  const stt = isSell ? turnover * (kind === 'OPTIONS' ? 0.001 : 0.0002) : 0;

  // Exchange transaction charges
  const exchangeCharges = turnover * (kind === 'OPTIONS' ? 0.0003503 : 0.0000173);

  // SEBI turnover fees — Rs 10 per crore
  const sebiCharges = turnover * 0.000001;

  // Stamp duty, buy side only
  const stampDuty = isSell ? 0 : turnover * (kind === 'OPTIONS' ? 0.00003 : 0.00002);

  const gst = (brokerage + exchangeCharges + sebiCharges) * 0.18;

  const totalCost = brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty;

  return {
    brokerage: round2(brokerage),
    stt: round2(stt),
    exchangeCharges: round2(exchangeCharges),
    gst: round2(gst),
    sebiCharges: round2(sebiCharges),
    stampDuty: round2(stampDuty),
    totalCost: round2(totalCost),
  };
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
