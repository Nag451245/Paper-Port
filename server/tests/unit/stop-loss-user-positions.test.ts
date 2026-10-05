import { describe, it, expect } from 'vitest';
import { StopLossMonitor } from '../../src/services/stop-loss-monitor.service.js';

const monitor = new StopLossMonitor({} as any) as any;
const leg = (over: Record<string, unknown> = {}) => ({
  id: 'p1', symbol: 'NIFTY2026100622500CE', portfolioId: 'pf', side: 'SHORT', qty: 65,
  avgEntryPrice: 106.38, stopLoss: null, target: null, portfolio: { userId: 'u1' }, strategyTag: null, ...over,
});

describe('stop-loss monitor leaves the user\u2019s own positions alone', () => {
  it('does not watch a position the user opened without a stop or target', () => {
    expect(monitor.buildConfig(leg())).toBeNull();
    expect(monitor.buildConfig(leg({ strategyTag: 'STRAT:Short Straddle · 05 Oct, 10:24:04' }))).toBeNull();
  });

  it('acts only on the stop or target the user set, and does not trail it', () => {
    const c = monitor.buildConfig(leg({ stopLoss: 160, strategyTag: 'STRAT:Short Straddle' }));
    expect(c).toMatchObject({ stopLossPrice: 160, takeProfitPrice: undefined });
    expect(c.trailingStopPct).toBeUndefined();
    // Target only: the stop sits where price cannot reach, so it never fires.
    expect(monitor.buildConfig(leg({ target: 40 })).stopLossPrice).toBe(Number.MAX_SAFE_INTEGER);
    expect(monitor.buildConfig(leg({ side: 'LONG', target: 200 })).stopLossPrice).toBe(0);
  });

  it('still gives a bot position the default stop, target and trailing stop', () => {
    const c = monitor.buildConfig(leg({ symbol: 'SBIN', avgEntryPrice: 1000, strategyTag: 'AI_BOT' }));
    expect(c).toMatchObject({ stopLossPrice: 1030, takeProfitPrice: 940, trailingStopPct: 2 });
  });
});
