import { Queue, Worker, type Job } from 'bullmq';
import { getRedis } from './redis.js';
import { createChildLogger } from './logger.js';
import { EventEmitter } from 'events';

const log = createChildLogger('EventBus');

// ── Event Type Definitions ──

export type MarketDataEvent =
  | { type: 'TICK_RECEIVED'; symbol: string; ltp: number; change: number; volume: number; timestamp: string }
  | { type: 'CANDLE_CLOSED'; symbol: string; interval: string; open: number; high: number; low: number; close: number; volume: number }
  | { type: 'DATA_GAP_DETECTED'; symbol: string; interval: string; gapMinutes: number; lastTimestamp: string }
  | { type: 'DATA_QUALITY_REPORT'; symbol: string; interval: string; issues: string[]; barCount: number; lastTimestamp: string };

export type SignalEvent =
  | { type: 'SIGNAL_GENERATED'; userId: string; botId?: string; symbol: string; direction: string; confidence: number; entry: number; stopLoss: number; target: number; source: string }
  | { type: 'SIGNAL_VALIDATED'; userId: string; symbol: string; direction: string; approved: boolean; reason: string }
  | { type: 'SIGNAL_EXPIRED'; userId: string; symbol: string; signalId: string }
  | { type: 'PIPELINE_SIGNAL'; symbol: string; direction: 'BUY' | 'SELL'; confidence: number; strategy: string; mlScore: number; source: string };

export type ExecutionEvent =
  | { type: 'ORDER_PLACED'; userId: string; orderId: string; symbol: string; side: string; qty: number; orderType: string }
  | { type: 'ORDER_FILLED'; userId: string; orderId: string; symbol: string; fillPrice: number; qty: number; slippageBps: number }
  | { type: 'POSITION_OPENED'; userId: string; positionId: string; symbol: string; side: string; qty: number; entryPrice: number }
  | { type: 'POSITION_CLOSED'; userId: string; positionId: string; symbol: string; pnl: number; exitPrice: number; strategyTag?: string }
  | { type: 'ORDER_STATE_CHANGE'; orderId: string; symbol: string; fromState: string; toState: string; filledQty?: number; avgFillPrice?: number };

export type RiskEvent =
  | { type: 'RISK_CHECK_PASSED'; userId: string; symbol: string; checks: string[] }
  | { type: 'RISK_VIOLATION'; userId: string; symbol: string; violations: string[]; severity: 'warning' | 'critical' }
  | { type: 'CIRCUIT_BREAKER_TRIGGERED'; userId: string; reason: string; drawdownPct: number };

export type SystemEvent =
  | { type: 'MARKET_OPEN'; exchange: string; timestamp: string }
  | { type: 'MARKET_CLOSE'; exchange: string; timestamp: string }
  | { type: 'PHASE_CHANGE'; from: string; to: string; timestamp: string }
  | { type: 'KILL_SWITCH_ACTIVATED'; userId: string; timestamp: string }
  | { type: 'KILL_SWITCH_DEACTIVATED'; userId: string; timestamp: string }
  | { type: 'LEARNING_UPDATE'; userId: string; symbol: string; outcome: string; intradayWinRate: number; totalIntradayTrades: number };

export type AppEvent = MarketDataEvent | SignalEvent | ExecutionEvent | RiskEvent | SystemEvent;

// ── Queue Names ──

const QUEUES = {
  'market-data': 'cg-market-data',
  signals: 'cg-signals',
  execution: 'cg-execution',
  risk: 'cg-risk',
  system: 'cg-system',
} as const;

type QueueCategory = keyof typeof QUEUES;

// ── Event Bus Implementation ──

const queues = new Map<string, Queue>();
const workers = new Map<string, Worker>();

const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(50);

function getOrCreateQueue(category: QueueCategory): Queue | null {
  const name = QUEUES[category];
  if (queues.has(name)) return queues.get(name)!;

  const redis = getRedis();
  if (!redis) return null;

  const q = new Queue(name, {
    connection: redis.duplicate({ maxRetriesPerRequest: null }),
    defaultJobOptions: {
      removeOnComplete: { age: 1800, count: 500 },
      removeOnFail: { age: 7200, count: 200 },
      attempts: 2,
      backoff: { type: 'fixed', delay: 1000 },
    },
  });

  queues.set(name, q);
  return q;
}

export async function emit(category: QueueCategory, event: AppEvent): Promise<void> {
  localEmitter.emit(event.type, event);
  localEmitter.emit(`${category}:*`, event);

  const q = getOrCreateQueue(category);
  if (!q) return;

  try {
    await q.add(event.type, event, {
      priority: category === 'risk' ? 1 : category === 'execution' ? 2 : 5,
    });
  } catch (err) {
    log.warn({ err, event: event.type }, 'Failed to enqueue event, local-only delivery');
  }
}

export function on(eventType: string, handler: (event: AppEvent) => void): void {
  localEmitter.on(eventType, handler);
}

export function onCategory(category: QueueCategory, handler: (event: AppEvent) => void): void {
  localEmitter.on(`${category}:*`, handler);
}

export function off(eventType: string, handler: (event: AppEvent) => void): void {
  localEmitter.off(eventType, handler);
}

type EventHandler = (job: Job<AppEvent>) => Promise<void>;

export function registerWorker(
  category: QueueCategory,
  handler: EventHandler,
  opts?: { concurrency?: number },
): void {
  const redis = getRedis();
  if (!redis) {
    log.warn({ category }, 'Redis unavailable — worker not started, using local emitter only');
    return;
  }

  const name = QUEUES[category];
  if (workers.has(name)) return;

  const w = new Worker<AppEvent>(
    name,
    async (job) => { await handler(job); },
    {
      connection: redis.duplicate({ maxRetriesPerRequest: null }),
      concurrency: opts?.concurrency ?? 5,
    },
  );

  w.on('failed', (job, err) => {
    log.error({ jobName: job?.name, jobId: job?.id, err }, 'Event worker job failed');
  });

  workers.set(name, w);
  log.info({ category, queue: name }, 'Event worker started');
}

export async function shutdownEventBus(): Promise<void> {
  for (const [name, w] of workers) {
    await w.close();
    log.info({ queue: name }, 'Worker shut down');
  }
  workers.clear();

  for (const [name, q] of queues) {
    await q.close();
    log.info({ queue: name }, 'Queue closed');
  }
  queues.clear();
}
