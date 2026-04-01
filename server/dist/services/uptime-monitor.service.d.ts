/**
 * Uptime Monitor — Tracks system health for 99.9% uptime target.
 *
 * Monitors:
 *   - Heartbeat (is the server responsive?)
 *   - Service availability (Rust engine, Python ML, Redis, DB, Breeze)
 *   - Error rates (per-minute error counts)
 *   - Latency (response times)
 *   - Market hours uptime vs total uptime
 */
interface HealthSnapshot {
    timestamp: number;
    services: {
        server: boolean;
        rustEngine: boolean;
        pythonML: boolean;
        redis: boolean;
        database: boolean;
        breeze: boolean;
    };
    errorCount: number;
    avgLatencyMs: number;
}
export declare class UptimeMonitorService {
    private history;
    private intervalHandle;
    private errorCounter;
    private latencyBuckets;
    private startTime;
    private dbCheckFn;
    constructor(dbCheck?: () => Promise<boolean>);
    start(): void;
    stop(): void;
    recordError(): void;
    recordLatency(ms: number): void;
    private recordHeartbeat;
    private checkRedis;
    private checkDatabase;
    private checkBreeze;
    getStatus(): {
        uptimeMs: number;
        uptimePct: number;
        marketHoursUptimePct: number;
        currentHealth: HealthSnapshot | null;
        recentErrors: number;
        avgLatencyMs: number;
        servicesUp: number;
        servicesTotal: number;
        target: string;
        onTrack: boolean;
    };
    getHistory(hours?: number): HealthSnapshot[];
}
export {};
//# sourceMappingURL=uptime-monitor.service.d.ts.map