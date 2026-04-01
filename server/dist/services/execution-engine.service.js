import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
const log = createChildLogger('ExecutionEngine');
const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const LATENCY_WINDOW = 1000;
const BREEZE_URL = 'http://localhost:5001/order';
export var OrderPriority;
(function (OrderPriority) {
    OrderPriority[OrderPriority["MARKET"] = 1] = "MARKET";
    OrderPriority[OrderPriority["LIMIT"] = 2] = "LIMIT";
    OrderPriority[OrderPriority["GTC"] = 3] = "GTC";
})(OrderPriority || (OrderPriority = {}));
export class ExecutionEngineService {
    queue = [];
    latencyWindow = [];
    processing = false;
    fillSimulator;
    marketStateProvider;
    constructor(fillSimulator, marketStateProvider) {
        this.fillSimulator = fillSimulator;
        this.marketStateProvider = marketStateProvider;
    }
    async submit(order) {
        const validationError = this.validate(order);
        if (validationError) {
            log.warn({ orderId: order.orderId, error: validationError }, 'Order validation failed');
            await emit('execution', {
                type: 'ORDER_PLACED',
                userId: order.userId,
                orderId: order.orderId,
                symbol: order.symbol,
                side: order.side,
                qty: order.qty,
                orderType: order.orderType,
            }).catch(() => { });
            const result = {
                orderId: order.orderId,
                status: 'REJECTED',
                fillPrice: 0,
                fillQty: 0,
                latency: { submitToAckMs: 0, ackToFillMs: 0, totalMs: 0 },
                exchange: order.exchange,
                rejectionReason: validationError,
            };
            await emit('execution', {
                type: 'ORDER_FILLED',
                userId: order.userId,
                orderId: order.orderId,
                symbol: order.symbol,
                fillPrice: 0,
                qty: 0,
                slippageBps: 0,
            }).catch(() => { });
            return result;
        }
        const entry = {
            order,
            enqueuedAt: Date.now(),
            cancelled: false,
        };
        this.enqueue(entry);
        await emit('execution', {
            type: 'ORDER_PLACED',
            userId: order.userId,
            orderId: order.orderId,
            symbol: order.symbol,
            side: order.side,
            qty: order.qty,
            orderType: order.orderType,
        }).catch(err => log.error({ err, orderId: order.orderId }, 'Failed to emit order:submitted'));
        return this.processOrder(entry);
    }
    getQueueDepth() {
        return this.queue.filter(e => !e.cancelled).length;
    }
    getLatencyStats() {
        const samples = [...this.latencyWindow];
        const count = samples.length;
        if (count === 0) {
            return { avgMs: 0, p50Ms: 0, p95Ms: 0, p99Ms: 0, count: 0 };
        }
        samples.sort((a, b) => a - b);
        const avgMs = Math.round(samples.reduce((a, b) => a + b, 0) / count);
        const p50Ms = samples[Math.floor(count * 0.50)];
        const p95Ms = samples[Math.floor(count * 0.95)];
        const p99Ms = samples[Math.floor(count * 0.99)];
        return { avgMs, p50Ms, p95Ms, p99Ms, count };
    }
    cancelOrder(orderId) {
        const entry = this.queue.find(e => e.order.orderId === orderId && !e.cancelled);
        if (!entry)
            return false;
        entry.cancelled = true;
        log.info({ orderId }, 'Order cancelled from execution queue');
        return true;
    }
    enqueue(entry) {
        let inserted = false;
        for (let i = 0; i < this.queue.length; i++) {
            const existing = this.queue[i];
            if (entry.order.priority < existing.order.priority ||
                (entry.order.priority === existing.order.priority &&
                    entry.order.submittedAt < existing.order.submittedAt)) {
                this.queue.splice(i, 0, entry);
                inserted = true;
                break;
            }
        }
        if (!inserted) {
            this.queue.push(entry);
        }
    }
    async processOrder(entry) {
        const { order } = entry;
        const retryCount = order.retryCount ?? 0;
        for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
            if (entry.cancelled) {
                return {
                    orderId: order.orderId,
                    status: 'REJECTED',
                    fillPrice: 0,
                    fillQty: 0,
                    latency: { submitToAckMs: 0, ackToFillMs: 0, totalMs: 0 },
                    exchange: order.exchange,
                    rejectionReason: 'Order cancelled',
                };
            }
            const submitTime = Date.now();
            try {
                const result = order.mode === 'PAPER'
                    ? await this.executePaper(order, submitTime)
                    : await this.executeLive(order, submitTime);
                this.removeFromQueue(order.orderId);
                this.recordLatency(result.latency.totalMs);
                const eventType = result.status === 'REJECTED' ? 'ORDER_FILLED' : 'ORDER_FILLED';
                await emit('execution', {
                    type: eventType,
                    userId: order.userId,
                    orderId: order.orderId,
                    symbol: order.symbol,
                    fillPrice: result.fillPrice,
                    qty: result.fillQty,
                    slippageBps: 0,
                }).catch(err => log.error({ err, orderId: order.orderId }, 'Failed to emit fill event'));
                return result;
            }
            catch (err) {
                const isLastAttempt = attempt >= MAX_RETRIES;
                log.warn({ orderId: order.orderId, attempt: attempt + 1 + retryCount, err }, isLastAttempt ? 'Order failed after all retries' : 'Order attempt failed — retrying');
                if (isLastAttempt) {
                    this.removeFromQueue(order.orderId);
                    const totalMs = Date.now() - submitTime;
                    const result = {
                        orderId: order.orderId,
                        status: 'TIMEOUT',
                        fillPrice: 0,
                        fillQty: 0,
                        latency: { submitToAckMs: totalMs, ackToFillMs: 0, totalMs },
                        exchange: order.exchange,
                        rejectionReason: `Failed after ${MAX_RETRIES + 1} attempts: ${err instanceof Error ? err.message : String(err)}`,
                    };
                    await emit('execution', {
                        type: 'ORDER_FILLED',
                        userId: order.userId,
                        orderId: order.orderId,
                        symbol: order.symbol,
                        fillPrice: 0,
                        qty: 0,
                        slippageBps: 0,
                    }).catch(() => { });
                    return result;
                }
                const backoffMs = BACKOFF_BASE_MS * Math.pow(2, attempt);
                await this.sleep(backoffMs);
            }
        }
        return {
            orderId: order.orderId,
            status: 'TIMEOUT',
            fillPrice: 0,
            fillQty: 0,
            latency: { submitToAckMs: 0, ackToFillMs: 0, totalMs: 0 },
            exchange: order.exchange,
            rejectionReason: 'Unexpected: fell through retry loop',
        };
    }
    async executePaper(order, submitTime) {
        const marketState = this.marketStateProvider?.(order.symbol) ?? {
            ltp: order.price ?? 100,
            bid: undefined,
            ask: undefined,
            avgDailyVolume: 1_000_000,
        };
        const ackTime = Date.now();
        const fillResult = this.fillSimulator.simulate({
            symbol: order.symbol,
            exchange: order.exchange,
            side: order.side,
            orderType: order.orderType,
            qty: order.qty,
            price: order.price,
            triggerPrice: order.triggerPrice,
        }, marketState);
        await this.sleep(fillResult.latencyMs);
        const fillTime = Date.now();
        if (fillResult.fillQty === 0) {
            return {
                orderId: order.orderId,
                status: 'REJECTED',
                fillPrice: 0,
                fillQty: 0,
                latency: {
                    submitToAckMs: ackTime - submitTime,
                    ackToFillMs: fillTime - ackTime,
                    totalMs: fillTime - submitTime,
                },
                exchange: order.exchange,
                rejectionReason: 'Limit price does not cross current market',
            };
        }
        const status = fillResult.partial ? 'PARTIALLY_FILLED' : 'FILLED';
        return {
            orderId: order.orderId,
            status,
            fillPrice: fillResult.fillPrice,
            fillQty: fillResult.fillQty,
            latency: {
                submitToAckMs: ackTime - submitTime,
                ackToFillMs: fillTime - ackTime,
                totalMs: fillTime - submitTime,
            },
            exchange: order.exchange,
        };
    }
    async executeLive(order, submitTime) {
        const body = {
            stock_code: order.symbol,
            exchange: order.exchange,
            action: order.side === 'BUY' ? 'buy' : 'sell',
            quantity: order.qty,
            order_type: order.orderType.toLowerCase(),
            price: order.price ?? 0,
            validity: 'day',
        };
        const ackTime = Date.now();
        const response = await fetch(BREEZE_URL, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
            signal: AbortSignal.timeout(30_000),
        });
        if (!response.ok) {
            const errorText = await response.text().catch(() => 'Unknown error');
            throw new Error(`Breeze API responded with ${response.status}: ${errorText}`);
        }
        const data = await response.json();
        const fillTime = Date.now();
        if (data.status === 'rejected' || data.rejection_reason) {
            return {
                orderId: order.orderId,
                status: 'REJECTED',
                fillPrice: 0,
                fillQty: 0,
                latency: {
                    submitToAckMs: ackTime - submitTime,
                    ackToFillMs: fillTime - ackTime,
                    totalMs: fillTime - submitTime,
                },
                exchange: order.exchange,
                brokerOrderId: data.order_id,
                rejectionReason: data.rejection_reason ?? 'Rejected by broker',
            };
        }
        const fillPrice = data.fill_price ?? order.price ?? 0;
        const fillQty = data.fill_qty ?? order.qty;
        const status = fillQty < order.qty ? 'PARTIALLY_FILLED' : 'FILLED';
        return {
            orderId: order.orderId,
            status,
            fillPrice,
            fillQty,
            latency: {
                submitToAckMs: ackTime - submitTime,
                ackToFillMs: fillTime - ackTime,
                totalMs: fillTime - submitTime,
            },
            exchange: order.exchange,
            brokerOrderId: data.order_id,
        };
    }
    validate(order) {
        if (!order.orderId)
            return 'orderId is required';
        if (!order.symbol)
            return 'symbol is required';
        if (!order.exchange)
            return 'exchange is required';
        if (order.qty <= 0)
            return 'qty must be > 0';
        if (!order.userId)
            return 'userId is required';
        if (!order.portfolioId)
            return 'portfolioId is required';
        if (order.orderType === 'LIMIT' && (!order.price || order.price <= 0)) {
            return 'price must be > 0 for LIMIT orders';
        }
        if (order.orderType === 'SL' && (!order.triggerPrice || order.triggerPrice <= 0)) {
            return 'triggerPrice must be > 0 for SL orders';
        }
        if (order.orderType === 'SL' && (!order.price || order.price <= 0)) {
            return 'price must be > 0 for SL orders';
        }
        if (order.orderType === 'SL-M' && (!order.triggerPrice || order.triggerPrice <= 0)) {
            return 'triggerPrice must be > 0 for SL-M orders';
        }
        return null;
    }
    removeFromQueue(orderId) {
        const idx = this.queue.findIndex(e => e.order.orderId === orderId);
        if (idx !== -1) {
            this.queue.splice(idx, 1);
        }
    }
    recordLatency(ms) {
        this.latencyWindow.push(ms);
        if (this.latencyWindow.length > LATENCY_WINDOW) {
            this.latencyWindow = this.latencyWindow.slice(-LATENCY_WINDOW);
        }
    }
    sleep(ms) {
        return new Promise(resolve => setTimeout(resolve, ms));
    }
}
//# sourceMappingURL=execution-engine.service.js.map