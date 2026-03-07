/**
 * Strategy builder functions and payoff computation extracted from StrategyBuilder page.
 * Reduces monolithic page size by ~450 lines.
 */

// ─── Types ───────────────────────────────────────────────────────────────────

export interface Strike {
  strike: number;
  callOI: number;
  callOIChange: number;
  callVolume: number;
  callIV: number;
  callLTP: number;
  callNetChange: number;
  callDelta: number;
  callGamma: number;
  callTheta: number;
  callVega: number;
  callBuildup: string;
  putOI: number;
  putOIChange: number;
  putVolume: number;
  putIV: number;
  putLTP: number;
  putNetChange: number;
  putDelta: number;
  putGamma: number;
  putTheta: number;
  putVega: number;
  putBuildup: string;
}

export interface StrategyLeg {
  type: 'CE' | 'PE';
  strike: number;
  action: 'BUY' | 'SELL';
  qty: number;
  premium: number;
  iv?: number;
  expiry?: string;
  expiryDays?: number;
}

export interface PayoffPoint { spot: number; pnl: number }
export interface Greeks { delta: number; gamma: number; theta: number; vega: number }
export interface PayoffResult {
  payoffCurve: PayoffPoint[];
  greeks: Greeks;
  maxProfit: number;
  maxLoss: number;
  breakevens: number[];
  netPremium: number;
  probabilityOfProfit?: number;
  riskRewardRatio?: number;
  capitalRequired?: number;
  source?: string;
  strategyName?: string;
}
export interface ScenarioResult { label: string; pnl: number; spotPrice: number }
export interface OptimizedStrategy {
  name: string;
  category: string;
  legs: StrategyLeg[];
  maxProfit: number;
  maxLoss: number;
  breakevens: number[];
  netPremium: number;
  riskReward: number;
  pop: number;
  score: number;
}

// ─── Helpers ─────────────────────────────────────────────────────────────────

export function isMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

export function formatNum(val: number | undefined | null): string {
  if (val == null || isNaN(val)) return '—';
  if (Math.abs(val) >= 10000000) return (val / 10000000).toFixed(2) + 'Cr';
  if (Math.abs(val) >= 100000) return (val / 100000).toFixed(1) + 'L';
  if (Math.abs(val) >= 1000) return (val / 1000).toFixed(1) + 'K';
  return val.toLocaleString('en-IN');
}

export function dte(expiry: string): number {
  if (!expiry) return 0;
  return Math.max(0, Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000));
}

export function fmtDate(d: string): string {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

export function findATM(strikes: Strike[], spot: number): number {
  if (strikes.length === 0) return spot;
  let closest = strikes[0].strike;
  let minDiff = Math.abs(spot - closest);
  for (const s of strikes) {
    const diff = Math.abs(spot - s.strike);
    if (diff < minDiff) { minDiff = diff; closest = s.strike; }
  }
  return closest;
}

export function getStrikeStep(strikes: Strike[]): number {
  if (strikes.length < 2) return 50;
  const sorted = strikes.map(s => s.strike).sort((a, b) => a - b);
  return sorted[1] - sorted[0] || 50;
}

export function findStrike(chain: Strike[], target: number): Strike | undefined {
  let best: Strike | undefined;
  let minDiff = Infinity;
  for (const s of chain) {
    const diff = Math.abs(s.strike - target);
    if (diff < minDiff) { minDiff = diff; best = s; }
  }
  return best;
}

// ─── Strategy Builders ───────────────────────────────────────────────────────

export function buildStraddle(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const s = findStrike(chain, atm);
  if (!s) return [];
  return [
    { type: 'CE', strike: s.strike, action: 'SELL', qty, premium: s.callLTP, iv: s.callIV },
    { type: 'PE', strike: s.strike, action: 'SELL', qty, premium: s.putLTP, iv: s.putIV },
  ];
}

export function buildStrangle(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const ce = findStrike(chain, atm + step * 2);
  const pe = findStrike(chain, atm - step * 2);
  if (!ce || !pe) return [];
  return [
    { type: 'CE', strike: ce.strike, action: 'SELL', qty, premium: ce.callLTP, iv: ce.callIV },
    { type: 'PE', strike: pe.strike, action: 'SELL', qty, premium: pe.putLTP, iv: pe.putIV },
  ];
}

export function buildBullSpread(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const buy = findStrike(chain, atm);
  const sell = findStrike(chain, atm + step * 2);
  if (!buy || !sell) return [];
  return [
    { type: 'CE', strike: buy.strike, action: 'BUY', qty, premium: buy.callLTP, iv: buy.callIV },
    { type: 'CE', strike: sell.strike, action: 'SELL', qty, premium: sell.callLTP, iv: sell.callIV },
  ];
}

export function buildBearSpread(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const buy = findStrike(chain, atm);
  const sell = findStrike(chain, atm - step * 2);
  if (!buy || !sell) return [];
  return [
    { type: 'PE', strike: buy.strike, action: 'BUY', qty, premium: buy.putLTP, iv: buy.putIV },
    { type: 'PE', strike: sell.strike, action: 'SELL', qty, premium: sell.putLTP, iv: sell.putIV },
  ];
}

export function buildIronCondor(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const s1 = findStrike(chain, atm - step * 3);
  const s2 = findStrike(chain, atm - step);
  const s3 = findStrike(chain, atm + step);
  const s4 = findStrike(chain, atm + step * 3);
  if (!s1 || !s2 || !s3 || !s4) return [];
  return [
    { type: 'PE', strike: s1.strike, action: 'BUY', qty, premium: s1.putLTP, iv: s1.putIV },
    { type: 'PE', strike: s2.strike, action: 'SELL', qty, premium: s2.putLTP, iv: s2.putIV },
    { type: 'CE', strike: s3.strike, action: 'SELL', qty, premium: s3.callLTP, iv: s3.callIV },
    { type: 'CE', strike: s4.strike, action: 'BUY', qty, premium: s4.callLTP, iv: s4.callIV },
  ];
}

export function buildButterfly(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const lower = findStrike(chain, atm - step * 2);
  const mid = findStrike(chain, atm);
  const upper = findStrike(chain, atm + step * 2);
  if (!lower || !mid || !upper) return [];
  return [
    { type: 'CE', strike: lower.strike, action: 'BUY', qty, premium: lower.callLTP, iv: lower.callIV },
    { type: 'CE', strike: mid.strike, action: 'SELL', qty: qty * 2, premium: mid.callLTP, iv: mid.callIV },
    { type: 'CE', strike: upper.strike, action: 'BUY', qty, premium: upper.callLTP, iv: upper.callIV },
  ];
}

export function buildLongCall(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const s = findStrike(chain, atm);
  if (!s) return [];
  return [{ type: 'CE', strike: s.strike, action: 'BUY', qty, premium: s.callLTP, iv: s.callIV }];
}

export function buildLongPut(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const s = findStrike(chain, atm);
  if (!s) return [];
  return [{ type: 'PE', strike: s.strike, action: 'BUY', qty, premium: s.putLTP, iv: s.putIV }];
}

export function buildLongStraddle(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const s = findStrike(chain, atm);
  if (!s) return [];
  return [
    { type: 'CE', strike: s.strike, action: 'BUY', qty, premium: s.callLTP, iv: s.callIV },
    { type: 'PE', strike: s.strike, action: 'BUY', qty, premium: s.putLTP, iv: s.putIV },
  ];
}

export function buildLongStrangle(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const ce = findStrike(chain, atm + step * 2);
  const pe = findStrike(chain, atm - step * 2);
  if (!ce || !pe) return [];
  return [
    { type: 'CE', strike: ce.strike, action: 'BUY', qty, premium: ce.callLTP, iv: ce.callIV },
    { type: 'PE', strike: pe.strike, action: 'BUY', qty, premium: pe.putLTP, iv: pe.putIV },
  ];
}

export function buildBullPutSpread(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const sell = findStrike(chain, atm);
  const buy = findStrike(chain, atm - step * 2);
  if (!sell || !buy) return [];
  return [
    { type: 'PE', strike: sell.strike, action: 'SELL', qty, premium: sell.putLTP, iv: sell.putIV },
    { type: 'PE', strike: buy.strike, action: 'BUY', qty, premium: buy.putLTP, iv: buy.putIV },
  ];
}

export function buildBearCallSpread(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const sell = findStrike(chain, atm);
  const buy = findStrike(chain, atm + step * 2);
  if (!sell || !buy) return [];
  return [
    { type: 'CE', strike: sell.strike, action: 'SELL', qty, premium: sell.callLTP, iv: sell.callIV },
    { type: 'CE', strike: buy.strike, action: 'BUY', qty, premium: buy.callLTP, iv: buy.callIV },
  ];
}

export function buildIronButterfly(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const lower = findStrike(chain, atm - step * 2);
  const mid = findStrike(chain, atm);
  const upper = findStrike(chain, atm + step * 2);
  if (!lower || !mid || !upper) return [];
  return [
    { type: 'PE', strike: lower.strike, action: 'BUY', qty, premium: lower.putLTP, iv: lower.putIV },
    { type: 'PE', strike: mid.strike, action: 'SELL', qty, premium: mid.putLTP, iv: mid.putIV },
    { type: 'CE', strike: mid.strike, action: 'SELL', qty, premium: mid.callLTP, iv: mid.callIV },
    { type: 'CE', strike: upper.strike, action: 'BUY', qty, premium: upper.callLTP, iv: upper.callIV },
  ];
}

export function buildCoveredCall(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const sell = findStrike(chain, atm + step * 2);
  if (!sell) return [];
  return [
    { type: 'CE', strike: atm, action: 'BUY', qty, premium: 0, iv: 0 },
    { type: 'CE', strike: sell.strike, action: 'SELL', qty, premium: sell.callLTP, iv: sell.callIV },
  ];
}

export function buildJadeLizard(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const put = findStrike(chain, atm - step);
  const callSell = findStrike(chain, atm + step);
  const callBuy = findStrike(chain, atm + step * 3);
  if (!put || !callSell || !callBuy) return [];
  return [
    { type: 'PE', strike: put.strike, action: 'SELL', qty, premium: put.putLTP, iv: put.putIV },
    { type: 'CE', strike: callSell.strike, action: 'SELL', qty, premium: callSell.callLTP, iv: callSell.callIV },
    { type: 'CE', strike: callBuy.strike, action: 'BUY', qty, premium: callBuy.callLTP, iv: callBuy.callIV },
  ];
}

export function buildRatioCallSpread(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const buy = findStrike(chain, atm);
  const sell = findStrike(chain, atm + step * 2);
  if (!buy || !sell) return [];
  return [
    { type: 'CE', strike: buy.strike, action: 'BUY', qty, premium: buy.callLTP, iv: buy.callIV },
    { type: 'CE', strike: sell.strike, action: 'SELL', qty: qty * 2, premium: sell.callLTP, iv: sell.callIV },
  ];
}

// ─── Margin Estimation ───────────────────────────────────────────────────────

const INDEX_SET = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50', 'SENSEX']);

export function estimateMargin(legs: StrategyLeg[], spot: number, maxLoss: number, sym = 'NIFTY'): number {
  if (legs.length === 0 || spot <= 0) return 0;

  const buyLegs = legs.filter(l => l.action === 'BUY');
  const sellLegs = legs.filter(l => l.action === 'SELL');

  if (sellLegs.length === 0) {
    return Math.round(buyLegs.reduce((s, l) => s + l.premium * l.qty, 0));
  }

  const isIndex = INDEX_SET.has(sym.toUpperCase());
  const spanPct = isIndex ? 0.12 : 0.20;
  const exposurePct = isIndex ? 0.03 : 0.05;

  const ceBuys = buyLegs.filter(l => l.type === 'CE');
  const ceSells = sellLegs.filter(l => l.type === 'CE');
  const peBuys = buyLegs.filter(l => l.type === 'PE');
  const peSells = sellLegs.filter(l => l.type === 'PE');
  const isCallSpread = ceBuys.length > 0 && ceSells.length > 0;
  const isPutSpread = peBuys.length > 0 && peSells.length > 0;

  if ((isCallSpread || isPutSpread) && maxLoss < 0 && maxLoss > -1e9) {
    const nakedCE = ceSells.length > 0 && ceBuys.length === 0;
    const nakedPE = peSells.length > 0 && peBuys.length === 0;
    if (!nakedCE && !nakedPE) {
      return Math.round(Math.abs(maxLoss));
    }
  }

  let margin = 0;
  for (const leg of sellLegs) {
    const notional = spot * leg.qty;
    const otmPct = Math.abs(leg.strike - spot) / spot;
    const otmDiscount = Math.min(otmPct * 0.3, 0.03);
    const adjSpan = Math.max(spanPct - otmDiscount, isIndex ? 0.08 : 0.14);
    const spanMargin = notional * adjSpan;
    const exposureMargin = notional * exposurePct;
    margin += spanMargin + exposureMargin;
  }

  for (const leg of buyLegs) {
    const notional = spot * leg.qty;
    const hedgeBenefit = notional * (spanPct * 0.6);
    margin -= hedgeBenefit;
  }

  const buyPremium = buyLegs.reduce((s, l) => s + l.premium * l.qty, 0);
  margin += buyPremium;

  return Math.round(Math.max(margin, 0));
}

// ─── Local Payoff Computation ────────────────────────────────────────────────

export function computeLocalPayoff(legs: StrategyLeg[], spotPrice: number): PayoffResult {
  const range = spotPrice * 0.12;
  const step = Math.round(range / 50 / 10) * 10 || 10;
  const low = Math.round((spotPrice - range) / step) * step;
  const high = Math.round((spotPrice + range) / step) * step;
  const curve: PayoffPoint[] = [];
  let maxProfit = -Infinity;
  let maxLoss = Infinity;
  for (let s = low; s <= high; s += step) {
    let pnl = 0;
    for (const leg of legs) {
      const intrinsic = leg.type === 'CE' ? Math.max(s - leg.strike, 0) : Math.max(leg.strike - s, 0);
      pnl += (leg.action === 'BUY' ? intrinsic - leg.premium : leg.premium - intrinsic) * leg.qty;
    }
    pnl = Math.round(pnl);
    curve.push({ spot: s, pnl });
    if (pnl > maxProfit) maxProfit = pnl;
    if (pnl < maxLoss) maxLoss = pnl;
  }
  const breakevens: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    if ((curve[i - 1].pnl <= 0 && curve[i].pnl >= 0) || (curve[i - 1].pnl >= 0 && curve[i].pnl <= 0)) {
      const ratio = Math.abs(curve[i - 1].pnl) / (Math.abs(curve[i - 1].pnl) + Math.abs(curve[i].pnl));
      breakevens.push(Math.round(curve[i - 1].spot + ratio * step));
    }
  }
  let netPremium = 0;
  for (const leg of legs) netPremium += leg.action === 'SELL' ? leg.premium * leg.qty : -leg.premium * leg.qty;
  const totalQty = legs.reduce((s, l) => s + l.qty, 0) || 1;
  return {
    payoffCurve: curve,
    greeks: {
      delta: +(legs.reduce((a, l) => a + (l.type === 'CE' ? 0.5 : -0.5) * (l.action === 'BUY' ? 1 : -1) * l.qty, 0) / totalQty).toFixed(4),
      gamma: +(0.002 * legs.length).toFixed(4),
      theta: +(legs.reduce((a, l) => a + (l.action === 'SELL' ? 1 : -1) * l.premium * 0.03 * l.qty, 0)).toFixed(2),
      vega: +(legs.reduce((a, l) => a + (l.action === 'BUY' ? 1 : -1) * 12 * l.qty, 0)).toFixed(2),
    },
    maxProfit, maxLoss, breakevens, netPremium: Math.round(netPremium), source: 'local',
  };
}

// ─── Constants ───────────────────────────────────────────────────────────────

export const SCENARIOS = [
  { label: 'Spot +5%', spotDelta: 0.05, ivDelta: 0, daysPass: 0 },
  { label: 'Spot -5%', spotDelta: -0.05, ivDelta: 0, daysPass: 0 },
  { label: 'Spot +10%', spotDelta: 0.10, ivDelta: 0, daysPass: 0 },
  { label: 'Spot -10%', spotDelta: -0.10, ivDelta: 0, daysPass: 0 },
  { label: 'IV Crush -20%', spotDelta: 0, ivDelta: -0.20, daysPass: 0 },
  { label: 'IV Spike +30%', spotDelta: 0, ivDelta: 0.30, daysPass: 0 },
  { label: '3 Days Passed', spotDelta: 0, ivDelta: 0, daysPass: 3 },
  { label: '7 Days Passed', spotDelta: 0, ivDelta: 0, daysPass: 7 },
];

export type TemplateCategory = 'All' | 'Bullish' | 'Bearish' | 'Neutral' | 'Volatile';

export interface StrategyTemplate {
  id: string;
  name: string;
  category: TemplateCategory;
  risk: 'low' | 'medium' | 'high';
  description: string;
  build: (atm: number, qty: number, chain: Strike[]) => StrategyLeg[];
}

export const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  { id: 'long-call', name: 'Long Call', category: 'Bullish', risk: 'medium', description: 'Buy a call option expecting price to rise. Unlimited profit, loss limited to premium.', build: buildLongCall },
  { id: 'long-put', name: 'Long Put', category: 'Bearish', risk: 'medium', description: 'Buy a put option expecting price to fall. Profit potential up to strike, loss limited to premium.', build: buildLongPut },
  { id: 'bull-call-spread', name: 'Bull Call Spread', category: 'Bullish', risk: 'low', description: 'Buy lower strike call, sell higher strike call. Limited profit and limited risk.', build: buildBullSpread },
  { id: 'bear-put-spread', name: 'Bear Put Spread', category: 'Bearish', risk: 'low', description: 'Buy higher strike put, sell lower strike put. Limited risk bearish strategy.', build: buildBearSpread },
  { id: 'bull-put-spread', name: 'Bull Put Spread', category: 'Bullish', risk: 'low', description: 'Sell ATM put, buy OTM put. Credit strategy profiting from bullish or flat market.', build: buildBullPutSpread },
  { id: 'bear-call-spread', name: 'Bear Call Spread', category: 'Bearish', risk: 'low', description: 'Sell ATM call, buy OTM call. Credit strategy profiting from bearish or flat market.', build: buildBearCallSpread },
  { id: 'long-straddle', name: 'Long Straddle', category: 'Volatile', risk: 'medium', description: 'Buy call and put at same strike. Profit from big moves in either direction.', build: buildLongStraddle },
  { id: 'short-straddle', name: 'Short Straddle', category: 'Neutral', risk: 'high', description: 'Sell call and put at same strike. Profit from time decay if price stays near strike.', build: buildStraddle },
  { id: 'long-strangle', name: 'Long Strangle', category: 'Volatile', risk: 'medium', description: 'Buy OTM call and OTM put. Cheaper than straddle, needs a bigger move to profit.', build: buildLongStrangle },
  { id: 'short-strangle', name: 'Short Strangle', category: 'Neutral', risk: 'high', description: 'Sell OTM call and OTM put. Profit from time decay in a range-bound market.', build: buildStrangle },
  { id: 'iron-condor', name: 'Iron Condor', category: 'Neutral', risk: 'low', description: 'Combine bull put spread and bear call spread. Defined risk, profit in range-bound market.', build: buildIronCondor },
  { id: 'iron-butterfly', name: 'Iron Butterfly', category: 'Neutral', risk: 'medium', description: 'Short straddle with protective wings. Higher premium collected but narrower profit zone.', build: buildIronButterfly },
  { id: 'butterfly-spread', name: 'Butterfly Spread', category: 'Neutral', risk: 'low', description: 'Buy 1 lower call, sell 2 middle calls, buy 1 upper call. Max profit at middle strike.', build: buildButterfly },
  { id: 'covered-call', name: 'Covered Call', category: 'Bullish', risk: 'low', description: 'Sell a call against existing stock. Earn premium, cap upside. Limited risk strategy.', build: buildCoveredCall },
  { id: 'jade-lizard', name: 'Jade Lizard', category: 'Bullish', risk: 'medium', description: 'Short put + bear call spread. No upside risk if total credit exceeds call spread width.', build: buildJadeLizard },
  { id: 'ratio-call-spread', name: 'Ratio Call Spread', category: 'Bullish', risk: 'high', description: 'Buy 1 ATM call, sell 2 OTM calls. Risk on large up-moves. Can be zero or net credit.', build: buildRatioCallSpread },
];

export const QUICK_STRATEGIES = [
  { id: 'straddle', label: 'Straddle', build: buildStraddle },
  { id: 'strangle', label: 'Strangle', build: buildStrangle },
  { id: 'bull-spread', label: 'Bull Spread', build: buildBullSpread },
  { id: 'bear-spread', label: 'Bear Spread', build: buildBearSpread },
  { id: 'iron-condor', label: 'Iron Condor', build: buildIronCondor },
  { id: 'butterfly', label: 'Butterfly', build: buildButterfly },
];
