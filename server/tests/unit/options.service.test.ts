import { describe, it, expect, vi } from 'vitest';
import {
  calculateGreeks,
  calculateOptionPrice,
  calculatePayoffCurve,
  calculateStrategyGreeks,
  calculateMaxPain,
  calculateIVPercentile,
  analyzeOIData,
  OptionsService,
  type OptionLeg,
} from '../../src/services/options.service.js';

describe('calculateGreeks', () => {
  it('should compute ATM call Greeks with expected ranges', () => {
    const g = calculateGreeks(100, 100, 30 / 365, 0.2, 0.065, 'CE');
    expect(g.delta).toBeGreaterThan(0.4);
    expect(g.delta).toBeLessThan(0.7);
    expect(g.gamma).toBeGreaterThan(0);
    expect(g.theta).toBeLessThan(0);
    expect(g.vega).toBeGreaterThan(0);
  });

  it('should compute deep ITM put delta near -1', () => {
    const g = calculateGreeks(80, 120, 30 / 365, 0.2, 0.065, 'PE');
    expect(g.delta).toBeLessThan(-0.85);
  });

  it('should compute deep OTM call delta near 0', () => {
    const g = calculateGreeks(100, 150, 7 / 365, 0.2, 0.065, 'CE');
    expect(g.delta).toBeLessThan(0.05);
  });

  it('should return intrinsic-only values when expired', () => {
    const gITM = calculateGreeks(110, 100, 0, 0.2, 0.065, 'CE');
    expect(gITM.delta).toBe(1);
    expect(gITM.gamma).toBe(0);
    expect(gITM.theta).toBe(0);
    expect(gITM.vega).toBe(0);

    const gOTM = calculateGreeks(90, 100, 0, 0.2, 0.065, 'CE');
    expect(gOTM.delta).toBe(0);
  });

  it('should return negative delta for puts and positive for calls', () => {
    const call = calculateGreeks(100, 100, 30 / 365, 0.2, 0.065, 'CE');
    const put = calculateGreeks(100, 100, 30 / 365, 0.2, 0.065, 'PE');
    expect(call.delta).toBeGreaterThan(0);
    expect(put.delta).toBeLessThan(0);
    // Put-call delta parity: call delta - put delta ≈ 1
    expect(call.delta - put.delta).toBeCloseTo(1, 1);
  });
});

describe('calculateOptionPrice', () => {
  it('should compute positive price for ATM call', () => {
    const price = calculateOptionPrice(100, 100, 30 / 365, 0.2, 0.065, 'CE');
    expect(price).toBeGreaterThan(0);
    expect(price).toBeLessThan(20);
  });

  it('should return intrinsic value when expired', () => {
    expect(calculateOptionPrice(110, 100, 0, 0.2, 0.065, 'CE')).toBe(10);
    expect(calculateOptionPrice(90, 100, 0, 0.2, 0.065, 'CE')).toBe(0);
    expect(calculateOptionPrice(90, 100, 0, 0.2, 0.065, 'PE')).toBe(10);
    expect(calculateOptionPrice(110, 100, 0, 0.2, 0.065, 'PE')).toBe(0);
  });

  it('should satisfy put-call parity approximately', () => {
    const S = 100, K = 100, T = 30 / 365, vol = 0.2, r = 0.065;
    const call = calculateOptionPrice(S, K, T, vol, r, 'CE');
    const put = calculateOptionPrice(S, K, T, vol, r, 'PE');
    // C - P ≈ S - K*e^(-rT)
    const expected = S - K * Math.exp(-r * T);
    expect(call - put).toBeCloseTo(expected, 1);
  });
});

describe('calculatePayoffCurve', () => {
  it('should generate correct payoff for a long call', () => {
    const legs: OptionLeg[] = [{ type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 }];
    const payoffs = calculatePayoffCurve(legs, [80, 120], 40);
    expect(payoffs.length).toBe(41);

    const atStrike = payoffs.find(p => Math.abs(p.spotPrice - 100) < 1.5);
    expect(atStrike!.pnl).toBeCloseTo(-5, 0);

    const deep = payoffs.find(p => p.spotPrice >= 118);
    expect(deep!.pnl).toBeGreaterThan(10);

    const belowStrike = payoffs.find(p => p.spotPrice <= 82);
    expect(belowStrike!.pnl).toBeCloseTo(-5, 0);
  });

  it('should generate correct payoff for an iron condor', () => {
    const legs: OptionLeg[] = [
      { type: 'PE', strike: 90, action: 'BUY', qty: 1, premium: 1 },
      { type: 'PE', strike: 95, action: 'SELL', qty: 1, premium: 3 },
      { type: 'CE', strike: 105, action: 'SELL', qty: 1, premium: 3 },
      { type: 'CE', strike: 110, action: 'BUY', qty: 1, premium: 1 },
    ];
    const payoffs = calculatePayoffCurve(legs, [80, 120], 100);

    const atMiddle = payoffs.find(p => Math.abs(p.spotPrice - 100) < 0.5);
    expect(atMiddle!.pnl).toBe(4); // net credit = 3+3-1-1 = 4

    const extremeLow = payoffs[0];
    expect(extremeLow.pnl).toBeLessThan(0);
  });

  it('should generate correct payoff for a straddle', () => {
    const legs: OptionLeg[] = [
      { type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
      { type: 'PE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
    ];
    const payoffs = calculatePayoffCurve(legs, [80, 120], 100);

    const atStrike = payoffs.find(p => Math.abs(p.spotPrice - 100) < 0.5);
    expect(atStrike!.pnl).toBeCloseTo(-10, 0);

    const farUp = payoffs[payoffs.length - 1];
    expect(farUp.pnl).toBeGreaterThan(0);

    const farDown = payoffs[0];
    expect(farDown.pnl).toBeGreaterThan(0);
  });
});

describe('calculateStrategyGreeks', () => {
  it('should aggregate Greeks for multi-leg strategy', () => {
    const legs: OptionLeg[] = [
      { type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
      { type: 'PE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
    ];
    const greeks = calculateStrategyGreeks(legs, 100, 30 / 365, 0.2, 0.065);

    // Straddle delta should be near 0 (call delta + put delta ≈ 0)
    expect(Math.abs(greeks.delta)).toBeLessThan(0.15);
    expect(greeks.gamma).toBeGreaterThan(0);
    expect(greeks.theta).toBeLessThan(0);
    expect(greeks.vega).toBeGreaterThan(0);
    expect(greeks.netPremium).toBe(-10);
  });

  it('should detect breakeven points', () => {
    const legs: OptionLeg[] = [
      { type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
    ];
    const greeks = calculateStrategyGreeks(legs, 100, 30 / 365, 0.2, 0.065);

    expect(greeks.breakevens.length).toBeGreaterThanOrEqual(1);
    const mainBreakeven = greeks.breakevens.find(b => b > 100 && b < 110);
    expect(mainBreakeven).toBeDefined();
    expect(mainBreakeven!).toBeCloseTo(105, 0);
  });

  it('should calculate max profit and max loss', () => {
    const legs: OptionLeg[] = [
      { type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
    ];
    const greeks = calculateStrategyGreeks(legs, 100, 30 / 365, 0.2, 0.065);

    expect(greeks.maxLoss).toBeCloseTo(-5, 0);
    expect(greeks.maxProfit).toBeGreaterThan(10);
  });
});

describe('calculateMaxPain', () => {
  it('should find the strike with minimum total pain', () => {
    const strikes = [90, 95, 100, 105, 110];
    const callOI: Record<number, number> = { 90: 100, 95: 200, 100: 500, 105: 300, 110: 100 };
    const putOI: Record<number, number> = { 90: 50, 95: 150, 100: 400, 105: 200, 110: 300 };

    const result = calculateMaxPain(strikes, callOI, putOI);
    expect(result.maxPainStrike).toBeDefined();
    expect(strikes).toContain(result.maxPainStrike);
    expect(result.painByStrike.length).toBe(5);
    expect(result.painByStrike[0].totalPain).toBeLessThanOrEqual(result.painByStrike[4].totalPain);
  });

  it('should return 0 for empty strikes', () => {
    const result = calculateMaxPain([], {}, {});
    expect(result.maxPainStrike).toBe(0);
    expect(result.painByStrike.length).toBe(0);
  });

  it('should correctly compute pain at specific strike', () => {
    const strikes = [100, 110];
    const callOI: Record<number, number> = { 100: 10, 110: 0 };
    const putOI: Record<number, number> = { 100: 0, 110: 10 };

    const result = calculateMaxPain(strikes, callOI, putOI);
    // At 100: call pain = 0 (100-100)*10=0, put pain = (110-100)*10=100 → total=100
    // At 110: call pain = (110-100)*10=100, put pain = 0 → total=100
    expect(result.painByStrike[0].totalPain).toBeLessThanOrEqual(result.painByStrike[1].totalPain);
  });
});

describe('calculateIVPercentile', () => {
  it('should return 50 for empty historical data', () => {
    expect(calculateIVPercentile(20, [])).toBe(50);
  });

  it('should return 100 when current IV is highest', () => {
    expect(calculateIVPercentile(30, [10, 15, 20, 25])).toBe(100);
  });

  it('should return 0 when current IV is lowest', () => {
    expect(calculateIVPercentile(5, [10, 15, 20, 25])).toBe(0);
  });

  it('should return 50 for median IV', () => {
    expect(calculateIVPercentile(15, [10, 20])).toBe(50);
  });

  it('should handle all same values', () => {
    expect(calculateIVPercentile(20, [20, 20, 20])).toBe(0);
  });
});

describe('analyzeOIData', () => {
  it('should classify bullish signal when PCR > 1.3', () => {
    const result = analyzeOIData(
      [100],
      { 100: 100 },
      { 100: 200 },
      { 100: 10 },
      { 100: 20 },
      { 100: 18 },
      { 100: 16 },
    );
    expect(result[0].signal).toBe('bullish');
    expect(result[0].pcr).toBe(2);
  });

  it('should classify bearish signal when PCR < 0.7', () => {
    const result = analyzeOIData(
      [100],
      { 100: 200 },
      { 100: 100 },
      { 100: 0 },
      { 100: 0 },
      { 100: 0 },
      { 100: 0 },
    );
    expect(result[0].signal).toBe('bearish');
    expect(result[0].pcr).toBe(0.5);
  });

  it('should classify neutral signal when PCR is between 0.7 and 1.3', () => {
    const result = analyzeOIData(
      [100],
      { 100: 100 },
      { 100: 100 },
      { 100: 0 },
      { 100: 0 },
      { 100: 0 },
      { 100: 0 },
    );
    expect(result[0].signal).toBe('neutral');
    expect(result[0].pcr).toBe(1);
  });
});

describe('OptionsService', () => {
  const service = new OptionsService({} as any);

  describe('getTemplates', () => {
    it('should return all 17 strategy templates', () => {
      const templates = service.getTemplates();
      expect(templates.length).toBe(17);
    });

    it('should have required fields on each template', () => {
      const templates = service.getTemplates();
      for (const t of templates) {
        expect(t).toHaveProperty('id');
        expect(t).toHaveProperty('name');
        expect(t).toHaveProperty('category');
        expect(t).toHaveProperty('legs');
        expect(t).toHaveProperty('description');
        expect(t).toHaveProperty('riskLevel');
        expect(['bullish', 'bearish', 'neutral', 'volatile']).toContain(t.category);
        expect(['low', 'medium', 'high']).toContain(t.riskLevel);
      }
    });
  });

  describe('getTemplateById', () => {
    it('should return a template by id', () => {
      const t = service.getTemplateById('iron-condor');
      expect(t).toBeDefined();
      expect(t!.name).toBe('Iron Condor');
      expect(t!.legs.length).toBe(4);
    });

    it('should return undefined for unknown id', () => {
      expect(service.getTemplateById('nonexistent')).toBeUndefined();
    });
  });

  describe('getTemplatesByCategory', () => {
    it('should filter templates by category', () => {
      const bullish = service.getTemplatesByCategory('bullish');
      expect(bullish.length).toBeGreaterThan(0);
      for (const t of bullish) {
        expect(t.category).toBe('bullish');
      }
    });

    it('should return empty for unknown category', () => {
      expect(service.getTemplatesByCategory('unknown').length).toBe(0);
    });
  });

  describe('computePayoff', () => {
    it('should return payoff curve and greeks', () => {
      const legs: OptionLeg[] = [
        { type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
      ];
      const result = service.computePayoff(legs, 100);
      expect(result.payoffCurve.length).toBeGreaterThan(0);
      expect(result.greeks).toHaveProperty('delta');
      expect(result.greeks).toHaveProperty('netPremium');
    });
  });

  describe('computeMaxPain', () => {
    it('should compute max pain from option chain data', () => {
      const result = service.computeMaxPain({
        strikes: [90, 95, 100, 105, 110],
        callOI: { 90: 100, 95: 200, 100: 500, 105: 300, 110: 100 },
        putOI: { 90: 50, 95: 150, 100: 400, 105: 200, 110: 300 },
      });
      expect(result.maxPainStrike).toBeDefined();
    });
  });

  describe('generateAIExplanation', () => {
    it('should produce explanation text with key metrics', () => {
      const legs: OptionLeg[] = [
        { type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
      ];
      const greeks = calculateStrategyGreeks(legs, 100, 30 / 365, 0.2, 0.065);
      const text = service.generateAIExplanation({
        strategyName: 'Long Call',
        legs,
        greeks,
        spotPrice: 100,
      });
      expect(text).toContain('Long Call');
      expect(text).toContain('Max Profit');
      expect(text).toContain('Max Loss');
      expect(text).toContain('debit');
    });

    it('should describe credit for net-credit strategies', () => {
      const legs: OptionLeg[] = [
        { type: 'CE', strike: 100, action: 'SELL', qty: 1, premium: 5 },
      ];
      const greeks = calculateStrategyGreeks(legs, 100, 30 / 365, 0.2, 0.065);
      const text = service.generateAIExplanation({
        strategyName: 'Short Call',
        legs,
        greeks,
        spotPrice: 100,
      });
      expect(text).toContain('credit');
    });
  });

  describe('scenarioSimulation', () => {
    it('should return scenario results for given parameters', () => {
      const legs: OptionLeg[] = [
        { type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
      ];
      const scenarios = [
        { spotChange: 5, ivChange: 0, daysElapsed: 0 },
        { spotChange: -5, ivChange: 10, daysElapsed: 3 },
        { spotChange: 0, ivChange: -20, daysElapsed: 7 },
      ];
      const results = service.scenarioSimulation(legs, 100, scenarios);
      expect(results.length).toBe(3);
      for (const r of results) {
        expect(r).toHaveProperty('label');
        expect(r).toHaveProperty('spotPrice');
        expect(r).toHaveProperty('pnl');
      }
    });

    it('should show profit when spot moves up for long call', () => {
      const legs: OptionLeg[] = [
        { type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
      ];
      const results = service.scenarioSimulation(legs, 100, [
        { spotChange: 10, ivChange: 0, daysElapsed: 0 },
      ]);
      expect(results[0].pnl).toBeGreaterThan(0);
    });

    it('should show loss when spot moves down for long call at expiry', () => {
      const legs: OptionLeg[] = [
        { type: 'CE', strike: 100, action: 'BUY', qty: 1, premium: 5 },
      ];
      const results = service.scenarioSimulation(legs, 100, [
        { spotChange: -10, ivChange: 0, daysElapsed: 7 },
      ]);
      expect(results[0].pnl).toBeCloseTo(-5, 0);
    });
  });
});
