import { wsHub } from '../lib/websocket.js';
import { getRedis } from '../lib/redis.js';
import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('ExitCoordinator');
const LOCK_TTL_MS = 15_000;
const LOCK_PREFIX = 'cg:exit_lock:';
const activeExits = new Set();
/**
 * Acquires a Redis-based distributed lock for a position.
 * Falls back to in-memory Set if Redis is unavailable.
 * Returns a unique lock value for release, or null if lock was not acquired.
 */
async function acquireDistributedLock(positionId) {
    const redis = getRedis();
    const lockValue = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    if (redis) {
        try {
            const result = await redis.set(LOCK_PREFIX + positionId, lockValue, 'PX', LOCK_TTL_MS, 'NX');
            if (result === 'OK')
                return lockValue;
            return null;
        }
        catch (err) {
            log.warn({ err, positionId }, 'Redis lock failed, falling back to in-memory');
        }
    }
    // Fallback: in-memory (single-process safety only)
    if (activeExits.has(positionId))
        return null;
    activeExits.add(positionId);
    return lockValue;
}
/**
 * Releases the distributed lock, only if we still own it (prevents releasing
 * a lock that expired and was re-acquired by another process).
 */
async function releaseDistributedLock(positionId, lockValue) {
    const redis = getRedis();
    if (redis) {
        try {
            // Atomic check-and-delete via Lua script
            const script = `
        if redis.call("get", KEYS[1]) == ARGV[1] then
          return redis.call("del", KEYS[1])
        else
          return 0
        end
      `;
            await redis.eval(script, 1, LOCK_PREFIX + positionId, lockValue);
        }
        catch (err) {
            log.warn({ err, positionId }, 'Redis unlock failed');
        }
    }
    activeExits.delete(positionId);
}
export class ExitCoordinator {
    static async closePosition(req) {
        const lockValue = await acquireDistributedLock(req.positionId);
        if (!lockValue) {
            log.warn({ positionId: req.positionId, source: req.source }, 'Duplicate close attempt blocked by distributed lock');
            return { success: false, alreadyClosing: true, error: 'Position exit already in progress' };
        }
        try {
            // Verify position is still open (inside the lock)
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
                    direction: pos.side,
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
            }
            catch { /* audit is best-effort */ }
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
            }
            catch { /* best-effort */ }
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
        }
        catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            log.error({ err, positionId: req.positionId, source: req.source }, 'Exit failed');
            return { success: false, error: msg };
        }
        finally {
            await releaseDistributedLock(req.positionId, lockValue);
        }
    }
    static isExiting(positionId) {
        return activeExits.has(positionId);
    }
}
//# sourceMappingURL=exit-coordinator.service.js.map