/**
 * Option strategy maths at expiry, after charges — the same rules as the Rust
 * engine's options_strategy (engine/src/options_strategy.rs), for the places
 * that rank many candidates or run without the engine.
 *
 * The P&L at expiry is a straight line between strikes, so the best and worst
 * values sit at a strike or at a price of 0; above the highest strike it keeps
 * moving by the net calls held (unlimited profit or loss).
 */

export interface MathLeg {
  type: 'CE' | 'PE';
  action: 'BUY' | 'SELL';
  strike: number;
  qty: number;
  premium: number;
}

export interface AnalyzeOptions {
  /** Days to expiry. */
  days: number;
  /** Annual volatility (0.146) for the chance of profit — normally implied volatility. */
  sigma: number;
  /** Annual volatility for the expected P&L — normally recent realised volatility. Defaults to `sigma`. */
  sigmaEv?: number;
  rf?: number;
  /** Charges paid to open, rupees. */
  fixedCost?: number;
  /** STT rate on long options expiring in the money. */
  exerciseStt?: number;
  range?: [number, number];
  points?: number;
  /** For the margin estimate: index options are margined at a lower rate than stock options. */
  underlying?: string;
}

export interface Analysis {
  curve: { spot: number; pnl: number }[];
  maxProfit: number;
  maxLoss: number;
  unlimitedProfit: boolean;
  unlimitedLoss: boolean;
  breakevens: number[];
  /** 0..1 */
  pop: number;
  /** Average P&L at expiry if prices move with `sigmaEv`, after charges. */
  expectedPnl: number;
  /** + = credit received. */
  netPremium: number;
  /** Capital the position ties up: bought options paid in full plus the margin on sold ones (lib/margin.ts). */
  margin: number;
}

import { strategyMargin } from './margin.js';

const r2 = (n: number) => Math.round(n * 100) / 100;

export function normCdf(x: number): number {
  // Abramowitz & Stegun 7.1.26, as in the engine.
  const sign = x < 0 ? -1 : 1;
  const z = Math.abs(x) / Math.SQRT2;
  const t = 1 / (1 + 0.3275911 * z);
  const y = 1 - (((((1.061405429 * t - 1.453152027) * t) + 1.421413741) * t - 0.284496736) * t + 0.254829592) * t * Math.exp(-z * z);
  return 0.5 * (1 + sign * y);
}

export function analyzeStrategy(legs: MathLeg[], spot: number, o: AnalyzeOptions): Analysis {
  const rf = o.rf ?? 0.065;
  const fixed = Math.max(0, o.fixedCost ?? 0);
  const ex = Math.max(0, o.exerciseStt ?? 0);
  const signed = (l: MathLeg) => (l.action === 'BUY' ? l.qty : -l.qty);
  const keep = (l: MathLeg) => (l.action === 'BUY' ? 1 - ex : 1);
  const intrinsic = (l: MathLeg, s: number) => Math.max(0, l.type === 'CE' ? s - l.strike : l.strike - s);
  const netPaid = legs.reduce((s, l) => s + l.premium * signed(l), 0);           // + = debit
  const pnlAt = (s: number) => legs.reduce((a, l) => a + intrinsic(l, s) * signed(l) * keep(l), 0) - netPaid - fixed;

  const netCalls = legs.filter((l) => l.type === 'CE').reduce((s, l) => s + signed(l) * keep(l), 0);
  const corners = [...new Set([0, ...legs.map((l) => l.strike)])].sort((a, b) => a - b);
  const top = Math.max(spot, ...corners) * 2;
  corners.push(top);
  const cp = corners.map(pnlAt);
  const breakevens: number[] = [];
  for (let i = 1; i < corners.length; i++) {
    const [a, b, pa, pb] = [corners[i - 1], corners[i], cp[i - 1], cp[i]];
    if ((pa < 0) !== (pb < 0) && pb !== pa) breakevens.push(r2(a + (0 - pa) * (b - a) / (pb - pa)));
  }
  const last = cp[cp.length - 1];
  if (netCalls !== 0 && (last < 0) !== (netCalls < 0)) breakevens.push(r2(top - last / netCalls));

  // Lognormal price at expiry.
  const t = Math.max(o.days, 0.5) / 365;
  const below = (x: number, sigma: number) => (x <= 0 ? 0 : x === Infinity ? 1
    : normCdf((Math.log(x / spot) - (rf - sigma * sigma / 2) * t) / (sigma * Math.sqrt(t))));
  const sigma = o.sigma > 0 ? o.sigma : 0.2;
  let pop = 0;
  const cuts = [...breakevens].sort((a, b) => a - b);
  let lo = 0;
  for (let i = 0; i <= cuts.length; i++) {
    const hi = i < cuts.length ? cuts[i] : Infinity;
    const probe = hi === Infinity ? Math.max(lo, spot) * 1.5 + 1 : (lo + hi) / 2;
    if (pnlAt(probe) > 0) pop += below(hi, sigma) - below(lo, sigma);
    lo = hi;
  }

  // Expected P&L: sum of P&L x probability over thin price slices (±6 standard deviations).
  const sEv = o.sigmaEv && o.sigmaEv > 0 ? o.sigmaEv : sigma;
  const width = sEv * Math.sqrt(t);
  const n = 400;
  let expectedPnl = 0;
  for (let i = 0; i < n; i++) {
    const a = spot * Math.exp(-6 * width + (12 * width * i) / n);
    const b = spot * Math.exp(-6 * width + (12 * width * (i + 1)) / n);
    expectedPnl += pnlAt((a + b) / 2) * (below(b, sEv) - below(a, sEv));
  }

  const maxProfit = Math.max(...cp);
  const maxLoss = Math.min(...cp);
  const buyPremium = legs.filter((l) => l.action === 'BUY').reduce((s, l) => s + l.premium * l.qty, 0);
  // What placing these legs ties up: bought options paid in full, plus the
  // margin on the sold ones (the same rules the order engine applies).
  const margin = buyPremium + strategyMargin(legs, spot, o.underlying);

  const lowR = o.range?.[0] ?? spot * 0.8, highR = o.range?.[1] ?? spot * 1.2, pts = o.points ?? 100;
  const xs = [...new Set([...Array.from({ length: pts + 1 }, (_, i) => lowR + ((highR - lowR) * i) / pts),
    ...legs.map((l) => l.strike).filter((k) => k > lowR && k < highR)])].sort((a, b) => a - b);

  return {
    curve: xs.map((s) => ({ spot: r2(s), pnl: r2(pnlAt(s)) })),
    maxProfit: r2(maxProfit),
    maxLoss: r2(maxLoss),
    unlimitedProfit: netCalls > 0,
    unlimitedLoss: netCalls < 0,
    breakevens,
    pop: Math.min(1, Math.max(0, pop)),
    expectedPnl: r2(expectedPnl),
    netPremium: r2(-netPaid),
    margin: r2(margin),
  };
}

/** Annualised volatility of daily closes (log returns, 252 trading days). */
export function realisedVol(closes: number[], days = 20): number | null {
  const c = closes.filter((x) => x > 0).slice(-(days + 1));
  if (c.length < Math.min(days, 10) + 1) return null;
  const r = c.slice(1).map((x, i) => Math.log(x / c[i]));
  const mean = r.reduce((a, b) => a + b, 0) / r.length;
  const v = r.reduce((a, b) => a + (b - mean) ** 2, 0) / Math.max(1, r.length - 1);
  return Math.sqrt(v * 252);
}
