import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { TradeService } from './trade.service.js';
import { ExitCoordinator } from './exit-coordinator.service.js';
import { OrderManagementService } from './oms.service.js';
import { wsHub } from '../lib/websocket.js';
import { DecisionAuditService } from './decision-audit.service.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('StopLossMonitor');

const RELOAD_INTERVAL_MS = 30_000;

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
  timeBasedExitAt?: string;
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
  private reloadHandle: ReturnType<typeof setInterval> | null = null;
  private marketData: MarketDataService;
  private tradeService: TradeService;
  private decisionAudit: DecisionAuditService;
  private checkIntervalMs = 3_000;

  constructor(private prisma: PrismaClient, oms?: OrderManagementService) {
    this.marketData = new MarketDataService();
    this.tradeService = new TradeService(prisma, oms);
    this.decisionAudit = new DecisionAuditService(prisma);
  }

  async start(): Promise<void> {
    if (this.intervalHandle) return;
    log.info('Starting — checking every 3s, reloading positions every 30s');

    await this.loadOpenPositions();

    this.intervalHandle = setInterval(() => {
      this.runChecks().catch(err =>
        log.error({ err }, 'Check cycle error')
      );
    }, this.checkIntervalMs);

    this.reloadHandle = setInterval(() => {
      this.syncOpenPositions().catch(err =>
        log.warn({ err }, 'Position reload error')
      );
    }, RELOAD_INTERVAL_MS);
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.reloadHandle) {
      clearInterval(this.reloadHandle);
      this.reloadHandle = null;
    }
    log.info('Stopped');
  }

  addPosition(config: StopLossConfig): void {
    if (this.monitoredPositions.has(config.positionId)) return;
    this.monitoredPositions.set(config.positionId, {
      config,
      highWaterMark: config.entryPrice,
      lowWaterMark: config.entryPrice,
      currentTrailingStop: config.stopLossPrice,
      lastCheckedAt: new Date(),
    });
    log.info({ symbol: config.symbol, side: config.side, stopLoss: config.stopLossPrice }, 'Tracking position');
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

  getMonitoredPositions(): Array<{
    positionId: string; symbol: string; side: string; qty: number;
    entryPrice: number; stopLoss: number; takeProfit: number;
    currentPrice: number; unrealizedPnl: number;
    distanceToStop: number; distanceToTarget: number;
    trailingStop: number;
  }> {
    return [...this.monitoredPositions.values()].map(p => {
      const { config } = p;
      const currentPrice = config.side === 'LONG' ? p.highWaterMark : p.lowWaterMark;
      const unrealizedPnl = config.side === 'LONG'
        ? (currentPrice - config.entryPrice) * config.qty
        : (config.entryPrice - currentPrice) * config.qty;

      const distanceToStop = config.entryPrice > 0
        ? Math.abs(currentPrice - p.currentTrailingStop) / config.entryPrice * 100 : 0;

      const tp = config.takeProfitPrice ?? 0;
      const distanceToTarget = (tp > 0 && config.entryPrice > 0)
        ? Math.abs(tp - currentPrice) / config.entryPrice * 100 : 0;

      return {
        positionId: config.positionId,
        symbol: config.symbol,
        side: config.side,
        qty: config.qty,
        entryPrice: config.entryPrice,
        stopLoss: p.currentTrailingStop,
        takeProfit: tp,
        currentPrice: Number(currentPrice.toFixed(2)),
        unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
        distanceToStop: Number(distanceToStop.toFixed(2)),
        distanceToTarget: Number(distanceToTarget.toFixed(2)),
        trailingStop: p.currentTrailingStop,
      };
    });
  }

  /**
   * Periodically sync with DB: add new positions, remove closed ones,
   * update qty/entryPrice for pyramided positions, and refresh unrealizedPnl.
   */
  private async syncOpenPositions(): Promise<void> {
    const positions = await this.prisma.position.findMany({
      where: { status: 'OPEN' },
      include: { portfolio: { select: { userId: true } } },
    });

    const dbPositionIds = new Set(positions.map(p => p.id));

    // Remove positions that have been closed elsewhere
    for (const posId of this.monitoredPositions.keys()) {
      if (!dbPositionIds.has(posId)) {
        this.monitoredPositions.delete(posId);
        log.info({ positionId: posId }, 'Removed closed position from monitor');
      }
    }

    // Add new positions and update existing ones
    for (const pos of positions) {
      const entryPrice = Number(pos.avgEntryPrice);
      const existing = this.monitoredPositions.get(pos.id);

      if (existing) {
        // Update qty and entry price if position was pyramided
        existing.config.qty = pos.qty;
        existing.config.entryPrice = entryPrice;
      } else {
        const defaultStopPct = 0.03;
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
    }
  }

  private async loadOpenPositions(): Promise<void> {
    const positions = await this.prisma.position.findMany({
      where: { status: 'OPEN' },
      include: { portfolio: { select: { userId: true } } },
    });

    for (const pos of positions) {
      const entryPrice = Number(pos.avgEntryPrice);
      const defaultStopPct = 0.03;
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

    log.info({ count: positions.length }, 'Loaded open positions');
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

    // Batch-update unrealizedPnl for all monitored positions
    const pnlUpdates: Array<{ id: string; unrealizedPnl: number }> = [];

    for (const [posId, monitored] of this.monitoredPositions) {
      const { config } = monitored;
      const ltp = priceMap.get(config.symbol);
      if (!ltp) continue;

      monitored.lastCheckedAt = now;

      // Calculate and track unrealizedPnl
      const unrealizedPnl = config.side === 'LONG'
        ? (ltp - config.entryPrice) * config.qty
        : (config.entryPrice - ltp) * config.qty;
      pnlUpdates.push({ id: posId, unrealizedPnl });

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

    // Persist unrealizedPnl to DB in a single batch
    if (pnlUpdates.length > 0) {
      await Promise.allSettled(
        pnlUpdates.map(({ id, unrealizedPnl }) =>
          this.prisma.position.update({
            where: { id },
            data: { unrealizedPnl },
          }).catch(err => log.warn({ err, positionId: id }, 'Failed to persist unrealizedPnl'))
        )
      );
    }
  }

  private async executeStopLossExit(monitored: MonitoredPosition, ltp: number, reason: string): Promise<void> {
    const { config } = monitored;
    log.info({ symbol: config.symbol, reason, ltp }, 'EXIT triggered');

    const decisionType = reason.includes('Take-profit') ? 'TP_TRIGGER' as const
      : reason.includes('Time-based') ? 'EXIT_SIGNAL' as const
      : 'SL_TRIGGER' as const;

    const result = await ExitCoordinator.closePosition({
      positionId: config.positionId,
      userId: config.userId,
      exitPrice: ltp,
      reason,
      source: 'STOP_LOSS_MONITOR',
      decisionType,
      prisma: this.prisma,
      tradeService: this.tradeService,
      decisionAudit: this.decisionAudit,
      extraSnapshot: {
        highWaterMark: monitored.highWaterMark,
        lowWaterMark: monitored.lowWaterMark,
        trailingStop: monitored.currentTrailingStop,
      },
    });

    if (!result.success) {
      log.warn({ positionId: config.positionId, error: result.error }, 'Exit coordinator rejected close');
    }
  }
}
