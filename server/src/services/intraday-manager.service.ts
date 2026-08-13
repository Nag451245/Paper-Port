import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { TradeService } from './trade.service.js';
import { RiskService } from './risk.service.js';
import { ExitCoordinator } from './exit-coordinator.service.js';
import { OrderManagementService } from './oms.service.js';
import { wsHub } from '../lib/websocket.js';
import { DecisionAuditService } from './decision-audit.service.js';
import { createChildLogger } from '../lib/logger.js';
import { istDateStr, istMidnight, istMinutesSinceMidnight, parseHHMM } from '../lib/ist.js';
import { parseInstrumentSymbol, settlementType, type SettlementType } from '../lib/instrument.js';

const log = createChildLogger('IntradayManager');

interface SquareOffResult {
  symbol: string;
  positionId: string;
  exitPrice: number;
  pnl: number;
  reason: string;
}

const CIRCUIT_BREAKER_CHECK_INTERVAL = 10_000;

export class IntradayManager {
  private marketData: MarketDataService;
  private tradeService: TradeService;
  private riskService: RiskService;
  private squareOffTime = '15:15';
  private squareOffHandle: ReturnType<typeof setInterval> | null = null;
  private circuitBreakerHandle: ReturnType<typeof setInterval> | null = null;
  private circuitBreakerTriggered = false;
  private maxDrawdownPct = 3.0;
  /** IST date (YYYY-MM-DD) on which auto square-off last ran, for idempotency. */
  private lastSquareOffDate: string | null = null;

  private decisionAudit: DecisionAuditService;

  constructor(private prisma: PrismaClient, oms?: OrderManagementService) {
    this.marketData = new MarketDataService();
    this.tradeService = new TradeService(prisma, oms);
    this.riskService = new RiskService(prisma);
    this.decisionAudit = new DecisionAuditService(prisma);
  }

  setSquareOffTime(time: string): void {
    this.squareOffTime = time;
  }

  setMaxDrawdown(pct: number): void {
    this.maxDrawdownPct = pct;
  }

  isCircuitBreakerActive(): boolean {
    return this.circuitBreakerTriggered;
  }

  startAutoSquareOff(): void {
    if (this.squareOffHandle) return;
    this.circuitBreakerTriggered = false;
    console.log(`[IntradayManager] Auto square-off armed for ${this.squareOffTime} IST | Circuit breaker at ${this.maxDrawdownPct}% drawdown`);

    this.squareOffHandle = setInterval(() => {
      this.runSquareOffCheck().catch(err =>
        log.error({ err }, 'Auto square-off cycle failed')
      );
    }, 30_000);

    this.circuitBreakerHandle = setInterval(async () => {
      if (this.circuitBreakerTriggered) return;

      try {
        await this.checkIntradayDrawdown();
        await this.checkDailyLossLimitViaRisk();
      } catch (err) {
        console.error('[IntradayManager] Circuit breaker check error:', (err as Error).message);
      }
    }, CIRCUIT_BREAKER_CHECK_INTERVAL);
  }

  stopAutoSquareOff(): void {
    if (this.squareOffHandle) {
      clearInterval(this.squareOffHandle);
      this.squareOffHandle = null;
    }
    if (this.circuitBreakerHandle) {
      clearInterval(this.circuitBreakerHandle);
      this.circuitBreakerHandle = null;
    }
    this.circuitBreakerTriggered = false;
  }

  private async checkDailyLossLimitViaRisk(): Promise<void> {
    if (this.circuitBreakerTriggered) return;

    const portfolios = await this.prisma.portfolio.findMany({
      select: { userId: true },
    });
    const userIds = [...new Set(portfolios.map(p => p.userId))];

    for (const userId of userIds) {
      const result = await this.riskService.forceCloseOnDailyLossLimit(
        userId,
        async (positionId: string, uid: string, exitPrice: number) => {
          await this.squareOffPosition(positionId, `RISK: Daily loss limit breach`);
        },
      );
      if (result.triggered) {
        this.circuitBreakerTriggered = true;
        log.warn({ userId, dayLossPct: result.dayLossPct, closedCount: result.closedCount },
          'forceCloseOnDailyLossLimit triggered by RiskService');
      }
    }
  }

  /**
   * One tick of the auto square-off check.
   *
   * Fires when the deadline has PASSED, not when a clock string equals it. The
   * previous version compared `"HH:MM" === this.squareOffTime` off a drifting
   * 30s timer: a single delayed tick skipped the square-off for the whole day
   * and left intraday positions to carry overnight into a gap. It also built the
   * hour as `(getUTCHours() + 5) % 24 + carry`, which yields 24 between
   * 18:30-19:00 UTC, and could fire twice inside the same minute.
   *
   * `lastSquareOffDate` makes this idempotent per IST day, and is assigned
   * before the await so a slow square-off cannot be re-entered by the next tick.
   */
  async runSquareOffCheck(): Promise<boolean> {
    const today = istDateStr();
    if (this.lastSquareOffDate === today) return false;

    const deadline = parseHHMM(this.squareOffTime);
    if (deadline === null) {
      log.error({ squareOffTime: this.squareOffTime }, 'Invalid square-off time — auto square-off cannot run');
      return false;
    }
    if (istMinutesSinceMidnight() < deadline) return false;

    this.lastSquareOffDate = today;
    log.warn({ squareOffTime: this.squareOffTime }, 'Auto square-off deadline reached — closing intraday positions');
    await this.squareOffAllIntraday();

    // Expiring derivatives are swept at the SAME deadline, deliberately reusing
    // it rather than introducing a second configurable time. They need their own
    // pass because `squareOffAllIntraday` excludes product = 'DELIVERY' — so an
    // expiring stock option held for delivery survived that sweep and went to
    // physical settlement.
    //
    // Isolated: a failure here must not propagate. The intraday square-off above
    // has already run, and reporting it as failed would misrepresent the state of
    // the book. The error is logged loudly instead.
    try {
      await this.squareOffExpiringDerivatives();
    } catch (err) {
      log.error({ err }, 'Expiry square-off sweep failed — check for open positions on expiring contracts');
    }
    return true;
  }

  /**
   * Close derivative positions expiring today, regardless of product.
   *
   * Expiry overrides product: a contract that ceases to exist tonight cannot be
   * "held for delivery" in any meaningful sense, and for a stock derivative that
   * is precisely the problem — SEBI has mandated physical settlement of stock
   * derivatives since October 2019, so an in-the-money stock option left open
   * through expiry becomes an obligation to take or give delivery of the shares,
   * with the margin call that implies. Index derivatives are cash settled and
   * carry no delivery risk, but are still closed so the outcome is a known fill
   * rather than an exchange settlement price.
   *
   * PHYSICAL settlement is squared off FIRST, because if the sweep is interrupted
   * — a restart, a broker outage, a rate limit — the positions left open should
   * be the ones that merely settle in cash.
   */
  async squareOffExpiringDerivatives(userId?: string): Promise<SquareOffResult[]> {
    const portfolioFilter = userId ? { portfolio: { userId } } : {};

    // End of the IST day: a contract expiring today is normalized to IST
    // midnight, so "expiry <= todayEnd" catches today's and anything overdue.
    const todayEnd = new Date(istMidnight().getTime() + 86_400_000 - 1);

    const openPositions = await this.prisma.position.findMany({
      where: { status: 'OPEN', ...portfolioFilter },
      include: { portfolio: { select: { userId: true } } },
    });

    // Loud rather than silent: returning [] here would read as "nothing is
    // expiring" when in fact the query did not answer. The caller isolates this
    // throw so it cannot take down the intraday square-off.
    if (!Array.isArray(openPositions)) {
      throw new Error('Expiry sweep aborted: position query did not return a list');
    }

    interface Expiring {
      id: string;
      symbol: string;
      settlement: SettlementType;
      expiry: Date;
      overdue: boolean;
    }
    const expiring: Expiring[] = [];

    for (const pos of openPositions) {
      const p = pos as any;
      let expiry: Date | null = p.expiry ?? null;
      let underlying: string = p.underlying ?? '';
      let instrumentType: string = p.instrumentType ?? '';
      let segment: string = p.segment ?? '';

      // Rows predating the derivative columns fall back to the symbol.
      if (!expiry || !instrumentType) {
        try {
          const spec = parseInstrumentSymbol(pos.symbol, pos.exchange);
          expiry = expiry ?? spec.expiry;
          underlying = underlying || spec.underlying;
          instrumentType = instrumentType || spec.instrumentType;
          segment = segment || spec.segment;
        } catch { /* not identifiable — skipped below */ }
      }

      if (!expiry || instrumentType === 'EQUITY' || instrumentType === '') continue;
      if (expiry.getTime() > todayEnd.getTime()) continue;

      expiring.push({
        id: pos.id,
        symbol: pos.symbol,
        settlement: settlementType({ instrumentType, underlying, segment } as any),
        expiry,
        overdue: expiry.getTime() < istMidnight().getTime(),
      });
    }

    if (expiring.length === 0) return [];

    // An already-expired contract that is still OPEN means a previous sweep did
    // not run or did not complete. It is reported rather than quietly closed at
    // today's price, because the contract no longer trades and any "exit price"
    // for it is fiction.
    const overdue = expiring.filter(e => e.overdue);
    if (overdue.length > 0) {
      log.error(
        { count: overdue.length, positions: overdue.map(o => ({ symbol: o.symbol, expiry: istDateStr(o.expiry) })) },
        'Positions are OPEN on contracts that have ALREADY EXPIRED — these cannot be squared off at a real price and need manual reconciliation',
      );
    }

    const closable = expiring
      .filter(e => !e.overdue)
      .sort((a, b) => (a.settlement === 'PHYSICAL' ? 0 : 1) - (b.settlement === 'PHYSICAL' ? 0 : 1));

    log.warn(
      {
        total: closable.length,
        physical: closable.filter(e => e.settlement === 'PHYSICAL').length,
        cash: closable.filter(e => e.settlement === 'CASH').length,
      },
      'Squaring off derivatives expiring today',
    );

    const results: SquareOffResult[] = [];
    for (const e of closable) {
      const reason = e.settlement === 'PHYSICAL'
        ? `Expiry square-off (${istDateStr(e.expiry)}) — PHYSICALLY settled, delivery risk if held`
        : `Expiry square-off (${istDateStr(e.expiry)}) — cash settled`;
      try {
        const result = await this.squareOffPosition(e.id, reason);
        if (result) results.push(result);
      } catch (err) {
        // Do not abort the sweep: a failure on one contract must not leave the
        // remaining physically-settled positions untouched.
        log.error(
          { err, symbol: e.symbol, settlement: e.settlement },
          e.settlement === 'PHYSICAL'
            ? 'FAILED to square off a physically-settled expiring position — DELIVERY RISK, close manually'
            : 'Failed to square off an expiring position',
        );
      }
    }

    return results;
  }

  /**
   * Mark open positions to market using LIVE quotes.
   *
   * Deliberately does NOT trust `position.unrealizedPnl`. That column is
   * written only by StopLossMonitor and PriceFeedService, both of which are
   * started by the market-open cron — so after a mid-session restart it silently
   * freezes at its last value. A circuit breaker reading that column would then
   * compute a stale (often near-zero) drawdown at exactly the moment it is most
   * needed. The stored value is used only as a per-position last resort, and the
   * caller is told how many positions fell back to it.
   */
  private async computeLiveUnrealized(
    positions: Array<{ symbol: string; exchange: string | null; side: string; qty: number; avgEntryPrice: unknown; unrealizedPnl: unknown }>,
  ): Promise<{ unrealizedPnl: number; staleCount: number }> {
    if (positions.length === 0) return { unrealizedPnl: 0, staleCount: 0 };

    const marks = await Promise.allSettled(
      positions.map(p => this.marketData.getQuote(p.symbol, p.exchange ?? 'NSE')),
    );

    let unrealizedPnl = 0;
    let staleCount = 0;

    for (let i = 0; i < positions.length; i++) {
      const p = positions[i];
      const settled = marks[i];
      const ltp = settled.status === 'fulfilled' ? Number((settled.value as any)?.ltp ?? 0) : 0;

      if (ltp > 0) {
        const entry = Number(p.avgEntryPrice);
        unrealizedPnl += p.side === 'LONG'
          ? (ltp - entry) * p.qty
          : (entry - ltp) * p.qty;
      } else {
        staleCount++;
        unrealizedPnl += Number(p.unrealizedPnl ?? 0);
      }
    }

    return { unrealizedPnl, staleCount };
  }

  private async checkIntradayDrawdown(): Promise<void> {
    const portfolios = await this.prisma.portfolio.findMany({
      select: { id: true, userId: true, initialCapital: true },
    });

    // IST day boundary — a server-local setHours(0,0,0,0) attributes trades to
    // the wrong day on a UTC host (this is REG-001).
    const todayStart = istMidnight();

    for (const pf of portfolios) {
      const capital = Number(pf.initialCapital);
      if (capital <= 0) continue;

      const todayTrades = await this.prisma.trade.findMany({
        where: { portfolioId: pf.id, exitTime: { gte: todayStart } },
        select: { netPnl: true },
      });
      const realizedPnl = todayTrades.reduce((s, t) => s + Number(t.netPnl), 0);

      const openPositions = await this.prisma.position.findMany({
        where: { portfolioId: pf.id, status: 'OPEN' },
        select: { id: true, symbol: true, exchange: true, side: true, qty: true, avgEntryPrice: true, unrealizedPnl: true },
      });

      const { unrealizedPnl, staleCount } = await this.computeLiveUnrealized(openPositions);

      if (staleCount > 0) {
        // Loud on purpose: a breaker running on partially stale marks is a
        // breaker that may not fire. Better to know than to assume it is armed.
        log.error({ userId: pf.userId, staleCount, total: openPositions.length },
          'Circuit breaker could not price some positions — drawdown may be understated');
      }

      const combinedExposure = realizedPnl + unrealizedPnl;
      const drawdownPct = capital > 0 ? Math.abs(Math.min(combinedExposure, 0)) / capital * 100 : 0;

      if (combinedExposure < 0 && drawdownPct >= this.maxDrawdownPct) {
        log.warn({ userId: pf.userId, drawdownPct, realizedPnl, unrealizedPnl, limit: this.maxDrawdownPct },
          'CIRCUIT BREAKER TRIGGERED');

        this.circuitBreakerTriggered = true;

        for (const pos of openPositions) {
          try {
            await this.squareOffPosition(pos.id, `CIRCUIT BREAKER: ${drawdownPct.toFixed(1)}% drawdown`);
          } catch (err) {
            log.error({ symbol: pos.symbol, err }, 'Circuit breaker square-off failed');
          }
        }

        await this.prisma.riskEvent.create({
          data: {
            userId: pf.userId,
            ruleType: 'CIRCUIT_BREAKER',
            severity: 'critical',
            symbol: 'PORTFOLIO',
            details: JSON.stringify({
              drawdownPct,
              realizedPnl,
              unrealizedPnl,
              positionsClosed: openPositions.length,
            }),
          },
        }).catch(err => log.error({ err, userId: pf.userId }, 'Failed to record circuit breaker risk event'));

        wsHub.broadcastToUser(pf.userId, {
          type: 'circuit_breaker',
          drawdownPct: drawdownPct.toFixed(2),
          totalLoss: combinedExposure.toFixed(0),
          message: `CIRCUIT BREAKER: Drawdown ${drawdownPct.toFixed(1)}% hit. All positions squared off. Trading halted for the day.`,
        });

        wsHub.broadcastNotification(pf.userId, {
          title: 'Circuit Breaker Triggered',
          message: `Daily loss of ₹${Math.abs(combinedExposure).toFixed(0)} (${drawdownPct.toFixed(1)}%) exceeded ${this.maxDrawdownPct}% limit. All positions closed.`,
          notificationType: 'error',
        });

        break;
      }
    }
  }

  /**
   * Square off ALL open positions at EOD. Delivery-tagged positions are excluded
   * (they survive overnight). Everything else — AI-BOT, RUST_ENGINE, ML_SCORED,
   * INTRADAY, etc. — gets closed.
   *
   * @param userId — when provided, only positions belonging to this user are closed.
   *                  When omitted (system calls like EOD timer), all users' positions are closed.
   */
  async squareOffAllIntraday(userId?: string): Promise<SquareOffResult[]> {
    const portfolioFilter = userId
      ? { portfolio: { userId } }
      : {};

    // Exclude delivery positions by the `product` column, still honouring the
    // legacy strategyTag convention for rows written before that column existed.
    //
    // The explicit `{ OR: [{ col: null }, ...] }` is REQUIRED, not defensive
    // styling. SQL three-valued logic makes `NOT (col = 'DELIVERY')` evaluate to
    // NULL — not TRUE — when col IS NULL, so those rows are filtered OUT of the
    // result. Two consequences, both verified against the database:
    //
    //   - The previous tag-only filter silently skipped every position with a
    //     NULL strategyTag, so manually-placed positions were never squared off.
    //   - Naively adding `product` to that filter would have skipped every row
    //     with a NULL product — i.e. the entire existing book immediately after
    //     the derivative-columns migration.
    const openPositions = await this.prisma.position.findMany({
      where: {
        status: 'OPEN',
        AND: [
          { OR: [{ product: null }, { product: { not: 'DELIVERY' } }] },
          { OR: [{ strategyTag: null }, { NOT: { strategyTag: { contains: 'DELIVERY' } } }] },
        ],
        ...portfolioFilter,
      },
      include: { portfolio: { select: { userId: true } } },
    });

    if (openPositions.length === 0) return [];

    log.info({ count: openPositions.length, userId: userId ?? 'ALL' }, 'Squaring off non-delivery positions');
    const results: SquareOffResult[] = [];

    for (const pos of openPositions) {
      try {
        const result = await this.squareOffPosition(pos.id, 'Auto square-off at EOD');
        if (result) results.push(result);
      } catch (err) {
        log.error({ symbol: pos.symbol, err }, 'Failed to square off position');
      }
    }

    return results;
  }

  /**
   * @param userId — when provided, verifies the position belongs to this user
   *                  before executing. Returns null if ownership check fails.
   */
  async squareOffPosition(positionId: string, reason = 'Manual square-off', userId?: string): Promise<SquareOffResult | null> {
    const position = await this.prisma.position.findUnique({
      where: { id: positionId },
      include: { portfolio: { select: { userId: true } } },
    });

    if (!position || position.status !== 'OPEN') return null;

    if (userId && position.portfolio.userId !== userId) {
      log.warn({ positionId, requestedBy: userId, ownedBy: position.portfolio.userId }, 'IDOR blocked: position ownership mismatch');
      return null;
    }

    let exitPrice = Number(position.avgEntryPrice);

    try {
      const quote = await this.marketData.getQuote(position.symbol, position.exchange);
      if (quote.ltp > 0) exitPrice = quote.ltp;
    } catch { /* use entry price as fallback */ }

    const source = reason.includes('CIRCUIT BREAKER') ? 'CIRCUIT_BREAKER' : 'INTRADAY_SQUAREOFF';

    const result = await ExitCoordinator.closePosition({
      positionId,
      userId: position.portfolio.userId,
      exitPrice,
      reason,
      source,
      decisionType: 'EXIT_SIGNAL',
      prisma: this.prisma,
      tradeService: this.tradeService,
      decisionAudit: this.decisionAudit,
    });

    if (!result.success) {
      if (!result.alreadyClosing) {
        log.warn({ positionId, error: result.error }, 'Square-off failed');
      }
      return null;
    }

    return {
      symbol: position.symbol,
      positionId,
      exitPrice,
      pnl: Number((result.pnl ?? 0).toFixed(2)),
      reason,
    };
  }

  async partialExit(positionId: string, exitQty: number, userId: string): Promise<{
    exitedQty: number;
    remainingQty: number;
    pnl: number;
  }> {
    const position = await this.prisma.position.findUnique({
      where: { id: positionId },
      include: { portfolio: true },
    });

    if (!position || position.portfolio.userId !== userId || position.status !== 'OPEN') {
      throw new Error('Position not found or unauthorized');
    }

    if (exitQty >= position.qty) {
      const result = await this.squareOffPosition(positionId, 'Full exit via partial API');
      return { exitedQty: position.qty, remainingQty: 0, pnl: result?.pnl ?? 0 };
    }

    const entryPrice = Number(position.avgEntryPrice);
    let exitPrice = entryPrice;
    try {
      const quote = await this.marketData.getQuote(position.symbol, position.exchange);
      if (quote.ltp > 0) exitPrice = quote.ltp;
    } catch { /* use entry price as fallback */ }

    const grossPnl = position.side === 'LONG'
      ? (exitPrice - entryPrice) * exitQty
      : (entryPrice - exitPrice) * exitQty;

    const turnover = exitPrice * exitQty;
    const totalCost = Math.min(turnover * 0.0003, 20) + turnover * 0.001;
    const netPnl = grossPnl - totalCost;

    await this.prisma.trade.create({
      data: {
        portfolioId: position.portfolioId,
        positionId: position.id,
        symbol: position.symbol,
        exchange: position.exchange,
        side: position.side === 'LONG' ? 'SELL' : 'BUY',
        entryPrice,
        exitPrice,
        qty: exitQty,
        grossPnl,
        totalCosts: totalCost,
        netPnl,
        entryTime: position.openedAt,
        exitTime: new Date(),
        strategyTag: `PARTIAL_EXIT`,
      },
    });

    const remainingQty = position.qty - exitQty;
    await this.prisma.position.update({
      where: { id: positionId },
      data: { qty: remainingQty },
    });

    // Atomic increment — a read-modify-write here loses concurrent fills' deltas
    await this.prisma.portfolio.update({
      where: { id: position.portfolioId },
      data: { currentNav: { increment: exitPrice * exitQty - totalCost } },
    });

    return {
      exitedQty: exitQty,
      remainingQty,
      pnl: Number(netPnl.toFixed(2)),
    };
  }

  async scaleIn(positionId: string, additionalQty: number, price: number, userId: string): Promise<{
    newQty: number;
    newAvgPrice: number;
  }> {
    const position = await this.prisma.position.findUnique({
      where: { id: positionId },
      include: { portfolio: true },
    });

    if (!position || position.portfolio.userId !== userId || position.status !== 'OPEN') {
      throw new Error('Position not found or unauthorized');
    }

    const oldAvg = Number(position.avgEntryPrice);
    const totalCost = oldAvg * position.qty + price * additionalQty;
    const newQty = position.qty + additionalQty;
    const newAvg = totalCost / newQty;

    await this.prisma.position.update({
      where: { id: positionId },
      data: { qty: newQty, avgEntryPrice: newAvg },
    });

    if (position.side === 'LONG') {
      // Atomic increment — see squareOffPosition above
      await this.prisma.portfolio.update({
        where: { id: position.portfolioId },
        data: { currentNav: { decrement: price * additionalQty } },
      });
    }

    return {
      newQty,
      newAvgPrice: Number(newAvg.toFixed(2)),
    };
  }

  async convertToDelivery(positionId: string, userId: string): Promise<{ converted: boolean }> {
    const position = await this.prisma.position.findUnique({
      where: { id: positionId },
      include: { portfolio: true },
    });

    if (!position || position.portfolio.userId !== userId || position.status !== 'OPEN') {
      throw new Error('Position not found or unauthorized');
    }

    // Product type lives in its own column now.
    //
    // This used to be `strategyTag.replace('INTRADAY', 'DELIVERY')`, which only
    // did anything when the tag literally contained the word INTRADAY. For a
    // position tagged with a strategy name — `BOT:momentum`, the common case —
    // the replace was a no-op, the tag was written back unchanged, and this
    // method still returned `{ converted: true }`. The position then remained
    // eligible for EOD square-off, so a user who asked to hold for delivery got
    // force-sold anyway.
    await this.prisma.position.update({
      where: { id: positionId },
      data: { product: 'DELIVERY' },
    });

    return { converted: true };
  }
}
