import { PrismaClient } from '@prisma/client';
import { getBrokerAdapter, type BrokerAdapter } from '../lib/broker-adapter.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('BrokerStopLoss');

/**
 * Keeps a protective stop-loss order resting AT THE BROKER for every open
 * live position.
 *
 * Why this exists: the in-process StopLossMonitor polls the last traded price
 * every few seconds and, on breach, sends a market order. That is fine in an
 * orderly market and worthless in a gap — if the instrument opens below the
 * stop, the poll observes the gap only after it has happened and the market
 * order fills wherever the book is. A stop resting at the exchange is the only
 * thing that acts while the process is asleep, disconnected, or restarting.
 *
 * The software monitor is NOT replaced by this; it stays as the backstop for
 * trailing logic, take-profit and time-based exits, and for the case where the
 * broker rejects or loses the resting order.
 *
 * Scope: no-ops entirely unless a live broker adapter is available, so paper
 * trading is unaffected.
 *
 * Orphan safety: a resting stop that outlives its position would later sell
 * shares that are no longer held. Every close path must call
 * `cancelStop`, and `reconcile` sweeps for stops whose position is gone.
 */

export type StopSide = 'LONG' | 'SHORT';

export interface StopIntent {
  positionId: string;
  symbol: string;
  exchange: string;
  side: StopSide;
  qty: number;
  triggerPrice: number;
}

/** A protective stop that executed at the broker. The DB still shows OPEN. */
export interface FiredStop {
  positionId: string;
  symbol: string;
  brokerOrderId: string;
  /** Broker's average fill price. 0 if the broker did not report one. */
  fillPrice: number;
  filledQty: number;
}

export interface SyncResult {
  action: 'placed' | 'modified' | 'unchanged' | 'skipped' | 'failed';
  brokerOrderId?: string;
  reason?: string;
}

/** Skip the modify if the trigger moved by less than this fraction. */
const MIN_TRIGGER_CHANGE_PCT = 0.001; // 0.1%

/** Do not retry a failed broker connection more often than this. */
const RECONNECT_COOLDOWN_MS = 60_000;

export interface BrokerStopLossOptions {
  /** Defaults to TRADING_MODE === 'LIVE'. */
  liveMode?: boolean;
}

export class BrokerStopLossService {
  private broker: BrokerAdapter | null = null;
  private liveMode: boolean;
  private connecting: Promise<void> | null = null;
  private nextConnectAttemptAt = 0;

  constructor(
    private prisma: PrismaClient,
    broker?: BrokerAdapter | null,
    opts?: BrokerStopLossOptions,
  ) {
    // Explicit null means "deliberately disabled"; undefined means "resolve it".
    this.broker = broker === undefined ? getBrokerAdapter('breeze') : broker;
    this.liveMode = opts?.liveMode ?? (process.env.TRADING_MODE ?? 'PAPER').toUpperCase() === 'LIVE';
  }

  /**
   * Whether protective stops are configured at all.
   *
   * This is the cheap, synchronous gate callers use to skip the whole code path
   * in paper mode. It deliberately does NOT report live connectivity —
   * `getBrokerAdapter` hands back a fresh, unconnected adapter on every call, so
   * checking `isConnected()` here would report false forever and silently
   * disable protective stops even in LIVE mode.
   */
  isEnabled(): boolean {
    return this.broker !== null && this.liveMode;
  }

  /**
   * Bring the adapter up if it is not already. Each caller of a broker
   * operation goes through here, because our adapter instance is our own and
   * nobody else connects it.
   */
  private async ensureConnected(): Promise<boolean> {
    if (!this.isEnabled()) return false;
    if (this.broker!.isConnected()) return true;

    if (this.connecting) {
      await this.connecting;
      return this.broker!.isConnected();
    }

    if (Date.now() < this.nextConnectAttemptAt) return false;

    this.connecting = this.broker!.connect({})
      .catch(err => {
        this.nextConnectAttemptAt = Date.now() + RECONNECT_COOLDOWN_MS;
        log.error({ err }, 'Could not connect to broker for protective stops — positions rely on the software monitor alone');
      })
      .finally(() => { this.connecting = null; });

    await this.connecting;

    const ok = this.broker!.isConnected();
    if (!ok) this.nextConnectAttemptAt = Date.now() + RECONNECT_COOLDOWN_MS;
    return ok;
  }

  /**
   * A protective stop closes the position, so it trades the opposite side:
   * a LONG is protected by a SELL stop, a SHORT by a BUY stop.
   */
  private exitSide(side: StopSide): 'BUY' | 'SELL' {
    return side === 'LONG' ? 'SELL' : 'BUY';
  }

  /**
   * Ensure a stop matching `intent` is resting at the broker.
   *
   * Places one if absent, modifies it if the trigger or quantity has moved,
   * and does nothing if it already matches. Safe to call repeatedly — the
   * trailing-stop loop does exactly that.
   */
  async syncStop(intent: StopIntent): Promise<SyncResult> {
    if (!this.isEnabled()) return { action: 'skipped', reason: 'protective stops not enabled' };

    if (!(intent.triggerPrice > 0) || !(intent.qty > 0)) {
      return { action: 'skipped', reason: 'invalid trigger price or qty' };
    }

    if (!(await this.ensureConnected())) {
      return { action: 'skipped', reason: 'broker not connected' };
    }

    const position = await this.prisma.position.findUnique({
      where: { id: intent.positionId },
      select: {
        id: true, status: true,
        brokerStopOrderId: true, brokerStopTriggerPrice: true, brokerStopQty: true,
      },
    });

    if (!position || position.status !== 'OPEN') {
      return { action: 'skipped', reason: 'position not open' };
    }

    if (!position.brokerStopOrderId) {
      return this.placeStop(intent);
    }

    const currentTrigger = Number(position.brokerStopTriggerPrice ?? 0);
    const currentQty = Number(position.brokerStopQty ?? 0);
    const triggerMoved = currentTrigger > 0
      ? Math.abs(intent.triggerPrice - currentTrigger) / currentTrigger > MIN_TRIGGER_CHANGE_PCT
      : true;
    const qtyChanged = currentQty !== intent.qty;

    if (!triggerMoved && !qtyChanged) {
      return { action: 'unchanged', brokerOrderId: position.brokerStopOrderId };
    }

    return this.modifyStop(position.brokerStopOrderId, intent);
  }

  private async placeStop(intent: StopIntent): Promise<SyncResult> {
    try {
      const result = await this.broker!.placeOrder({
        symbol: intent.symbol,
        exchange: intent.exchange,
        side: this.exitSide(intent.side),
        orderType: 'SL_M',
        qty: intent.qty,
        triggerPrice: intent.triggerPrice,
        product: 'INTRADAY',
      } as any);

      if (result.status === 'FAILED' || !result.brokerOrderId) {
        log.error({ intent, message: result.message },
          'Failed to place protective stop at broker — position is protected only by the software monitor');
        return { action: 'failed', reason: result.message ?? 'broker rejected stop order' };
      }

      await this.prisma.position.update({
        where: { id: intent.positionId },
        data: {
          brokerStopOrderId: result.brokerOrderId,
          brokerStopTriggerPrice: intent.triggerPrice,
          brokerStopQty: intent.qty,
          brokerStopPlacedAt: new Date(),
        },
      });

      log.info({ positionId: intent.positionId, symbol: intent.symbol, trigger: intent.triggerPrice, brokerOrderId: result.brokerOrderId },
        'Protective stop resting at broker');
      return { action: 'placed', brokerOrderId: result.brokerOrderId };
    } catch (err) {
      log.error({ err, intent }, 'Error placing protective stop at broker');
      return { action: 'failed', reason: (err as Error).message };
    }
  }

  private async modifyStop(brokerOrderId: string, intent: StopIntent): Promise<SyncResult> {
    try {
      const result = await this.broker!.modifyOrder(brokerOrderId, {
        triggerPrice: intent.triggerPrice,
        qty: intent.qty,
      });

      if (result.status === 'FAILED') {
        // The resting order may have been filled or cancelled underneath us.
        // Clear our handle so the next sync re-places rather than repeatedly
        // trying to modify an order that no longer exists.
        log.warn({ brokerOrderId, intent, message: result.message },
          'Failed to modify protective stop — clearing handle so it is re-placed');
        await this.clearStopHandle(intent.positionId);
        return { action: 'failed', reason: result.message ?? 'broker rejected modify' };
      }

      await this.prisma.position.update({
        where: { id: intent.positionId },
        data: {
          brokerStopTriggerPrice: intent.triggerPrice,
          brokerStopQty: intent.qty,
        },
      });

      log.info({ positionId: intent.positionId, trigger: intent.triggerPrice, brokerOrderId },
        'Protective stop trigger updated at broker');
      return { action: 'modified', brokerOrderId };
    } catch (err) {
      log.error({ err, brokerOrderId, intent }, 'Error modifying protective stop');
      return { action: 'failed', reason: (err as Error).message };
    }
  }

  /**
   * Cancel the resting stop for a position. MUST be called on every close path
   * — an orphaned stop would later sell shares the account no longer holds.
   *
   * Returns true if there is no longer a stop resting for this position.
   */
  async cancelStop(positionId: string): Promise<boolean> {
    const position = await this.prisma.position.findUnique({
      where: { id: positionId },
      select: { brokerStopOrderId: true },
    });

    const brokerOrderId = position?.brokerStopOrderId;
    if (!brokerOrderId) return true;

    if (!this.isEnabled() || !(await this.ensureConnected())) {
      log.error({ positionId, brokerOrderId },
        'Cannot reach broker to cancel protective stop. A resting stop may be ORPHANED at the broker; cancel it manually.');
      return false;
    }

    try {
      const result = await this.broker!.cancelOrder(brokerOrderId);
      // A stop that already filled or was cancelled at the broker is equally
      // "not resting", so treat a failed cancel as resolved only after we have
      // confirmed its state.
      if (result.status === 'FAILED') {
        const status = await this.broker!.getOrderStatus(brokerOrderId).catch(() => null);
        const terminal = status && ['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED'].includes(status.status);
        if (!terminal) {
          log.error({ positionId, brokerOrderId, message: result.message },
            'Failed to cancel protective stop and it is not in a terminal state — ORPHAN RISK, cancel manually');
          return false;
        }
      }

      await this.clearStopHandle(positionId);
      log.info({ positionId, brokerOrderId }, 'Protective stop cancelled at broker');
      return true;
    } catch (err) {
      log.error({ err, positionId, brokerOrderId },
        'Error cancelling protective stop — ORPHAN RISK, verify at the broker');
      return false;
    }
  }

  private async clearStopHandle(positionId: string): Promise<void> {
    await this.prisma.position.update({
      where: { id: positionId },
      data: {
        brokerStopOrderId: null,
        brokerStopTriggerPrice: null,
        brokerStopQty: null,
        brokerStopPlacedAt: null,
      },
    }).catch(err => log.warn({ err, positionId }, 'Failed to clear broker stop handle'));
  }

  /**
   * Reconcile resting stops against the broker.
   *
   * Two directions, both of which cost money if missed:
   *  - a stop that FILLED means the broker already flattened the position and
   *    our DB still believes it is open;
   *  - a stop still resting for a position we have closed is an orphan that
   *    will sell shares the account no longer holds.
   */
  async reconcile(): Promise<{ fired: FiredStop[]; orphansCancelled: string[]; unresolved: string[] }> {
    const fired: FiredStop[] = [];
    const orphansCancelled: string[] = [];
    const unresolved: string[] = [];

    if (!this.isEnabled() || !(await this.ensureConnected())) {
      return { fired, orphansCancelled, unresolved };
    }

    const tracked = await this.prisma.position.findMany({
      where: { brokerStopOrderId: { not: null } },
      select: { id: true, status: true, symbol: true, qty: true, brokerStopOrderId: true },
    });

    for (const pos of tracked) {
      const brokerOrderId = pos.brokerStopOrderId!;

      if (pos.status !== 'OPEN') {
        const cleared = await this.cancelStop(pos.id);
        if (cleared) orphansCancelled.push(pos.id);
        else unresolved.push(pos.id);
        continue;
      }

      let status: { status: string; filledQty: number; avgPrice: number } | null = null;
      try {
        status = await this.broker!.getOrderStatus(brokerOrderId);
      } catch (err) {
        log.warn({ err, positionId: pos.id, brokerOrderId }, 'Could not read protective stop status');
        unresolved.push(pos.id);
        continue;
      }

      if (status.status === 'FILLED') {
        log.error({ positionId: pos.id, symbol: pos.symbol, brokerOrderId, avgPrice: status.avgPrice },
          'Protective stop FIRED at broker — position was flattened outside the app');
        // The stop is spent; drop the handle so nothing tries to cancel or
        // modify it later. The caller is responsible for recording the close.
        await this.clearStopHandle(pos.id);
        fired.push({
          positionId: pos.id,
          symbol: pos.symbol,
          brokerOrderId,
          fillPrice: Number(status.avgPrice ?? 0),
          filledQty: Number(status.filledQty ?? 0),
        });
        continue;
      }

      if (['CANCELLED', 'REJECTED', 'EXPIRED'].includes(status.status)) {
        // The position is open but unprotected at the broker. Clear the handle
        // so the next sync re-places it.
        log.error({ positionId: pos.id, symbol: pos.symbol, brokerOrderId, status: status.status },
          'Protective stop is no longer resting — position is UNPROTECTED at the broker; will re-place');
        await this.clearStopHandle(pos.id);
        unresolved.push(pos.id);
      }
    }

    return { fired, orphansCancelled, unresolved };
  }
}
