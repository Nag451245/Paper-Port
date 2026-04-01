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
import { engineFeatureStore, isEngineAvailable } from '../lib/rust-engine.js';
import { isMLServiceAvailable, mlScore } from '../lib/ml-service-client.js';
import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';
const log = createChildLogger('DataPipeline');
const STREAM_TICKS = 'stream:ticks';
const STREAM_FEATURES = 'stream:features';
const STREAM_SIGNALS = 'stream:signals';
const STREAM_ORDERS = 'stream:orders';
const CONSUMER_GROUP = 'capital-guard';
const MAX_STREAM_LEN = 10_000;
export class DataPipelineService {
    running = false;
    pollIntervalMs = 500;
    async initialize() {
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
                }
                catch (err) {
                    if (!err?.message?.includes('BUSYGROUP'))
                        throw err;
                }
            }
            log.info('Redis Streams pipeline initialized');
            return true;
        }
        catch (err) {
            log.warn({ err }, 'Failed to initialize Redis Streams — pipeline disabled');
            return false;
        }
    }
    /**
     * Publish a tick event into the pipeline.
     * Called by price feed / WebSocket handler.
     */
    async publishTick(symbol, ltp, volume, timestamp) {
        const redis = getRedis();
        if (!redis)
            return;
        try {
            await redis.xadd(STREAM_TICKS, 'MAXLEN', '~', String(MAX_STREAM_LEN), '*', 'symbol', symbol, 'ltp', String(ltp), 'volume', String(volume), 'ts', String(timestamp));
        }
        catch {
            // Non-fatal: skip if Redis is down
        }
    }
    /**
     * Publish computed features into the pipeline.
     */
    async publishFeatures(symbol, features) {
        const redis = getRedis();
        if (!redis)
            return;
        try {
            await redis.xadd(STREAM_FEATURES, 'MAXLEN', '~', String(MAX_STREAM_LEN), '*', 'symbol', symbol, 'data', JSON.stringify(features), 'ts', String(Date.now()));
        }
        catch {
            // Non-fatal
        }
    }
    /**
     * Publish a scored signal into the pipeline.
     */
    async publishSignal(signal) {
        const redis = getRedis();
        if (!redis)
            return;
        try {
            await redis.xadd(STREAM_SIGNALS, 'MAXLEN', '~', String(MAX_STREAM_LEN), '*', 'symbol', signal.symbol, 'direction', signal.direction, 'confidence', String(signal.confidence), 'strategy', signal.strategy, 'ml_score', String(signal.mlScore ?? signal.confidence), 'risk_approved', signal.riskApproved ? '1' : '0', 'ts', String(Date.now()));
        }
        catch {
            // Non-fatal
        }
    }
    /**
     * Process ticks: compute features via Rust engine, publish to feature stream.
     * This is the Feature Compute stage of the pipeline.
     */
    async processTickBatch(ticks) {
        if (!isEngineAvailable() || ticks.length === 0)
            return;
        for (const tick of ticks) {
            if (!tick.candles || tick.candles.length < 20)
                continue;
            try {
                const result = await engineFeatureStore({
                    command: 'extract_features',
                    candles: tick.candles,
                });
                if (result?.features?.data?.length > 0) {
                    const lastRow = result.features.data[result.features.data.length - 1];
                    const columns = result.features.columns ?? [];
                    const featureMap = {};
                    for (let i = 0; i < columns.length && i < lastRow.length; i++) {
                        featureMap[columns[i]] = lastRow[i];
                    }
                    await this.publishFeatures(tick.symbol, featureMap);
                    // Persist last candle to CandleStore
                    const lastCandle = tick.candles[tick.candles.length - 1];
                    if (lastCandle) {
                        this.persistCandles(tick.symbol, '5m', [lastCandle]).catch(err => log.warn({ err, symbol: tick.symbol }, 'Failed to persist candle'));
                    }
                }
            }
            catch (err) {
                log.warn({ symbol: tick.symbol, err }, 'Feature extraction failed');
            }
        }
    }
    /**
     * Score features using Python ML service, then pass through risk check.
     * This is the ML Scoring → Risk Check stage.
     */
    async scoreAndFilter(features, riskCheckFn) {
        const signals = [];
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
                        const direction = (f) => {
                            const emaRatio = f.ema_ratio_9_21 ?? 1.0;
                            const rsi = f.rsi_14 ?? 50;
                            const slope = f.linreg_slope_20 ?? 0;
                            const momentum = f.momentum_12d ?? 0;
                            let bullish = 0;
                            if (emaRatio > 1.0)
                                bullish++;
                            if (rsi > 50)
                                bullish++;
                            if (slope > 0)
                                bullish++;
                            if (momentum > 0)
                                bullish++;
                            return bullish >= 3 ? 'BUY' : bullish <= 1 ? 'SELL' : (emaRatio > 1.0 ? 'BUY' : 'SELL');
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
            }
            catch (err) {
                log.warn({ err }, 'Python ML scoring failed — signals skipped');
            }
        }
        return signals;
    }
    /**
     * Read recent entries from a stream for monitoring/debugging.
     */
    async readStream(stream, count = 10) {
        const redis = getRedis();
        if (!redis)
            return [];
        try {
            const entries = await redis.xrevrange(stream, '+', '-', 'COUNT', count);
            return entries.map(([id, fields]) => {
                const obj = { _id: id };
                for (let i = 0; i < fields.length; i += 2) {
                    obj[fields[i]] = fields[i + 1];
                }
                return obj;
            });
        }
        catch {
            return [];
        }
    }
    /**
     * Get pipeline statistics.
     */
    async getStats() {
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
        }
        catch {
            return {
                tickStreamLen: 0, featureStreamLen: 0,
                signalStreamLen: 0, orderStreamLen: 0,
                redisAvailable: false,
            };
        }
    }
    /**
     * Start a consumer loop that reads ticks from Redis Streams, computes features,
     * and runs ML scoring. This connects the pipeline end-to-end.
     */
    startConsumer(intervalMs = 5_000) {
        if (this.running)
            return;
        this.running = true;
        const consumerId = `consumer-${process.pid}`;
        const loop = async () => {
            if (!this.running)
                return;
            const redis = getRedis();
            if (!redis) {
                setTimeout(loop, intervalMs * 2);
                return;
            }
            try {
                // Read new ticks from the consumer group
                const results = await redis.xreadgroup('GROUP', CONSUMER_GROUP, consumerId, 'COUNT', '100', 'BLOCK', '1000', 'STREAMS', STREAM_TICKS, '>');
                if (results && results.length > 0) {
                    const entries = results[0][1];
                    if (entries.length > 0) {
                        // Group ticks by symbol and accumulate for candle building
                        const ticksBySymbol = new Map();
                        const ackIds = [];
                        for (const [id, fields] of entries) {
                            const obj = {};
                            for (let i = 0; i < fields.length; i += 2) {
                                obj[fields[i]] = fields[i + 1];
                            }
                            const symbol = obj.symbol;
                            if (!symbol)
                                continue;
                            if (!ticksBySymbol.has(symbol))
                                ticksBySymbol.set(symbol, []);
                            ticksBySymbol.get(symbol).push({
                                ltp: parseFloat(obj.ltp ?? '0'),
                                volume: parseFloat(obj.volume ?? '0'),
                                ts: parseInt(obj.ts ?? '0', 10),
                            });
                            ackIds.push(id);
                        }
                        // Build candle-like data for feature extraction
                        const tickBatch = [];
                        for (const [symbol, ticks] of ticksBySymbol) {
                            // Accumulate in-memory; only process when we have enough data points
                            if (!this.tickBuffer)
                                this.tickBuffer = new Map();
                            const buffer = this.tickBuffer;
                            if (!buffer.has(symbol))
                                buffer.set(symbol, []);
                            const symbolBuffer = buffer.get(symbol);
                            for (const t of ticks) {
                                symbolBuffer.push({
                                    close: t.ltp,
                                    high: t.ltp * 1.001,
                                    low: t.ltp * 0.999,
                                    open: t.ltp,
                                    volume: t.volume,
                                });
                            }
                            // Keep buffer capped at 100 candles
                            if (symbolBuffer.length > 100) {
                                buffer.set(symbol, symbolBuffer.slice(-100));
                            }
                            if (symbolBuffer.length >= 20) {
                                tickBatch.push({ symbol, candles: symbolBuffer });
                            }
                        }
                        // Process tick batch through Rust feature extraction
                        if (tickBatch.length > 0) {
                            await this.processTickBatch(tickBatch);
                        }
                        // Acknowledge processed messages
                        if (ackIds.length > 0) {
                            await redis.xack(STREAM_TICKS, CONSUMER_GROUP, ...ackIds).catch(err => log.warn({ err }, 'Failed to ack tick stream messages'));
                        }
                    }
                }
                // Read features and score them
                const featureResults = await redis.xreadgroup('GROUP', CONSUMER_GROUP, consumerId, 'COUNT', '50', 'BLOCK', '500', 'STREAMS', STREAM_FEATURES, '>');
                if (featureResults && featureResults.length > 0) {
                    const featureEntries = featureResults[0][1];
                    const featureBatch = [];
                    const featureAckIds = [];
                    for (const [id, fields] of featureEntries) {
                        const obj = {};
                        for (let i = 0; i < fields.length; i += 2) {
                            obj[fields[i]] = fields[i + 1];
                        }
                        try {
                            const featureMap = JSON.parse(obj.data ?? '{}');
                            featureBatch.push({ symbol: obj.symbol, featureMap });
                        }
                        catch { /* skip malformed entries */ }
                        featureAckIds.push(id);
                    }
                    if (featureBatch.length > 0) {
                        await this.scoreAndFilter(featureBatch);
                    }
                    if (featureAckIds.length > 0) {
                        await redis.xack(STREAM_FEATURES, CONSUMER_GROUP, ...featureAckIds).catch(err => log.warn({ err }, 'Failed to ack feature stream messages'));
                    }
                }
                // Read scored signals and route to execution via event bus
                const signalResults = await redis.xreadgroup('GROUP', CONSUMER_GROUP, consumerId, 'COUNT', '50', 'BLOCK', '500', 'STREAMS', STREAM_SIGNALS, '>');
                if (signalResults && signalResults.length > 0) {
                    const signalEntries = signalResults[0][1];
                    const signalAckIds = [];
                    for (const [id, fields] of signalEntries) {
                        const obj = {};
                        for (let i = 0; i < fields.length; i += 2) {
                            obj[fields[i]] = fields[i + 1];
                        }
                        const riskApproved = obj.risk_approved === '1';
                        const confidence = parseFloat(obj.confidence ?? '0');
                        const mlScore = parseFloat(obj.ml_score ?? '0');
                        if (riskApproved && confidence >= 0.6) {
                            emit('signals', {
                                type: 'PIPELINE_SIGNAL',
                                symbol: obj.symbol,
                                direction: obj.direction,
                                confidence,
                                strategy: obj.strategy,
                                mlScore,
                                source: 'DATA_PIPELINE',
                            });
                            log.info({
                                symbol: obj.symbol, direction: obj.direction,
                                confidence, mlScore, strategy: obj.strategy,
                            }, 'Pipeline signal forwarded to event bus');
                        }
                        signalAckIds.push(id);
                    }
                    if (signalAckIds.length > 0) {
                        await redis.xack(STREAM_SIGNALS, CONSUMER_GROUP, ...signalAckIds).catch(err => log.warn({ err }, 'Failed to ack signal stream messages'));
                    }
                }
            }
            catch (err) {
                log.warn({ err }, 'Pipeline consumer loop error');
            }
            if (this.running) {
                setTimeout(loop, intervalMs);
            }
        };
        log.info({ intervalMs }, 'Data pipeline consumer started');
        setTimeout(loop, 1000);
    }
    stopConsumer() {
        this.running = false;
        log.info('Data pipeline consumer stopped');
    }
    tickBuffer;
    /**
     * Persist candles to DB via CandleStore model. Upserts on conflict (symbol+exchange+interval+timestamp).
     */
    async persistCandles(symbol, interval, candles, exchange = 'NSE') {
        const prisma = getPrisma();
        let persisted = 0;
        for (const c of candles) {
            const ts = c.timestamp
                ? new Date(typeof c.timestamp === 'number' ? c.timestamp : c.timestamp)
                : new Date();
            try {
                await prisma.candleStore.upsert({
                    where: {
                        symbol_exchange_interval_timestamp: { symbol, exchange, interval, timestamp: ts },
                    },
                    create: { symbol, exchange, interval, timestamp: ts, open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume },
                    update: { open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume },
                });
                persisted++;
            }
            catch (err) {
                log.warn({ symbol, err }, 'Failed to persist candle');
            }
        }
        return persisted;
    }
    /**
     * Load historical candles from DB to bootstrap tick buffer on restart.
     */
    async loadHistoricalCandles(symbol, interval, since, exchange = 'NSE') {
        const prisma = getPrisma();
        try {
            const rows = await prisma.candleStore.findMany({
                where: { symbol, exchange, interval, timestamp: { gte: since } },
                orderBy: { timestamp: 'asc' },
                take: 200,
            });
            return rows.map(r => ({
                open: Number(r.open),
                high: Number(r.high),
                low: Number(r.low),
                close: Number(r.close),
                volume: Number(r.volume),
            }));
        }
        catch (err) {
            log.warn({ symbol, err }, 'Failed to load historical candles');
            return [];
        }
    }
    /**
     * Bootstrap tick buffers from DB for all recently-traded symbols.
     */
    async bootstrapFromDB(symbols, interval = '5m') {
        const since = new Date(Date.now() - 2 * 24 * 60 * 60 * 1000); // last 2 days
        if (!this.tickBuffer)
            this.tickBuffer = new Map();
        const buffer = this.tickBuffer;
        for (const symbol of symbols) {
            const candles = await this.loadHistoricalCandles(symbol, interval, since);
            if (candles.length > 0) {
                buffer.set(symbol, candles);
                log.info({ symbol, count: candles.length }, 'Bootstrapped candle buffer from DB');
            }
        }
    }
}
//# sourceMappingURL=data-pipeline.service.js.map