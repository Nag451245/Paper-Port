/**
 * Black-Scholes price, implied volatility and Greeks for one option, per unit.
 * Used to describe an open strategy; orders, margins and P&L never come from here.
 */
import { normCdf } from './strategy-math.js';

const pdf = (x: number) => Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);

export interface OptionInput {
  type: 'CE' | 'PE';
  spot: number;
  strike: number;
  /** Days to expiry (fractions allowed). */
  days: number;
  /** Annual volatility as a fraction (0.146). */
  sigma: number;
  rf?: number;
}

const terms = (o: OptionInput) => {
  const t = Math.max(o.days, 0.02) / 365;
  const rf = o.rf ?? 0.065;
  const sd = o.sigma * Math.sqrt(t);
  const d1 = (Math.log(o.spot / o.strike) + (rf + o.sigma * o.sigma / 2) * t) / sd;
  return { t, rf, d1, d2: d1 - sd, disc: Math.exp(-rf * t) };
};

export function bsPrice(o: OptionInput): number {
  if (!(o.spot > 0) || !(o.strike > 0)) return 0;
  if (!(o.sigma > 0)) return Math.max(0, o.type === 'CE' ? o.spot - o.strike : o.strike - o.spot);
  const { d1, d2, disc } = terms(o);
  return o.type === 'CE'
    ? o.spot * normCdf(d1) - o.strike * disc * normCdf(d2)
    : o.strike * disc * normCdf(-d2) - o.spot * normCdf(-d1);
}

/** The volatility that reproduces `price`, or null when no volatility can (price below its floor). */
export function impliedVol(price: number, o: Omit<OptionInput, 'sigma'>): number | null {
  if (!(price > 0) || !(o.spot > 0) || !(o.strike > 0)) return null;
  let lo = 0.01, hi = 5;
  if (bsPrice({ ...o, sigma: lo }) > price || bsPrice({ ...o, sigma: hi }) < price) return null;
  for (let i = 0; i < 60; i++) {
    const mid = (lo + hi) / 2;
    if (bsPrice({ ...o, sigma: mid }) > price) hi = mid; else lo = mid;
  }
  return (lo + hi) / 2;
}

export interface Greeks {
  /** Change in price for a 1-point move in the underlying. */
  delta: number;
  gamma: number;
  /** Change in price over one calendar day. */
  theta: number;
  /** Change in price for a 1-point (0.01) rise in volatility. */
  vega: number;
}

export function greeks(o: OptionInput): Greeks {
  if (!(o.sigma > 0) || !(o.spot > 0) || !(o.strike > 0)) return { delta: 0, gamma: 0, theta: 0, vega: 0 };
  const { t, rf, d1, d2, disc } = terms(o);
  const sqrtT = Math.sqrt(t);
  const call = o.type === 'CE';
  const decay = -(o.spot * pdf(d1) * o.sigma) / (2 * sqrtT);
  const carry = rf * o.strike * disc * (call ? normCdf(d2) : normCdf(-d2));
  return {
    delta: call ? normCdf(d1) : normCdf(d1) - 1,
    gamma: pdf(d1) / (o.spot * o.sigma * sqrtT),
    theta: (decay + (call ? -carry : carry)) / 365,
    vega: (o.spot * pdf(d1) * sqrtT) / 100,
  };
}
