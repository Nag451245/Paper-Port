import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { TradeService } from './trade.service.js';
import { ExitCoordinator } from './exit-coordinator.service.js';
import { OrderManagementService } from './oms.service.js';
import { wsHub } from '../lib/websocket.js';
import { DecisionAuditService } from './decision-audit.service.js';
import { createChildLogger } from '../lib/logger.js';

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
  private squareOffTime = '15:15';
  private squareOffHandle: ReturnType<typeof setInterval> | null = null;
  private circuitBreakerHandle: ReturnType<typeof setInterval> | null = null;
  private circuitBreakerTriggered = false;
  private maxDrawdownPct = 3.0;

  private decisionAudit: DecisionAuditService;

  constructor(private prisma: PrismaClient, oms?: OrderManagementService) {
    this.marketData = new MarketDataService();
    this.tradeService = new TradeService(prisma, oms);
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

    this.squareOffHandle = setInterval(async () => {
      const now = new Date();
      const istHours = (now.getUTCHours() + 5) % 24 + (now.getUTCMinutes() + 30 >= 60 ? 1 : 0);
      const istMinutes = (now.getUTCMinutes() + 30) % 60;
      const currentTime = `${istHours.toString().padStart(2, '0')}:${istMinutes.toString().padStart(2, '0')}`;

      if (currentTime === this.squareOffTime) {
        await this.squareOffAllIntraday();
      }
    }, 30_000);

    this.circuitBreakerHandle = setInterval(async () => {
      if (this.circuitBreakerTriggered) return;

      try {
        await this.checkIntradayDrawdown();
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

  private async checkIntradayDrawdown(): Promise<void> {
    const portfolios = await this.prisma.portfolio.findMany({
      select: { id: true, userId: true, initialCapital: true },
    });

    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

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

      const unrealizedPnl = openPositions.reduce((s, p) => s + Number(p.unrealizedPnl ?? 0), 0);
      const totalDayPnl = realizedPnl + unrealizedPnl;
      const drawdownPct = capital > 0 ? Math.abs(Math.min(totalDayPnl, 0)) / capital * 100 : 0;

      if (totalDayPnl < 0 && drawdownPct >= this.maxDrawdownPct) {
        log.warn({ userId: pf.userId, drawdownPct, totalDayPnl, limit: this.maxDrawdownPct },
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
              totalDayPnl,
              realizedPnl,
              unrealizedPnl,
              positionsClosed: openPositions.length,
            }),
          },
        }).catch(err => log.error({ err, userId: pf.userId }, 'Failed to record circuit breaker risk event'));

        wsHub.broadcastToUser(pf.userId, {
          type: 'circuit_breaker',
          drawdownPct: drawdownPct.toFixed(2),
          totalLoss: totalDayPnl.toFixed(0),
          message: `CIRCUIT BREAKER: Drawdown ${drawdownPct.toFixed(1)}% hit. All positions squared off. Trading halted for the day.`,
        });

        wsHub.broadcastNotification(pf.userId, {
          title: 'Circuit Breaker Triggered',
          message: `Daily loss of ₹${Math.abs(totalDayPnl).toFixed(0)} (${drawdownPct.toFixed(1)}%) exceeded ${this.maxDrawdownPct}% limit. All positions closed.`,
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
   */
  async squareOffAllIntraday(): Promise<SquareOffResult[]> {
    const openPositions = await this.prisma.position.findMany({
      where: {
        status: 'OPEN',
        NOT: { strategyTag: { contains: 'DELIVERY' } },
      },
      include: { portfolio: { select: { userId: true } } },
    });

    if (openPositions.length === 0) return [];

    log.info({ count: openPositions.length }, 'Squaring off all non-delivery positions at EOD');
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

  async squareOffPosition(positionId: string, reason = 'Manual square-off'): Promise<SquareOffResult | null> {
    const position = await this.prisma.position.findUnique({
      where: { id: positionId },
      include: { portfolio: { select: { userId: true } } },
    });

    if (!position || position.status !== 'OPEN') return null;

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

    const portfolio = await this.prisma.portfolio.findUnique({ where: { id: position.portfolioId } });
    if (portfolio) {
      await this.prisma.portfolio.update({
        where: { id: position.portfolioId },
        data: { currentNav: Number(portfolio.currentNav) + (exitPrice * exitQty - totalCost) },
      });
    }

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

    const portfolio = await this.prisma.portfolio.findUnique({ where: { id: position.portfolioId } });
    if (portfolio && position.side === 'LONG') {
      await this.prisma.portfolio.update({
        where: { id: position.portfolioId },
        data: { currentNav: Number(portfolio.currentNav) - price * additionalQty },
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

    const currentTag = position.strategyTag ?? '';
    const newTag = currentTag.replace('INTRADAY', 'DELIVERY');

    await this.prisma.position.update({
      where: { id: positionId },
      data: { strategyTag: newTag || 'DELIVERY' },
    });

    return { converted: true };
  }
}
