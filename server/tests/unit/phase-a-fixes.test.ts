import { describe, it, expect } from 'vitest';
import { sizePosition, RISK_PER_TRADE } from '../../src/lib/position-size.js';
import { engineRegime } from '../../src/services/bot-engine.js';
import { backtestStrategyName } from '../../src/services/backtest.service.js';
import { istHour, istDayOfWeek } from '../../src/lib/ist.js';

describe('position sizing by risk', () => {
  it('caps the loss at the stop to the per-trade risk budget', () => {
    // ₹10L capital, 10% cap = 100 shares at ₹1,000; a ₹50 stop allows only 0.5% × 10L / 50 = 100 shares
    expect(sizePosition({ nav: 1_000_000, ltp: 1000, allocation: 0.10, stopLoss: 950 })).toBe(100);
    // a ₹100 stop: 50 shares, so the loss at the stop is still ₹5,000
    const qty = sizePosition({ nav: 1_000_000, ltp: 1000, allocation: 0.10, stopLoss: 900 });
    expect(qty).toBe(50);
    expect(qty * 100).toBe(1_000_000 * RISK_PER_TRADE);
  });

  it('never exceeds the allocation, and sizes zero when there is no edge or no price', () => {
    expect(sizePosition({ nav: 1_000_000, ltp: 1000, allocation: 0.02, stopLoss: 999 })).toBe(20);
    expect(sizePosition({ nav: 1_000_000, ltp: 1000, allocation: 0, stopLoss: 950 })).toBe(0);
    expect(sizePosition({ nav: 1_000_000, ltp: 0, allocation: 0.1 })).toBe(0);
    expect(sizePosition({ nav: 1_000, ltp: 5_000, allocation: 0.5 })).toBe(0);         // one share too big: no forced 1
  });
});

describe('regime names sent to the engine', () => {
  it('match the keys the Rust scan weights by', () => {
    expect(['TRENDING_UP', 'TRENDING_DOWN', 'MEAN_REVERTING', 'VOLATILE', null, 'UNKNOWN'].map(engineRegime))
      .toEqual(['trending', 'trending', 'mean_reverting', 'volatile', undefined, undefined]);
  });
});

describe('backtest strategy names', () => {
  it('maps every accepted spelling and refuses the rest', () => {
    expect(backtestStrategyName('ema-crossover')).toBe('ema_crossover');
    expect(backtestStrategyName('Opening Range Breakout')).toBe('orb');
    expect(backtestStrategyName('adx')).toBe('trend_following');
    expect(backtestStrategyName('composite')).toBeNull();
    expect(backtestStrategyName('made_up')).toBeNull();
  });
});

describe('Indian time helpers (the server runs on UTC)', () => {
  it('report IST hour and weekday', () => {
    const d = new Date('2026-10-05T04:30:00Z');                    // Monday 10:00 IST
    expect(istHour(d)).toBe(10);
    expect(istDayOfWeek(d)).toBe(1);
    expect(istDayOfWeek(new Date('2026-10-04T20:00:00Z'))).toBe(1); // Sunday 20:00 UTC is Monday 01:30 IST
  });
});
