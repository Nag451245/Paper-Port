/**
 * Strategy ideas: defined-risk option strategies built from the live chain,
 * priced at what can actually be traded (sell at the bid, buy at the ask),
 * charged, margined and ranked. Pure: the route supplies the chain and history.
 *
 * It proposes, the user decides. Nothing here places an order, and an idea is
 * only listed when it clears every check below; "nothing today" is a valid answer.
 */
import { analyzeStrategy, type MathLeg } from './strategy-math.js';
import { optionOrderCharges, sumCharges, type FnoRates } from './fno-charges.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const frac = (iv: number | undefined | null) => { const v = Number(iv) || 0; return v > 3 ? v / 100 : v; };

export interface ChainRow {
  strike: number;
  callLTP: number; putLTP: number;
  callIV?: number; putIV?: number;
  callOI?: number; putOI?: number;
  callBidPrice?: number; callAskPrice?: number;
  putBidPrice?: number; putAskPrice?: number;
}

export type VolVerdict = 'expensive' | 'fair' | 'cheap' | 'unknown';
export type Trend = 'up' | 'down' | 'sideways' | 'unknown';
export type Family = 'iron_condor' | 'iron_fly' | 'bull_put' | 'bear_call' | 'bull_call' | 'bear_put';
export type Fit = 'with' | 'neutral' | 'against';

export interface IdeasInput {
  symbol: string;
  spot: number;
  strikes: ChainRow[];
  /** Units per leg: lot size x lots. */
  qty: number;
  /** Days to expiry (fractions allowed). */
  days: number;
  rates: FnoRates;
  /** Daily closes of the underlying, oldest first (for realised volatility and trend). */
  closes: number[];
  /** Annual realised volatility over 20 sessions, as a fraction; null when unknown. */
  rv20: number | null;
  /** India VIX's place in its one-year range, 0-100; null when unknown. */
  vixPercentile?: number | null;
  /** Most the user will lose on one idea, rupees. */
  maxLoss?: number;
  /** Account net worth, to show each idea's worst case as a share of it. */
  netWorth?: number;
}

export interface IdeaLeg extends MathLeg { iv: number | null; priced: 'bid' | 'ask' | 'last' }

export interface Idea {
  id: string;
  name: string;
  family: Family;
  view: 'neutral' | 'bullish' | 'bearish';
  kind: 'credit' | 'debit';
  legs: IdeaLeg[];
  /** + = credit received */
  netPremium: number;
  maxProfit: number;
  /** Negative: the worst case at expiry, after charges. */
  maxLoss: number;
  breakevens: number[];
  /** 0-100 */
  pop: number;
  expectedPnl: number;
  margin: number;
  /** Expected P&L as a percentage of the margin blocked. */
  returnOnMargin: number;
  rewardToRisk: number;
  charges: number;
  fit: Fit;
  why: string[];
  warnings: string[];
  payoff: { spot: number; pnl: number }[];
  /** Why it is not offered, for near misses only. */
  blocked?: string;
}

export interface MarketRead {
  symbol: string;
  spot: number;
  days: number;
  atmIv: number | null;
  rv20: number | null;
  verdict: VolVerdict;
  trend: Trend;
  /** One standard deviation move to expiry at current implied volatility, in points. */
  expectedMove: number | null;
  vixPercentile: number | null;
  summary: string[];
}

export interface IdeasResult {
  read: MarketRead;
  ideas: Idea[];
  /** The best of what was turned down, when nothing passes, each with the reason. */
  nearMisses: Idea[];
  considered: number;
  rejected: Record<string, number>;
  message: string | null;
}

const NAMES: Record<Family, string> = {
  iron_condor: 'Iron Condor', iron_fly: 'Iron Butterfly', bull_put: 'Bull Put Spread',
  bear_call: 'Bear Call Spread', bull_call: 'Bull Call Spread', bear_put: 'Bear Put Spread',
};
const VIEW: Record<Family, Idea['view']> = {
  iron_condor: 'neutral', iron_fly: 'neutral', bull_put: 'bullish', bear_call: 'bearish', bull_call: 'bullish', bear_put: 'bearish',
};
const KIND: Record<Family, Idea['kind']> = {
  iron_condor: 'credit', iron_fly: 'credit', bull_put: 'credit', bear_call: 'credit', bull_call: 'debit', bear_put: 'debit',
};

/** Does this kind of strategy suit what the market is doing? */
export function fitOf(family: Family, vol: VolVerdict, trend: Trend): Fit {
  const view = VIEW[family];
  const withTrend = (view === 'bullish' && trend === 'up') || (view === 'bearish' && trend === 'down');
  const againstTrend = (view === 'bullish' && trend === 'down') || (view === 'bearish' && trend === 'up');
  if (KIND[family] === 'credit') {
    if (vol === 'cheap') return 'against';                       // selling options that are priced low
    if (view === 'neutral') return vol === 'expensive' && trend !== 'up' && trend !== 'down' ? 'with' : 'neutral';
    if (againstTrend) return 'against';
    return vol === 'expensive' && withTrend ? 'with' : 'neutral';
  }
  if (!withTrend) return 'against';                              // a debit spread needs the move
  return vol === 'cheap' ? 'with' : vol === 'expensive' ? 'against' : 'neutral';
}

export function buildIdeas(input: IdeasInput): IdeasResult {
  const { symbol, spot, qty, days, rates } = input;
  const rows = [...input.strikes].filter((r) => r.strike > 0).sort((a, b) => a.strike - b.strike);
  const rejected: Record<string, number> = {};
  const turnDown = (why: string) => { rejected[why] = (rejected[why] ?? 0) + 1; };

  const atm = rows.reduce<ChainRow | null>((b, r) => (!b || Math.abs(r.strike - spot) < Math.abs(b.strike - spot) ? r : b), null);
  const ivs = atm ? [frac(atm.callIV), frac(atm.putIV)].filter((v) => v > 0.01 && v < 3) : [];
  const atmIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : null;
  const rv = input.rv20 && input.rv20 > 0 ? input.rv20 : null;
  const ratio = atmIv && rv ? atmIv / rv : null;
  const verdict: VolVerdict = ratio == null ? 'unknown' : ratio >= 1.2 ? 'expensive' : ratio <= 0.9 ? 'cheap' : 'fair';

  // Trend: the 20-session move measured against what 20 sessions normally produce.
  let trend: Trend = 'unknown';
  const c = input.closes.filter((x) => x > 0);
  if (c.length >= 21 && rv) {
    const z = Math.log(c[c.length - 1] / c[c.length - 21]) / (rv * Math.sqrt(20 / 252));
    trend = z > 0.5 ? 'up' : z < -0.5 ? 'down' : 'sideways';
  }
  const move = atmIv ? spot * atmIv * Math.sqrt(Math.max(days, 0.25) / 365) : null;

  const pct = (v: number) => `${(v * 100).toFixed(1)}%`;
  const summary: string[] = [];
  if (atmIv && rv) {
    summary.push(verdict === 'expensive'
      ? `Options look expensive: they price ${pct(atmIv)} a year while ${symbol} has actually moved ${pct(rv)}. Selling premium has the wind behind it.`
      : verdict === 'cheap'
        ? `Options look cheap: they price ${pct(atmIv)} a year while ${symbol} has actually moved ${pct(rv)}. Buying has the better odds; selling does not pay.`
        : `Options are fairly priced: ${pct(atmIv)} implied against ${pct(rv)} actually moved. No edge from volatility either way.`);
  } else summary.push('Volatility could not be compared with recent movement, so ideas are judged on structure alone.');
  if (trend !== 'unknown') summary.push(trend === 'sideways' ? `${symbol} has gone sideways over the last 20 sessions.` : `${symbol} has trended ${trend} over the last 20 sessions.`);
  if (move) summary.push(`The market expects a move of about ${Math.round(move)} points either way by expiry.`);

  const read: MarketRead = {
    symbol, spot, days: r2(days), atmIv: atmIv != null ? r2(atmIv * 100) : null, rv20: rv != null ? r2(rv * 100) : null,
    verdict, trend, expectedMove: move != null ? Math.round(move) : null, vixPercentile: input.vixPercentile ?? null, summary,
  };
  const empty = (message: string): IdeasResult => ({ read, ideas: [], nearMisses: [], considered: 0, rejected, message });
  if (!atm || rows.length < 7) return empty('The option chain has too few strikes to build a strategy.');
  if (!move) return empty('The chain has no implied volatility at the money, so strikes cannot be chosen.');

  const near = (target: number) => rows.reduce((b, r) => (Math.abs(r.strike - target) < Math.abs(b.strike - target) ? r : b), rows[0]);
  const idx = (r: ChainRow) => rows.indexOf(r);
  const step = (r: ChainRow, n: number) => rows[Math.max(0, Math.min(rows.length - 1, idx(r) + n))];

  // What a leg can actually be traded at, and whether the market in it is good enough.
  const leg = (r: ChainRow, type: 'CE' | 'PE', action: 'BUY' | 'SELL'): IdeaLeg | string => {
    const last = type === 'CE' ? r.callLTP : r.putLTP;
    const bid = Number(type === 'CE' ? r.callBidPrice : r.putBidPrice) || 0;
    const ask = Number(type === 'CE' ? r.callAskPrice : r.putAskPrice) || 0;
    const oi = Number(type === 'CE' ? r.callOI : r.putOI) || 0;
    if (!(last > 0)) return 'no price on a leg';
    let premium = last, priced: IdeaLeg['priced'] = 'last';
    if (bid > 0 && ask > 0 && ask >= bid) {
      const mid = (bid + ask) / 2;
      if (ask - bid > Math.max(0.5, mid * 0.08)) return 'a leg is too thinly traded';
      premium = action === 'SELL' ? bid : ask;
      priced = action === 'SELL' ? 'bid' : 'ask';
    }
    if (!(premium > 0)) return 'no price on a leg';
    if ((type === 'CE' ? r.callOI : r.putOI) != null && oi <= 0) return 'a leg is too thinly traded';
    const iv = frac(type === 'CE' ? r.callIV : r.putIV);
    return { type, action, strike: r.strike, qty, premium: r2(premium), iv: iv > 0 ? r2(iv * 100) : null, priced };
  };

  type Spec = { family: Family; legs: (IdeaLeg | string)[]; shortDist: number | null; width: number };
  const specs: Spec[] = [];
  const add = (family: Family, parts: [ChainRow, 'CE' | 'PE', 'BUY' | 'SELL'][], shortDist: number | null, width: number) => {
    if (new Set(parts.map(([r, t]) => `${r.strike}${t}`)).size !== parts.length || width <= 0) return;
    specs.push({ family, legs: parts.map(([r, t, a]) => leg(r, t, a)), shortDist, width });
  };

  for (const k of [0.8, 1.0, 1.3]) {
    const sp = near(spot - k * move), sc = near(spot + k * move);
    if (sp.strike >= spot || sc.strike <= spot) continue;
    for (const w of [2, 3, 4]) {
      const lp = step(sp, -w), lc = step(sc, w);
      add('iron_condor', [[lp, 'PE', 'BUY'], [sp, 'PE', 'SELL'], [sc, 'CE', 'SELL'], [lc, 'CE', 'BUY']], k, Math.min(sp.strike - lp.strike, lc.strike - sc.strike));
    }
  }
  for (const k of [1.0, 1.5]) {
    const lp = near(atm.strike - k * move), lc = near(atm.strike + k * move);
    add('iron_fly', [[lp, 'PE', 'BUY'], [atm, 'PE', 'SELL'], [atm, 'CE', 'SELL'], [lc, 'CE', 'BUY']], 0, Math.min(atm.strike - lp.strike, lc.strike - atm.strike));
  }
  for (const k of [0.5, 0.8, 1.0]) {
    const sp = near(spot - k * move), sc = near(spot + k * move);
    for (const w of [2, 3]) {
      if (sp.strike < spot) add('bull_put', [[step(sp, -w), 'PE', 'BUY'], [sp, 'PE', 'SELL']], k, sp.strike - step(sp, -w).strike);
      if (sc.strike > spot) add('bear_call', [[sc, 'CE', 'SELL'], [step(sc, w), 'CE', 'BUY']], k, step(sc, w).strike - sc.strike);
    }
  }
  for (const k of [0.8, 1.2]) {
    const up = near(spot + k * move), down = near(spot - k * move);
    if (up.strike > atm.strike) add('bull_call', [[atm, 'CE', 'BUY'], [up, 'CE', 'SELL']], null, up.strike - atm.strike);
    if (down.strike < atm.strike) add('bear_put', [[atm, 'PE', 'BUY'], [down, 'PE', 'SELL']], null, atm.strike - down.strike);
  }

  const rs = (n: number) => `₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
  const passed: Idea[] = [];
  const blocked: Idea[] = [];
  for (const s of specs) {
    const bad = s.legs.find((l): l is string => typeof l === 'string');
    if (bad) { turnDown(bad); continue; }
    const legs = s.legs as IdeaLeg[];
    const entry = sumCharges(legs.map((l) => optionOrderCharges(rates, l.action, l.premium, l.qty)));
    const lo = Math.min(...legs.map((l) => l.strike)), hi = Math.max(...legs.map((l) => l.strike));
    const pad = Math.max(move * 1.5, (hi - lo) * 0.5);
    const a = analyzeStrategy(legs, spot, {
      // Exercise STT is left out: it applies only to a bought option held to expiry in
      // the money, and it would make a fully covered spread look open-ended far from the price.
      days, sigma: atmIv!, sigmaEv: rv ?? undefined, fixedCost: entry.totalCost,
      underlying: symbol, range: [Math.max(1, Math.min(lo, spot) - pad), Math.max(hi, spot) + pad], points: 60,
    });
    if (a.unlimitedLoss || !(a.maxLoss < 0) || !(a.maxProfit > 0)) { turnDown('no profit left after charges'); continue; }

    const kind = KIND[s.family];
    const fit = fitOf(s.family, verdict, trend);
    const sold = legs.filter((l) => l.action === 'SELL').map((l) => l.strike);
    const why: string[] = [];
    if (kind === 'credit') {
      const between = a.breakevens.map((b) => Math.round(b).toLocaleString('en-IN')).join(' and ');
      if (s.family === 'iron_fly') why.push(`Makes the most if ${symbol} finishes at ${sold[0].toLocaleString('en-IN')}; it makes money anywhere between ${between}.`);
      else why.push(a.breakevens.length === 2
        ? `Keeps the whole credit if ${symbol} is between ${Math.min(...sold).toLocaleString('en-IN')} and ${Math.max(...sold).toLocaleString('en-IN')} at expiry; it makes money anywhere between ${a.breakevens.map((b) => Math.round(b).toLocaleString('en-IN')).join(' and ')}.`
        : `Keeps the whole credit if ${symbol} is ${s.family === 'bull_put' ? 'above' : 'below'} ${sold[0].toLocaleString('en-IN')} at expiry.`);
      if (s.shortDist) why.push(`The sold strike${sold.length > 1 ? 's are' : ' is'} about ${s.shortDist}× the expected move away from the price now.`);
    } else {
      why.push(`Pays most if ${symbol} is ${s.family === 'bull_call' ? 'at or above' : 'at or below'} ${sold[0].toLocaleString('en-IN')} at expiry; it needs ${symbol} to move ${s.family === 'bull_call' ? 'up' : 'down'}.`);
    }
    why.push(fit === 'with' ? 'It suits both the volatility picture and the recent trend.' : 'It does not go against the volatility picture or the trend.');
    why.push(`Worst case is a loss of ${rs(a.maxLoss)}, known in advance: every sold option has a bought one protecting it.`);

    const warnings: string[] = [];
    if (days < 1.5) warnings.push('It expires within a day or so: the price of the position can swing sharply near expiry.');
    if (kind === 'credit' && input.vixPercentile != null && input.vixPercentile < 20) warnings.push('India VIX is near the bottom of its yearly range: premiums are thin, and a jump in volatility would hurt.');
    if (legs.some((l) => l.priced === 'last')) warnings.push('Some legs have no live bid and ask, so they are priced at the last trade; the real fill may differ.');
    if (input.netWorth && input.netWorth > 0) warnings.push(`The worst case is ${(Math.abs(a.maxLoss) / input.netWorth * 100).toFixed(1)}% of your net worth.`);

    const idea: Idea = {
      id: `${s.family}:${legs.map((l) => `${l.action[0]}${l.strike}${l.type}`).join('-')}`,
      name: NAMES[s.family], family: s.family, view: VIEW[s.family], kind, legs,
      netPremium: a.netPremium, maxProfit: a.maxProfit, maxLoss: a.maxLoss, breakevens: a.breakevens,
      pop: Math.round(a.pop * 1000) / 10, expectedPnl: a.expectedPnl, margin: a.margin,
      returnOnMargin: a.margin > 0 ? r2(a.expectedPnl / a.margin * 100) : 0,
      rewardToRisk: r2(a.maxProfit / Math.abs(a.maxLoss)), charges: entry.totalCost,
      fit, why, warnings, payoff: a.curve.filter((_, i) => i % 2 === 0).map((p) => ({ spot: p.spot, pnl: Math.round(p.pnl) })),
    };

    // Checks, hardest facts first. The first one failed is the reason shown.
    const perUnitCredit = a.netPremium / qty;
    const reason =
      kind === 'credit' && perUnitCredit < s.width * 0.15 ? 'the credit is too small for the risk taken'
        : entry.totalCost > a.maxProfit * 0.25 ? 'charges would eat too much of the profit'
          : input.maxLoss != null && Math.abs(a.maxLoss) > input.maxLoss ? 'the worst case is over your loss limit'
            : fit === 'against' ? 'it goes against the volatility picture or the trend'
              : !(a.expectedPnl > 0) ? 'the expected result after charges is not positive'
                : null;
    if (reason) { turnDown(reason); blocked.push({ ...idea, blocked: reason }); continue; }
    passed.push(idea);
  }

  // The best of each kind, then the best overall: with the market first, then by return on margin.
  const rank = (x: Idea, y: Idea) => Number(y.fit === 'with') - Number(x.fit === 'with') || y.returnOnMargin - x.returnOnMargin;
  const bestPer = (list: Idea[]) => {
    const seen = new Map<Family, Idea>();
    for (const i of [...list].sort(rank)) if (!seen.has(i.family)) seen.set(i.family, i);
    return [...seen.values()].sort(rank);
  };
  const ideas = bestPer(passed).slice(0, 5);
  // Near misses are only the ones that fell at the last two (judgement) checks.
  const soft = blocked.filter((b) => b.blocked === 'it goes against the volatility picture or the trend' || b.blocked === 'the expected result after charges is not positive');
  const nearMisses = ideas.length ? [] : bestPer(soft).slice(0, 3);
  return {
    read, ideas, nearMisses, considered: specs.length, rejected,
    message: ideas.length ? null : 'Nothing clears the checks right now. Not trading is a position too.',
  };
}
