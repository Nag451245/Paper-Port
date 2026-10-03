/**
 * P&L after charges for multi-leg strategies placed from the Strategy Builder,
 * and their automatic exits: close every leg when the P&L after charges
 * reaches the target or the stop, or at the planned time.
 *
 * "After charges" = what has been realised + open legs marked at the latest
 * price, less the charges already paid on the strategy's orders and the
 * charges the closing orders would cost now.
 */
import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';
import { fnoRatesOn, optionOrderCharges } from '../lib/fno-charges.js';
import { istDateStr } from '../lib/ist.js';
import { parseInstrumentSymbol } from '../lib/instrument.js';

const log = createChildLogger('StrategyExitPlan');

export interface StrategyPnl {
  strategyTag: string;
  grossPnl: number;
  chargesPaid: number;
  exitChargesEstimate: number;
  netPnl: number;
  openLegs: number;
  priced: boolean;
}

type Quote = (symbol: string, exchange: string) => Promise<{ ltp: number }>;

export class StrategyExitPlanService {
  constructor(private readonly prisma: PrismaClient, private readonly quote: Quote) {}

  private async portfolioIds(userId: string): Promise<string[]> {
    return (await this.prisma.portfolio.findMany({ where: { userId }, select: { id: true } })).map((p) => p.id);
  }

  /** P&L after charges for one strategy (open and closed legs). */
  async pnl(userId: string, strategyTag: string): Promise<StrategyPnl> {
    const portfolioIds = await this.portfolioIds(userId);
    const [positions, orders] = await Promise.all([
      this.prisma.position.findMany({ where: { portfolioId: { in: portfolioIds }, strategyTag } }),
      this.prisma.order.findMany({ where: { portfolioId: { in: portfolioIds }, strategyTag, status: 'FILLED' }, select: { totalCost: true } }),
    ]);
    const chargesPaid = orders.reduce((s, o) => s + Number(o.totalCost ?? 0), 0);
    let gross = 0, exitCharges = 0, open = 0, priced = true;
    for (const p of positions) {
      if (p.status !== 'OPEN') { gross += Number(p.realizedPnl ?? 0); continue; }
      open++;
      const entry = Number(p.avgEntryPrice);
      const ltp = await this.quote(p.symbol, p.exchange).then((q) => q.ltp).catch(() => 0);
      if (!(ltp > 0)) { priced = false; continue; }
      const sign = p.side === 'SHORT' ? -1 : 1;
      gross += (ltp - entry) * p.qty * sign;
      let underlying: string | undefined;
      try { underlying = parseInstrumentSymbol(p.symbol, p.exchange).underlying; } catch { /* keep NSE rates */ }
      exitCharges += optionOrderCharges(fnoRatesOn(istDateStr(), { underlying }), sign > 0 ? 'SELL' : 'BUY', ltp, p.qty).totalCost;
    }
    const r2 = (n: number) => Math.round(n * 100) / 100;
    return {
      strategyTag, grossPnl: r2(gross), chargesPaid: r2(chargesPaid), exitChargesEstimate: r2(exitCharges),
      netPnl: r2(gross - chargesPaid - exitCharges), openLegs: open, priced,
    };
  }

  async setPlan(userId: string, strategyTag: string, plan: { target?: number; stop?: number; exitAt?: Date }): Promise<void> {
    if (plan.target == null && plan.stop == null && !plan.exitAt) return;
    const data = { targetRupees: plan.target ?? null, stopRupees: plan.stop ?? null, exitAt: plan.exitAt ?? null, status: 'ACTIVE', reason: null };
    await this.prisma.strategyExitPlan.upsert({
      where: { userId_strategyTag: { userId, strategyTag } },
      create: { userId, strategyTag, ...data },
      update: data,
    });
  }

  async plansFor(userId: string) {
    return this.prisma.strategyExitPlan.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: 50 });
  }

  async cancel(userId: string, strategyTag: string): Promise<void> {
    await this.prisma.strategyExitPlan.updateMany({ where: { userId, strategyTag, status: 'ACTIVE' }, data: { status: 'CANCELLED', reason: 'cancelled' } });
  }

  /**
   * Check every active plan once (run each minute in market hours). `exit`
   * closes the open legs; returns how many strategies were closed.
   */
  async check(exit: (userId: string, positionIds: string[]) => Promise<unknown>, now = new Date()): Promise<number> {
    const plans = await this.prisma.strategyExitPlan.findMany({ where: { status: 'ACTIVE' } });
    let closed = 0;
    for (const plan of plans) {
      try {
        const pnl = await this.pnl(plan.userId, plan.strategyTag);
        if (pnl.openLegs === 0) {
          await this.prisma.strategyExitPlan.update({ where: { id: plan.id }, data: { status: 'DONE', reason: 'closed by hand', closedPnl: pnl.netPnl } });
          continue;
        }
        const reason = plan.exitAt && now >= plan.exitAt ? 'time'
          : !pnl.priced ? null                        // never act on a half-priced position
            : plan.targetRupees != null && pnl.netPnl >= plan.targetRupees ? 'target'
              : plan.stopRupees != null && pnl.netPnl <= -Math.abs(plan.stopRupees) ? 'stop'
                : null;
        if (!reason) continue;
        const ids = (await this.prisma.position.findMany({
          where: { portfolioId: { in: await this.portfolioIds(plan.userId) }, strategyTag: plan.strategyTag, status: 'OPEN' },
          select: { id: true },
        })).map((p) => p.id);
        await exit(plan.userId, ids);
        await this.prisma.strategyExitPlan.update({ where: { id: plan.id }, data: { status: 'DONE', reason, closedPnl: pnl.netPnl } });
        log.info({ user: plan.userId, strategy: plan.strategyTag, reason, netPnl: pnl.netPnl }, 'Strategy exit plan closed the position');
        closed++;
      } catch (err) {
        log.warn({ strategy: plan.strategyTag, err: (err as Error).message }, 'Exit plan check failed');
      }
    }
    return closed;
  }
}
