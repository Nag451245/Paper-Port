import { Queue, Worker, type Job } from 'bullmq';
type JobProcessor = (job: Job) => Promise<void>;
export declare function getQueue(): Queue | null;
export declare function registerProcessor(jobType: string, processor: JobProcessor): void;
export declare function startWorker(): Worker | null;
export declare function addJob(name: string, data: Record<string, unknown>, opts?: {
    delay?: number;
    priority?: number;
    repeat?: {
        every: number;
    };
}): Promise<string | null>;
export declare function addRepeatingJob(name: string, data: Record<string, unknown>, intervalMs: number): Promise<void>;
export declare function removeRepeatingJob(name: string): Promise<void>;
export declare function shutdownQueue(): Promise<void>;
export {};
//# sourceMappingURL=job-queue.d.ts.map