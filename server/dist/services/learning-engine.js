import { existsSync, readFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { chatCompletionJSON, chatCompletion } from '../lib/openai.js';
import { MarketDataService } from './market-data.service.js';
import { engineOptimize, engineFeatureStore, engineMLScore, isEngineAvailable, engineTrainingData } from '../lib/rust-engine.js';
import { isMLServiceAvailable, mlTrain, mlDetectRegime, mlAllocate, mlOnlineUpdate } from '../lib/ml-service-client.js';
import { LearningStoreService } from './learning-store.service.js';
import { getRedis } from '../lib/redis.js';
import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
import { getPrisma } from '../lib/prisma.js';
import { MarketMemoryService } from './market-memory.service.js';
import { FeaturePipelineService } from './feature-pipeline.service.js';
import { istDateStr, istDaysAgo } from '../lib/ist.js';
import { LessonsEngineService } from './lessons-engine.service.js';
import { DecisionFusionService } from './decision-fusion.service.js';
const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const log = createChildLogger('LearningEngine');
const STRATEGIES = [
    'ema-crossover', 'supertrend', 'sma_crossover', 'mean_reversion', 'momentum', 'rsi_reversal', 'orb',
    'gap_trading', 'vwap_reversion', 'volatility_breakout', 'sector_rotation', 'pairs_trading',
    'expiry_theta', 'calendar_spread', 'trend_following',
];
const DEFAULT_PARAM_GRIDS = {
    'ema-crossover': { ema_short: [5, 9, 13], ema_long: [15, 21, 30] },
    supertrend: { ema_short: [7, 10, 14], ema_long: [20, 26, 34] },
    sma_crossover: { ema_short: [5, 10, 15], ema_long: [20, 30, 50] },
    mean_reversion: { ema_short: [8, 12, 16], ema_long: [18, 24, 32] },
    momentum: { ema_short: [5, 9, 14], ema_long: [15, 21, 28] },
    rsi_reversal: { ema_short: [7, 10, 14], ema_long: [20, 26, 34] },
    orb: { ema_short: [5, 9, 13], ema_long: [15, 21, 30] },
};
export class LearningEngine {
    prisma;
    marketData = new MarketDataService();
    learningStore = new LearningStoreService();
    running = false;
    marketMemory = new MarketMemoryService();
    featurePipeline = new FeaturePipelineService();
    lessonsEngine = new LessonsEngineService();
    fusionService = new DecisionFusionService();
    intradayWinTracker = { wins: 0, total: 0 };
    weeklyRetrainTimer = null;
    constructor(prisma) {
        this.prisma = prisma;
        this.scheduleWeeklyRetrain();
    }
    /**
     * Runs every minute, checking if it's Saturday 11:00 IST. When it is,
     * pulls outcome data from the Rust Performance Engine and retrains
     * both XGBoost and LightGBM models on the merged training data.
     */
    scheduleWeeklyRetrain() {
        let lastRetrainDate = '';
        this.weeklyRetrainTimer = setInterval(async () => {
            const nowUtc = new Date();
            const ist = new Date(nowUtc.getTime() + (5.5 * 3600_000));
            const istDay = ist.toLocaleDateString('en-US', { weekday: 'long', timeZone: 'Asia/Kolkata' });
            const istTime = ist.toLocaleTimeString('en-GB', { hour: '2-digit', minute: '2-digit', hour12: false, timeZone: 'Asia/Kolkata' });
            const istDate = ist.toISOString().split('T')[0];
            if (istDay !== 'Saturday')
                return;
            if (istTime < '11:00' || istTime >= '11:05')
                return;
            if (lastRetrainDate === istDate)
                return;
            lastRetrainDate = istDate;
            log.info('Weekly ML retrain triggered (Saturday 11:00 IST)');
            await this.runWeeklyMLRetrain();
        }, 60_000);
    }
    async runWeeklyMLRetrain() {
        try {
            if (!await isMLServiceAvailable()) {
                log.warn('Python ML service unavailable — skipping weekly retrain');
                return;
            }
            const perfData = await engineTrainingData();
            const outcomes = perfData?.outcomes ?? [];
            const rustLog = perfData?.training_log ?? [];
            log.info({ outcomes: outcomes.length, rustLog: rustLog.length }, 'Fetched training data from Performance Engine');
            const since = new Date();
            since.setDate(since.getDate() - 120);
            const decisions = await this.prisma.decisionAudit.findMany({
                where: {
                    createdAt: { gte: since },
                    outcome: { in: ['WIN', 'LOSS', 'BREAKEVEN'] },
                    decisionType: 'ENTRY_SIGNAL',
                },
                select: {
                    symbol: true, confidence: true, direction: true, outcome: true,
                    marketDataSnapshot: true, entryPrice: true, exitPrice: true, pnl: true, createdAt: true,
                },
                orderBy: { createdAt: 'desc' },
                take: 1000,
            });
            const trainingData = [];
            for (const d of decisions) {
                const snapshot = typeof d.marketDataSnapshot === 'string'
                    ? JSON.parse(d.marketDataSnapshot) : (d.marketDataSnapshot ?? {});
                trainingData.push({
                    features: {
                        ema_vote: snapshot.ema_vote ?? d.confidence * 0.5,
                        rsi_vote: snapshot.rsi_vote ?? 0,
                        macd_vote: snapshot.macd_vote ?? 0,
                        supertrend_vote: snapshot.supertrend_vote ?? 0,
                        bollinger_vote: snapshot.bollinger_vote ?? 0,
                        vwap_vote: snapshot.vwap_vote ?? 0,
                        momentum_vote: snapshot.momentum_vote ?? 0,
                        volume_vote: snapshot.volume_vote ?? 0,
                        composite_score: d.confidence,
                        regime: 1.0,
                        hour_of_day: d.createdAt.getHours(),
                        day_of_week: d.createdAt.getDay(),
                        raw_features: [],
                    },
                    outcome: d.outcome === 'WIN' ? 1.0 : d.outcome === 'BREAKEVEN' ? 0.5 : 0.0,
                });
            }
            for (const o of outcomes) {
                trainingData.push({
                    features: {
                        ema_vote: 0, rsi_vote: 0, macd_vote: 0, supertrend_vote: 0,
                        bollinger_vote: 0, vwap_vote: 0, momentum_vote: 0, volume_vote: 0,
                        composite_score: Number(o.predicted_confidence ?? 0.5),
                        regime: 1.0, hour_of_day: 10, day_of_week: 3, raw_features: [],
                    },
                    outcome: o.won ? 1.0 : 0.0,
                });
            }
            for (const entry of rustLog) {
                const outcomeVal = entry.outcome === 'WIN' ? 1.0 : entry.outcome === 'FLAT' ? 0.5 : 0.0;
                trainingData.push({
                    features: {
                        ema_vote: 0, rsi_vote: 0, macd_vote: 0, supertrend_vote: 0,
                        bollinger_vote: 0, vwap_vote: 0, momentum_vote: 0, volume_vote: 0,
                        composite_score: Number(entry.confidence ?? entry.ml_score ?? 0.5),
                        regime: 1.0, hour_of_day: 10, day_of_week: 3, raw_features: [],
                    },
                    outcome: outcomeVal,
                });
            }
            if (trainingData.length < 30) {
                log.info({ samples: trainingData.length }, 'Not enough training data for weekly retrain (need 30)');
                return;
            }
            const maxRawLen = Math.max(...trainingData.map(d => d.features.raw_features.length), 0);
            if (maxRawLen > 0) {
                for (const d of trainingData) {
                    const raw = d.features.raw_features;
                    while (raw.length < maxRawLen)
                        raw.push(0);
                }
            }
            const xgbResult = await mlTrain({
                training_data: trainingData,
                model_type: 'xgboost',
                walk_forward_days: 60,
                purge_gap_days: 5,
            });
            log.info({
                model: 'xgboost', accuracy: xgbResult.accuracy,
                auc: xgbResult.auc_roc, samples: xgbResult.training_samples,
            }, 'Weekly XGBoost retrain complete');
            const lgbResult = await mlTrain({
                training_data: trainingData,
                model_type: 'lightgbm',
                walk_forward_days: 60,
                purge_gap_days: 5,
            });
            log.info({
                model: 'lightgbm', accuracy: lgbResult.accuracy,
                auc: lgbResult.auc_roc, samples: lgbResult.training_samples,
            }, 'Weekly LightGBM retrain complete');
            const bestAcc = Math.max(xgbResult.accuracy, lgbResult.accuracy);
            const bestModel = xgbResult.accuracy >= lgbResult.accuracy ? 'xgboost' : 'lightgbm';
            await this.prisma.strategyParam.create({
                data: {
                    userId: 'system',
                    strategyId: 'weekly_retrain_metrics',
                    params: JSON.stringify({
                        xgboost: { accuracy: xgbResult.accuracy, auc: xgbResult.auc_roc },
                        lightgbm: { accuracy: lgbResult.accuracy, auc: lgbResult.auc_roc },
                        best_model: bestModel,
                        samples: trainingData.length,
                        outcome_samples: outcomes.length,
                        decision_samples: decisions.length,
                        retrained_at: new Date().toISOString(),
                    }),
                    isActive: true,
                    version: 1,
                    source: 'weekly_auto_retrain',
                },
            });
            emit('system', {
                type: 'LEARNING_UPDATE',
                userId: 'system',
                symbol: 'ML_RETRAIN',
                outcome: `${bestModel}_acc_${bestAcc.toFixed(3)}`,
                intradayWinRate: bestAcc,
                totalIntradayTrades: trainingData.length,
            }).catch(() => { });
            log.info({ bestModel, bestAcc, totalSamples: trainingData.length }, 'Weekly ML retrain completed successfully');
        }
        catch (err) {
            log.error({ err }, 'Weekly ML retrain failed');
        }
    }
    async runNightlyLearning() {
        if (this.running)
            return { usersProcessed: 0, insights: 0 };
        this.running = true;
        try {
            const users = await this.prisma.user.findMany({
                where: { isActive: true },
                select: { id: true },
            });
            let insightCount = 0;
            for (const user of users) {
                try {
                    await this.processUserLearning(user.id);
                    insightCount++;
                }
                catch (err) {
                    console.error(`[LearningEngine] Error processing user ${user.id}:`, err.message);
                }
            }
            return { usersProcessed: users.length, insights: insightCount };
        }
        finally {
            this.running = false;
        }
    }
    async processUserLearning(userId) {
        const today = new Date();
        today.setHours(0, 0, 0, 0);
        const todayEnd = new Date(today);
        todayEnd.setHours(23, 59, 59, 999);
        const trades = await this.prisma.trade.findMany({
            where: {
                portfolio: { userId },
                exitTime: { gte: today, lte: todayEnd },
            },
        });
        const signals = await this.prisma.aITradeSignal.findMany({
            where: {
                userId,
                createdAt: { gte: today, lte: todayEnd },
            },
        });
        await this.computeStrategyLedgers(userId, today, trades);
        await this.tagSignalOutcomes(userId, trades, signals);
        await this.autoPopulateJournals(userId, trades);
        const marketContext = await this.getMarketContext();
        const ledgers = await this.prisma.strategyLedger.findMany({
            where: { userId, date: today },
        });
        const insight = await this.generateLearningInsight(userId, today, ledgers, marketContext, trades.length);
        await this.runParameterOptimization(userId, today);
        // Enhanced: false positive analysis, regime tracking, strategy evolution
        await this.analyzeFalsePositives(userId, today, signals, trades);
        await this.trackRegimeAndAdjust(userId, today, insight.marketRegime, ledgers);
        await this.trackStrategyEvolution(userId, today, ledgers);
        // Phase 3: ML model retraining (using expanded features from feature_store)
        await this.retrainMLScorer(userId);
        // Phase 4: Strategy allocation optimization via Thompson sampling
        await this.optimizeStrategyAllocation(userId, ledgers);
        // Phase 5: Auto-calibration check
        await this.autoCalibrate(userId);
        log.info({ userId, trades: trades.length, regime: insight.marketRegime }, 'Nightly learning completed');
    }
    async computeStrategyLedgers(userId, date, trades) {
        const grouped = new Map();
        for (const trade of trades) {
            const key = trade.strategyTag || 'unknown';
            if (!grouped.has(key))
                grouped.set(key, []);
            grouped.get(key).push(trade);
        }
        for (const [strategyId, stratTrades] of grouped) {
            const wins = stratTrades.filter(t => Number(t.netPnl) > 0);
            const losses = stratTrades.filter(t => Number(t.netPnl) < 0);
            const grossPnl = stratTrades.reduce((s, t) => s + Number(t.grossPnl), 0);
            const netPnl = stratTrades.reduce((s, t) => s + Number(t.netPnl), 0);
            const winAmounts = wins.map(t => Number(t.netPnl));
            const lossAmounts = losses.map(t => Math.abs(Number(t.netPnl)));
            const avgWin = winAmounts.length > 0 ? winAmounts.reduce((a, b) => a + b, 0) / winAmounts.length : 0;
            const avgLoss = lossAmounts.length > 0 ? lossAmounts.reduce((a, b) => a + b, 0) / lossAmounts.length : 0;
            const winRate = stratTrades.length > 0 ? (wins.length / stratTrades.length) * 100 : 0;
            const returns = stratTrades.map(t => Number(t.netPnl));
            const mean = returns.length > 0 ? returns.reduce((a, b) => a + b, 0) / returns.length : 0;
            const variance = returns.length > 1
                ? returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length
                : 0;
            const std = Math.sqrt(variance);
            const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
            let peak = 0;
            let maxDD = 0;
            let cumulative = 0;
            for (const r of returns) {
                cumulative += r;
                if (cumulative > peak)
                    peak = cumulative;
                const dd = peak > 0 ? (peak - cumulative) / peak : 0;
                if (dd > maxDD)
                    maxDD = dd;
            }
            const activeParam = await this.prisma.strategyParam.findFirst({
                where: { userId, strategyId, isActive: true },
                orderBy: { createdAt: 'desc' },
            });
            const existingLedger = await this.prisma.strategyLedger.findUnique({
                where: { userId_strategyId_date: { userId, strategyId, date } },
            });
            const ledgerData = {
                tradesCount: stratTrades.length,
                wins: wins.length,
                losses: losses.length,
                grossPnl,
                netPnl,
                winRate: round2(winRate),
                avgWin: round2(avgWin),
                avgLoss: round2(avgLoss),
                sharpeRatio: round2(sharpe),
                maxDrawdown: round2(maxDD * 100),
                paramSnapshot: activeParam ? activeParam.params : '{}',
            };
            if (existingLedger) {
                await this.prisma.strategyLedger.update({
                    where: { id: existingLedger.id },
                    data: ledgerData,
                });
            }
            else {
                await this.prisma.strategyLedger.create({
                    data: { userId, strategyId, date, ...ledgerData },
                });
            }
        }
    }
    async tagSignalOutcomes(userId, trades, signals) {
        for (const signal of signals) {
            if (signal.outcomeTag)
                continue;
            const matchingTrade = trades.find(t => t.symbol === signal.symbol);
            if (!matchingTrade)
                continue;
            const pnl = Number(matchingTrade.netPnl);
            let outcomeTag;
            if (Math.abs(pnl) < 10)
                outcomeTag = 'BREAKEVEN';
            else if (pnl > 0)
                outcomeTag = 'WIN';
            else
                outcomeTag = 'LOSS';
            try {
                const notes = await chatCompletion({
                    messages: [
                        { role: 'system', content: 'You are a trade outcome analyst. Write a concise 1-sentence reason for why this trade resulted the way it did.' },
                        { role: 'user', content: `Signal: ${signal.symbol}, Status: ${signal.status}, PnL: ₹${pnl.toFixed(2)}, Outcome: ${outcomeTag}. Explain in one sentence.` },
                    ],
                    maxTokens: 100,
                    temperature: 0.3,
                });
                await this.prisma.aITradeSignal.update({
                    where: { id: signal.id },
                    data: { outcomeTag, outcomeNotes: notes.trim() },
                });
            }
            catch {
                await this.prisma.aITradeSignal.update({
                    where: { id: signal.id },
                    data: { outcomeTag },
                });
            }
            // Online ML model update — incremental learning on each resolved trade
            try {
                const outcomeValue = outcomeTag === 'WIN' ? 1.0 : outcomeTag === 'BREAKEVEN' ? 0.5 : 0.0;
                const features = {};
                if (signal.snapshot) {
                    const snap = typeof signal.snapshot === 'string' ? JSON.parse(signal.snapshot) : signal.snapshot;
                    for (const [k, v] of Object.entries(snap)) {
                        if (typeof v === 'number')
                            features[k] = v;
                    }
                }
                if (Object.keys(features).length > 3) {
                    mlOnlineUpdate(features, outcomeValue, signal.id).catch(err => log.warn({ err, decisionId: signal.id }, 'Online ML update failed'));
                }
            }
            catch { /* non-critical */ }
        }
    }
    async autoPopulateJournals(userId, trades) {
        for (const trade of trades) {
            const existing = await this.prisma.tradeJournal.findUnique({
                where: { tradeId: trade.id },
            });
            if (existing?.signalQualityReview && existing?.exitAnalysis)
                continue;
            try {
                const analysis = await chatCompletionJSON({
                    messages: [
                        {
                            role: 'system',
                            content: 'You are a trading journal analyst. Analyze the trade and provide brief feedback in JSON with keys: signalQualityReview, exitAnalysis, improvementSuggestion.',
                        },
                        {
                            role: 'user',
                            content: `Trade: ${trade.symbol} ${trade.side}, Entry: ₹${trade.entryPrice} at ${trade.entryTime.toISOString()}, Exit: ₹${trade.exitPrice} at ${trade.exitTime.toISOString()}, PnL: ₹${Number(trade.netPnl).toFixed(2)}`,
                        },
                    ],
                    maxTokens: 300,
                    temperature: 0.4,
                });
                if (existing) {
                    await this.prisma.tradeJournal.update({
                        where: { tradeId: trade.id },
                        data: {
                            signalQualityReview: analysis.signalQualityReview,
                            exitAnalysis: analysis.exitAnalysis,
                            improvementSuggestion: analysis.improvementSuggestion,
                        },
                    });
                }
                else {
                    await this.prisma.tradeJournal.create({
                        data: {
                            tradeId: trade.id,
                            userId,
                            signalQualityReview: analysis.signalQualityReview,
                            exitAnalysis: analysis.exitAnalysis,
                            improvementSuggestion: analysis.improvementSuggestion,
                        },
                    });
                }
            }
            catch (err) {
                console.error(`[LearningEngine] Journal auto-fill failed for trade ${trade.id}:`, err.message);
            }
        }
    }
    async getMarketContext() {
        try {
            const [vixData, indices, fiiDii] = await Promise.all([
                this.marketData.getVIX().catch(() => ({ value: 15, change: 0, changePercent: 0 })),
                this.marketData.getIndices().catch(() => []),
                this.marketData.getFIIDII().catch(() => ({ fii: { netBuy: 0 }, dii: { netBuy: 0 } })),
            ]);
            const nifty = indices.find((i) => i.name.includes('NIFTY'));
            return {
                vix: vixData.value,
                niftyChange: nifty?.changePercent ?? 0,
                fiiNetBuy: fiiDii?.fii?.netBuy ?? 0,
            };
        }
        catch {
            return { vix: 15, niftyChange: 0, fiiNetBuy: 0 };
        }
    }
    async generateLearningInsight(userId, date, ledgers, marketContext, totalTrades) {
        const strategyPerformance = ledgers.map(l => ({
            strategy: l.strategyId,
            winRate: l.winRate,
            netPnl: Number(l.netPnl),
            sharpe: l.sharpeRatio,
            trades: l.tradesCount,
        }));
        const sorted = [...strategyPerformance].sort((a, b) => b.netPnl - a.netPnl);
        const topWinners = sorted.filter(s => s.netPnl > 0).slice(0, 3);
        const topLosers = sorted.filter(s => s.netPnl < 0).slice(0, 3);
        let insight;
        try {
            insight = await chatCompletionJSON({
                messages: [
                    {
                        role: 'system',
                        content: `You are a quantitative trading analyst. Analyze today's trading performance and market conditions.
Return JSON with:
- marketRegime: one of "trending_up", "trending_down", "range_bound", "volatile"
- narrative: 2-3 paragraph analysis of what worked and what didn't
- paramAdjustments: suggested parameter changes for strategies (keys are strategy names, values are parameter objects)`,
                    },
                    {
                        role: 'user',
                        content: `Market Context: VIX=${marketContext.vix}, NIFTY change=${marketContext.niftyChange}%, FII net buy=₹${marketContext.fiiNetBuy}Cr.
Total trades today: ${totalTrades}.
Strategy performance: ${JSON.stringify(strategyPerformance)}
Top winners: ${JSON.stringify(topWinners)}
Top losers: ${JSON.stringify(topLosers)}`,
                    },
                ],
                maxTokens: 1000,
                temperature: 0.4,
            });
        }
        catch {
            insight = {
                marketRegime: marketContext.vix > 20 ? 'volatile' : (marketContext.niftyChange > 0.5 ? 'trending_up' : marketContext.niftyChange < -0.5 ? 'trending_down' : 'range_bound'),
                narrative: `Today saw ${totalTrades} trades across ${ledgers.length} strategies. VIX at ${marketContext.vix}. ${topWinners.length > 0 ? `Best performer: ${topWinners[0].strategy}` : 'No winning strategies today.'}`,
                paramAdjustments: {},
            };
        }
        const existing = await this.prisma.learningInsight.findUnique({
            where: { userId_date: { userId, date } },
        });
        const insightData = {
            marketRegime: insight.marketRegime,
            topWinningStrategies: JSON.stringify(topWinners.map(w => w.strategy)),
            topLosingStrategies: JSON.stringify(topLosers.map(l => l.strategy)),
            paramAdjustments: JSON.stringify(insight.paramAdjustments),
            narrative: insight.narrative,
        };
        if (existing) {
            await this.prisma.learningInsight.update({
                where: { id: existing.id },
                data: insightData,
            });
        }
        else {
            await this.prisma.learningInsight.create({
                data: { userId, date, ...insightData },
            });
        }
        return { marketRegime: insight.marketRegime };
    }
    async runParameterOptimization(userId, date) {
        const thirtyDaysAgo = new Date(date);
        thirtyDaysAgo.setDate(thirtyDaysAgo.getDate() - 30);
        for (const strategy of STRATEGIES) {
            try {
                const grid = DEFAULT_PARAM_GRIDS[strategy];
                if (!grid)
                    continue;
                const recentTrades = await this.prisma.trade.findMany({
                    where: {
                        portfolio: { userId },
                        strategyTag: strategy,
                        exitTime: { gte: thirtyDaysAgo },
                    },
                    take: 1,
                });
                if (recentTrades.length === 0)
                    continue;
                let candles = [];
                try {
                    const history = await this.marketData.getHistory('NIFTY 50', '1day', istDateStr(thirtyDaysAgo), istDateStr(date), userId, 'NSE');
                    candles = history.map((h) => ({
                        timestamp: h.date || h.timestamp || new Date().toISOString(),
                        open: Number(h.open),
                        high: Number(h.high),
                        low: Number(h.low),
                        close: Number(h.close),
                        volume: Number(h.volume || 0),
                    }));
                }
                catch {
                    continue;
                }
                if (candles.length < 20)
                    continue;
                const input = {
                    strategy,
                    symbol: 'NIFTY 50',
                    initial_capital: 1000000,
                    candles,
                    param_grid: grid,
                };
                const result = await engineOptimize(input);
                if (result.best_sharpe <= 0)
                    continue;
                await this.prisma.strategyParam.updateMany({
                    where: { userId, strategyId: strategy, isActive: true },
                    data: { isActive: false },
                });
                const latestParam = await this.prisma.strategyParam.findFirst({
                    where: { userId, strategyId: strategy },
                    orderBy: { version: 'desc' },
                });
                await this.prisma.strategyParam.create({
                    data: {
                        userId,
                        strategyId: strategy,
                        version: (latestParam?.version ?? 0) + 1,
                        params: JSON.stringify(result.best_params),
                        source: 'backtest_optimized',
                        backtestMetrics: JSON.stringify({
                            sharpe: result.best_sharpe,
                            winRate: result.best_win_rate,
                            profitFactor: result.best_profit_factor,
                        }),
                        isActive: true,
                    },
                });
            }
            catch (err) {
                console.error(`[LearningEngine] Optimization failed for ${strategy}:`, err.message);
            }
        }
    }
    async analyzeFalsePositives(userId, date, signals, trades) {
        const falsePositives = signals.filter(s => {
            if (s.outcomeTag === 'LOSS')
                return true;
            if (s.status === 'EXPIRED' || s.status === 'REJECTED')
                return true;
            if (s.status === 'EXECUTED') {
                const trade = trades.find(t => t.symbol === s.symbol);
                return trade && Number(trade.netPnl) < 0;
            }
            return false;
        });
        if (falsePositives.length === 0)
            return;
        // Group by symbol to find pattern
        const bySymbol = new Map();
        for (const fp of falsePositives) {
            bySymbol.set(fp.symbol, (bySymbol.get(fp.symbol) || 0) + 1);
        }
        const fpData = {
            date: istDateStr(date),
            total: falsePositives.length,
            bySymbol: Object.fromEntries(bySymbol),
            avgConfidence: falsePositives.reduce((s, fp) => s + fp.compositeScore, 0) / falsePositives.length,
            signals: falsePositives.map(fp => ({
                symbol: fp.symbol,
                type: fp.signalType,
                confidence: fp.compositeScore,
                status: fp.status,
                outcome: fp.outcomeTag,
            })),
        };
        try {
            await this.learningStore.writeFalsePositives(date, fpData);
        }
        catch (err) {
            console.error('[LearningEngine] FP store write failed:', err.message);
        }
    }
    async trackRegimeAndAdjust(userId, date, regime, ledgers) {
        const performanceSummary = {};
        for (const l of ledgers) {
            performanceSummary[l.strategyId] = {
                winRate: l.winRate,
                pnl: Number(l.netPnl),
                sharpe: l.sharpeRatio,
            };
        }
        try {
            await this.learningStore.writeRegimeLog(date, regime, {
                strategyPerformance: performanceSummary,
            });
        }
        catch (err) {
            console.error('[LearningEngine] Regime log write failed:', err.message);
        }
        // Persist to RegimeHistory table for transition analysis
        try {
            const dateOnly = new Date(istDateStr(date) + 'T00:00:00+05:30');
            const prev = await this.prisma.regimeHistory.findFirst({
                orderBy: { date: 'desc' },
                where: { date: { lt: dateOnly } },
            });
            let durationDays = 1;
            if (prev && prev.regime === regime) {
                durationDays = prev.durationDays + 1;
            }
            let niftyChange = null;
            let vix = null;
            try {
                const vixData = await this.marketData.getVIX().catch(() => null);
                vix = vixData?.value ?? null;
            }
            catch { /* skip */ }
            await this.prisma.regimeHistory.upsert({
                where: { date: dateOnly },
                update: {
                    regime,
                    confidence: 0.8,
                    durationDays,
                    niftyChange,
                    vix,
                    transitionFrom: prev && prev.regime !== regime ? prev.regime : null,
                    metadata: JSON.stringify(performanceSummary),
                },
                create: {
                    date: dateOnly,
                    regime,
                    confidence: 0.8,
                    durationDays,
                    niftyChange,
                    vix,
                    transitionFrom: prev && prev.regime !== regime ? prev.regime : null,
                    metadata: JSON.stringify(performanceSummary),
                },
            });
            if (prev && prev.regime !== regime) {
                log.info({ from: prev.regime, to: regime, prevDuration: prev.durationDays }, 'Regime transition detected');
            }
        }
        catch (err) {
            log.warn({ err }, 'Failed to persist regime history (non-fatal)');
        }
    }
    async getRegimeTransitionStats() {
        const recent = await this.prisma.regimeHistory.findMany({
            orderBy: { date: 'desc' },
            take: 90,
        });
        const current = recent[0];
        const transitions = recent
            .filter(r => r.transitionFrom)
            .slice(0, 10)
            .map(r => ({
            from: r.transitionFrom,
            to: r.regime,
            date: istDateStr(r.date),
            duration: r.durationDays,
        }));
        const regimeDurations = {};
        for (const r of recent.filter(r => r.transitionFrom)) {
            const key = r.transitionFrom;
            const entry = regimeDurations[key] ?? { totalDays: 0, count: 0 };
            entry.totalDays += r.durationDays;
            entry.count += 1;
            regimeDurations[key] = entry;
        }
        return {
            currentRegime: current?.regime ?? null,
            currentDuration: current?.durationDays ?? 0,
            recentTransitions: transitions,
            regimeDurations: Object.fromEntries(Object.entries(regimeDurations).map(([k, v]) => [k, { avgDays: round2(v.totalDays / v.count), count: v.count }])),
        };
    }
    async trackStrategyEvolution(userId, date, ledgers) {
        for (const ledger of ledgers) {
            if (ledger.tradesCount === 0)
                continue;
            const activeParam = await this.prisma.strategyParam.findFirst({
                where: { userId, strategyId: ledger.strategyId, isActive: true },
                select: { params: true, version: true },
            });
            try {
                await this.learningStore.writeStrategyEvolution(ledger.strategyId, {
                    date: istDateStr(date),
                    userId,
                    winRate: ledger.winRate,
                    pnl: Number(ledger.netPnl),
                    sharpe: ledger.sharpeRatio,
                    trades: ledger.tradesCount,
                    paramVersion: activeParam?.version ?? 0,
                    params: activeParam?.params ? JSON.parse(activeParam.params) : null,
                });
            }
            catch (err) {
                console.error(`[LearningEngine] Strategy evolution write failed for ${ledger.strategyId}:`, err.message);
            }
        }
        // Alpha decay tracking
        await this.trackAlphaDecay(userId, date, ledgers);
    }
    async trackAlphaDecay(userId, date, ledgers) {
        for (const ledger of ledgers) {
            try {
                const dateOnly = new Date(istDateStr(date) + 'T00:00:00+05:30');
                // Compute rolling Sharpe from recent trade history
                const windows = [30, 60, 90];
                const sharpes = {};
                let hitRate30d = null;
                for (const days of windows) {
                    const since = new Date(date);
                    since.setDate(since.getDate() - days);
                    const trades = await this.prisma.trade.findMany({
                        where: {
                            portfolio: { userId },
                            strategyTag: ledger.strategyId,
                            exitTime: { gte: since, lte: date },
                        },
                        select: { netPnl: true },
                    });
                    if (trades.length >= 5) {
                        const returns = trades.map(t => Number(t.netPnl));
                        const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
                        const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
                        sharpes[`sharpe${days}d`] = std > 0 ? (mean / std) * Math.sqrt(252 / days) : 0;
                        if (days === 30) {
                            hitRate30d = returns.filter(r => r > 0).length / returns.length;
                        }
                    }
                    else {
                        sharpes[`sharpe${days}d`] = null;
                    }
                }
                const isDecaying = (sharpes['sharpe30d'] ?? 1) < 0.5 && (sharpes['sharpe60d'] ?? 1) > (sharpes['sharpe30d'] ?? 0);
                await this.prisma.alphaDecay.upsert({
                    where: {
                        userId_strategyId_date: { userId, strategyId: ledger.strategyId, date: dateOnly },
                    },
                    update: {
                        sharpe30d: sharpes['sharpe30d'],
                        sharpe60d: sharpes['sharpe60d'],
                        sharpe90d: sharpes['sharpe90d'],
                        hitRate30d: hitRate30d,
                        signalCount: ledger.tradesCount,
                        isDecaying,
                    },
                    create: {
                        userId,
                        strategyId: ledger.strategyId,
                        date: dateOnly,
                        sharpe30d: sharpes['sharpe30d'],
                        sharpe60d: sharpes['sharpe60d'],
                        sharpe90d: sharpes['sharpe90d'],
                        hitRate30d: hitRate30d,
                        signalCount: ledger.tradesCount,
                        isDecaying,
                    },
                });
                if (isDecaying) {
                    console.warn(`[LearningEngine] Alpha decay detected for ${ledger.strategyId}: 30d Sharpe=${sharpes['sharpe30d']?.toFixed(2)}`);
                }
            }
            catch (err) {
                console.error(`[LearningEngine] Alpha decay tracking failed for ${ledger.strategyId}:`, err.message);
            }
        }
    }
    async retrainMLScorer(userId) {
        try {
            if (!isEngineAvailable())
                return;
            // Collect last 90 days of decision audits with outcomes
            const since = new Date();
            since.setDate(since.getDate() - 90);
            const decisions = await this.prisma.decisionAudit.findMany({
                where: {
                    userId,
                    createdAt: { gte: since },
                    outcome: { in: ['WIN', 'LOSS', 'BREAKEVEN'] },
                    decisionType: 'ENTRY_SIGNAL',
                },
                select: {
                    symbol: true,
                    confidence: true,
                    direction: true,
                    outcome: true,
                    marketDataSnapshot: true,
                    entryPrice: true,
                    exitPrice: true,
                    pnl: true,
                    createdAt: true,
                },
                orderBy: { createdAt: 'desc' },
                take: 500,
            });
            if (decisions.length < 30) {
                log.info({ userId, samples: decisions.length }, 'Not enough samples for ML retraining (need 30)');
                return;
            }
            // Build training data, enriching with full 76-feature vectors from the Feature Store
            const trainingData = [];
            for (const d of decisions) {
                const snapshot = typeof d.marketDataSnapshot === 'string'
                    ? JSON.parse(d.marketDataSnapshot) : d.marketDataSnapshot;
                const hour = d.createdAt.getHours();
                const dow = d.createdAt.getDay();
                // Attempt to compute rich features from stored candle data
                let rawFeatures = [];
                if (isEngineAvailable()) {
                    try {
                        const fromDate = istDateStr(new Date(d.createdAt.getTime() - 60 * 86400000));
                        const toDate = istDateStr(d.createdAt);
                        const candles = await this.marketData.getHistory(d.symbol, '1d', fromDate, toDate, undefined, 'NSE');
                        if (candles && candles.length >= 30) {
                            const featureResult = await engineFeatureStore({
                                command: 'extract_features',
                                candles: candles.map((c) => ({
                                    timestamp: c.timestamp || c.date,
                                    open: c.open, high: c.high, low: c.low,
                                    close: c.close, volume: c.volume,
                                })),
                            });
                            // Use the last row of features (most recent day)
                            if (featureResult?.features?.data?.length > 0) {
                                const lastRow = featureResult.features.data[featureResult.features.data.length - 1];
                                rawFeatures = lastRow;
                            }
                        }
                    }
                    catch {
                        // Fall back to empty raw_features — base features still work
                    }
                }
                trainingData.push({
                    features: {
                        ema_vote: snapshot?.ema_vote ?? d.confidence * 0.5,
                        rsi_vote: snapshot?.rsi_vote ?? 0,
                        macd_vote: snapshot?.macd_vote ?? 0,
                        supertrend_vote: snapshot?.supertrend_vote ?? 0,
                        bollinger_vote: snapshot?.bollinger_vote ?? 0,
                        vwap_vote: snapshot?.vwap_vote ?? 0,
                        momentum_vote: snapshot?.momentum_vote ?? d.confidence * 0.6,
                        volume_vote: snapshot?.volume_vote ?? 0,
                        composite_score: d.confidence,
                        regime: 1.0,
                        hour_of_day: hour,
                        day_of_week: dow,
                        raw_features: rawFeatures,
                    },
                    outcome: d.outcome === 'WIN' ? 1.0 : d.outcome === 'BREAKEVEN' ? 0.5 : 0.0,
                });
            }
            // Feed false positive files as negative training samples (outcome=0, weight=0.5x)
            try {
                const fpFiles = this.learningStore.readRecentFalsePositives(30);
                for (const fpDay of fpFiles) {
                    for (const sig of fpDay.signals) {
                        trainingData.push({
                            features: {
                                ema_vote: 0,
                                rsi_vote: 0,
                                macd_vote: 0,
                                supertrend_vote: 0,
                                bollinger_vote: 0,
                                vwap_vote: 0,
                                momentum_vote: 0,
                                volume_vote: 0,
                                composite_score: sig.confidence ?? 0.5,
                                regime: 1.0,
                                hour_of_day: 10,
                                day_of_week: 3,
                                raw_features: [],
                            },
                            outcome: 0.0,
                        });
                    }
                }
                if (fpFiles.length > 0) {
                    const fpSamples = fpFiles.reduce((s, f) => s + f.signals.length, 0);
                    log.info({ fpFiles: fpFiles.length, fpSamples }, 'False positive samples added to training data');
                }
            }
            catch (fpErr) {
                log.warn({ err: fpErr }, 'Failed to load false positive files for retraining (non-fatal)');
            }
            // Merge Rust EOD outcomes from ml_training_log.json
            try {
                const rustLogPath = resolve(__dirname, '..', '..', '..', 'data', 'ml_training_log.json');
                if (existsSync(rustLogPath)) {
                    const rustEntries = JSON.parse(readFileSync(rustLogPath, 'utf-8'));
                    const since90d = new Date();
                    since90d.setDate(since90d.getDate() - 90);
                    // Dedup against existing decision audit entries (by symbol + date)
                    const existingKeys = new Set(decisions.map(d => `${d.symbol}:${istDateStr(d.createdAt)}`));
                    let mergedCount = 0;
                    for (const entry of rustEntries) {
                        const entryDate = entry.timestamp?.split('T')[0] ?? '';
                        if (new Date(entryDate) < since90d)
                            continue;
                        const key = `${entry.symbol}:${entryDate}`;
                        if (existingKeys.has(key))
                            continue;
                        const outcomeVal = entry.outcome === 'WIN' ? 1.0
                            : entry.outcome === 'FLAT' ? 0.5
                                : 0.0;
                        trainingData.push({
                            features: {
                                ema_vote: 0,
                                rsi_vote: 0,
                                macd_vote: 0,
                                supertrend_vote: 0,
                                bollinger_vote: 0,
                                vwap_vote: 0,
                                momentum_vote: 0,
                                volume_vote: 0,
                                composite_score: entry.confidence ?? entry.ml_score ?? 0.5,
                                regime: 1.0,
                                hour_of_day: 10,
                                day_of_week: 3,
                                raw_features: [],
                            },
                            outcome: outcomeVal,
                        });
                        mergedCount++;
                    }
                    if (mergedCount > 0) {
                        log.info({ mergedCount, totalRustEntries: rustEntries.length }, 'Rust EOD training data merged into unified training set');
                    }
                }
            }
            catch (rustErr) {
                log.warn({ err: rustErr }, 'Failed to read Rust ml_training_log.json (non-fatal)');
            }
            // Ensure all feature rows have consistent dimension (some may lack raw_features)
            const maxRawLen = Math.max(...trainingData.map(d => d.features.raw_features.length));
            if (maxRawLen > 0) {
                for (const d of trainingData) {
                    while (d.features.raw_features.length < maxRawLen) {
                        d.features.raw_features.push(0);
                    }
                }
            }
            const result = await engineMLScore({
                command: 'train',
                training_data: trainingData,
                learning_rate: 0.01,
                epochs: 500,
            });
            // Persist weights for the bot engine to load
            const existingWeights = await this.prisma.strategyParam.findFirst({
                where: { userId, strategyId: 'ml_scorer_weights' },
                orderBy: { createdAt: 'desc' },
            });
            if (existingWeights) {
                await this.prisma.strategyParam.update({
                    where: { id: existingWeights.id },
                    data: {
                        params: JSON.stringify(result.weights),
                        isActive: true,
                        version: existingWeights.version + 1,
                    },
                });
            }
            else {
                await this.prisma.strategyParam.create({
                    data: {
                        userId,
                        strategyId: 'ml_scorer_weights',
                        params: JSON.stringify(result.weights),
                        isActive: true,
                        version: 1,
                    },
                });
            }
            log.info({
                userId,
                accuracy: result.training_accuracy,
                samples: result.samples_used,
            }, 'Rust ML scorer retrained');
            // Also train Python XGBoost/LightGBM if available
            if (await isMLServiceAvailable()) {
                try {
                    const xgbResult = await mlTrain({
                        training_data: trainingData,
                        model_type: 'xgboost',
                        walk_forward_days: 30,
                        purge_gap_days: 5,
                    });
                    log.info({
                        userId,
                        model: 'xgboost',
                        accuracy: xgbResult.accuracy,
                        auc: xgbResult.auc_roc,
                        trainSamples: xgbResult.training_samples,
                    }, 'Python XGBoost model retrained');
                    const lgbResult = await mlTrain({
                        training_data: trainingData,
                        model_type: 'lightgbm',
                        walk_forward_days: 30,
                        purge_gap_days: 5,
                    });
                    log.info({
                        userId,
                        model: 'lightgbm',
                        accuracy: lgbResult.accuracy,
                        auc: lgbResult.auc_roc,
                    }, 'Python LightGBM model retrained');
                    // Cross-model ensemble: compute blend weights based on relative accuracy
                    const rustAcc = result.training_accuracy ?? 0.5;
                    const pyAcc = Math.max(xgbResult.accuracy, lgbResult.accuracy);
                    const totalAcc = rustAcc + pyAcc;
                    const rustBlendWeight = totalAcc > 0 ? round2(rustAcc / totalAcc) : 0.5;
                    const pythonBlendWeight = totalAcc > 0 ? round2(pyAcc / totalAcc) : 0.5;
                    const blendParam = await this.prisma.strategyParam.findFirst({
                        where: { userId, strategyId: 'model_blend_weights' },
                        orderBy: { createdAt: 'desc' },
                    });
                    const blendData = JSON.stringify({
                        rustWeight: rustBlendWeight,
                        pythonWeight: pythonBlendWeight,
                        rustAccuracy: rustAcc,
                        pythonAccuracy: pyAcc,
                        computedAt: new Date().toISOString(),
                    });
                    if (blendParam) {
                        await this.prisma.strategyParam.update({
                            where: { id: blendParam.id },
                            data: { params: blendData, isActive: true, version: blendParam.version + 1 },
                        });
                    }
                    else {
                        await this.prisma.strategyParam.create({
                            data: {
                                userId,
                                strategyId: 'model_blend_weights',
                                params: blendData,
                                isActive: true,
                                version: 1,
                            },
                        });
                    }
                    log.info({ userId, rustBlendWeight, pythonBlendWeight, rustAcc, pyAcc }, 'Cross-model blend weights computed and persisted');
                }
                catch (pyErr) {
                    log.warn({ err: pyErr }, 'Python ML training failed (non-fatal, Rust model still active)');
                }
            }
            // Retrain ensemble meta-learner with recent decision audit outcomes
            try {
                const recentDecisions = await this.prisma.decisionAudit.findMany({
                    where: {
                        userId,
                        outcome: { in: ['WIN', 'LOSS', 'BREAKEVEN'] },
                        createdAt: { gte: new Date(Date.now() - 60 * 86400_000) },
                    },
                    orderBy: { createdAt: 'asc' },
                    take: 500,
                });
                if (recentDecisions.length >= 30) {
                    const ensembleTrainingData = recentDecisions.map(d => {
                        const snap = typeof d.marketDataSnapshot === 'string' ? JSON.parse(d.marketDataSnapshot) : {};
                        return {
                            xgb_prob: Number(snap.pythonScore ?? snap.mlScore ?? 0.5),
                            lgb_prob: Number(snap.challengerScore ?? snap.pythonScore ?? 0.5),
                            lstm_prob: Number(snap.lstmProb ?? 0.5),
                            tft_prob: Number(snap.tftProb ?? 0.5),
                            return_pred: Number(snap.expectedReturn ?? 0),
                            online_prob: Number(snap.onlineProb ?? 0.5),
                            regime_id: snap.regime === 'TRENDING_UP' ? 0 : snap.regime === 'TRENDING_DOWN' ? 1 : snap.regime === 'VOLATILE' ? 3 : 2,
                            vix_level: Number(snap.vixLevel ?? 15),
                            outcome: d.outcome === 'WIN' ? 1.0 : d.outcome === 'BREAKEVEN' ? 0.5 : 0.0,
                        };
                    });
                    const ensembleResp = await fetch(`${process.env.ML_SERVICE_URL ?? 'http://localhost:8002'}/ensemble-train`, {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ training_data: ensembleTrainingData }),
                        signal: AbortSignal.timeout(30000),
                    });
                    if (ensembleResp.ok) {
                        const result = await ensembleResp.json();
                        log.info({ result }, 'Ensemble meta-learner retrained');
                    }
                }
            }
            catch (err) {
                log.warn({ err }, 'Ensemble retraining failed — non-critical');
            }
        }
        catch (err) {
            log.error({ err, userId }, 'ML scorer retraining failed');
        }
    }
    async optimizeStrategyAllocation(userId, ledgers) {
        try {
            if (!isEngineAvailable())
                return;
            if (ledgers.length === 0)
                return;
            // Get alpha decay data for each strategy
            const decayData = await this.prisma.alphaDecay.findMany({
                where: { userId },
                orderBy: { date: 'desc' },
                distinct: ['strategyId'],
            });
            const decayMap = new Map(decayData.map(d => [d.strategyId, d.isDecaying]));
            // Get recent backtest results as priors for allocation
            const backtestResults = await this.prisma.backtestResult.findMany({
                where: { userId },
                orderBy: { createdAt: 'desc' },
                distinct: ['strategyId'],
                select: { strategyId: true, sharpeRatio: true, winRate: true, profitFactor: true },
            });
            const backtestMap = new Map(backtestResults.map(b => [b.strategyId, b]));
            const strategyStats = ledgers.map(l => {
                const bt = backtestMap.get(l.strategyId);
                const liveSharpe = l.sharpeRatio;
                const backtestSharpe = bt?.sharpeRatio ?? null;
                // Blend live and backtest Sharpe: 70% live, 30% backtest prior
                let blendedSharpe = liveSharpe;
                if (backtestSharpe !== null) {
                    blendedSharpe = liveSharpe * 0.7 + Number(backtestSharpe) * 0.3;
                }
                // Accelerate decay for strategies with poor backtest AND poor live performance
                const isDecaying = decayMap.get(l.strategyId) ?? false;
                const fastDecay = isDecaying && backtestSharpe !== null && Number(backtestSharpe) < 0.3;
                return {
                    strategy_id: l.strategyId,
                    wins: l.wins,
                    losses: l.losses,
                    sharpe: round2(blendedSharpe),
                    is_decaying: fastDecay || isDecaying,
                };
            });
            const user = await this.prisma.user.findUnique({
                where: { id: userId },
                select: { virtualCapital: true },
            });
            const capital = Number(user?.virtualCapital ?? 1_000_000);
            const result = await engineMLScore({
                command: 'allocate',
                strategy_stats: strategyStats,
                total_capital: capital,
            });
            if (result?.allocations) {
                // Persist allocation result so bot-engine can use it for capital sizing
                const existingAlloc = await this.prisma.strategyParam.findFirst({
                    where: { userId, strategyId: 'strategy_allocations' },
                    orderBy: { createdAt: 'desc' },
                });
                const allocData = JSON.stringify({
                    allocations: result.allocations,
                    method: result.method,
                    computedAt: new Date().toISOString(),
                });
                if (existingAlloc) {
                    await this.prisma.strategyParam.update({
                        where: { id: existingAlloc.id },
                        data: { params: allocData, isActive: true, version: existingAlloc.version + 1 },
                    });
                }
                else {
                    await this.prisma.strategyParam.create({
                        data: {
                            userId,
                            strategyId: 'strategy_allocations',
                            params: allocData,
                            isActive: true,
                            version: 1,
                        },
                    });
                }
                log.info({
                    userId,
                    allocations: result.allocations,
                    method: result.method,
                }, 'Strategy allocation optimized and persisted (Rust)');
            }
            // Also call Python ML service for enhanced Bayesian allocation and merge results
            if (await isMLServiceAvailable()) {
                try {
                    const pyResult = await mlAllocate({
                        strategy_stats: strategyStats.map(s => ({
                            ...s,
                            avg_return: 0,
                        })),
                        total_capital: capital,
                        current_regime: 'unknown',
                        risk_budget_pct: 2.0,
                    });
                    log.info({
                        userId,
                        allocations: pyResult.allocations,
                        method: pyResult.method,
                        explorationRate: pyResult.exploration_rate,
                    }, 'Python strategy allocation computed');
                    // Merge Python allocation with Rust allocation (60% Rust, 40% Python)
                    if (result?.allocations && pyResult.allocations) {
                        const rustWeight = 0.6;
                        const pyWeight = 0.4;
                        const mergedAllocations = {};
                        const allStrategies = new Set([
                            ...Object.keys(result.allocations),
                            ...Object.keys(pyResult.allocations),
                        ]);
                        for (const strat of allStrategies) {
                            const rustVal = result.allocations[strat] ?? 0;
                            const pyVal = pyResult.allocations[strat] ?? 0;
                            mergedAllocations[strat] = round2(rustVal * rustWeight + pyVal * pyWeight);
                        }
                        const mergedAllocData = JSON.stringify({
                            allocations: mergedAllocations,
                            rustAllocations: result.allocations,
                            pythonAllocations: pyResult.allocations,
                            method: `merged(rust=${rustWeight},python=${pyWeight})`,
                            pythonMethod: pyResult.method,
                            explorationRate: pyResult.exploration_rate,
                            computedAt: new Date().toISOString(),
                        });
                        const currentAlloc = await this.prisma.strategyParam.findFirst({
                            where: { userId, strategyId: 'strategy_allocations' },
                            orderBy: { createdAt: 'desc' },
                        });
                        if (currentAlloc) {
                            await this.prisma.strategyParam.update({
                                where: { id: currentAlloc.id },
                                data: { params: mergedAllocData, isActive: true, version: currentAlloc.version + 1 },
                            });
                        }
                        log.info({ userId, mergedAllocations }, 'Merged Rust+Python allocation persisted');
                    }
                }
                catch (pyErr) {
                    log.warn({ err: pyErr }, 'Python allocation failed (non-fatal)');
                }
            }
        }
        catch (err) {
            log.error({ err, userId }, 'Strategy allocation optimization failed');
        }
    }
    // Track consecutive losses per strategy for intraday deallocation
    consecutiveLosses = new Map();
    intradayTradeCount = 0;
    lastRegimeCheck = 0;
    /**
     * Intraday Bayesian update — called on each POSITION_CLOSED event during trading hours.
     * Updates per-strategy Thompson sampling alpha/beta, adjusts confidence,
     * persists state to Redis, and triggers regime re-detection every 5 trades.
     */
    async runIntradayUpdate(trade) {
        const { strategyTag, netPnl, userId } = trade;
        if (!strategyTag)
            return;
        const won = netPnl > 0;
        const key = `${userId}:${strategyTag}`;
        this.intradayTradeCount++;
        // Update consecutive loss tracker
        if (won) {
            this.consecutiveLosses.set(key, 0);
        }
        else {
            const prev = this.consecutiveLosses.get(key) ?? 0;
            this.consecutiveLosses.set(key, prev + 1);
        }
        const consecutiveLossCount = this.consecutiveLosses.get(key) ?? 0;
        // Update StrategyParam confidence in DB
        try {
            const activeParam = await this.prisma.strategyParam.findFirst({
                where: { userId, strategyId: strategyTag, isActive: true },
                orderBy: { createdAt: 'desc' },
            });
            if (activeParam) {
                const currentParams = typeof activeParam.params === 'string'
                    ? JSON.parse(activeParam.params) : (activeParam.params ?? {});
                // Bayesian confidence update: shift confidence toward actual outcomes
                const priorConfidence = currentParams.confidence ?? 1.0;
                const learningRate = 0.1;
                const newConfidence = priorConfidence * (1 - learningRate) + (won ? 1.0 : 0.0) * learningRate;
                // Apply penalty for 3+ consecutive losses: reduce allocation by 50%
                const confidenceMultiplier = consecutiveLossCount >= 3 ? 0.5 : 1.0;
                currentParams.confidence = Math.round(newConfidence * confidenceMultiplier * 1000) / 1000;
                currentParams.intradayWins = (currentParams.intradayWins ?? 0) + (won ? 1 : 0);
                currentParams.intradayLosses = (currentParams.intradayLosses ?? 0) + (won ? 0 : 1);
                currentParams.consecutiveLosses = consecutiveLossCount;
                currentParams.lastUpdateTime = new Date().toISOString();
                await this.prisma.strategyParam.update({
                    where: { id: activeParam.id },
                    data: { params: JSON.stringify(currentParams) },
                });
                if (consecutiveLossCount >= 3) {
                    log.warn({
                        userId, strategyTag, consecutiveLossCount,
                        reducedConfidence: currentParams.confidence,
                    }, 'Strategy throttled: 3+ consecutive losses, allocation reduced 50%');
                }
            }
        }
        catch (err) {
            log.warn({ err, strategyTag, userId }, 'Intraday Bayesian update failed');
        }
        // Persist Thompson sampling state to Redis for crash recovery
        await this.persistThompsonState(userId, strategyTag, won);
        // Intraday regime re-detection every 5 trades
        if (this.intradayTradeCount % 5 === 0) {
            this.intradayRegimeRecheck(userId).catch(err => log.warn({ err }, 'Intraday regime recheck failed'));
        }
        // Intraday alpha decay check every 10 trades
        if (this.intradayTradeCount % 10 === 0) {
            this.intradayAlphaDecayCheck(userId, strategyTag).catch(err => log.warn({ err }, 'Intraday alpha decay check failed'));
        }
        // --- Intelligent Trading Brain: intraday learning ---
        try {
            const recentMemories = await getPrisma().marketMemory.findMany({
                where: { userId, symbol: trade.symbol, outcome: null },
                orderBy: { createdAt: 'desc' },
                take: 1,
            });
            if (recentMemories.length > 0) {
                const memory = recentMemories[0];
                const outcome = won ? 'WIN' : 'LOSS';
                const pnlPct = trade.netPnl;
                const holdingMinutes = Math.round((Date.now() - memory.timestamp.getTime()) / 60000);
                const lesson = this.lessonsEngine.generateLesson({
                    symbol: trade.symbol,
                    signalDirection: memory.signalDirection,
                    signalStrategy: memory.signalStrategy,
                    niftyBand: memory.niftyBand,
                    vixLevel: memory.vixLevel,
                    regime: memory.regime,
                    outcome,
                    pnlPct,
                    holdingMinutes,
                    dayOfWeek: memory.dayOfWeek,
                    hourOfDay: memory.hourOfDay,
                    gapPct: memory.gapPct,
                    signalConfidence: memory.signalConfidence,
                });
                await this.marketMemory.resolveMemory(memory.id, outcome, pnlPct, holdingMinutes, lesson);
                log.info({ symbol: trade.symbol, outcome, lesson: lesson.substring(0, 100) }, 'Market memory resolved with lesson');
            }
            this.intradayWinTracker.total++;
            if (won)
                this.intradayWinTracker.wins++;
            if (this.intradayWinTracker.total >= 5) {
                const winRate = this.intradayWinTracker.wins / this.intradayWinTracker.total;
                if (winRate < 0.4) {
                    await this.fusionService.updateThresholds(userId, 0.05);
                    log.warn({ userId, winRate, totalTrades: this.intradayWinTracker.total }, 'Intraday win rate < 40% — raising decision fusion thresholds');
                }
            }
            emit('system', {
                type: 'LEARNING_UPDATE', userId,
                symbol: trade.symbol, outcome: won ? 'WIN' : 'LOSS',
                intradayWinRate: this.intradayWinTracker.total > 0
                    ? this.intradayWinTracker.wins / this.intradayWinTracker.total : 0.5,
                totalIntradayTrades: this.intradayWinTracker.total,
            }).catch(() => { });
        }
        catch (err) {
            log.warn({ err, symbol: trade.symbol }, 'Intraday learning extension failed');
        }
    }
    async persistThompsonState(userId, strategyTag, won) {
        try {
            const redis = getRedis();
            if (!redis)
                return;
            const key = `cg:thompson:${userId}:${strategyTag}`;
            const raw = await redis.get(key);
            const state = raw ? JSON.parse(raw) : { alpha: 1, beta: 1, emaWinRate: 0.5, totalTrades: 0 };
            if (won) {
                state.alpha += 1;
            }
            else {
                state.beta += 1;
            }
            state.totalTrades += 1;
            const decay = 0.05;
            state.emaWinRate = state.emaWinRate * (1 - decay) + (won ? 1.0 : 0.0) * decay;
            state.lastUpdate = new Date().toISOString();
            await redis.set(key, JSON.stringify(state), 'EX', 24 * 3600);
        }
        catch (err) {
            log.warn({ err, userId, strategyTag }, 'Failed to persist Thompson state');
        }
    }
    async intradayRegimeRecheck(userId) {
        const now = Date.now();
        if (now - this.lastRegimeCheck < 120_000)
            return;
        this.lastRegimeCheck = now;
        if (!await isMLServiceAvailable())
            return;
        try {
            const candles = await this.marketData.getHistory('NIFTY 50', '5m', istDaysAgo(5), istDateStr(), undefined, 'NSE');
            if (!candles || candles.length < 30)
                return;
            const closes = candles.slice(-60).map(c => c.close);
            const returns = closes.slice(1).map((c, i) => (c - closes[i]) / closes[i]);
            const volatility = returns.map((_, i) => {
                const window = returns.slice(Math.max(0, i - 9), i + 1);
                const mean = window.reduce((a, b) => a + b, 0) / window.length;
                return Math.sqrt(window.reduce((s, r) => s + (r - mean) ** 2, 0) / window.length);
            });
            const regime = await mlDetectRegime({ returns, volatility });
            const redis = getRedis();
            if (redis && regime?.current_regime) {
                const maxProb = Math.max(...Object.values(regime.regime_probabilities ?? {}), 0);
                await redis.set(`cg:intraday_regime:${userId}`, JSON.stringify({
                    regime: regime.current_regime,
                    confidence: maxProb,
                    timestamp: new Date().toISOString(),
                }), 'EX', 3600);
                log.info({ userId, regime: regime.current_regime, confidence: maxProb }, 'Intraday regime re-detected');
            }
        }
        catch (err) {
            log.warn({ err, userId }, 'Intraday regime recheck failed');
        }
    }
    async intradayAlphaDecayCheck(userId, strategyTag) {
        try {
            const since = new Date();
            since.setDate(since.getDate() - 7);
            const recentTrades = await this.prisma.trade.findMany({
                where: {
                    portfolio: { userId },
                    strategyTag,
                    exitTime: { gte: since },
                },
                select: { netPnl: true },
                orderBy: { exitTime: 'desc' },
                take: 20,
            });
            if (recentTrades.length < 5)
                return;
            const returns = recentTrades.map(t => Number(t.netPnl));
            const wins = returns.filter(r => r > 0).length;
            const hitRate = wins / returns.length;
            const mean = returns.reduce((a, b) => a + b, 0) / returns.length;
            const std = Math.sqrt(returns.reduce((s, r) => s + (r - mean) ** 2, 0) / returns.length);
            const recentSharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;
            const isDecaying = recentSharpe < 0.3 && hitRate < 0.4;
            if (isDecaying) {
                log.warn({
                    userId, strategyTag, recentSharpe: round2(recentSharpe),
                    hitRate: round2(hitRate), sampleSize: returns.length,
                }, 'Intraday alpha decay detected — strategy underperforming in recent trades');
                const redis = getRedis();
                if (redis) {
                    await redis.set(`cg:alpha_decay_alert:${userId}:${strategyTag}`, JSON.stringify({ isDecaying, recentSharpe, hitRate, detectedAt: new Date().toISOString() }), 'EX', 8 * 3600);
                }
            }
        }
        catch (err) {
            log.warn({ err, userId, strategyTag }, 'Intraday alpha decay check failed');
        }
    }
    /**
     * Reset intraday learning state at market open.
     * Called by the server orchestrator at 9:15 IST.
     */
    async autoCalibrate(userId) {
        if (!await isMLServiceAvailable())
            return;
        try {
            const since = new Date();
            since.setDate(since.getDate() - 30);
            const decisions = await this.prisma.decisionAudit.findMany({
                where: {
                    userId,
                    decisionType: 'ENTRY_SIGNAL',
                    outcome: { in: ['WIN', 'LOSS'] },
                    resolvedAt: { not: null },
                    createdAt: { gte: since },
                },
                select: { confidence: true, outcome: true },
                take: 200,
            });
            if (decisions.length < 30)
                return;
            const predictions = decisions.map(d => d.confidence);
            const actuals = decisions.map(d => d.outcome === 'WIN' ? 1.0 : 0.0);
            // Compute Brier score: mean((predicted - actual)^2)
            const brierScore = predictions.reduce((sum, p, i) => sum + (p - actuals[i]) ** 2, 0) / predictions.length;
            log.info({ userId, brierScore, samples: decisions.length }, 'Calibration check');
            if (brierScore > 0.25) {
                const { mlCalibrate } = await import('../lib/ml-service-client.js');
                const result = await mlCalibrate({ predictions, actuals, model_type: 'xgboost' });
                log.info({
                    userId,
                    brierScore,
                    calibrated: result.calibrated,
                    message: result.message,
                }, 'Auto-calibration triggered');
                // Adjust signal thresholds if model is miscalibrated
                const agentConfig = await this.prisma.aIAgentConfig.findUnique({ where: { userId } });
                if (agentConfig) {
                    const newMinScore = Math.min(0.85, agentConfig.minSignalScore + 0.05);
                    await this.prisma.aIAgentConfig.update({
                        where: { userId },
                        data: { minSignalScore: round2(newMinScore) },
                    });
                    log.info({ userId, oldScore: agentConfig.minSignalScore, newScore: newMinScore }, 'Signal threshold tightened due to poor calibration');
                }
            }
        }
        catch (err) {
            log.warn({ err, userId }, 'Auto-calibration failed (non-fatal)');
        }
    }
    resetIntradayState() {
        this.consecutiveLosses.clear();
        this.intradayTradeCount = 0;
        this.lastRegimeCheck = 0;
        log.info('Intraday learning state reset for new trading day');
    }
}
function round2(v) {
    return Math.round(v * 100) / 100;
}
//# sourceMappingURL=learning-engine.js.map