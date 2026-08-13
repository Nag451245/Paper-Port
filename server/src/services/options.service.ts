import { PrismaClient } from '@prisma/client';

export interface OptionLeg {
  type: 'CE' | 'PE';
  strike: number;
  action: 'BUY' | 'SELL';
  qty: number;
  premium: number;
  expiry?: string;
}

export interface StrategyPayoff {
  spotPrice: number;
  pnl: number;
}

export interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
  rho: number;
}

export interface StrategyGreeks extends Greeks {
  netPremium: number;
  maxProfit: number;
  maxLoss: number;
  breakevens: number[];
}

export interface StrategyTemplate {
  id: string;
  name: string;
  category: 'bullish' | 'bearish' | 'neutral' | 'volatile';
  legs: Omit<OptionLeg, 'premium'>[];
  description: string;
  idealCondition: string;
  riskLevel: 'low' | 'medium' | 'high';
}

export interface MaxPainResult {
  maxPainStrike: number;
  callOI: Record<number, number>;
  putOI: Record<number, number>;
  painByStrike: { strike: number; totalPain: number }[];
}

export interface OIAnalysis {
  strike: number;
  callOI: number;
  putOI: number;
  callOIChange: number;
  putOIChange: number;
  callIV: number;
  putIV: number;
  pcr: number;
  signal: 'bullish' | 'bearish' | 'neutral';
}

const STRATEGY_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'long-call', name: 'Long Call', category: 'bullish',
    legs: [{ type: 'CE', strike: 0, action: 'BUY', qty: 1 }],
    description: 'Buy a call option expecting the price to rise significantly. Unlimited profit potential, loss limited to premium paid.',
    idealCondition: 'Strong bullish view with expectation of a big move upward',
    riskLevel: 'medium',
  },
  {
    id: 'long-put', name: 'Long Put', category: 'bearish',
    legs: [{ type: 'PE', strike: 0, action: 'BUY', qty: 1 }],
    description: 'Buy a put option expecting the price to fall significantly. Profit potential up to strike minus premium, loss limited to premium.',
    idealCondition: 'Strong bearish view with expectation of a big move downward',
    riskLevel: 'medium',
  },
  {
    id: 'covered-call', name: 'Covered Call', category: 'neutral',
    legs: [
      { type: 'CE', strike: 0, action: 'SELL', qty: 1 },
    ],
    description: 'Sell a call against an existing stock position. Earn premium income while holding the stock.',
    idealCondition: 'Mildly bullish or neutral view, willing to cap upside for income',
    riskLevel: 'low',
  },
  {
    id: 'bull-call-spread', name: 'Bull Call Spread', category: 'bullish',
    legs: [
      { type: 'CE', strike: -1, action: 'BUY', qty: 1 },
      { type: 'CE', strike: 1, action: 'SELL', qty: 1 },
    ],
    description: 'Buy a lower strike call and sell a higher strike call. Limited profit and limited risk.',
    idealCondition: 'Moderately bullish view, want to reduce cost of buying a call',
    riskLevel: 'low',
  },
  {
    id: 'bear-put-spread', name: 'Bear Put Spread', category: 'bearish',
    legs: [
      { type: 'PE', strike: 1, action: 'BUY', qty: 1 },
      { type: 'PE', strike: -1, action: 'SELL', qty: 1 },
    ],
    description: 'Buy a higher strike put and sell a lower strike put. Limited profit and limited risk.',
    idealCondition: 'Moderately bearish view, want to reduce cost of buying a put',
    riskLevel: 'low',
  },
  {
    id: 'long-straddle', name: 'Long Straddle', category: 'volatile',
    legs: [
      { type: 'CE', strike: 0, action: 'BUY', qty: 1 },
      { type: 'PE', strike: 0, action: 'BUY', qty: 1 },
    ],
    description: 'Buy both a call and a put at the same strike. Profit from a big move in either direction.',
    idealCondition: 'Expecting a large move but unsure of direction (before earnings, RBI policy, budget)',
    riskLevel: 'high',
  },
  {
    id: 'short-straddle', name: 'Short Straddle', category: 'neutral',
    legs: [
      { type: 'CE', strike: 0, action: 'SELL', qty: 1 },
      { type: 'PE', strike: 0, action: 'SELL', qty: 1 },
    ],
    description: 'Sell both a call and a put at the same strike. Profit if price stays near the strike.',
    idealCondition: 'Low volatility expected, market consolidating, no major events ahead',
    riskLevel: 'high',
  },
  {
    id: 'long-strangle', name: 'Long Strangle', category: 'volatile',
    legs: [
      { type: 'CE', strike: 1, action: 'BUY', qty: 1 },
      { type: 'PE', strike: -1, action: 'BUY', qty: 1 },
    ],
    description: 'Buy OTM call and OTM put. Cheaper than straddle but needs a bigger move to profit.',
    idealCondition: 'Expecting a big move, want lower cost entry than straddle',
    riskLevel: 'medium',
  },
  {
    id: 'short-strangle', name: 'Short Strangle', category: 'neutral',
    legs: [
      { type: 'CE', strike: 1, action: 'SELL', qty: 1 },
      { type: 'PE', strike: -1, action: 'SELL', qty: 1 },
    ],
    description: 'Sell OTM call and OTM put. Profit from time decay if price stays in a range.',
    idealCondition: 'Low volatility, range-bound market, comfortable with margin requirements',
    riskLevel: 'high',
  },
  {
    id: 'iron-condor', name: 'Iron Condor', category: 'neutral',
    legs: [
      { type: 'PE', strike: -2, action: 'BUY', qty: 1 },
      { type: 'PE', strike: -1, action: 'SELL', qty: 1 },
      { type: 'CE', strike: 1, action: 'SELL', qty: 1 },
      { type: 'CE', strike: 2, action: 'BUY', qty: 1 },
    ],
    description: 'Combine a bull put spread and a bear call spread. Defined risk, profit from range-bound market.',
    idealCondition: 'Neutral view, expect price to stay in a defined range, want limited risk',
    riskLevel: 'low',
  },
  {
    id: 'iron-butterfly', name: 'Iron Butterfly', category: 'neutral',
    legs: [
      { type: 'PE', strike: -1, action: 'BUY', qty: 1 },
      { type: 'PE', strike: 0, action: 'SELL', qty: 1 },
      { type: 'CE', strike: 0, action: 'SELL', qty: 1 },
      { type: 'CE', strike: 1, action: 'BUY', qty: 1 },
    ],
    description: 'Short straddle with protective wings. Higher premium collected but narrower profit zone.',
    idealCondition: 'Very neutral, expect price to pin near a specific level at expiry',
    riskLevel: 'medium',
  },
  {
    id: 'bull-put-spread', name: 'Bull Put Spread', category: 'bullish',
    legs: [
      { type: 'PE', strike: 0, action: 'SELL', qty: 1 },
      { type: 'PE', strike: -1, action: 'BUY', qty: 1 },
    ],
    description: 'Sell a higher strike put and buy a lower strike put. Credit spread that profits from time decay.',
    idealCondition: 'Mildly bullish, comfortable selling puts with protection',
    riskLevel: 'low',
  },
  {
    id: 'bear-call-spread', name: 'Bear Call Spread', category: 'bearish',
    legs: [
      { type: 'CE', strike: 0, action: 'SELL', qty: 1 },
      { type: 'CE', strike: 1, action: 'BUY', qty: 1 },
    ],
    description: 'Sell a lower strike call and buy a higher strike call. Credit spread that profits if price stays below.',
    idealCondition: 'Mildly bearish, want income with defined risk',
    riskLevel: 'low',
  },
  {
    id: 'long-call-butterfly', name: 'Long Call Butterfly', category: 'neutral',
    legs: [
      { type: 'CE', strike: -1, action: 'BUY', qty: 1 },
      { type: 'CE', strike: 0, action: 'SELL', qty: 2 },
      { type: 'CE', strike: 1, action: 'BUY', qty: 1 },
    ],
    description: 'Buy 1 lower call, sell 2 middle calls, buy 1 higher call. Max profit if price pins at middle strike.',
    idealCondition: 'Expect minimal movement, want low-cost bet on price pinning at a level',
    riskLevel: 'low',
  },
  {
    id: 'calendar-spread', name: 'Calendar Spread', category: 'neutral',
    legs: [
      { type: 'CE', strike: 0, action: 'SELL', qty: 1, expiry: 'near' },
      { type: 'CE', strike: 0, action: 'BUY', qty: 1, expiry: 'far' },
    ],
    description: 'Sell near-expiry call, buy far-expiry call at same strike. Profit from time decay differential.',
    idealCondition: 'Neutral near-term, expecting higher IV or move later',
    riskLevel: 'medium',
  },
  {
    id: 'ratio-call-spread', name: 'Ratio Call Spread', category: 'bullish',
    legs: [
      { type: 'CE', strike: 0, action: 'BUY', qty: 1 },
      { type: 'CE', strike: 1, action: 'SELL', qty: 2 },
    ],
    description: 'Buy 1 ATM call, sell 2 OTM calls. Can be entered at zero or net credit. Risk on large up-moves.',
    idealCondition: 'Mildly bullish, dont expect a large move beyond the short strikes',
    riskLevel: 'high',
  },
  {
    id: 'jade-lizard', name: 'Jade Lizard', category: 'bullish',
    legs: [
      { type: 'PE', strike: -1, action: 'SELL', qty: 1 },
      { type: 'CE', strike: 1, action: 'SELL', qty: 1 },
      { type: 'CE', strike: 2, action: 'BUY', qty: 1 },
    ],
    description: 'Short put + bear call spread. No upside risk if total credit exceeds call spread width.',
    idealCondition: 'Bullish to neutral, want to collect premium with no upside risk',
    riskLevel: 'medium',
  },
];

// Black-Scholes Greeks calculations
function normalCDF(x: number): number {
  const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741;
  const a4 = -1.453152027, a5 = 1.061405429, p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.SQRT2;
  const t = 1.0 / (1.0 + p * x);
  const y = 1.0 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1.0 + sign * y);
}

function normalPDF(x: number): number {
  return Math.exp(-0.5 * x * x) / Math.sqrt(2 * Math.PI);
}

export function calculateGreeks(
  spot: number, strike: number, timeToExpiry: number,
  volatility: number, riskFreeRate: number, type: 'CE' | 'PE',
): Greeks {
  if (timeToExpiry <= 0) {
    const intrinsic = type === 'CE'
      ? Math.max(spot - strike, 0)
      : Math.max(strike - spot, 0);
    return { delta: intrinsic > 0 ? (type === 'CE' ? 1 : -1) : 0, gamma: 0, theta: 0, vega: 0, rho: 0 };
  }

  const sqrtT = Math.sqrt(timeToExpiry);
  const d1 = (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeToExpiry) / (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;

  let delta: number, theta: number, rho: number;

  if (type === 'CE') {
    delta = normalCDF(d1);
    theta = (-spot * normalPDF(d1) * volatility / (2 * sqrtT)
      - riskFreeRate * strike * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(d2)) / 365;
    rho = strike * timeToExpiry * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(d2) / 100;
  } else {
    delta = normalCDF(d1) - 1;
    theta = (-spot * normalPDF(d1) * volatility / (2 * sqrtT)
      + riskFreeRate * strike * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(-d2)) / 365;
    rho = -strike * timeToExpiry * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(-d2) / 100;
  }

  const gamma = normalPDF(d1) / (spot * volatility * sqrtT);
  const vega = spot * normalPDF(d1) * sqrtT / 100;

  return { delta, gamma, theta, vega, rho };
}

export function calculateOptionPrice(
  spot: number, strike: number, timeToExpiry: number,
  volatility: number, riskFreeRate: number, type: 'CE' | 'PE',
): number {
  if (timeToExpiry <= 0) {
    return type === 'CE' ? Math.max(spot - strike, 0) : Math.max(strike - spot, 0);
  }
  const sqrtT = Math.sqrt(timeToExpiry);
  const d1 = (Math.log(spot / strike) + (riskFreeRate + 0.5 * volatility * volatility) * timeToExpiry) / (volatility * sqrtT);
  const d2 = d1 - volatility * sqrtT;

  if (type === 'CE') {
    return spot * normalCDF(d1) - strike * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(d2);
  }
  return strike * Math.exp(-riskFreeRate * timeToExpiry) * normalCDF(-d2) - spot * normalCDF(-d1);
}

export function calculatePayoffCurve(legs: OptionLeg[], spotRange: [number, number], steps = 100): StrategyPayoff[] {
  const [minSpot, maxSpot] = spotRange;
  const stepSize = (maxSpot - minSpot) / steps;
  const payoffs: StrategyPayoff[] = [];

  for (let i = 0; i <= steps; i++) {
    const spot = minSpot + i * stepSize;
    let pnl = 0;

    for (const leg of legs) {
      const intrinsic = leg.type === 'CE'
        ? Math.max(spot - leg.strike, 0)
        : Math.max(leg.strike - spot, 0);
      const legPnl = leg.action === 'BUY'
        ? (intrinsic - leg.premium) * leg.qty
        : (leg.premium - intrinsic) * leg.qty;
      pnl += legPnl;
    }
    payoffs.push({ spotPrice: Math.round(spot * 100) / 100, pnl: Math.round(pnl * 100) / 100 });
  }
  return payoffs;
}

export function calculateStrategyGreeks(
  legs: OptionLeg[], spot: number, timeToExpiry: number,
  volatility: number, riskFreeRate: number,
): StrategyGreeks {
  let totalDelta = 0, totalGamma = 0, totalTheta = 0, totalVega = 0, totalRho = 0;
  let netPremium = 0;

  for (const leg of legs) {
    const greeks = calculateGreeks(spot, leg.strike, timeToExpiry, volatility, riskFreeRate, leg.type);
    const multiplier = leg.action === 'BUY' ? leg.qty : -leg.qty;
    totalDelta += greeks.delta * multiplier;
    totalGamma += greeks.gamma * multiplier;
    totalTheta += greeks.theta * multiplier;
    totalVega += greeks.vega * multiplier;
    totalRho += greeks.rho * multiplier;
    netPremium += leg.action === 'BUY' ? -leg.premium * leg.qty : leg.premium * leg.qty;
  }

  const payoffs = calculatePayoffCurve(legs, [spot * 0.8, spot * 1.2], 200);
  const pnls = payoffs.map(p => p.pnl);
  const maxProfit = Math.max(...pnls);
  const maxLoss = Math.min(...pnls);

  const breakevens: number[] = [];
  for (let i = 1; i < payoffs.length; i++) {
    if ((payoffs[i - 1].pnl <= 0 && payoffs[i].pnl >= 0) || (payoffs[i - 1].pnl >= 0 && payoffs[i].pnl <= 0)) {
      const ratio = Math.abs(payoffs[i - 1].pnl) / (Math.abs(payoffs[i - 1].pnl) + Math.abs(payoffs[i].pnl));
      breakevens.push(Math.round((payoffs[i - 1].spotPrice + ratio * (payoffs[i].spotPrice - payoffs[i - 1].spotPrice)) * 100) / 100);
    }
  }

  return {
    delta: Math.round(totalDelta * 10000) / 10000,
    gamma: Math.round(totalGamma * 10000) / 10000,
    theta: Math.round(totalTheta * 100) / 100,
    vega: Math.round(totalVega * 100) / 100,
    rho: Math.round(totalRho * 100) / 100,
    netPremium: Math.round(netPremium * 100) / 100,
    maxProfit: maxProfit > 1e8 ? Infinity : Math.round(maxProfit * 100) / 100,
    maxLoss: maxLoss < -1e8 ? -Infinity : Math.round(maxLoss * 100) / 100,
    breakevens,
  };
}

export function calculateMaxPain(
  strikes: number[], callOI: Record<number, number>, putOI: Record<number, number>,
): MaxPainResult {
  const painByStrike: { strike: number; totalPain: number }[] = [];

  for (const expiryPrice of strikes) {
    let totalPain = 0;
    for (const strike of strikes) {
      const callIntrinsic = Math.max(expiryPrice - strike, 0);
      totalPain += callIntrinsic * (callOI[strike] || 0);
      const putIntrinsic = Math.max(strike - expiryPrice, 0);
      totalPain += putIntrinsic * (putOI[strike] || 0);
    }
    painByStrike.push({ strike: expiryPrice, totalPain });
  }

  painByStrike.sort((a, b) => a.totalPain - b.totalPain);
  return {
    maxPainStrike: painByStrike[0]?.strike ?? 0,
    callOI,
    putOI,
    painByStrike,
  };
}

export function calculateIVPercentile(currentIV: number, historicalIVs: number[]): number {
  if (historicalIVs.length === 0) return 50;
  const below = historicalIVs.filter(iv => iv < currentIV).length;
  return Math.round((below / historicalIVs.length) * 100);
}

export function analyzeOIData(
  strikes: number[], callOI: Record<number, number>, putOI: Record<number, number>,
  callOIChange: Record<number, number>, putOIChange: Record<number, number>,
  callIV: Record<number, number>, putIV: Record<number, number>,
): OIAnalysis[] {
  return strikes.map(strike => {
    const cOI = callOI[strike] || 0;
    const pOI = putOI[strike] || 0;
    const pcr = cOI > 0 ? pOI / cOI : 0;

    let signal: 'bullish' | 'bearish' | 'neutral' = 'neutral';
    if (pcr > 1.3) signal = 'bullish';
    else if (pcr < 0.7) signal = 'bearish';

    return {
      strike,
      callOI: cOI,
      putOI: pOI,
      callOIChange: callOIChange[strike] || 0,
      putOIChange: putOIChange[strike] || 0,
      callIV: callIV[strike] || 0,
      putIV: putIV[strike] || 0,
      pcr: Math.round(pcr * 100) / 100,
      signal,
    };
  });
}

export class OptionsService {
  constructor(private prisma: PrismaClient) {}

  getTemplates(): StrategyTemplate[] {
    return STRATEGY_TEMPLATES;
  }

  getTemplateById(id: string): StrategyTemplate | undefined {
    return STRATEGY_TEMPLATES.find(t => t.id === id);
  }

  getTemplatesByCategory(category: string): StrategyTemplate[] {
    return STRATEGY_TEMPLATES.filter(t => t.category === category);
  }

  computePayoff(legs: OptionLeg[], spotPrice: number): {
    payoffCurve: StrategyPayoff[];
    greeks: StrategyGreeks;
  } {
    const range: [number, number] = [spotPrice * 0.85, spotPrice * 1.15];
    const payoffCurve = calculatePayoffCurve(legs, range, 150);
    const daysToExpiry = 7;
    const timeToExpiry = daysToExpiry / 365;
    const volatility = 0.20;
    const riskFreeRate = 0.065;
    const greeks = calculateStrategyGreeks(legs, spotPrice, timeToExpiry, volatility, riskFreeRate);
    return { payoffCurve, greeks };
  }

  computeMaxPain(optionChainData: {
    strikes: number[];
    callOI: Record<number, number>;
    putOI: Record<number, number>;
  }): MaxPainResult {
    return calculateMaxPain(optionChainData.strikes, optionChainData.callOI, optionChainData.putOI);
  }

  generateAIExplanation(context: {
    strategyName: string;
    legs: OptionLeg[];
    greeks: StrategyGreeks;
    spotPrice: number;
    marketCondition?: string;
  }): string {
    const { strategyName, greeks, spotPrice } = context;
    const parts: string[] = [];

    parts.push(`**${strategyName}** at spot ₹${spotPrice.toLocaleString('en-IN')}`);

    if (greeks.netPremium > 0) {
      parts.push(`You receive a net credit of ₹${greeks.netPremium.toFixed(0)} per lot upfront. This is your maximum profit if all options expire worthless.`);
    } else {
      parts.push(`You pay a net debit of ₹${Math.abs(greeks.netPremium).toFixed(0)} per lot. This is the maximum you can lose.`);
    }

    if (greeks.breakevens.length === 1) {
      parts.push(`Breakeven at ₹${greeks.breakevens[0].toLocaleString('en-IN')} — the stock needs to move ${greeks.breakevens[0] > spotPrice ? 'above' : 'below'} this level to profit.`);
    } else if (greeks.breakevens.length === 2) {
      parts.push(`Two breakevens: ₹${greeks.breakevens[0].toLocaleString('en-IN')} and ₹${greeks.breakevens[1].toLocaleString('en-IN')}. Profitable if the price stays between (or moves beyond) these levels depending on the strategy.`);
    }

    if (Math.abs(greeks.delta) < 0.1) {
      parts.push(`Delta is near zero (${greeks.delta}) — this is a **direction-neutral** strategy. It profits from time decay or range-bound movement, not from price going up or down.`);
    } else if (greeks.delta > 0.3) {
      parts.push(`Delta is ${greeks.delta} — this strategy has a **bullish bias**. It benefits when the underlying moves up.`);
    } else if (greeks.delta < -0.3) {
      parts.push(`Delta is ${greeks.delta} — this strategy has a **bearish bias**. It benefits when the underlying moves down.`);
    }

    if (greeks.theta > 0) {
      parts.push(`Theta is +${greeks.theta.toFixed(2)}/day — **time decay works in your favor**. Each day that passes with no price movement earns you ₹${greeks.theta.toFixed(0)}.`);
    } else if (greeks.theta < -5) {
      parts.push(`Theta is ${greeks.theta.toFixed(2)}/day — **time decay works against you**. You lose ₹${Math.abs(greeks.theta).toFixed(0)} each day the stock doesn't move. Act quickly or adjust.`);
    }

    if (greeks.vega > 5) {
      parts.push(`Vega is +${greeks.vega.toFixed(2)} — this strategy **benefits from rising volatility**. Good before events like earnings or RBI policy.`);
    } else if (greeks.vega < -5) {
      parts.push(`Vega is ${greeks.vega.toFixed(2)} — this strategy **benefits from falling volatility** (IV crush). Best deployed before high-IV events expecting a vol collapse.`);
    }

    const maxProfitStr = greeks.maxProfit === Infinity ? 'Unlimited' : `₹${greeks.maxProfit.toLocaleString('en-IN')}`;
    const maxLossStr = greeks.maxLoss === -Infinity ? 'Unlimited' : `₹${Math.abs(greeks.maxLoss).toLocaleString('en-IN')}`;
    parts.push(`**Max Profit**: ${maxProfitStr} | **Max Loss**: ${maxLossStr}`);

    return parts.join('\n\n');
  }

  scenarioSimulation(
    legs: OptionLeg[], spotPrice: number,
    scenarios: { spotChange: number; ivChange: number; daysElapsed: number }[],
  ) {
    return scenarios.map(s => {
      const newSpot = spotPrice * (1 + s.spotChange / 100);
      const newTimeToExpiry = Math.max(0, (7 - s.daysElapsed) / 365);
      const newIV = 0.20 * (1 + s.ivChange / 100);

      let pnl = 0;
      for (const leg of legs) {
        const newPrice = calculateOptionPrice(newSpot, leg.strike, newTimeToExpiry, newIV, 0.065, leg.type);
        const legPnl = leg.action === 'BUY'
          ? (newPrice - leg.premium) * leg.qty
          : (leg.premium - newPrice) * leg.qty;
        pnl += legPnl;
      }

      return {
        label: `Spot ${s.spotChange >= 0 ? '+' : ''}${s.spotChange}%, IV ${s.ivChange >= 0 ? '+' : ''}${s.ivChange}%, ${s.daysElapsed}d`,
        spotPrice: Math.round(newSpot * 100) / 100,
        pnl: Math.round(pnl * 100) / 100,
      };
    });
  }
}

export class OptionsError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'OptionsError';
  }
}
