import { Queue, Worker } from 'bullmq';
import { getRedis } from './redis.js';
import { createChildLogger } from './logger.js';
import { EventEmitter } from 'events';
const log = createChildLogger('EventBus');
// ── Queue Names ──
const QUEUES = {
    'market-data': 'cg-market-data',
    signals: 'cg-signals',
    execution: 'cg-execution',
    risk: 'cg-risk',
    system: 'cg-system',
};
// ── Event Bus Implementation ──
const queues = new Map();
const workers = new Map();
const localEmitter = new EventEmitter();
localEmitter.setMaxListeners(50);
function getOrCreateQueue(category) {
    const name = QUEUES[category];
    if (queues.has(name))
        return queues.get(name);
    const redis = getRedis();
    if (!redis)
        return null;
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
export async function emit(category, event) {
    localEmitter.emit(event.type, event);
    localEmitter.emit(`${category}:*`, event);
    const q = getOrCreateQueue(category);
    if (!q)
        return;
    try {
        await q.add(event.type, event, {
            priority: category === 'risk' ? 1 : category === 'execution' ? 2 : 5,
        });
    }
    catch (err) {
        log.warn({ err, event: event.type }, 'Failed to enqueue event, local-only delivery');
    }
}
export function on(eventType, handler) {
    localEmitter.on(eventType, handler);
}
export function onCategory(category, handler) {
    localEmitter.on(`${category}:*`, handler);
}
export function off(eventType, handler) {
    localEmitter.off(eventType, handler);
}
export function registerWorker(category, handler, opts) {
    const redis = getRedis();
    if (!redis) {
        log.warn({ category }, 'Redis unavailable — worker not started, using local emitter only');
        return;
    }
    const name = QUEUES[category];
    if (workers.has(name))
        return;
    const w = new Worker(name, async (job) => { await handler(job); }, {
        connection: redis.duplicate({ maxRetriesPerRequest: null }),
        concurrency: opts?.concurrency ?? 5,
    });
    w.on('failed', (job, err) => {
        log.error({ jobName: job?.name, jobId: job?.id, err }, 'Event worker job failed');
    });
    workers.set(name, w);
    log.info({ category, queue: name }, 'Event worker started');
}
export async function shutdownEventBus() {
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
//# sourceMappingURL=event-bus.js.map