/**
 * The maths behind stock alerts. An alert means "this stock is doing
 * something statistically unusual today, on real volume, beyond what the
 * market explains", with risk levels sized to its own volatility. It is a
 * description of today, not a forecast: none of these numbers has been shown
 * to predict tomorrow's price (see server/scripts/measure-signal-ic.mjs).
 *
 * Models used:
 *  - Market model (CAPM-style regression): r_stock = α + β·r_NIFTY + ε over the
 *    last 60 sessions. Today's surprise is ε_today = r_today − α − β·r_NIFTY,today,
 *    measured in standard deviations of ε (an idiosyncratic z-score).
 *  - RiskMetrics EWMA volatility (λ = 0.94) for the stock's and NIFTY's own
 *    daily moves.
 *  - Relative volume: today's volume against the 20-session average, scaled to
 *    the part of the session that has passed.
 *  - Wilder's ATR(14) for stop and target distances.
 */

export interface DailyBar { timestamp: string; high: number; low: number; close: number; volume: number }

export const ALERT_RULES = {
  /** Sessions used for β, residual volatility and averages. */
  lookback: 60,
  minPrice: 20,
  /** Average daily traded value, in rupees: ₹5 crore. Thinner stocks move on small orders. */
  minAvgTurnover: 5e7,
  /** Stock-specific move of at least 2 standard deviations. */
  minIdioZ: 2,
  /** At least 1.5× the usual volume for this point in the session. */
  minRelVolume: 1.5,
  /** Do not buy into a broad sell-off (or short into a broad rally) beyond this many σ of NIFTY. */
  marketAgainstZ: 1.5,
  stopAtr: 1.5,
  targetAtr: 3,
  /** A 1.5×ATR stop wider than this is too volatile to alert on. */
  maxStopPct: 6,
} as const;

export const logReturns = (closes: number[]): number[] =>
  closes.slice(1).map((c, i) => Math.log(c / closes[i]));

export function mean(xs: number[]): number {
  return xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0;
}

export function stdev(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(xs.reduce((s, x) => s + (x - m) ** 2, 0) / (xs.length - 1));
}

/** RiskMetrics EWMA volatility of daily returns (λ = 0.94), seeded with the sample variance. */
export function ewmaVol(returns: number[], lambda = 0.94): number {
  if (returns.length < 2) return 0;
  let v = stdev(returns) ** 2;
  for (const r of returns) v = lambda * v + (1 - lambda) * r * r;
  return Math.sqrt(v);
}

/** Ordinary least squares of y on x: intercept, slope and the residuals' standard deviation. */
export function regress(y: number[], x: number[]): { alpha: number; beta: number; residualSd: number } {
  const n = Math.min(y.length, x.length);
  const ys = y.slice(-n), xs = x.slice(-n);
  const mx = mean(xs), my = mean(ys);
  let sxy = 0, sxx = 0;
  for (let i = 0; i < n; i++) { sxy += (xs[i] - mx) * (ys[i] - my); sxx += (xs[i] - mx) ** 2; }
  const beta = sxx > 0 ? sxy / sxx : 0;
  const alpha = my - beta * mx;
  const resid = ys.map((v, i) => v - alpha - beta * xs[i]);
  // n − 2 degrees of freedom: two parameters were estimated.
  const residualSd = n > 2 ? Math.sqrt(resid.reduce((s, e) => s + e * e, 0) / (n - 2)) : 0;
  return { alpha, beta, residualSd };
}

/** Wilder's average true range. */
export function atr(bars: DailyBar[], period = 14): number {
  if (bars.length < period + 1) return 0;
  const tr = bars.slice(1).map((b, i) => Math.max(b.high - b.low, Math.abs(b.high - bars[i].close), Math.abs(b.low - bars[i].close)));
  let a = mean(tr.slice(0, period));
  for (const t of tr.slice(period)) a = (a * (period - 1) + t) / period;
  return a;
}

export const sma = (xs: number[], n: number): number => (xs.length >= n ? mean(xs.slice(-n)) : 0);

/** Share of the NSE cash session (09:15–15:30 IST) that has passed at `now`. */
export function sessionFraction(now: Date): number {
  const istMinuteOfDay = (((now.getTime() + 330 * 60_000) % 86_400_000) + 86_400_000) % 86_400_000 / 60_000;
  const minutes = istMinuteOfDay - (9 * 60 + 15);
  return Math.min(1, Math.max(0, minutes / 375));
}

/** What a stock's history says, computed once a day per stock. */
export interface StockStats {
  closes: number[];
  alpha: number;
  beta: number;
  residualSd: number;
  vol: number;
  atr: number;
  avgVolume: number;
  avgTurnover: number;
  sma50: number;
}

/**
 * History statistics for a stock against the market, from completed daily
 * bars (today's bar must not be included). Null without enough history.
 */
export function stockStats(bars: DailyBar[], marketBars: DailyBar[]): StockStats | null {
  const L = ALERT_RULES.lookback;
  const market = new Map(marketBars.map((b) => [b.timestamp.slice(0, 10), b.close]));
  // Returns on days both traded, so the regression pairs like with like.
  const paired = bars.filter((b) => market.has(b.timestamp.slice(0, 10)) && b.close > 0).slice(-(L + 1));
  if (paired.length < 40) return null;
  const rs = logReturns(paired.map((b) => b.close));
  const rm = logReturns(paired.map((b) => market.get(b.timestamp.slice(0, 10))!));
  const { alpha, beta, residualSd } = regress(rs, rm);
  const recent = bars.slice(-20);
  return {
    closes: bars.map((b) => b.close),
    alpha, beta, residualSd,
    vol: ewmaVol(logReturns(bars.slice(-(L + 1)).map((b) => b.close))),
    atr: atr(bars.slice(-(L + 1))),
    avgVolume: mean(recent.map((b) => b.volume)),
    avgTurnover: mean(recent.map((b) => b.volume * b.close)),
    sma50: sma(bars.map((b) => b.close), 50),
  };
}

export interface Assessment {
  pass: boolean;
  /** Why it failed, in plain words (first failing rule). */
  reason?: string;
  direction: 'BUY' | 'SELL';
  ltp: number;
  changePct: number;
  idioZ: number;
  totalZ: number;
  beta: number;
  relVolume: number;
  stop: number;
  target: number;
  stopPct: number;
  aboveSma50: boolean;
  /** Ranking only: bigger, better-confirmed surprises first. */
  score: number;
}

/**
 * Is today's move alert-worthy? `direction` is the side a signal asked for;
 * omit it to take the side of the move.
 */
export function assess(input: {
  stats: StockStats;
  ltp: number;
  prevClose: number;
  volume: number;
  marketReturn: number;
  marketVol: number;
  now: Date;
  direction?: 'BUY' | 'SELL';
}): Assessment {
  const R = ALERT_RULES;
  const { stats, ltp, prevClose, volume, marketReturn, marketVol, now } = input;
  const r = Math.log(ltp / prevClose);
  const idio = r - stats.alpha - stats.beta * marketReturn;
  const idioZ = stats.residualSd > 0 ? idio / stats.residualSd : 0;
  const totalZ = stats.vol > 0 ? r / stats.vol : 0;
  const direction = input.direction ?? (idio >= 0 ? 'BUY' : 'SELL');
  const expectedVolume = stats.avgVolume * Math.max(sessionFraction(now), 0.05);
  const relVolume = expectedVolume > 0 ? volume / expectedVolume : 0;
  const stopDist = R.stopAtr * stats.atr;
  const sign = direction === 'BUY' ? 1 : -1;
  const marketZ = marketVol > 0 ? marketReturn / marketVol : 0;

  const base: Assessment = {
    pass: false, direction, ltp,
    changePct: (ltp / prevClose - 1) * 100,
    idioZ, totalZ, beta: stats.beta, relVolume,
    stop: ltp - sign * stopDist,
    target: ltp + sign * R.targetAtr * stats.atr,
    stopPct: (stopDist / ltp) * 100,
    aboveSma50: stats.sma50 > 0 && ltp > stats.sma50,
    score: Math.abs(idioZ) * Math.log1p(Math.min(relVolume, 10)),
  };

  const fail = (reason: string): Assessment => ({ ...base, reason });
  if (ltp < R.minPrice) return fail(`price below ₹${R.minPrice}`);
  if (stats.avgTurnover < R.minAvgTurnover) return fail('too thinly traded');
  if (!(stats.atr > 0) || !(stats.residualSd > 0)) return fail('not enough history');
  if (Math.abs(idioZ) < R.minIdioZ) return fail(`stock-specific move only ${Math.abs(idioZ).toFixed(1)}σ`);
  if (Math.sign(idio) !== sign) return fail('the move goes against the signal');
  if (relVolume < R.minRelVolume) return fail(`volume only ${relVolume.toFixed(1)}× normal`);
  if (sign * marketZ <= -R.marketAgainstZ) return fail('the whole market is moving hard the other way');
  if (base.stopPct > R.maxStopPct) return fail('too volatile for a sensible stop');
  return { ...base, pass: true };
}
