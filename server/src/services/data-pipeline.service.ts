/**
 * Data Pipeline Service — Redis Streams-based event-driven data flow.
 *
 * Implements the 5.2 data flow architecture:
 *   Breeze WebSocket → Redis Stream → Feature Compute (Rust)
 *     → Feature Store (DB) → ML Scoring (Python) → Signal
 *     → Risk Check → OMS → Order → Broker → Position Monitor
 *
 * Uses Redis Streams for durable, ordered event delivery between stages.
 */

import { getRedis } from '../lib/redis.js';
import { emit } from '../lib/event-bus.js';
import { engineFeatureStore, engineScan, isEngineAvailable } from '../lib/rust-engine.js';
import { isMLServiceAvailable, mlScore, mlDetectRegime } from '../lib/ml-service-client.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('DataPipeline');

const STREAM_TICKS = 'stream:ticks';
const STREAM_FEATURES = 'stream:features';
const STREAM_SIGNALS = 'stream:signals';
const STREAM_ORDERS = 'stream:orders';
const CONSUMER_GROUP = 'capital-guard';
const MAX_STREAM_LEN = 10_000;

export class DataPipelineService {
  private running = false;
  private pollIntervalMs = 500;

  async initialize(): Promise<boolean> {
    const redis = getRedis();
    if (!redis) {
      log.warn('Redis not available — pipeline disabled, falling back to in-process flow');
      return false;
    }

    try {
      // Create consumer groups (idempotent — ignore BUSYGROUP error)
      for (const stream of [STREAM_TICKS, STREAM_FEATURES, STREAM_SIGNALS, STREAM_ORDERS]) {
        try {
          await redis.xgroup('CREATE', stream, CONSUMER_GROUP, '0', 'MKSTREAM');
        } catch (err: any) {
          if (!err?.message?.includes('BUSYGROUP')) throw err;
        }
      }
      log.info('Redis Streams pipeline initialized');
      return true;
    } catch (err) {
      log.warn({ err }, 'Failed to initialize Redis Streams — pipeline disabled');
      return false;
    }
  }

  /**
   * Publish a tick event into the pipeline.
   * Called by price feed / WebSocket handler.
   */
  async publishTick(symbol: string, ltp: number, volume: number, timestamp: number): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    try {
      await redis.xadd(
        STREAM_TICKS, 'MAXLEN', '~', String(MAX_STREAM_LEN),
        '*',
        'symbol', symbol,
        'ltp', String(ltp),
        'volume', String(volume),
        'ts', String(timestamp),
      );
    } catch {
      // Non-fatal: skip if Redis is down
    }
  }

  /**
   * Publish computed features into the pipeline.
   */
  async publishFeatures(symbol: string, features: Record<string, number>): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    try {
      await redis.xadd(
        STREAM_FEATURES, 'MAXLEN', '~', String(MAX_STREAM_LEN),
        '*',
        'symbol', symbol,
        'data', JSON.stringify(features),
        'ts', String(Date.now()),
      );
    } catch {
      // Non-fatal
    }
  }

  /**
   * Publish a scored signal into the pipeline.
   */
  async publishSignal(signal: {
    symbol: string;
    direction: string;
    confidence: number;
    strategy: string;
    mlScore?: number;
    riskApproved?: boolean;
  }): Promise<void> {
    const redis = getRedis();
    if (!redis) return;

    try {
      await redis.xadd(
        STREAM_SIGNALS, 'MAXLEN', '~', String(MAX_STREAM_LEN),
        '*',
        'symbol', signal.symbol,
        'direction', signal.direction,
        'confidence', String(signal.confidence),
        'strategy', signal.strategy,
        'ml_score', String(signal.mlScore ?? signal.confidence),
        'risk_approved', signal.riskApproved ? '1' : '0',
        'ts', String(Date.now()),
      );
    } catch {
      // Non-fatal
    }
  }

  /**
   * Process ticks: compute features via Rust engine, publish to feature stream.
   * This is the Feature Compute stage of the pipeline.
   */
  async processTickBatch(ticks: Array<{ symbol: string; candles: unknown[] }>): Promise<void> {
    if (!isEngineAvailable() || ticks.length === 0) return;

    for (const tick of ticks) {
      if (!tick.candles || (tick.candles as any[]).length < 20) continue;

      try {
        const result = await engineFeatureStore({
          command: 'extract_features',
          candles: tick.candles as any,
        }) as any;

        if (result?.features?.data?.length > 0) {
          const lastRow = result.features.data[result.features.data.length - 1];
          const columns: string[] = result.features.columns ?? [];

          const featureMap: Record<string, number> = {};
          for (let i = 0; i < columns.length && i < lastRow.length; i++) {
            featureMap[columns[i]] = lastRow[i];
          }

          await this.publishFeatures(tick.symbol, featureMap);
        }
      } catch (err) {
        log.warn({ symbol: tick.symbol, err }, 'Feature extraction failed');
      }
    }
  }

  /**
   * Score features using Python ML service, then pass through risk check.
   * This is the ML Scoring → Risk Check stage.
   */
  async scoreAndFilter(
    features: Array<{ symbol: string; featureMap: Record<string, number> }>,
    riskCheckFn?: (symbol: string, direction: string) => Promise<boolean>,
  ): Promise<Array<{ symbol: string; direction: string; confidence: number; mlScore: number; strategy: string }>> {
    const signals: Array<{ symbol: string; direction: string; confidence: number; mlScore: number; strategy: string }> = [];

    // Step 1: ML scoring via Python service (if available)
    const pyAvailable = await isMLServiceAvailable();
    if (pyAvailable && features.length > 0) {
      try {
        const scoreResult = await mlScore({
          features: features.map(f => ({
            features: f.featureMap,
            raw_features: Object.values(f.featureMap),
          })),
          model_type: 'xgboost',
        });

        for (let i = 0; i < features.length; i++) {
          const score = scoreResult.scores[i] ?? 0.5;
          const label = scoreResult.labels[i] ?? 'LOSS';

          if (label === 'WIN' && score > 0.6) {
            const direction = (f: Record<string, number>) => {
              const composite = f.composite_score ?? f.ema_vote ?? 0;
              return composite > 0 ? 'BUY' : 'SELL';
            };

            const dir = direction(features[i].featureMap);

            // Step 2: Risk check
            let approved = true;
            if (riskCheckFn) {
              approved = await riskCheckFn(features[i].symbol, dir);
            }

            if (approved) {
              signals.push({
                symbol: features[i].symbol,
                direction: dir,
                confidence: score,
                mlScore: score,
                strategy: 'ml_xgboost',
              });

              await this.publishSignal({
                symbol: features[i].symbol,
                direction: dir,
                confidence: score,
                strategy: 'ml_xgboost',
                mlScore: score,
                riskApproved: true,
              });
            }
          }
        }
      } catch (err) {
        log.warn({ err }, 'Python ML scoring failed — signals skipped');
      }
    }

    return signals;
  }

  /**
   * Read recent entries from a stream for monitoring/debugging.
   */
  async readStream(stream: string, count = 10): Promise<unknown[]> {
    const redis = getRedis();
    if (!redis) return [];

    try {
      const entries = await redis.xrevrange(stream, '+', '-', 'COUNT', count);
      return entries.map(([id, fields]: any) => {
        const obj: Record<string, string> = { _id: id };
        for (let i = 0; i < fields.length; i += 2) {
          obj[fields[i]] = fields[i + 1];
        }
        return obj;
      });
    } catch {
      return [];
    }
  }

  /**
   * Get pipeline statistics.
   */
  async getStats(): Promise<{
    tickStreamLen: number;
    featureStreamLen: number;
    signalStreamLen: number;
    orderStreamLen: number;
    redisAvailable: boolean;
  }> {
    const redis = getRedis();
    if (!redis) {
      return {
        tickStreamLen: 0, featureStreamLen: 0,
        signalStreamLen: 0, orderStreamLen: 0,
        redisAvailable: false,
      };
    }

    try {
      const [ticks, features, signals, orders] = await Promise.all([
        redis.xlen(STREAM_TICKS).catch(() => 0),
        redis.xlen(STREAM_FEATURES).catch(() => 0),
        redis.xlen(STREAM_SIGNALS).catch(() => 0),
        redis.xlen(STREAM_ORDERS).catch(() => 0),
      ]);

      return {
        tickStreamLen: ticks,
        featureStreamLen: features,
        signalStreamLen: signals,
        orderStreamLen: orders,
        redisAvailable: true,
      };
    } catch {
      return {
        tickStreamLen: 0, featureStreamLen: 0,
        signalStreamLen: 0, orderStreamLen: 0,
        redisAvailable: false,
      };
    }
  }
}
