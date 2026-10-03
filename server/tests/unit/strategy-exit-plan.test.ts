import { describe, it, expect, vi } from 'vitest';
import { StrategyExitPlanService } from '../../src/services/strategy-exit-plan.service.js';

const TAG = 'STRAT:Short Straddle · 03 Oct, 10:00:00';

function setup(ltp: Record<string, number>, plan: Record<string, unknown>) {
  const positions = [
    { id: 'p1', symbol: 'NIFTY2026100622400CE', exchange: 'NFO', qty: 65, avgEntryPrice: 156.1, side: 'SHORT', status: 'OPEN', strategyTag: TAG },
    { id: 'p2', symbol: 'NIFTY2026100622400PE', exchange: 'NFO', qty: 65, avgEntryPrice: 103.6, side: 'SHORT', status: 'OPEN', strategyTag: TAG },
  ];
  const plans = [{ id: 'plan1', userId: 'u1', strategyTag: TAG, status: 'ACTIVE', targetRupees: null, stopRupees: null, exitAt: null, ...plan }];
  const prisma: any = {
    portfolio: { findMany: vi.fn().mockResolvedValue([{ id: 'pf1' }]) },
    position: { findMany: vi.fn().mockResolvedValue(positions) },
    order: { findMany: vi.fn().mockResolvedValue([{ totalCost: 60 }, { totalCost: 50 }]) },
    strategyExitPlan: { findMany: vi.fn().mockResolvedValue(plans), update: vi.fn().mockResolvedValue({}) },
  };
  const svc = new StrategyExitPlanService(prisma, async (s) => ({ ltp: ltp[s] ?? 0 }));
  return { svc, prisma };
}

describe('StrategyExitPlanService', () => {
  it('P&L is after the charges already paid and the cost of closing now', async () => {
    const { svc } = setup({ NIFTY2026100622400CE: 100, NIFTY2026100622400PE: 80 }, {});
    const p = await svc.pnl('u1', TAG);
    expect(p.grossPnl).toBeCloseTo((156.1 - 100) * 65 + (103.6 - 80) * 65, 2);
    expect(p.chargesPaid).toBe(110);
    expect(p.exitChargesEstimate).toBeGreaterThan(40);                // two buy orders: ₹20 each + fees
    expect(p.netPnl).toBeCloseTo(p.grossPnl - 110 - p.exitChargesEstimate, 2);
  });

  it('closes every leg when the P&L after charges reaches the target', async () => {
    const { svc, prisma } = setup({ NIFTY2026100622400CE: 100, NIFTY2026100622400PE: 80 }, { targetRupees: 3000 });
    const exit = vi.fn().mockResolvedValue({});
    expect(await svc.check(exit)).toBe(1);
    expect(exit).toHaveBeenCalledWith('u1', ['p1', 'p2']);
    expect(prisma.strategyExitPlan.update).toHaveBeenCalledWith(expect.objectContaining({ data: expect.objectContaining({ status: 'DONE', reason: 'target' }) }));
  });

  it('closes at the stop, and never acts while a leg has no price', async () => {
    const stop = setup({ NIFTY2026100622400CE: 300, NIFTY2026100622400PE: 150 }, { stopRupees: 5000 });
    const exit = vi.fn().mockResolvedValue({});
    expect(await stop.svc.check(exit)).toBe(1);

    const unpriced = setup({ NIFTY2026100622400CE: 300 }, { stopRupees: 5000 });
    const exit2 = vi.fn();
    expect(await unpriced.svc.check(exit2)).toBe(0);
    expect(exit2).not.toHaveBeenCalled();
  });

  it('closes at the planned time whatever the P&L', async () => {
    const { svc } = setup({ NIFTY2026100622400CE: 156, NIFTY2026100622400PE: 103 }, { exitAt: new Date('2026-10-03T09:00:00Z') });
    const exit = vi.fn().mockResolvedValue({});
    expect(await svc.check(exit, new Date('2026-10-03T09:01:00Z'))).toBe(1);
  });
});
