import { getBrokerAdapter } from '../lib/broker-adapter.js';
import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
const log = createChildLogger('FillReconciliation');
const RECONCILE_INTERVAL_MS = 30_000;
const TERMINAL_STATES = new Set(['FILLED', 'CANCELLED', 'REJECTED', 'EXPIRED']);
export class FillReconciliationService {
    prisma;
    oms;
    handle = null;
    broker = null;
    constructor(prisma, oms) {
        this.prisma = prisma;
        this.oms = oms;
        const mode = (process.env.TRADING_MODE ?? 'PAPER').toUpperCase();
        if (mode === 'LIVE') {
            this.broker = getBrokerAdapter('breeze');
        }
    }
    start() {
        if (this.handle)
            return;
        log.info('Starting async fill reconciliation loop');
        this.handle = setInterval(async () => {
            try {
                await this.reconcilePendingOrders();
            }
            catch (err) {
                log.error({ err }, 'Fill reconciliation cycle failed');
            }
        }, RECONCILE_INTERVAL_MS);
        this.reconcilePendingOrders().catch(err => log.error({ err }, 'Initial fill reconciliation failed'));
    }
    stop() {
        if (this.handle) {
            clearInterval(this.handle);
            this.handle = null;
            log.info('Fill reconciliation stopped');
        }
    }
    async reconcilePendingOrders() {
        if (!this.broker)
            return { checked: 0, updated: 0, errors: 0 };
        const pendingOrders = await this.prisma.order.findMany({
            where: {
                status: { in: ['SUBMITTED', 'PARTIALLY_FILLED', 'PENDING'] },
                brokerOrderId: { not: null },
            },
            select: {
                id: true,
                brokerOrderId: true,
                symbol: true,
                status: true,
                qty: true,
                filledQty: true,
            },
        });
        let checked = 0;
        let updated = 0;
        let errors = 0;
        for (const order of pendingOrders) {
            const brokerId = order.brokerOrderId;
            if (!brokerId)
                continue;
            checked++;
            try {
                const brokerStatus = await this.broker.getOrderStatus(brokerId);
                const normalizedStatus = this.normalizeBrokerStatus(brokerStatus.status);
                if (normalizedStatus === order.status) {
                    if (brokerStatus.filledQty > (order.filledQty ?? 0) && brokerStatus.avgPrice > 0) {
                        await this.oms.recordFill(order.id, brokerStatus.filledQty, brokerStatus.avgPrice);
                        updated++;
                        log.info({
                            orderId: order.id, symbol: order.symbol,
                            filledQty: brokerStatus.filledQty, avgPrice: brokerStatus.avgPrice,
                        }, 'Reconciliation: updated fill from broker');
                    }
                    continue;
                }
                if (normalizedStatus === 'FILLED' && brokerStatus.avgPrice > 0) {
                    await this.oms.recordFill(order.id, brokerStatus.filledQty || order.qty, brokerStatus.avgPrice);
                    updated++;
                    log.info({
                        orderId: order.id, symbol: order.symbol,
                        filledQty: brokerStatus.filledQty, avgPrice: brokerStatus.avgPrice,
                    }, 'Reconciliation: order filled at broker');
                }
                else if (normalizedStatus === 'CANCELLED') {
                    await this.oms.transition(order.id, 'CANCELLED', { reason: 'Cancelled at broker (reconciliation)' });
                    updated++;
                    log.info({ orderId: order.id, symbol: order.symbol }, 'Reconciliation: order cancelled at broker');
                }
                else if (normalizedStatus === 'REJECTED') {
                    await this.oms.transition(order.id, 'REJECTED', { reason: brokerStatus.message ?? 'Rejected at broker (reconciliation)' });
                    updated++;
                    log.info({ orderId: order.id, symbol: order.symbol }, 'Reconciliation: order rejected at broker');
                }
                else if (normalizedStatus === 'PARTIALLY_FILLED' && brokerStatus.filledQty > (order.filledQty ?? 0)) {
                    await this.oms.recordFill(order.id, brokerStatus.filledQty, brokerStatus.avgPrice);
                    updated++;
                    log.info({
                        orderId: order.id, symbol: order.symbol,
                        filledQty: brokerStatus.filledQty, avgPrice: brokerStatus.avgPrice,
                    }, 'Reconciliation: partial fill updated');
                }
            }
            catch (err) {
                errors++;
                log.error({ orderId: order.id, symbol: order.symbol, err }, 'Failed to reconcile order');
            }
        }
        if (updated > 0 || errors > 0) {
            log.info({ checked, updated, errors }, 'Fill reconciliation cycle complete');
        }
        return { checked, updated, errors };
    }
    /**
     * Startup reconciliation: compare broker positions vs DB positions
     * to detect orphaned positions from crashes.
     */
    async startupReconciliation() {
        if (!this.broker) {
            log.info('Startup reconciliation skipped (paper mode)');
            return { orphanedBrokerPositions: 0, missingBrokerPositions: 0, qtyMismatches: 0 };
        }
        log.info('Starting startup reconciliation: broker vs DB positions');
        let orphanedBrokerPositions = 0;
        let missingBrokerPositions = 0;
        let qtyMismatches = 0;
        try {
            const brokerPositions = await this.broker.getPositions();
            const dbPositions = await this.prisma.position.findMany({
                where: { status: 'OPEN' },
                select: { id: true, symbol: true, qty: true, side: true, portfolioId: true },
            });
            const dbBySymbol = new Map();
            for (const pos of dbPositions) {
                dbBySymbol.set(pos.symbol.toUpperCase(), pos);
            }
            for (const bp of brokerPositions) {
                if (bp.qty === 0)
                    continue;
                const sym = bp.symbol.toUpperCase();
                const dbPos = dbBySymbol.get(sym);
                if (!dbPos) {
                    orphanedBrokerPositions++;
                    log.error({
                        symbol: bp.symbol, qty: bp.qty, avgPrice: bp.avgPrice,
                    }, 'CRITICAL: Broker has position NOT in DB — possible crash during order');
                    emit('risk', {
                        type: 'RISK_VIOLATION',
                        userId: 'SYSTEM',
                        symbol: bp.symbol,
                        violations: [`Orphaned broker position: ${bp.symbol} qty=${bp.qty} avg=${bp.avgPrice} — not in DB`],
                        severity: 'critical',
                    }).catch(() => { });
                }
                else {
                    const dbQty = Math.abs(dbPos.qty);
                    const brokerQty = Math.abs(bp.qty);
                    if (dbQty !== brokerQty) {
                        qtyMismatches++;
                        log.warn({
                            symbol: bp.symbol, dbQty, brokerQty,
                            positionId: dbPos.id,
                        }, 'Position quantity mismatch between broker and DB');
                    }
                    dbBySymbol.delete(sym);
                }
            }
            for (const [sym, dbPos] of dbBySymbol) {
                missingBrokerPositions++;
                log.warn({
                    symbol: sym, dbQty: dbPos.qty, positionId: dbPos.id,
                }, 'DB has open position but broker does not — position may have been closed externally');
            }
            log.info({
                orphanedBrokerPositions, missingBrokerPositions, qtyMismatches,
                brokerCount: brokerPositions.filter(p => p.qty !== 0).length,
                dbCount: dbPositions.length,
            }, 'Startup reconciliation complete');
            if (orphanedBrokerPositions > 0) {
                emit('risk', {
                    type: 'RISK_VIOLATION',
                    userId: 'SYSTEM',
                    symbol: 'ALL',
                    violations: [`${orphanedBrokerPositions} orphaned broker position(s) detected — manual intervention required`],
                    severity: 'critical',
                }).catch(() => { });
            }
        }
        catch (err) {
            log.error({ err }, 'Startup reconciliation failed');
        }
        return { orphanedBrokerPositions, missingBrokerPositions, qtyMismatches };
    }
    normalizeBrokerStatus(status) {
        const s = (status ?? '').toUpperCase().trim();
        if (s === 'COMPLETE' || s === 'EXECUTED' || s === 'TRADED')
            return 'FILLED';
        if (s === 'REJECTED' || s === 'FAILED')
            return 'REJECTED';
        if (s === 'CANCELLED')
            return 'CANCELLED';
        if (s === 'EXPIRED')
            return 'EXPIRED';
        if (s.includes('PARTIAL'))
            return 'PARTIALLY_FILLED';
        if (s === 'OPEN' || s === 'PENDING' || s === 'ORDERED' || s === 'AFTER MARKET ORDER REQ RECEIVED')
            return 'SUBMITTED';
        return 'SUBMITTED';
    }
}
//# sourceMappingURL=fill-reconciliation.service.js.map