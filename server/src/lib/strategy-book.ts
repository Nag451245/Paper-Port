/**
 * One open derivative strategy, described for the My Strategies page: its legs,
 * profit or loss, payoff (at expiry and today), Greeks and a plain reading.
 * Pure: the route supplies positions, prices and the underlying's spot.
 */
import { analyzeStrategy, normCdf, type MathLeg } from './strategy-math.js';
import { bsPrice, greeks, impliedVol } from './option-greeks.js';
import { parseInstrumentSymbol } from './instrument.js';
import { isUserPlaced } from './order-source.js';

const r2 = (n: number) => Math.round(n * 100) / 100;
const ASSUMED_VOL = 0.15;

export interface BookPosition {
  id: string;
  symbol: string;
  exchange?: string | null;
  side: string;
  qty: number;
  avgEntryPrice: unknown;
  strategyTag: string | null;
  openedAt: Date;
  marginBlocked?: unknown;
  instrumentType?: string | null;
  underlying?: string | null;
  expiry?: Date | null;
  strike?: unknown;
  optionType?: string | null;
}

export interface BookLeg {
  positionId: string | null;
  symbol: string;
  kind: 'CE' | 'PE' | 'FUT' | 'EQ';
  strike: number | null;
  side: 'LONG' | 'SHORT';
  qty: number;
  entry: number;
  last: number | null;
  pnl: number | null;
  /** Implied volatility in percent, worked out from the last price. */
  iv: number | null;
  ivAssumed: boolean;
  marginBlocked: number | null;
  /** Expiry of this leg (YYYY-MM-DD, IST) and the days left to it. */
  expiry: string | null;
  days: number | null;
  /** A leg being tried out, not yet placed. */
  proposed?: boolean;
}

export interface BookCard {
  strategyTag: string;
  name: string;
  owner: 'user' | 'algo';
  underlying: string | null;
  /** The nearest expiry among the legs, and every expiry when they differ. */
  expiry: string | null;
  expiries: string[];
  daysToExpiry: number | null;
  spot: number | null;
  deployedAt: string;
  legs: BookLeg[];
  openPnl: number | null;
  marginBlocked: number;
  payoff: null | {
    curve: { spot: number; atExpiry: number; today: number }[];
    maxProfit: number; maxLoss: number; unlimitedProfit: boolean; unlimitedLoss: boolean;
    breakevens: number[]; pop: number; margin: number;
  };
  /** Rupees for the whole position: per 1-point move, per day, per 1-point of volatility. */
  greeks: null | { delta: number; gamma: number; theta: number; vega: number };
  reading: string[];
  /** Why there is no payoff or Greeks, when there is none. */
  note: string | null;
}

interface Extra { type: 'CE' | 'PE'; strike: number; action: 'BUY' | 'SELL'; qty: number; premium: number; /** YYYY-MM-DD; the strategy's own expiry when left out */ expiry?: string }

const describe = (p: BookPosition) => {
  let spec: ReturnType<typeof parseInstrumentSymbol> | null = null;
  try { spec = parseInstrumentSymbol(p.symbol, p.exchange ?? undefined); } catch { /* not a contract symbol */ }
  const type = (p.instrumentType ?? spec?.instrumentType ?? 'EQUITY').toUpperCase();
  const opt = (p.optionType ?? spec?.optionType ?? null) as 'CE' | 'PE' | null;
  return {
    kind: (type === 'OPTIONS' && opt ? opt : type === 'FUTURES' ? 'FUT' : 'EQ') as BookLeg['kind'],
    underlying: p.underlying ?? spec?.underlying ?? null,
    expiry: p.expiry ?? spec?.expiry ?? null,
    strike: p.strike != null ? Number(p.strike) : spec?.strike ?? null,
  };
};

export const isDerivativeGroup = (legs: BookPosition[]) => legs.some((p) => describe(p).kind !== 'EQ');

export function buildStrategyCard(input: {
  strategyTag: string;
  positions: BookPosition[];
  /** Position id -> last price and gain or loss from the shared valuation. */
  valued: Map<string, { price: number; pnl: number; priceSource: string }>;
  spot: number | null;
  /** Charges already paid to open the legs. */
  chargesPaid?: number;
  now?: Date;
  /** Legs to try out on top of the open ones (for "add a leg"). */
  extra?: Extra[];
}): BookCard {
  const now = input.now ?? new Date();
  const first = input.positions.map(describe);
  const underlying = first.find((d) => d.underlying)?.underlying ?? null;
  const spot = input.spot && input.spot > 0 ? input.spot : null;
  // Contracts stop trading at 15:30 IST on the expiry day (expiry is stored at IST midnight).
  const daysTo = (d: Date | null) => (d ? Math.max(0.02, (d.getTime() + 15.5 * 3_600_000 - now.getTime()) / 86_400_000) : null);
  const isoDay = (d: Date | null) => (d ? new Date(d.getTime() + 5.5 * 3_600_000).toISOString().slice(0, 10) : null);
  const firstExpiry = first.find((d) => d.expiry)?.expiry ?? null;

  const legs: BookLeg[] = input.positions.map((p, i) => {
    const d = first[i];
    const v = input.valued.get(p.id);
    const last = v && v.priceSource !== 'entry' ? v.price : null;
    const legDays = daysTo(d.expiry);
    let iv: number | null = null;
    if ((d.kind === 'CE' || d.kind === 'PE') && last && spot && d.strike && legDays) {
      iv = impliedVol(last, { type: d.kind, spot, strike: d.strike, days: legDays });
    }
    return {
      positionId: p.id, symbol: p.symbol, kind: d.kind, strike: d.strike,
      side: p.side === 'SHORT' ? 'SHORT' : 'LONG', qty: p.qty, entry: Number(p.avgEntryPrice),
      last, pnl: v && v.priceSource !== 'entry' ? r2(v.pnl) : null,
      iv: iv != null ? r2(iv * 100) : null, ivAssumed: iv == null,
      marginBlocked: p.marginBlocked != null ? Number(p.marginBlocked) : null,
      expiry: isoDay(d.expiry), days: legDays,
    };
  });
  for (const e of input.extra ?? []) {
    const when = e.expiry ? new Date(`${e.expiry}T00:00:00+05:30`) : firstExpiry;
    const legDays = daysTo(when && !Number.isNaN(when.getTime()) ? when : firstExpiry);
    const iv = spot && legDays ? impliedVol(e.premium, { type: e.type, spot, strike: e.strike, days: legDays }) : null;
    legs.push({
      positionId: null, symbol: `${underlying ?? ''} ${e.strike} ${e.type}`.trim(), kind: e.type, strike: e.strike,
      side: e.action === 'SELL' ? 'SHORT' : 'LONG', qty: e.qty, entry: e.premium, last: e.premium, pnl: 0,
      iv: iv != null ? r2(iv * 100) : null, ivAssumed: iv == null, marginBlocked: null,
      expiry: isoDay(when && !Number.isNaN(when.getTime()) ? when : firstExpiry), days: legDays, proposed: true,
    });
  }

  // The strategy is read as of its nearest expiry.
  const dated = legs.filter((l) => l.days != null);
  const days = dated.length ? Math.min(...dated.map((l) => l.days!)) : null;
  const expiries = [...new Set(legs.map((l) => l.expiry).filter((e): e is string => !!e))].sort();
  const mixed = expiries.length > 1;

  const priced = legs.filter((l) => !l.proposed && l.pnl != null);
  const card: BookCard = {
    strategyTag: input.strategyTag,
    name: input.strategyTag.replace(/^STRAT:/, '').replace(/^BOT:/, ''),
    owner: isUserPlaced(input.strategyTag) ? 'user' : 'algo',
    underlying, expiry: expiries[0] ?? null, expiries,
    daysToExpiry: days != null ? r2(days) : null,
    spot, deployedAt: new Date(Math.min(...input.positions.map((p) => p.openedAt.getTime()))).toISOString(),
    legs,
    openPnl: priced.length === legs.filter((l) => !l.proposed).length ? r2(priced.reduce((s, l) => s + (l.pnl ?? 0), 0)) : null,
    marginBlocked: r2(legs.reduce((s, l) => s + (l.marginBlocked ?? 0), 0)),
    payoff: null, greeks: null, reading: [], note: null,
  };

  const options = legs.filter((l) => l.kind === 'CE' || l.kind === 'PE');
  if (options.length !== legs.length || !options.every((l) => l.strike)) {
    card.note = 'The payoff chart and Greeks cover option legs only; this group also holds futures or shares.';
    return card;
  }
  if (!spot || !days || !options.every((l) => l.days)) {
    card.note = `No price for ${underlying ?? 'the underlying'} right now, so the payoff and Greeks cannot be worked out.`;
    return card;
  }

  const sign = (l: BookLeg) => (l.side === 'LONG' ? 1 : -1);
  const vol = (l: BookLeg) => (l.iv != null ? l.iv / 100 : ASSUMED_VOL);
  const kind = (l: BookLeg) => l.kind as 'CE' | 'PE';
  const math: MathLeg[] = options.map((l) => ({ type: kind(l), action: l.side === 'LONG' ? 'BUY' : 'SELL', strike: l.strike!, qty: l.qty, premium: l.entry }));
  const known = options.filter((l) => l.iv != null);
  const sigma = known.length ? known.reduce((s, l) => s + l.iv! / 100, 0) / known.length : ASSUMED_VOL;
  const strikes = options.map((l) => l.strike!);
  const reach = Math.max(spot * 0.06, (Math.max(...strikes) - Math.min(...strikes)) * 1.5);
  const range: [number, number] = [Math.max(1, Math.min(spot, ...strikes) - reach), Math.max(spot, ...strikes) + reach];
  const fixed = Math.max(0, input.chargesPaid ?? 0);
  const a = analyzeStrategy(math, spot, { days, sigma, fixedCost: fixed, underlying: underlying ?? undefined, range, points: 80 });

  const todayAt = (s: number) => options.reduce((sum, l) =>
    sum + sign(l) * l.qty * (bsPrice({ type: kind(l), spot: s, strike: l.strike!, days: l.days!, sigma: vol(l) }) - l.entry), 0) - fixed;

  if (!mixed) {
    card.payoff = {
      curve: a.curve.map((c) => ({ spot: c.spot, atExpiry: c.pnl, today: r2(todayAt(c.spot)) })),
      maxProfit: a.maxProfit, maxLoss: a.maxLoss, unlimitedProfit: a.unlimitedProfit, unlimitedLoss: a.unlimitedLoss,
      breakevens: a.breakevens, pop: a.pop, margin: a.margin,
    };
  } else {
    // Legs in different weeks: the position on the day the nearest one expires.
    // A leg expiring that day is worth what it pays out; a later one is still
    // an option, valued with its remaining time at today's implied volatility.
    const onNearExpiry = (s: number) => options.reduce((sum, l) => {
      const left = l.days! - days;
      const worth = left < 0.01
        ? Math.max(0, l.kind === 'CE' ? s - l.strike! : l.strike! - s)
        : bsPrice({ type: kind(l), spot: s, strike: l.strike!, days: left, sigma: vol(l) });
      return sum + sign(l) * l.qty * (worth - l.entry);
    }, 0) - fixed;
    const curve = a.curve.map((c) => ({ spot: c.spot, atExpiry: r2(onNearExpiry(c.spot)), today: r2(todayAt(c.spot)) }));
    const breakevens: number[] = [];
    for (let i = 1; i < curve.length; i++) {
      const p = curve[i - 1], q = curve[i];
      if ((p.atExpiry < 0) !== (q.atExpiry < 0) && q.atExpiry !== p.atExpiry) {
        breakevens.push(r2(p.spot + (0 - p.atExpiry) * (q.spot - p.spot) / (q.atExpiry - p.atExpiry)));
      }
    }
    // Chance the nearest expiry finds it in profit: each stretch of the chart
    // weighted by how likely the price is to land there, the ends by their sign.
    const t = Math.max(days, 0.5) / 365;
    const below = (x: number) => normCdf((Math.log(x / spot) - (0.065 - sigma * sigma / 2) * t) / (sigma * Math.sqrt(t)));
    let pop = (curve[0].atExpiry > 0 ? below(curve[0].spot) : 0) + (curve[curve.length - 1].atExpiry > 0 ? 1 - below(curve[curve.length - 1].spot) : 0);
    for (let i = 1; i < curve.length; i++) {
      if ((curve[i - 1].atExpiry + curve[i].atExpiry) / 2 > 0) pop += below(curve[i].spot) - below(curve[i - 1].spot);
    }
    const netCalls = options.filter((l) => l.kind === 'CE').reduce((n, l) => n + sign(l) * l.qty, 0);
    const values = curve.map((c) => c.atExpiry);
    card.payoff = {
      curve, maxProfit: r2(Math.max(...values)), maxLoss: r2(Math.min(...values)),
      unlimitedProfit: netCalls > 0, unlimitedLoss: netCalls < 0,
      breakevens, pop: Math.min(1, Math.max(0, pop)), margin: a.margin,
    };
  }

  const g = { delta: 0, gamma: 0, theta: 0, vega: 0 };
  for (const l of options) {
    const one = greeks({ type: kind(l), spot, strike: l.strike!, days: l.days!, sigma: vol(l) });
    for (const k of ['delta', 'gamma', 'theta', 'vega'] as const) g[k] += sign(l) * l.qty * one[k];
  }
  card.greeks = { delta: r2(g.delta), gamma: Math.round(g.gamma * 10_000) / 10_000, theta: r2(g.theta), vega: r2(g.vega) };

  const rs = (n: number) => `₹${Math.abs(Math.round(n)).toLocaleString('en-IN')}`;
  const u = underlying ?? 'the underlying';
  const read: string[] = [];
  if (mixed) read.push(`Legs expire on different dates (${expiries.join(', ')}). The chart shows the position on ${expiries[0]}, when the nearest leg expires; later legs are valued as options still running, and the most it can make or lose is read within the chart's range.`);
  read.push(days < 1 ? `${mixed ? 'The nearest leg expires' : 'Expires'} today.` : days < 2 ? `${mixed ? 'The nearest leg expires' : 'Expires'} tomorrow.` : `${Math.floor(days)} days to ${mixed ? 'the nearest ' : ''}expiry.`);
  if (Math.abs(g.delta) < 0.05 * Math.max(...options.map((l) => l.qty))) read.push(`Roughly neutral to direction right now: a 100-point move in ${u} changes it by about ${rs(g.delta * 100)}.`);
  else read.push(`${g.delta > 0 ? 'Gains' : 'Loses'} about ${rs(g.delta * 100)} if ${u} rises 100 points, and the reverse if it falls.`);
  if (Math.abs(g.theta) >= 1) read.push(g.theta > 0 ? `Time is on your side: it earns about ${rs(g.theta)} a day if nothing else changes.` : `Time works against it: it loses about ${rs(g.theta)} a day if nothing else changes.`);
  if (Math.abs(g.vega) >= 1) read.push(g.vega > 0 ? `Gains about ${rs(g.vega)} for each 1-point rise in implied volatility.` : `Loses about ${rs(g.vega)} for each 1-point rise in implied volatility (a nervous market hurts it).`);
  if (a.breakevens.length) {
    const nearest = a.breakevens.reduce((b, x) => (Math.abs(x - spot) < Math.abs(b - spot) ? x : b));
    const gap = Math.abs(nearest - spot);
    read.push(`Nearest breakeven at expiry is ${nearest.toLocaleString('en-IN')}, ${Math.round(gap)} points (${(gap / spot * 100).toFixed(1)}%) from ${u} now.`);
  }
  if (a.unlimitedLoss) read.push('The loss is not capped on the upside: there is a sold call with no bought call above it.');
  else if (options.some((l) => l.side === 'SHORT' && l.kind === 'PE') && !options.some((l) => l.side === 'LONG' && l.kind === 'PE')) read.push('The sold put is not protected: a sharp fall is the large risk here.');
  if (options.some((l) => l.ivAssumed)) read.push('Some legs had no usable price, so their volatility is assumed at 15%; treat the Greeks as approximate.');
  card.reading = read;
  return card;
}
