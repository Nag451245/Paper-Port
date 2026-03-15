import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
import { FillSimulatorService } from './fill-simulator.service.js';
import type { MarketState } from './fill-simulator.service.js';

const log = createChildLogger('ExecutionEngine');

const MAX_RETRIES = 3;
const BACKOFF_BASE_MS = 1000;
const LATENCY_WINDOW = 1000;
const BREEZE_URL = 'http://localhost:5001/order';

export enum OrderPriority {
  MARKET = 1,
  LIMIT = 2,
  GTC = 3,
}

export interface ExecutionOrder {
  orderId: string;
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  qty: number;
  price?: number;
  triggerPrice?: number;
  portfolioId: string;
  userId: string;
  strategyTag?: string;
  priority: OrderPriority;
  mode: 'PAPER' | 'LIVE';
  submittedAt: Date;
  retryCount?: number;
}

export type ExecutionStatus = 'FILLED' | 'PARTIALLY_FILLED' | 'REJECTED' | 'TIMEOUT';

export interface ExecutionResult {
  orderId: string;
  status: ExecutionStatus;
  fillPrice: number;
  fillQty: number;
  latency: {
    submitToAckMs: number;
    ackToFillMs: number;
    totalMs: number;
  };
  exchange: string;
  brokerOrderId?: string;
  rejectionReason?: string;
}

interface QueueEntry {
  order: ExecutionOrder;
  enqueuedAt: number;
  cancelled: boolean;
}

export class ExecutionEngineService {
  private queue: QueueEntry[] = [];
  private latencyWindow: number[] = [];
  private processing = false;
  private fillSimulator: FillSimulatorService;
  private marketStateProvider?: (symbol: string) => MarketState | undefined;

  constructor(
    fillSimulator: FillSimulatorService,
    marketStateProvider?: (symbol: string) => MarketState | undefined,
  ) {
    this.fillSimulator = fillSimulator;
    this.marketStateProvider = marketStateProvider;
  }

  async submit(order: ExecutionOrder): Promise<ExecutionResult> {
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
      }).catch(() => {});

      const result: ExecutionResult = {
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
      }).catch(() => {});

      return result;
    }

    const entry: QueueEntry = {
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

  getQueueDepth(): number {
    return this.queue.filter(e => !e.cancelled).length;
  }

  getLatencyStats(): {
    avgMs: number;
    p50Ms: number;
    p95Ms: number;
    p99Ms: number;
    count: number;
  } {
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

  cancelOrder(orderId: string): boolean {
    const entry = this.queue.find(e => e.order.orderId === orderId && !e.cancelled);
    if (!entry) return false;

    entry.cancelled = true;
    log.info({ orderId }, 'Order cancelled from execution queue');
    return true;
  }

  private enqueue(entry: QueueEntry): void {
    let inserted = false;
    for (let i = 0; i < this.queue.length; i++) {
      const existing = this.queue[i];
      if (
        entry.order.priority < existing.order.priority ||
        (entry.order.priority === existing.order.priority &&
          entry.order.submittedAt < existing.order.submittedAt)
      ) {
        this.queue.splice(i, 0, entry);
        inserted = true;
        break;
      }
    }
    if (!inserted) {
      this.queue.push(entry);
    }
  }

  private async processOrder(entry: QueueEntry): Promise<ExecutionResult> {
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
      } catch (err) {
        const isLastAttempt = attempt >= MAX_RETRIES;
        log.warn(
          { orderId: order.orderId, attempt: attempt + 1 + retryCount, err },
          isLastAttempt ? 'Order failed after all retries' : 'Order attempt failed — retrying',
        );

        if (isLastAttempt) {
          this.removeFromQueue(order.orderId);
          const totalMs = Date.now() - submitTime;

          const result: ExecutionResult = {
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
          }).catch(() => {});

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

  private async executePaper(
    order: ExecutionOrder,
    submitTime: number,
  ): Promise<ExecutionResult> {
    const marketState = this.marketStateProvider?.(order.symbol) ?? {
      ltp: order.price ?? 100,
      bid: undefined,
      ask: undefined,
      avgDailyVolume: 1_000_000,
    };

    const ackTime = Date.now();
    const fillResult = this.fillSimulator.simulate(
      {
        symbol: order.symbol,
        exchange: order.exchange,
        side: order.side,
        orderType: order.orderType,
        qty: order.qty,
        price: order.price,
        triggerPrice: order.triggerPrice,
      },
      marketState,
    );

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

    const status: ExecutionStatus = fillResult.partial ? 'PARTIALLY_FILLED' : 'FILLED';

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

  private async executeLive(
    order: ExecutionOrder,
    submitTime: number,
  ): Promise<ExecutionResult> {
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

    const data = await response.json() as {
      order_id?: string;
      status?: string;
      fill_price?: number;
      fill_qty?: number;
      rejection_reason?: string;
    };

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
    const status: ExecutionStatus = fillQty < order.qty ? 'PARTIALLY_FILLED' : 'FILLED';

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

  private validate(order: ExecutionOrder): string | null {
    if (!order.orderId) return 'orderId is required';
    if (!order.symbol) return 'symbol is required';
    if (!order.exchange) return 'exchange is required';
    if (order.qty <= 0) return 'qty must be > 0';
    if (!order.userId) return 'userId is required';
    if (!order.portfolioId) return 'portfolioId is required';

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

  private removeFromQueue(orderId: string): void {
    const idx = this.queue.findIndex(e => e.order.orderId === orderId);
    if (idx !== -1) {
      this.queue.splice(idx, 1);
    }
  }

  private recordLatency(ms: number): void {
    this.latencyWindow.push(ms);
    if (this.latencyWindow.length > LATENCY_WINDOW) {
      this.latencyWindow = this.latencyWindow.slice(-LATENCY_WINDOW);
    }
  }

  private sleep(ms: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, ms));
  }
}
