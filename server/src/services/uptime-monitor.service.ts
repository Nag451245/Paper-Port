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

import { getRedis } from '../lib/redis.js';
import { isEngineAvailable } from '../lib/rust-engine.js';
import { isMLServiceAvailable } from '../lib/ml-service-client.js';
import { createChildLogger } from '../lib/logger.js';
import { env } from '../config.js';

const log = createChildLogger('UptimeMonitor');

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

const HEARTBEAT_INTERVAL_MS = 60_000; // 1 minute
const HISTORY_MAX = 1440; // 24 hours at 1-min resolution
const BREEZE_BRIDGE_URL = env.BREEZE_BRIDGE_URL;

export class UptimeMonitorService {
  private history: HealthSnapshot[] = [];
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private errorCounter = 0;
  private latencyBuckets: number[] = [];
  private startTime = Date.now();
  private dbCheckFn: (() => Promise<boolean>) | null = null;

  constructor(dbCheck?: () => Promise<boolean>) {
    this.dbCheckFn = dbCheck ?? null;
  }

  start(): void {
    if (this.intervalHandle) return;

    // Record server start time for uptime calculation
    process.env.SERVER_START_TIME = String(this.startTime);

    this.intervalHandle = setInterval(() => {
      this.recordHeartbeat().catch(err =>
        log.error({ err }, 'Heartbeat recording failed')
      );
    }, HEARTBEAT_INTERVAL_MS);

    log.info('Uptime monitor started — heartbeat every 60s');
  }

  stop(): void {
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
  }

  recordError(): void {
    this.errorCounter++;
  }

  recordLatency(ms: number): void {
    this.latencyBuckets.push(ms);
    if (this.latencyBuckets.length > 100) {
      this.latencyBuckets = this.latencyBuckets.slice(-50);
    }
  }

  private async recordHeartbeat(): Promise<void> {
    const [rustOk, mlOk, redisOk, dbOk, breezeOk] = await Promise.all([
      Promise.resolve(isEngineAvailable()),
      isMLServiceAvailable().catch(() => false),
      this.checkRedis(),
      this.checkDatabase(),
      this.checkBreeze(),
    ]);

    const avgLatency = this.latencyBuckets.length > 0
      ? this.latencyBuckets.reduce((a, b) => a + b, 0) / this.latencyBuckets.length
      : 0;

    const snapshot: HealthSnapshot = {
      timestamp: Date.now(),
      services: {
        server: true,
        rustEngine: rustOk,
        pythonML: mlOk,
        redis: redisOk,
        database: dbOk,
        breeze: breezeOk,
      },
      errorCount: this.errorCounter,
      avgLatencyMs: Math.round(avgLatency),
    };

    this.history.push(snapshot);
    if (this.history.length > HISTORY_MAX) {
      this.history = this.history.slice(-HISTORY_MAX);
    }

    // Reset counters
    this.errorCounter = 0;
    this.latencyBuckets = [];

    // Persist to Redis if available
    const redis = getRedis();
    if (redis) {
      try {
        await redis.set('uptime:latest', JSON.stringify(snapshot), 'EX', 120);
        await redis.lpush('uptime:history', JSON.stringify(snapshot));
        await redis.ltrim('uptime:history', 0, HISTORY_MAX - 1);
      } catch {
        // Non-fatal
      }
    }
  }

  private async checkRedis(): Promise<boolean> {
    const redis = getRedis();
    if (!redis) return false;
    try {
      await redis.ping();
      return true;
    } catch {
      return false;
    }
  }

  private async checkDatabase(): Promise<boolean> {
    if (this.dbCheckFn) {
      try { return await this.dbCheckFn(); } catch { return false; }
    }
    return true; // Assume ok if no check function provided
  }

  private async checkBreeze(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const res = await fetch(`${BREEZE_BRIDGE_URL}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      return res.ok;
    } catch {
      return false;
    }
  }

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
  } {
    const uptimeMs = Date.now() - this.startTime;
    const totalSnapshots = this.history.length;

    // Calculate uptime percentage from heartbeat history
    const serverUpCount = this.history.filter(h => h.services.server).length;
    const uptimePct = totalSnapshots > 0 ? (serverUpCount / totalSnapshots) * 100 : 100;

    // Market hours uptime (09:15–15:30 IST = 03:45–10:00 UTC)
    const marketSnapshots = this.history.filter(h => {
      const d = new Date(h.timestamp);
      const utcHour = d.getUTCHours();
      const utcMin = d.getUTCMinutes();
      const minutes = utcHour * 60 + utcMin;
      return minutes >= 225 && minutes <= 600; // 03:45 to 10:00 UTC
    });
    const marketUp = marketSnapshots.filter(h => h.services.server).length;
    const marketHoursUptimePct = marketSnapshots.length > 0
      ? (marketUp / marketSnapshots.length) * 100 : 100;

    const currentHealth = this.history.length > 0 ? this.history[this.history.length - 1] : null;
    const recentErrors = this.history.slice(-5).reduce((s, h) => s + h.errorCount, 0);
    const recentLatencies = this.history.slice(-10).filter(h => h.avgLatencyMs > 0);
    const avgLatencyMs = recentLatencies.length > 0
      ? Math.round(recentLatencies.reduce((s, h) => s + h.avgLatencyMs, 0) / recentLatencies.length)
      : 0;

    const services = currentHealth?.services ?? {};
    const servicesUp = Object.values(services).filter(Boolean).length;
    const servicesTotal = Object.keys(services).length;

    return {
      uptimeMs,
      uptimePct: Math.round(uptimePct * 100) / 100,
      marketHoursUptimePct: Math.round(marketHoursUptimePct * 100) / 100,
      currentHealth,
      recentErrors,
      avgLatencyMs,
      servicesUp,
      servicesTotal,
      target: '99.9%',
      onTrack: marketHoursUptimePct >= 99.9,
    };
  }

  getHistory(hours = 1): HealthSnapshot[] {
    const cutoff = Date.now() - hours * 3_600_000;
    return this.history.filter(h => h.timestamp >= cutoff);
  }
}
