import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { OptionsService, type OptionLeg, calculateStrategyGreeks } from '../services/options.service.js';
import { engineOptionsStrategy, isEngineAvailable } from '../lib/rust-engine.js';
import { MarketDataService } from '../services/market-data.service.js';
import { fnoRatesOn, optionOrderCharges, sumCharges } from '../lib/fno-charges.js';
import { istDateStr } from '../lib/ist.js';
import { analyzeStrategy, realisedVol } from '../lib/strategy-math.js';

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
  // Every route here runs on the owner's broker session: signed-in users only.
  app.addHook('preHandler', authenticate);
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
    symbol: z.string().max(20).optional(),
    /** Recent realised volatility of the underlying (0.12 = 12%), for the expected P&L. */
    realizedVol: z.number().positive().max(5).optional(),
  });

  app.post('/payoff-engine', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = payoffEngineSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const { spotPrice, riskFreeRate } = parsed.data;
    // The option chain gives IV in percent (14.6); the pricing model needs 0.146.
    const legs = parsed.data.legs.map(l => ({ ...l, iv: l.iv && l.iv > 0 ? (l.iv > 3 ? l.iv / 100 : l.iv) : undefined }));
    // Above the highest strike the P&L keeps moving by the net calls held:
    // more bought than sold = unlimited profit, more sold = unlimited loss.
    const netCalls = legs.filter(l => l.type === 'CE').reduce((s, l) => s + (l.action === 'BUY' ? l.qty : -l.qty), 0);

    // Every profit and loss below is after charges: the orders that open the
    // position now, and STT on long options that expire in the money. Closing
    // before expiry costs another set of orders, shown separately.
    const rates = fnoRatesOn(istDateStr(), { underlying: parsed.data.symbol });
    const entry = sumCharges(legs.map(l => optionOrderCharges(rates, l.action, l.premium, l.qty)));
    const exitEarly = sumCharges(legs.map(l => optionOrderCharges(rates, l.action === 'BUY' ? 'SELL' : 'BUY', l.premium, l.qty)));
    const charges = { entry, exitEarlyEstimate: exitEarly.totalCost, exerciseSttRate: rates.sttOptionExercise, asOf: istDateStr() };

    // Expected P&L at expiry if the index keeps moving as it has lately (realised
    // volatility, when the page sends it), else at implied volatility.
    const days = Math.min(...legs.map(l => l.expiryDays ?? 7));
    const ivs = legs.map(l => l.iv).filter((v): v is number => !!v);
    const avgIv = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0.2;
    const analysis = analyzeStrategy(legs, spotPrice, {
      days, sigma: avgIv, sigmaEv: parsed.data.realizedVol, rf: riskFreeRate,
      fixedCost: entry.totalCost, exerciseStt: rates.sttOptionExercise,
    });
    const expected = { expectedPnl: analysis.expectedPnl, expectedPnlBasis: parsed.data.realizedVol ? 'realised' : 'implied' };

    // Try Rust engine first (only if available)
    if (isEngineAvailable()) try {
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
        fixed_cost: entry.totalCost,
        exercise_stt: rates.sttOptionExercise,
      }) as any;

      // An engine build older than the charges change ignores them: use the
      // TypeScript figures (same maths) so nothing is ever shown before charges.
      if (!result.charges_applied) {
        result.payoff_diagram = analysis.curve.map(p => ({ price: p.spot, pnl: p.pnl }));
        Object.assign(result, {
          max_profit: analysis.maxProfit, max_loss: analysis.maxLoss, breakeven_points: analysis.breakevens,
          probability_of_profit: analysis.pop, unlimited_profit: analysis.unlimitedProfit, unlimited_loss: analysis.unlimitedLoss,
        });
      }
      return {
        source: 'rust',
        payoffCurve: (result.payoff_diagram ?? []).map((p: any) => ({ spot: p.price, pnl: Math.round(p.pnl * 100) / 100 })),
        greeks: result.greeks_summary ?? { net_delta: 0, net_gamma: 0, net_theta: 0, net_vega: 0 },
        maxProfit: result.max_profit ?? 0,
        maxLoss: result.max_loss ?? 0,
        unlimitedProfit: result.unlimited_profit ?? netCalls > 0,
        unlimitedLoss: result.unlimited_loss ?? netCalls < 0,
        breakevens: result.breakeven_points ?? [],
        probabilityOfProfit: result.probability_of_profit ?? 0,
        riskRewardRatio: result.risk_metrics?.risk_reward_ratio ?? 0,
        capitalRequired: result.risk_metrics?.capital_required ?? 0,
        marginRequired: result.risk_metrics?.margin_required ?? 0,
        // The engine counts premium paid as positive; here + means credit received (as below).
        netPremium: -(result.risk_metrics?.net_premium ?? 0),
        strategyName: result.strategy_name ?? 'Custom',
        charges,
        ...expected,
      };
    } catch { /* Rust engine unavailable, use JS fallback */ }

    // Without the engine: the same maths in TypeScript (lib/strategy-math.ts).
    const jsGreeks = calculateStrategyGreeks(legs, spotPrice, days / 365, avgIv || 0.2, riskFreeRate ?? 0.065);
    return {
      source: 'js',
      payoffCurve: analysis.curve,
      greeks: { net_delta: jsGreeks.delta, net_gamma: jsGreeks.gamma, net_theta: jsGreeks.theta, net_vega: jsGreeks.vega },
      maxProfit: analysis.maxProfit,
      maxLoss: analysis.maxLoss,
      unlimitedProfit: analysis.unlimitedProfit,
      unlimitedLoss: analysis.unlimitedLoss,
      breakevens: analysis.breakevens,
      probabilityOfProfit: analysis.pop,
      riskRewardRatio: !analysis.unlimitedLoss && !analysis.unlimitedProfit && analysis.maxLoss < 0 ? Math.abs(analysis.maxProfit / analysis.maxLoss) : 0,
      capitalRequired: analysis.margin,
      marginRequired: analysis.margin,
      netPremium: analysis.netPremium,
      strategyName: 'Custom',
      charges,
      ...expected,
    };
  });

  // Are options cheap or expensive right now? Implied volatility against how much
  // the underlying has actually been moving, plus India VIX's place in its 1-year range.
  const VIX_UNDERLYINGS = new Set(['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX', 'NIFTYNXT50']);
  app.get('/vol-context', { preHandler: [authenticate] }, async (request, reply) => {
    const q = z.object({ symbol: z.string().min(1).max(20), atmIv: z.coerce.number().positive().max(500).optional() })
      .safeParse(request.query);
    if (!q.success) return reply.code(400).send({ error: 'symbol is required' });
    const symbol = q.data.symbol.toUpperCase();
    const market = new MarketDataService();
    const to = istDateStr();
    const from = istDateStr(new Date(Date.now() - 400 * 86_400_000));
    const closes = (await market.getHistory(symbol, '1day', from, to).catch(() => []))
      .map(b => b.close);
    const rv20 = realisedVol(closes, 20);
    const rv60 = realisedVol(closes, 60);

    let vix: { now: number; low: number; high: number; rank: number; percentile: number; days: number } | null = null;
    if (VIX_UNDERLYINGS.has(symbol)) {
      const series = (await market.getHistory('INDIA VIX', '1day', istDateStr(new Date(Date.now() - 370 * 86_400_000)), to).catch(() => []))
        .map(b => b.close).filter(v => v > 0);
      if (series.length >= 100) {
        const now = series[series.length - 1];
        const low = Math.min(...series), high = Math.max(...series);
        vix = {
          now, low, high, days: series.length,
          rank: high > low ? Math.round(((now - low) / (high - low)) * 1000) / 10 : 50,
          percentile: Math.round((series.filter(v => v < now).length / series.length) * 1000) / 10,
        };
      }
    }

    const iv = q.data.atmIv ? (q.data.atmIv > 3 ? q.data.atmIv / 100 : q.data.atmIv) : null;
    const ratio = iv && rv20 ? iv / rv20 : null;
    const verdict = ratio == null ? null
      : ratio >= 1.2 ? 'expensive' : ratio <= 0.9 ? 'cheap' : 'fair';
    return {
      symbol,
      atmIv: iv,
      realizedVol20: rv20,
      realizedVol60: rv60,
      ivToRealized: ratio != null ? Math.round(ratio * 100) / 100 : null,
      verdict,
      vix,
      asOf: to,
    };
  });

  // Strategy Optimizer: evaluate templates with live chain data
  const optimizeSchema = z.object({
    symbol: z.string().min(1),
    expiry: z.string().optional(),
    view: z.enum(['bullish', 'bearish', 'neutral', 'volatile']).optional(),
    lotSize: z.number().int().positive().optional(),
    lots: z.number().int().positive().max(50).optional(),
    /** Most the user is willing to lose at expiry, rupees (after charges). Unlimited-loss strategies are left out when set. */
    maxLoss: z.number().positive().optional(),
    realizedVol: z.number().positive().max(5).optional(),
  });

  app.post('/optimize', { preHandler: [authenticate] }, async (request, reply) => {
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
      ? Math.max(0.5, (new Date(`${String(chain.expiry).slice(0, 10)}T15:30:00+05:30`).getTime() - Date.now()) / 86400000)
      : 7;
    // Real lots: the candidates below are written per unit and scaled here.
    const qty = (Number(chain.lotSize) || parsed.data.lotSize || 1) * (parsed.data.lots ?? 1);
    const rates = fnoRatesOn(istDateStr(), { underlying: symbol });

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
    const ivOf = (l: OptionLeg) => {
      const st = strikes.find((ss: any) => ss.strike === l.strike);
      const iv = Number(l.type === 'CE' ? st?.callIV : st?.putIV) || 0;
      return iv > 3 ? iv / 100 : iv;
    };

    // Each candidate at real size, after charges. Ranked by the expected P&L per
    // rupee of margin if the index keeps moving as it has lately (realised
    // volatility) — selling options only pays when they are priced above that.
    const evaluated = filtered
      .map(c => ({ ...c, legs: c.legs.map(l => ({ ...l, qty: l.qty * qty })) }))
      .filter(c => c.legs.every(l => l.premium > 0))
      .map(strategy => {
        const ivs = strategy.legs.map(ivOf).filter(v => v > 0);
        const sigma = ivs.length ? ivs.reduce((a, b) => a + b, 0) / ivs.length : 0.2;
        const entry = sumCharges(strategy.legs.map(l => optionOrderCharges(rates, l.action, l.premium, l.qty)));
        const an = analyzeStrategy(strategy.legs, spot, {
          days: daysToExpiry, sigma, sigmaEv: parsed.data.realizedVol,
          fixedCost: entry.totalCost, exerciseStt: rates.sttOptionExercise, range: [spot * 0.85, spot * 1.15], points: 60,
        });
        const greeks = calculateStrategyGreeks(strategy.legs, spot, daysToExpiry / 365, sigma, 0.065);
        const evPerMargin = an.margin > 0 ? an.expectedPnl / an.margin : 0;
        return {
          ...strategy,
          legs: strategy.legs.map(l => ({ ...l, iv: ivOf(l) * 100 })),
          spotPrice: spot,
          expiry: chain.expiry,
          daysToExpiry: Math.round(daysToExpiry * 10) / 10,
          maxProfit: Math.round(an.maxProfit),
          maxLoss: Math.round(an.maxLoss),
          unlimitedProfit: an.unlimitedProfit,
          unlimitedLoss: an.unlimitedLoss,
          netPremium: Math.round(an.netPremium),
          charges: entry.totalCost,
          margin: Math.round(an.margin),
          expectedPnl: Math.round(an.expectedPnl),
          expectedReturnOnMargin: Math.round(evPerMargin * 10000) / 100,
          riskReward: !an.unlimitedLoss && !an.unlimitedProfit && an.maxLoss < 0 ? Math.round(Math.abs(an.maxProfit / an.maxLoss) * 100) / 100 : 0,
          pop: Math.round(an.pop * 1000) / 10,
          popEstimate: Math.round(an.pop * 100),
          breakevens: an.breakevens,
          greeks: { delta: greeks.delta, gamma: greeks.gamma, theta: greeks.theta, vega: greeks.vega },
          payoffPreview: an.curve.filter((_, i) => i % 3 === 0).map(p => ({ spot: p.spot, pnl: Math.round(p.pnl) })),
          score: Math.round(evPerMargin * 10000) / 100,
        };
      })
      .filter(s => parsed.data.maxLoss == null || (!s.unlimitedLoss && -s.maxLoss <= parsed.data.maxLoss));

    evaluated.sort((a, b) => b.score - a.score || b.pop - a.pop);

    return {
      strategies: evaluated.slice(0, 6), spotPrice: spot, symbol, expiry: chain.expiry, lotSize: qty,
      basis: parsed.data.realizedVol ? 'realised' : 'implied',
    };
  });
}
