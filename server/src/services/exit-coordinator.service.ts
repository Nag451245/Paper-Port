import type { PrismaClient } from '@prisma/client';
import type { TradeService } from './trade.service.js';
import type { DecisionAuditService } from './decision-audit.service.js';
import { wsHub } from '../lib/websocket.js';
import { emit } from '../lib/event-bus.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('ExitCoordinator');

/**
 * Prevents double-close races by locking position IDs during exit.
 * All exit paths (StopLossMonitor, IntradayManager, manual API, BotEngine)
 * must route through this coordinator.
 */

const activeExits = new Set<string>();

interface CloseRequest {
  positionId: string;
  userId: string;
  exitPrice: number;
  reason: string;
  source: string;
  decisionType: 'SL_TRIGGER' | 'TP_TRIGGER' | 'EXIT_SIGNAL' | 'POSITION_CLOSED';
  prisma: PrismaClient;
  tradeService: TradeService;
  decisionAudit: DecisionAuditService;
  extraSnapshot?: Record<string, unknown>;
}

interface CloseResult {
  success: boolean;
  pnl?: number;
  error?: string;
  alreadyClosing?: boolean;
}

export class ExitCoordinator {
  static async closePosition(req: CloseRequest): Promise<CloseResult> {
    if (activeExits.has(req.positionId)) {
      log.warn({ positionId: req.positionId, source: req.source }, 'Duplicate close attempt blocked');
      return { success: false, alreadyClosing: true, error: 'Position exit already in progress' };
    }

    activeExits.add(req.positionId);

    try {
      // Verify position is still open before closing
      const pos = await req.prisma.position.findUnique({ where: { id: req.positionId } });
      if (!pos || pos.status !== 'OPEN') {
        return { success: false, error: 'Position already closed' };
      }

      const trade = await req.tradeService.closePosition(req.positionId, req.userId, req.exitPrice);
      const netPnl = Number(trade.netPnl);
      const outcome = netPnl > 0 ? 'WIN' : 'LOSS';

      // Decision audit (best-effort)
      try {
        const auditId = await req.decisionAudit.recordDecision({
          userId: req.userId,
          symbol: pos.symbol,
          decisionType: req.decisionType,
          direction: pos.side as 'LONG' | 'SHORT',
          confidence: 1.0,
          signalSource: req.source,
          marketDataSnapshot: {
            ltp: req.exitPrice,
            entryPrice: Number(pos.avgEntryPrice),
            ...req.extraSnapshot,
          },
          reasoning: req.reason,
          entryPrice: Number(pos.avgEntryPrice),
        });

        await req.decisionAudit.resolveDecision(auditId, {
          exitPrice: req.exitPrice,
          pnl: netPnl,
          predictionAccuracy: outcome === 'WIN' ? 1 : 0,
          outcomeNotes: `${outcome}: P&L ₹${netPnl.toFixed(2)} | ${req.reason}`,
        });
      } catch { /* audit is best-effort */ }

      // Risk event (best-effort)
      try {
        await req.prisma.riskEvent.create({
          data: {
            userId: req.userId,
            ruleType: req.source === 'STOP_LOSS_MONITOR' ? 'STOP_LOSS_EXIT' : 'POSITION_EXIT',
            severity: 'high',
            symbol: pos.symbol,
            details: JSON.stringify({
              reason: req.reason, ltp: req.exitPrice,
              entryPrice: Number(pos.avgEntryPrice), qty: pos.qty,
              netPnl, side: pos.side, source: req.source,
              ...req.extraSnapshot,
            }),
          },
        });
      } catch { /* best-effort */ }

      // WebSocket notifications
      wsHub.broadcastToUser(req.userId, {
        type: 'position_exited',
        symbol: pos.symbol,
        side: pos.side,
        exitPrice: req.exitPrice,
        pnl: netPnl,
        reason: req.reason,
        source: req.source,
      });

      wsHub.broadcastNotification(req.userId, {
        title: req.source === 'STOP_LOSS_MONITOR' ? 'Stop-Loss Triggered' : 'Position Exited',
        message: `${pos.symbol} ${pos.side} exited at ₹${req.exitPrice.toFixed(2)} — P&L: ₹${netPnl.toFixed(2)} | ${req.reason}`,
        notificationType: netPnl >= 0 ? 'success' : 'warning',
      });

      return { success: true, pnl: netPnl };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      log.error({ err, positionId: req.positionId, source: req.source }, 'Exit failed');
      return { success: false, error: msg };
    } finally {
      activeExits.delete(req.positionId);
    }
  }

  static isExiting(positionId: string): boolean {
    return activeExits.has(positionId);
  }
}
