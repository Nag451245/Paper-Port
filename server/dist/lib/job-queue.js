import { Queue, Worker } from 'bullmq';
import { getRedis } from './redis.js';
const QUEUE_NAME = 'capital-guard';
let queue = null;
let worker = null;
const processors = new Map();
export function getQueue() {
    if (queue)
        return queue;
    const redis = getRedis();
    if (!redis)
        return null;
    queue = new Queue(QUEUE_NAME, {
        connection: redis.duplicate(),
        defaultJobOptions: {
            removeOnComplete: { age: 3600, count: 100 },
            removeOnFail: { age: 86400, count: 200 },
            attempts: 3,
            backoff: { type: 'exponential', delay: 5000 },
        },
    });
    return queue;
}
export function registerProcessor(jobType, processor) {
    processors.set(jobType, processor);
}
export function startWorker() {
    if (worker)
        return worker;
    const redis = getRedis();
    if (!redis)
        return null;
    worker = new Worker(QUEUE_NAME, async (job) => {
        const processor = processors.get(job.name);
        if (processor) {
            await processor(job);
        }
    }, {
        connection: redis.duplicate(),
        concurrency: 3,
        limiter: { max: 10, duration: 60_000 },
    });
    worker.on('failed', (job, err) => {
        console.error(`[JOB FAILED] ${job?.name}:${job?.id} — ${err.message}`);
    });
    return worker;
}
export async function addJob(name, data, opts) {
    const q = getQueue();
    if (!q)
        return null;
    const job = await q.add(name, data, {
        delay: opts?.delay,
        priority: opts?.priority,
        repeat: opts?.repeat,
    });
    return job.id ?? null;
}
export async function addRepeatingJob(name, data, intervalMs) {
    const q = getQueue();
    if (!q)
        return;
    await q.upsertJobScheduler(`${name}-scheduler`, { every: intervalMs }, { name, data });
}
export async function removeRepeatingJob(name) {
    const q = getQueue();
    if (!q)
        return;
    try {
        await q.removeJobScheduler(`${name}-scheduler`);
    }
    catch { /* scheduler may not exist */ }
}
export async function shutdownQueue() {
    if (worker) {
        await worker.close();
        worker = null;
    }
    if (queue) {
        await queue.close();
        queue = null;
    }
}
//# sourceMappingURL=job-queue.js.map