import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { OptionsService, type OptionLeg, calculateStrategyGreeks, calculatePayoffCurve } from '../services/options.service.js';
import { engineOptionsStrategy } from '../lib/rust-engine.js';
import { MarketDataService } from '../services/market-data.service.js';

const legSchema = z.object({
  type: z.enum(['CE', 'PE']),
  strike: z.number(),
  action: z.enum(['BUY', 'SELL']),
  qty: z.number().int().positive(),
  premium: z.number().min(0),
  expiry: z.string().optional(),
});

const payoffSchema = z.object({
  legs: z.array(legSchema).min(1).max(8),
  spotPrice: z.number().positive(),
});

const scenarioSchema = z.object({
  legs: z.array(legSchema).min(1).max(8),
  spotPrice: z.number().positive(),
  scenarios: z.array(z.object({
    spotChange: z.number(),
    ivChange: z.number(),
    daysElapsed: z.number().min(0),
  })).min(1).max(20),
});

const maxPainSchema = z.object({
  strikes: z.array(z.number()),
  callOI: z.record(z.string(), z.number()),
  putOI: z.record(z.string(), z.number()),
});

export async function optionsRoutes(app: FastifyInstance): Promise<void> {
  const optionsService = new OptionsService(getPrisma());

  app.get('/templates', async () => {
    return optionsService.getTemplates();
  });

  app.get('/templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const template = optionsService.getTemplateById(id);
    if (!template) return reply.code(404).send({ error: 'Template not found' });
    return template;
  });

  app.get('/templates/category/:category', async (request) => {
    const { category } = request.params as { category: string };
    return optionsService.getTemplatesByCategory(category);
  });

  app.post('/payoff', async (request, reply) => {
    const parsed = payoffSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const result = optionsService.computePayoff(parsed.data.legs as OptionLeg[], parsed.data.spotPrice);
    return result;
  });

  app.post('/scenario', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = scenarioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    return optionsService.scenarioSimulation(
      parsed.data.legs as OptionLeg[],
      parsed.data.spotPrice,
      parsed.data.scenarios,
    );
  });

  app.post('/max-pain', async (request, reply) => {
    const parsed = maxPainSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const callOI: Record<number, number> = {};
    const putOI: Record<number, number> = {};
    for (const [k, v] of Object.entries(parsed.data.callOI)) callOI[Number(k)] = v;
    for (const [k, v] of Object.entries(parsed.data.putOI)) putOI[Number(k)] = v;
    return optionsService.computeMaxPain({ strikes: parsed.data.strikes, callOI, putOI });
  });

  app.post('/explain', { preHandler: [authenticate] }, async (request, reply) => {
    const body = request.body as {
      strategyName: string;
      legs: OptionLeg[];
      spotPrice: number;
      greeks?: any;
    };
    if (!body.strategyName || !body.legs || !body.spotPrice) {
      return reply.code(400).send({ error: 'strategyName, legs, and spotPrice are required' });
    }
    const { payoffCurve: _, greeks } = optionsService.computePayoff(body.legs, body.spotPrice);
    const explanation = optionsService.generateAIExplanation({
      strategyName: body.strategyName,
      legs: body.legs,
      greeks,
      spotPrice: body.spotPrice,
    });
    return { explanation, greeks };
  });

  // Rust-powered payoff analysis with JS fallback
  const payoffEngineSchema = z.object({
    legs: z.array(z.object({
      type: z.enum(['CE', 'PE']),
      strike: z.number(),
      action: z.enum(['BUY', 'SELL']),
      qty: z.number().int().positive(),
      premium: z.number().min(0),
      iv: z.number().optional(),
      expiryDays: z.number().optional(),
    })).min(1).max(10),
    spotPrice: z.number().positive(),
    riskFreeRate: z.number().optional(),
  });

  app.post('/payoff-engine', async (request, reply) => {
    const parsed = payoffEngineSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { legs, spotPrice, riskFreeRate } = parsed.data;

    // Try Rust engine first
    try {
      const rustLegs = legs.map(l => ({
        option_type: l.type === 'CE' ? 'call' : 'put',
        strike: l.strike,
        premium: l.premium,
        quantity: l.action === 'BUY' ? l.qty : -l.qty,
        expiry_days: l.expiryDays ?? 7,
        iv: l.iv,
      }));

      const result = await engineOptionsStrategy({
        legs: rustLegs,
        spot: spotPrice,
        risk_free_rate: riskFreeRate ?? 0.065,
      }) as any;

      return {
        source: 'rust',
        payoffCurve: (result.payoff_diagram ?? []).map((p: any) => ({ spot: p.price, pnl: Math.round(p.pnl * 100) / 100 })),
        greeks: result.greeks_summary ?? { net_delta: 0, net_gamma: 0, net_theta: 0, net_vega: 0 },
        maxProfit: result.max_profit ?? 0,
        maxLoss: result.max_loss ?? 0,
        breakevens: result.breakeven_points ?? [],
        probabilityOfProfit: result.probability_of_profit ?? 0,
        riskRewardRatio: result.risk_metrics?.risk_reward_ratio ?? 0,
        capitalRequired: result.risk_metrics?.capital_required ?? 0,
        netPremium: result.risk_metrics?.net_premium ?? 0,
        strategyName: result.strategy_name ?? 'Custom',
      };
    } catch { /* Rust engine unavailable, use JS fallback */ }

    // JS fallback
    const jsLegs: OptionLeg[] = legs.map(l => ({
      type: l.type,
      strike: l.strike,
      action: l.action,
      qty: l.qty,
      premium: l.premium,
    }));

    const range: [number, number] = [spotPrice * 0.8, spotPrice * 1.2];
    const payoffCurve = calculatePayoffCurve(jsLegs, range, 100);
    const avgIV = legs.reduce((s, l) => s + (l.iv ?? 0.2), 0) / legs.length;
    const daysToExpiry = legs[0]?.expiryDays ?? 7;
    const greeks = calculateStrategyGreeks(jsLegs, spotPrice, daysToExpiry / 365, avgIV || 0.2, riskFreeRate ?? 0.065);

    return {
      source: 'js',
      payoffCurve: payoffCurve.map(p => ({ spot: p.spotPrice, pnl: p.pnl })),
      greeks: {
        net_delta: greeks.delta,
        net_gamma: greeks.gamma,
        net_theta: greeks.theta,
        net_vega: greeks.vega,
      },
      maxProfit: greeks.maxProfit,
      maxLoss: greeks.maxLoss,
      breakevens: greeks.breakevens,
      probabilityOfProfit: 0,
      riskRewardRatio: greeks.maxLoss !== 0 ? Math.abs(greeks.maxProfit / greeks.maxLoss) : 0,
      capitalRequired: Math.abs(greeks.netPremium),
      netPremium: greeks.netPremium,
      strategyName: 'Custom',
    };
  });

  // Strategy Optimizer: evaluate templates with live chain data
  const optimizeSchema = z.object({
    symbol: z.string().min(1),
    expiry: z.string().optional(),
    view: z.enum(['bullish', 'bearish', 'neutral', 'volatile']).optional(),
  });

  app.post('/optimize', async (request, reply) => {
    const parsed = optimizeSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { symbol, expiry, view } = parsed.data;
    const marketService = new MarketDataService();

    let chain: any;
    try {
      chain = await marketService.getOptionsChain(symbol, expiry);
    } catch {
      return reply.code(500).send({ error: 'Failed to fetch option chain' });
    }

    if (!chain || !chain.strikes || chain.strikes.length === 0) {
      return reply.send({ strategies: [], message: 'No chain data available' });
    }

    const spot = chain.spotPrice || chain.underlyingValue || 0;
    if (spot <= 0) return reply.send({ strategies: [], message: 'Could not determine spot price' });

    const strikes = chain.strikes as any[];
    const atmStrike = strikes.reduce((best: any, s: any) =>
      Math.abs(s.strike - spot) < Math.abs(best.strike - spot) ? s : best, strikes[0]);

    const atmIdx = strikes.findIndex((s: any) => s.strike === atmStrike.strike);
    const stepSize = strikes.length > 1 ? Math.abs(strikes[1].strike - strikes[0].strike) : 50;

    const getStrike = (offset: number) => {
      const idx = Math.max(0, Math.min(strikes.length - 1, atmIdx + offset));
      return strikes[idx];
    };

    const daysToExpiry = chain.expiry
      ? Math.max(1, Math.ceil((new Date(chain.expiry).getTime() - Date.now()) / 86400000))
      : 7;

    type CandidateStrategy = {
      name: string;
      category: string;
      risk: string;
      legs: OptionLeg[];
      description: string;
    };

    const candidates: CandidateStrategy[] = [
      {
        name: 'Bull Call Spread', category: 'bullish', risk: 'low',
        description: 'Buy ATM call, sell OTM call. Limited risk, limited reward.',
        legs: [
          { type: 'CE', strike: atmStrike.strike, action: 'BUY', qty: 1, premium: atmStrike.callLTP || 0 },
          { type: 'CE', strike: getStrike(2).strike, action: 'SELL', qty: 1, premium: getStrike(2).callLTP || 0 },
        ],
      },
      {
        name: 'Bear Put Spread', category: 'bearish', risk: 'low',
        description: 'Buy ATM put, sell OTM put. Limited risk bearish strategy.',
        legs: [
          { type: 'PE', strike: atmStrike.strike, action: 'BUY', qty: 1, premium: atmStrike.putLTP || 0 },
          { type: 'PE', strike: getStrike(-2).strike, action: 'SELL', qty: 1, premium: getStrike(-2).putLTP || 0 },
        ],
      },
      {
        name: 'Short Straddle', category: 'neutral', risk: 'high',
        description: 'Sell ATM call and put. Profit from low volatility.',
        legs: [
          { type: 'CE', strike: atmStrike.strike, action: 'SELL', qty: 1, premium: atmStrike.callLTP || 0 },
          { type: 'PE', strike: atmStrike.strike, action: 'SELL', qty: 1, premium: atmStrike.putLTP || 0 },
        ],
      },
      {
        name: 'Long Straddle', category: 'volatile', risk: 'medium',
        description: 'Buy ATM call and put. Profit from large moves.',
        legs: [
          { type: 'CE', strike: atmStrike.strike, action: 'BUY', qty: 1, premium: atmStrike.callLTP || 0 },
          { type: 'PE', strike: atmStrike.strike, action: 'BUY', qty: 1, premium: atmStrike.putLTP || 0 },
        ],
      },
      {
        name: 'Iron Condor', category: 'neutral', risk: 'low',
        description: 'Sell OTM strangle, hedge with wider strangle. Range-bound profit.',
        legs: [
          { type: 'PE', strike: getStrike(-3).strike, action: 'BUY', qty: 1, premium: getStrike(-3).putLTP || 0 },
          { type: 'PE', strike: getStrike(-1).strike, action: 'SELL', qty: 1, premium: getStrike(-1).putLTP || 0 },
          { type: 'CE', strike: getStrike(1).strike, action: 'SELL', qty: 1, premium: getStrike(1).callLTP || 0 },
          { type: 'CE', strike: getStrike(3).strike, action: 'BUY', qty: 1, premium: getStrike(3).callLTP || 0 },
        ],
      },
      {
        name: 'Bull Put Spread', category: 'bullish', risk: 'low',
        description: 'Sell ATM put, buy OTM put. Credit strategy for bullish outlook.',
        legs: [
          { type: 'PE', strike: atmStrike.strike, action: 'SELL', qty: 1, premium: atmStrike.putLTP || 0 },
          { type: 'PE', strike: getStrike(-2).strike, action: 'BUY', qty: 1, premium: getStrike(-2).putLTP || 0 },
        ],
      },
      {
        name: 'Bear Call Spread', category: 'bearish', risk: 'low',
        description: 'Sell ATM call, buy OTM call. Credit strategy for bearish view.',
        legs: [
          { type: 'CE', strike: atmStrike.strike, action: 'SELL', qty: 1, premium: atmStrike.callLTP || 0 },
          { type: 'CE', strike: getStrike(2).strike, action: 'BUY', qty: 1, premium: getStrike(2).callLTP || 0 },
        ],
      },
      {
        name: 'Long Strangle', category: 'volatile', risk: 'medium',
        description: 'Buy OTM call and put. Cheaper than straddle, needs bigger move.',
        legs: [
          { type: 'CE', strike: getStrike(2).strike, action: 'BUY', qty: 1, premium: getStrike(2).callLTP || 0 },
          { type: 'PE', strike: getStrike(-2).strike, action: 'BUY', qty: 1, premium: getStrike(-2).putLTP || 0 },
        ],
      },
      {
        name: 'Iron Butterfly', category: 'neutral', risk: 'medium',
        description: 'Short straddle with protective wings. Narrower but higher reward.',
        legs: [
          { type: 'PE', strike: getStrike(-2).strike, action: 'BUY', qty: 1, premium: getStrike(-2).putLTP || 0 },
          { type: 'PE', strike: atmStrike.strike, action: 'SELL', qty: 1, premium: atmStrike.putLTP || 0 },
          { type: 'CE', strike: atmStrike.strike, action: 'SELL', qty: 1, premium: atmStrike.callLTP || 0 },
          { type: 'CE', strike: getStrike(2).strike, action: 'BUY', qty: 1, premium: getStrike(2).callLTP || 0 },
        ],
      },
      {
        name: 'Butterfly Spread', category: 'neutral', risk: 'low',
        description: 'Buy 1 lower, sell 2 middle, buy 1 upper call. Max profit at middle strike.',
        legs: [
          { type: 'CE', strike: getStrike(-2).strike, action: 'BUY', qty: 1, premium: getStrike(-2).callLTP || 0 },
          { type: 'CE', strike: atmStrike.strike, action: 'SELL', qty: 2, premium: atmStrike.callLTP || 0 },
          { type: 'CE', strike: getStrike(2).strike, action: 'BUY', qty: 1, premium: getStrike(2).callLTP || 0 },
        ],
      },
    ];

    const filtered = view ? candidates.filter(c => c.category === view) : candidates;

    const evaluated = filtered.map(strategy => {
      const range: [number, number] = [spot * 0.85, spot * 1.15];
      const payoffCurve = calculatePayoffCurve(strategy.legs, range, 60);
      const pnls = payoffCurve.map(p => p.pnl);
      const maxProfit = Math.max(...pnls);
      const maxLoss = Math.min(...pnls);
      const netPremium = strategy.legs.reduce((s, l) =>
        s + (l.action === 'SELL' ? l.premium * l.qty : -l.premium * l.qty), 0);
      const riskReward = maxLoss !== 0 ? Math.abs(maxProfit / maxLoss) : maxProfit > 0 ? Infinity : 0;
      const profitablePoints = pnls.filter(p => p > 0).length;
      const popEstimate = Math.round((profitablePoints / pnls.length) * 100);

      const breakevens: number[] = [];
      for (let i = 1; i < payoffCurve.length; i++) {
        if ((payoffCurve[i - 1].pnl <= 0 && payoffCurve[i].pnl >= 0) || (payoffCurve[i - 1].pnl >= 0 && payoffCurve[i].pnl <= 0)) {
          const ratio = Math.abs(payoffCurve[i - 1].pnl) / (Math.abs(payoffCurve[i - 1].pnl) + Math.abs(payoffCurve[i].pnl));
          breakevens.push(Math.round(payoffCurve[i - 1].spotPrice + ratio * (payoffCurve[i].spotPrice - payoffCurve[i - 1].spotPrice)));
        }
      }

      const avgIV = strategy.legs.reduce((s, l) => {
        const st = strikes.find((ss: any) => ss.strike === l.strike);
        return s + ((l.type === 'CE' ? st?.callIV : st?.putIV) || 20);
      }, 0) / strategy.legs.length;

      const greeks = calculateStrategyGreeks(strategy.legs, spot, daysToExpiry / 365, (avgIV || 20) / 100, 0.065);

      return {
        ...strategy,
        spotPrice: spot,
        expiry: chain.expiry,
        daysToExpiry,
        maxProfit: Math.round(maxProfit),
        maxLoss: Math.round(maxLoss),
        netPremium: Math.round(netPremium),
        riskReward: Math.round(riskReward * 100) / 100,
        popEstimate,
        breakevens,
        greeks: { delta: greeks.delta, gamma: greeks.gamma, theta: greeks.theta, vega: greeks.vega },
        payoffPreview: payoffCurve.filter((_: any, i: number) => i % 3 === 0).map(p => ({ spot: p.spotPrice, pnl: Math.round(p.pnl) })),
        score: popEstimate * 0.4 + Math.min(riskReward, 5) * 12 + (netPremium > 0 ? 10 : 0),
      };
    });

    evaluated.sort((a, b) => b.score - a.score);

    return { strategies: evaluated.slice(0, 5), spotPrice: spot, symbol, expiry: chain.expiry };
  });
}
