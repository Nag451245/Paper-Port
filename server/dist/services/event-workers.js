/**
 * Event Workers — BullMQ consumers for all 5 event bus categories.
 *
 * Bridges the gap between event producers (TradeService, OMS, RiskService, etc.)
 * and consumers (WebSocket push, decision audit, learning triggers).
 */
import { registerWorker, } from '../lib/event-bus.js';
import { wsHub } from '../lib/websocket.js';
import { createChildLogger } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';
import { emit } from '../lib/event-bus.js';
import { TelegramService } from './telegram.service.js';
import { engineRecordOutcome } from '../lib/rust-engine.js';
import { mlOnlineUpdate, isMLServiceAvailable } from '../lib/ml-service-client.js';
const log = createChildLogger('EventWorkers');
export function registerAllWorkers(prisma, learningEngine, botEngine) {
    const telegram = new TelegramService(prisma);
    log.info('Registering event bus workers for all 5 categories');
    // ── Execution events: order fills, position changes, OMS state transitions ──
    registerWorker('execution', async (job) => {
        const event = job.data;
        switch (event.type) {
            case 'ORDER_PLACED':
                wsHub.broadcastToUser(event.userId, { type: 'order_placed', data: event });
                break;
            case 'ORDER_FILLED':
                wsHub.broadcastToUser(event.userId, { type: 'order_filled', data: event });
                log.info({ orderId: event.orderId, symbol: event.symbol, fillPrice: event.fillPrice }, 'Order filled');
                telegram.notifyTradeExecution(event.userId, event.symbol, 'FILLED', event.qty, event.fillPrice).catch(err => log.warn({ err }, 'Telegram trade notification failed'));
                break;
            case 'POSITION_CLOSED': {
                wsHub.broadcastToUser(event.userId, { type: 'position_closed', data: event });
                telegram.notifyTradeExecution(event.userId, event.symbol, 'CLOSE', 0, event.exitPrice, event.pnl).catch(err => log.warn({ err }, 'Telegram close notification failed'));
                // Persist to decision audit for learning loop
                try {
                    await prisma.decisionAudit.create({
                        data: {
                            userId: event.userId,
                            decisionType: 'POSITION_CLOSED',
                            symbol: event.symbol,
                            direction: event.pnl >= 0 ? 'WIN' : 'LOSS',
                            confidence: 0,
                            signalSource: 'EXECUTION',
                            marketDataSnapshot: JSON.stringify({ exitPrice: event.exitPrice, pnl: event.pnl }),
                            reasoning: `Position closed at ₹${event.exitPrice}, PnL: ₹${event.pnl.toFixed(2)}`,
                        },
                    });
                }
                catch { /* audit is best-effort */ }
                // Intraday Bayesian update: adjust strategy confidence in real-time
                if (learningEngine) {
                    learningEngine.runIntradayUpdate({
                        strategyTag: event.strategyTag ?? '',
                        netPnl: event.pnl ?? 0,
                        userId: event.userId,
                        symbol: event.symbol,
                    }).catch(err => log.warn({ err }, 'Intraday learning update failed'));
                }
                // Update BotEngine's Thompson sampling posteriors
                if (botEngine && event.strategyTag) {
                    botEngine.bayesianUpdate(event.strategyTag, event.pnl >= 0);
                }
                // Feed outcome to Rust Strategy Performance Engine for calibration & decay detection
                try {
                    const entryPrice = event.entryPrice ?? event.exitPrice;
                    const pnlPct = entryPrice > 0 ? ((event.exitPrice - entryPrice) / entryPrice) * 100 : 0;
                    engineRecordOutcome({
                        symbol: event.symbol,
                        strategy: event.strategyTag ?? 'unknown',
                        direction: event.pnl >= 0 ? 'BUY' : 'SELL',
                        predicted_confidence: event.confidence ?? 0.5,
                        entry_price: entryPrice,
                        exit_price: event.exitPrice,
                        pnl_pct: pnlPct,
                        won: event.pnl >= 0,
                        regime: 'neutral',
                    }).catch(err => log.debug({ err }, 'Performance engine outcome recording failed'));
                }
                catch { /* performance recording is best-effort */ }
                // Online ML model update — feed outcome to Python ML service for incremental learning
                try {
                    if (await isMLServiceAvailable()) {
                        const outcomeValue = event.pnl >= 0 ? 1.0 : 0.0;
                        const features = {
                            composite_score: event.confidence ?? 0.5,
                            pnl: event.pnl ?? 0,
                            exit_price: event.exitPrice ?? 0,
                        };
                        mlOnlineUpdate(features, outcomeValue, `pos_close_${event.symbol}_${Date.now()}`).catch(err => log.debug({ err }, 'Online ML update on position close failed'));
                    }
                }
                catch { /* online learning is best-effort */ }
                break;
            }
            case 'ORDER_STATE_CHANGE':
                if ('orderId' in event) {
                    // Look up the order to find the userId for WebSocket push
                    try {
                        const order = await prisma.order.findUnique({
                            where: { id: event.orderId },
                            include: { portfolio: { select: { userId: true } } },
                        });
                        if (order?.portfolio?.userId) {
                            wsHub.broadcastToUser(order.portfolio.userId, { type: 'order_state_change', data: event });
                        }
                    }
                    catch { /* best-effort */ }
                }
                break;
            case 'POSITION_OPENED':
                wsHub.broadcastToUser(event.userId, { type: 'position_opened', data: event });
                break;
        }
    }, { concurrency: 10 });
    // ── Risk events: violations, circuit breakers ──
    registerWorker('risk', async (job) => {
        const event = job.data;
        switch (event.type) {
            case 'RISK_VIOLATION':
                wsHub.broadcastToUser(event.userId, { type: 'risk_violation', data: event });
                telegram.notifyRiskAlert(event.userId, `Risk Violation (${event.severity})`, `Symbol: ${event.symbol}\nViolations: ${event.violations.join(', ')}`).catch(err => log.warn({ err }, 'Telegram risk notification failed'));
                try {
                    await prisma.riskEvent.create({
                        data: {
                            userId: event.userId,
                            ruleType: 'RISK_VIOLATION',
                            severity: event.severity,
                            details: JSON.stringify(event),
                        },
                    });
                }
                catch { /* best-effort */ }
                break;
            case 'CIRCUIT_BREAKER_TRIGGERED':
                wsHub.broadcastToUser(event.userId, { type: 'circuit_breaker', data: event });
                log.warn({ userId: event.userId, reason: event.reason, drawdownPct: event.drawdownPct }, 'Circuit breaker triggered');
                telegram.notifyRiskAlert(event.userId, 'CIRCUIT BREAKER', `Drawdown: ${event.drawdownPct?.toFixed(1)}%\nReason: ${event.reason}\nAll trading halted until reset.`).catch(err => log.warn({ err }, 'Telegram circuit breaker notification failed'));
                try {
                    await prisma.riskEvent.create({
                        data: {
                            userId: event.userId,
                            ruleType: 'CIRCUIT_BREAKER',
                            severity: 'critical',
                            details: JSON.stringify(event),
                        },
                    });
                }
                catch { /* best-effort */ }
                break;
            case 'RISK_CHECK_PASSED':
                break;
            case 'RECONCILIATION_MISMATCH':
                log.error({ mismatches: event.mismatches, timestamp: event.timestamp }, `EOD Reconciliation: ${Array.isArray(event.mismatches) ? event.mismatches.length : 0} position mismatches detected`);
                try {
                    await prisma.riskEvent.create({
                        data: {
                            userId: 'system',
                            ruleType: 'RECONCILIATION_MISMATCH',
                            severity: 'critical',
                            details: JSON.stringify(event),
                        },
                    });
                }
                catch { /* best-effort */ }
                telegram.notifyRiskAlert('system', 'RECONCILIATION MISMATCH', `${Array.isArray(event.mismatches) ? event.mismatches.length : 0} position mismatches between engine and broker at ${event.timestamp}`).catch(err => log.warn({ err }, 'Telegram reconciliation notification failed'));
                break;
        }
    }, { concurrency: 5 });
    // ── Signal events: generated signals, validations, pipeline-scored signals ──
    registerWorker('signals', async (job) => {
        const event = job.data;
        switch (event.type) {
            case 'SIGNAL_GENERATED':
                if ('userId' in event) {
                    wsHub.broadcastToUser(event.userId, { type: 'signal_generated', data: event });
                    const confidence = event.confidence ?? 0;
                    if (confidence >= 0.3) {
                        telegram.notifySignal(event.userId, event.symbol, event.direction ?? 'LONG', confidence, event.entry ?? 0, event.target ?? 0, event.stopLoss ?? 0, event.source).catch(err => log.warn({ err }, 'Telegram signal notification failed'));
                    }
                }
                break;
            case 'SIGNAL_VALIDATED':
                if ('userId' in event)
                    wsHub.broadcastToUser(event.userId, { type: 'signal_validated', data: event });
                break;
            case 'SIGNAL_EXPIRED':
                if ('userId' in event)
                    wsHub.broadcastToUser(event.userId, { type: 'signal_expired', data: event });
                break;
            case 'PIPELINE_SIGNAL': {
                log.info({
                    symbol: event.symbol,
                    direction: event.direction,
                    confidence: event.confidence,
                    strategy: event.strategy,
                    mlScore: event.mlScore,
                }, 'Pipeline signal received — routing to bot engine');
                if (event.confidence >= 0.5) {
                    telegram.notifyPipelineSignal(event.symbol, event.direction, event.confidence, event.strategy, event.mlScore, event.source).catch(err => log.warn({ err }, 'Telegram pipeline signal notification failed'));
                }
                if (botEngine) {
                    try {
                        await botEngine.executePipelineSignal({
                            symbol: event.symbol,
                            direction: event.direction,
                            confidence: event.confidence,
                            strategy: event.strategy,
                            mlScore: event.mlScore,
                            source: event.source,
                        });
                    }
                    catch (err) {
                        log.error({ err, symbol: event.symbol }, 'Failed to execute pipeline signal');
                    }
                }
                else {
                    log.warn('Pipeline signal received but no BotEngine instance available');
                }
                break;
            }
        }
    }, { concurrency: 5 });
    // ── System events: market phase changes, kill switch ──
    registerWorker('system', async (job) => {
        const event = job.data;
        switch (event.type) {
            case 'PHASE_CHANGE':
                wsHub.broadcastRegime({ regime: event.to, confidence: 1.0, timestamp: event.timestamp });
                log.info({ from: event.from, to: event.to }, 'Market phase change processed by worker');
                break;
            case 'MARKET_OPEN':
                log.info({ exchange: event.exchange }, 'Market opened');
                break;
            case 'MARKET_CLOSE':
                log.info({ exchange: event.exchange }, 'Market closed');
                break;
            case 'KILL_SWITCH_ACTIVATED':
                wsHub.broadcastToUser(event.userId, { type: 'kill_switch', data: { active: true, timestamp: event.timestamp } });
                log.warn({ userId: event.userId }, 'Kill switch activated');
                telegram.notifyRiskAlert(event.userId, 'KILL SWITCH ACTIVATED', 'Emergency kill switch activated. All new orders are blocked until you manually deactivate it.').catch(err => log.warn({ err }, 'Telegram kill switch notification failed'));
                break;
            case 'KILL_SWITCH_DEACTIVATED':
                wsHub.broadcastToUser(event.userId, { type: 'kill_switch', data: { active: false, timestamp: event.timestamp } });
                log.info({ userId: event.userId }, 'Kill switch deactivated');
                break;
            case 'ML_WEIGHTS_UPDATED':
                if (botEngine) {
                    log.info({ userId: event.userId, version: event.version }, 'Reloading ML weights in BotEngine');
                    botEngine.loadMLWeightsFromDB(event.userId).catch(err => log.warn({ err }, 'Failed to reload ML weights in BotEngine'));
                }
                break;
            case 'LEARNING_UPDATE':
                break;
        }
    }, { concurrency: 3 });
    // ── Market data events: ticks, gaps ──
    registerWorker('market-data', async (job) => {
        const event = job.data;
        switch (event.type) {
            case 'DATA_GAP_DETECTED':
                log.warn({ symbol: event.symbol, gapMinutes: event.gapMinutes }, 'Data gap detected');
                break;
            case 'TICK_RECEIVED': {
                // Sample 1-in-10 ticks for volume anomaly detection
                const tickKey = `tick_count:${event.symbol}`;
                const redis = getRedis();
                if (redis) {
                    try {
                        const count = await redis.incr(tickKey);
                        if (count === 1)
                            await redis.expire(tickKey, 3600);
                        if (count % 10 === 0) {
                            const volKey = `cg:vol_profile:${event.symbol}`;
                            const raw = await redis.get(volKey);
                            const profile = raw ? JSON.parse(raw) : { samples: 0, avgVolume: 0, maxVolume: 0 };
                            const vol = event.volume ?? 0;
                            profile.samples += 1;
                            profile.avgVolume = profile.avgVolume + (vol - profile.avgVolume) / profile.samples;
                            if (vol > profile.maxVolume)
                                profile.maxVolume = vol;
                            // Detect unusual volume spike (3x average)
                            if (profile.samples > 20 && vol > profile.avgVolume * 3) {
                                log.info({ symbol: event.symbol, volume: vol, avg: profile.avgVolume }, 'Volume anomaly detected');
                                emit('signals', {
                                    type: 'SIGNAL_GENERATED',
                                    symbol: event.symbol,
                                    direction: 'NEUTRAL',
                                    confidence: 0.6,
                                    source: 'volume_anomaly',
                                    userId: 'system',
                                }).catch(() => { });
                            }
                            await redis.set(volKey, JSON.stringify(profile), 'EX', 6 * 3600);
                        }
                    }
                    catch { /* tick learning is best-effort */ }
                }
                break;
            }
            case 'CANDLE_CLOSED': {
                // Compute intraday volume profile and VWAP deviation
                const candleRedis = getRedis();
                if (candleRedis && event.symbol) {
                    try {
                        const vpKey = `cg:vwap_profile:${event.symbol}`;
                        const raw = await candleRedis.get(vpKey);
                        const profile = raw ? JSON.parse(raw) : {
                            cumulativeVolume: 0,
                            cumulativeVwap: 0,
                            candleCount: 0,
                            highOfDay: -Infinity,
                            lowOfDay: Infinity,
                        };
                        const close = event.close ?? 0;
                        const vol = event.volume ?? 0;
                        profile.cumulativeVolume += vol;
                        profile.cumulativeVwap += close * vol;
                        profile.candleCount += 1;
                        if (close > profile.highOfDay)
                            profile.highOfDay = close;
                        if (close < profile.lowOfDay)
                            profile.lowOfDay = close;
                        const vwap = profile.cumulativeVolume > 0
                            ? profile.cumulativeVwap / profile.cumulativeVolume
                            : close;
                        const vwapDeviation = close !== 0 ? ((close - vwap) / close) * 100 : 0;
                        profile.vwap = vwap;
                        profile.vwapDeviation = vwapDeviation;
                        profile.lastClose = close;
                        profile.updatedAt = new Date().toISOString();
                        await candleRedis.set(vpKey, JSON.stringify(profile), 'EX', 12 * 3600);
                    }
                    catch { /* candle learning is best-effort */ }
                }
                break;
            }
        }
    }, { concurrency: 3 });
    log.info('All 5 event bus workers registered');
}
//# sourceMappingURL=event-workers.js.map