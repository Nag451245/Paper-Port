import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { TradeService } from './trade.service.js';
import { wsHub } from '../lib/websocket.js';
import { DecisionAuditService } from './decision-audit.service.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('StopLossMonitor');

interface StopLossConfig {
  symbol: string;
  positionId: string;
  portfolioId: string;
  userId: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryPrice: number;
  stopLossPrice: number;
  trailingStopPct?: number;
  takeProfitPrice?: number;
  timeBasedExitAt?: string;  // e.g. "15:15" for intraday
}

interface MonitoredPosition {
  config: StopLossConfig;
  highWaterMark: number;
  lowWaterMark: number;
  currentTrailingStop: number;
  lastCheckedAt: Date;
}

export class StopLossMonitor {
  private monitoredPositions = new Map<string, MonitoredPosition>();
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private marketData: MarketDataService;
  private tradeService: TradeService;
  private decisionAudit: DecisionAuditService;
  private checkIntervalMs = 3_000;

  constructor(private prisma: PrismaClient) {
    this.marketData = new MarketDataService();
    this.tradeService = new TradeService(prisma);
    this.decisionAudit = new DecisionAuditService(prisma);
  }

  async start(): Promise<void> {
    if (this.intervalHandle) return;
    console.log('[StopLossMonitor] Starting — checking every 3s');

    await this.loadOpenPositions();

    this.intervalHandle = setInterval(() => {
      this.runChecks().catch(err =>
        console.error('[StopLossMonitor] Check cycle error:', err.message)
      );
    }, this.checkIntervalMs);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    console.log('[StopLossMonitor] Stopped');
  }

  addPosition(config: StopLossConfig): void {
    this.monitoredPositions.set(config.positionId, {
      config,
      highWaterMark: config.entryPrice,
      lowWaterMark: config.entryPrice,
      currentTrailingStop: config.stopLossPrice,
      lastCheckedAt: new Date(),
    });
    console.log(`[StopLossMonitor] Tracking ${config.symbol} (${config.side}) SL@${config.stopLossPrice}`);
  }

  removePosition(positionId: string): void {
    this.monitoredPositions.delete(positionId);
  }

  updateStopLoss(positionId: string, newStopPrice: number): void {
    const pos = this.monitoredPositions.get(positionId);
    if (pos) {
      pos.config.stopLossPrice = newStopPrice;
      pos.currentTrailingStop = newStopPrice;
    }
  }

  getMonitoredCount(): number {
    return this.monitoredPositions.size;
  }

  getMonitoredPositions(): Array<{ positionId: string; symbol: string; side: string; stopLoss: number; trailingStop: number }> {
    return [...this.monitoredPositions.values()].map(p => ({
      positionId: p.config.positionId,
      symbol: p.config.symbol,
      side: p.config.side,
      stopLoss: p.config.stopLossPrice,
      trailingStop: p.currentTrailingStop,
    }));
  }

  private async loadOpenPositions(): Promise<void> {
    const positions = await this.prisma.position.findMany({
      where: { status: 'OPEN' },
      include: { portfolio: { select: { userId: true } } },
    });

    for (const pos of positions) {
      const entryPrice = Number(pos.avgEntryPrice);
      const defaultStopPct = pos.side === 'LONG' ? 0.03 : 0.03;
      const stopLossPrice = pos.side === 'LONG'
        ? entryPrice * (1 - defaultStopPct)
        : entryPrice * (1 + defaultStopPct);

      this.addPosition({
        symbol: pos.symbol,
        positionId: pos.id,
        portfolioId: pos.portfolioId,
        userId: pos.portfolio.userId,
        side: pos.side as 'LONG' | 'SHORT',
        qty: pos.qty,
        entryPrice,
        stopLossPrice: Number(stopLossPrice.toFixed(2)),
        trailingStopPct: 2,
      });
    }

    console.log(`[StopLossMonitor] Loaded ${positions.length} open positions`);
  }

  private async runChecks(): Promise<void> {
    if (this.monitoredPositions.size === 0) return;

    const symbols = [...new Set([...this.monitoredPositions.values()].map(p => p.config.symbol))];
    const priceMap = new Map<string, number>();

    await Promise.allSettled(
      symbols.map(async sym => {
        try {
          const quote = await this.marketData.getQuote(sym);
          if (quote.ltp > 0) priceMap.set(sym, quote.ltp);
        } catch {}
      })
    );

    const now = new Date();
    const currentTime = `${now.getHours().toString().padStart(2, '0')}:${now.getMinutes().toString().padStart(2, '0')}`;

    for (const [posId, monitored] of this.monitoredPositions) {
      const { config } = monitored;
      const ltp = priceMap.get(config.symbol);
      if (!ltp) continue;

      monitored.lastCheckedAt = now;

      // Update watermarks
      if (ltp > monitored.highWaterMark) monitored.highWaterMark = ltp;
      if (ltp < monitored.lowWaterMark || monitored.lowWaterMark === 0) monitored.lowWaterMark = ltp;

      // Trailing stop update
      if (config.trailingStopPct && config.trailingStopPct > 0) {
        if (config.side === 'LONG') {
          const newTrailing = monitored.highWaterMark * (1 - config.trailingStopPct / 100);
          if (newTrailing > monitored.currentTrailingStop) {
            monitored.currentTrailingStop = Number(newTrailing.toFixed(2));
          }
        } else {
          const newTrailing = monitored.lowWaterMark * (1 + config.trailingStopPct / 100);
          if (newTrailing < monitored.currentTrailingStop || monitored.currentTrailingStop === 0) {
            monitored.currentTrailingStop = Number(newTrailing.toFixed(2));
          }
        }
      }

      let triggerExit = false;
      let exitReason = '';

      // Stop-loss check
      if (config.side === 'LONG' && ltp <= monitored.currentTrailingStop) {
        triggerExit = true;
        exitReason = `Stop-loss hit: LTP ₹${ltp} <= SL ₹${monitored.currentTrailingStop}`;
      } else if (config.side === 'SHORT' && ltp >= monitored.currentTrailingStop) {
        triggerExit = true;
        exitReason = `Stop-loss hit: LTP ₹${ltp} >= SL ₹${monitored.currentTrailingStop}`;
      }

      // Take-profit check
      if (!triggerExit && config.takeProfitPrice) {
        if (config.side === 'LONG' && ltp >= config.takeProfitPrice) {
          triggerExit = true;
          exitReason = `Take-profit hit: LTP ₹${ltp} >= TP ₹${config.takeProfitPrice}`;
        } else if (config.side === 'SHORT' && ltp <= config.takeProfitPrice) {
          triggerExit = true;
          exitReason = `Take-profit hit: LTP ₹${ltp} <= TP ₹${config.takeProfitPrice}`;
        }
      }

      // Time-based exit
      if (!triggerExit && config.timeBasedExitAt && currentTime >= config.timeBasedExitAt) {
        triggerExit = true;
        exitReason = `Time-based exit at ${config.timeBasedExitAt}`;
      }

      if (triggerExit) {
        await this.executeStopLossExit(monitored, ltp, exitReason);
        this.monitoredPositions.delete(posId);
      }
    }
  }

  private async executeStopLossExit(monitored: MonitoredPosition, ltp: number, reason: string): Promise<void> {
    const { config } = monitored;
    log.info({ symbol: config.symbol, reason, ltp }, 'EXIT triggered');

    try {
      const trade = await this.tradeService.closePosition(config.positionId, config.userId, ltp);
      const netPnl = Number(trade.netPnl);
      const outcome = netPnl > 0 ? 'WIN' : 'LOSS';

      // Record in DecisionAudit so the nightly learning pipeline can use this data
      const decisionType = reason.includes('Take-profit') ? 'TP_TRIGGER' as const
        : reason.includes('Time-based') ? 'EXIT_SIGNAL' as const
        : 'SL_TRIGGER' as const;

      try {
        const auditId = await this.decisionAudit.recordDecision({
          userId: config.userId,
          symbol: config.symbol,
          decisionType,
          direction: config.side === 'LONG' ? 'LONG' : 'SHORT',
          confidence: 1.0,
          signalSource: 'STOP_LOSS_MONITOR',
          marketDataSnapshot: {
            ltp,
            entryPrice: config.entryPrice,
            highWaterMark: monitored.highWaterMark,
            lowWaterMark: monitored.lowWaterMark,
            trailingStop: monitored.currentTrailingStop,
          },
          reasoning: reason,
          entryPrice: config.entryPrice,
        });

        await this.decisionAudit.resolveDecision(auditId, {
          exitPrice: ltp,
          pnl: netPnl,
          predictionAccuracy: outcome === 'WIN' ? 1 : 0,
          outcomeNotes: `${outcome}: P&L ₹${netPnl.toFixed(2)} | ${reason}`,
        });
      } catch {
        // Audit is best-effort — don't block the exit
      }

      await this.prisma.riskEvent.create({
        data: {
          userId: config.userId,
          ruleType: 'STOP_LOSS_EXIT',
          severity: 'high',
          symbol: config.symbol,
          details: JSON.stringify({
            reason, ltp, entryPrice: config.entryPrice, qty: config.qty,
            netPnl, side: config.side,
            highWaterMark: monitored.highWaterMark,
            lowWaterMark: monitored.lowWaterMark,
          }),
        },
      });

      wsHub.broadcastToUser(config.userId, {
        type: 'stop_loss_exit',
        symbol: config.symbol,
        side: config.side,
        exitPrice: ltp,
        pnl: netPnl,
        reason,
      });

      wsHub.broadcastNotification(config.userId, {
        title: 'Stop-Loss Triggered',
        message: `${config.symbol} ${config.side} exited at ₹${ltp.toFixed(2)} — P&L: ₹${netPnl.toFixed(2)} | ${reason}`,
        notificationType: 'warning',
      });

    } catch (err) {
      log.error({ err, symbol: config.symbol }, 'Failed to execute stop-loss exit');
    }
  }
}
