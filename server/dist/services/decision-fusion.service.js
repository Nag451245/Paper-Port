import { createChildLogger } from '../lib/logger.js';
import { getRedis } from '../lib/redis.js';
const log = createChildLogger('decision-fusion');
const THRESHOLD_TTL_SECONDS = 8 * 60 * 60;
const REGIME_ALIGNMENT = {
    TRENDING_UP: { BUY: 1.0, SELL: 0.3 },
    TRENDING_DOWN: { BUY: 0.3, SELL: 1.0 },
    MEAN_REVERTING: { BUY: 0.7, SELL: 0.7 },
    VOLATILE: { BUY: 0.4, SELL: 0.4 },
    QUIET: { BUY: 0.5, SELL: 0.5 },
};
export class DecisionFusionService {
    minExecuteScore;
    minWatchScore;
    constructor(minExecuteScore = 0.55, minWatchScore = 0.35) {
        this.minExecuteScore = minExecuteScore;
        this.minWatchScore = minWatchScore;
    }
    async decide(rustSignal, mlScore, memoryRecall, regime, strategyHealth, userId) {
        let minExecuteScore = this.minExecuteScore;
        let minWatchScore = this.minWatchScore;
        if (userId) {
            try {
                const adaptive = await this.getAdaptiveThresholds(userId);
                minExecuteScore = adaptive.minExecute;
                minWatchScore = adaptive.minWatch;
            }
            catch { /* use defaults */ }
        }
        let rustWeight = 0.30;
        let mlWeight = 0.35;
        let memoryWeight = 0.20;
        let regimeWeight = 0.15;
        const adjustments = [];
        if (!mlScore.available) {
            rustWeight = 0.50;
            memoryWeight = 0.30;
            mlWeight = 0.0;
            regimeWeight = 0.20;
        }
        if (memoryRecall.similarCases < 5) {
            const freed = memoryWeight - 0.05;
            memoryWeight = 0.05;
            if (mlScore.available) {
                mlWeight += freed * 0.6;
                rustWeight += freed * 0.4;
            }
            else {
                rustWeight += freed;
            }
        }
        const vix = rustSignal.indicators['vix'] ?? rustSignal.indicators['VIX'] ?? 0;
        if (vix > 25) {
            regimeWeight = 0.25;
            rustWeight = Math.max(0.15, rustWeight - 0.10);
            const leftover = 1.0 - regimeWeight - rustWeight - mlWeight - memoryWeight;
            if (Math.abs(leftover) > 0.001) {
                mlWeight += leftover * 0.5;
                memoryWeight += leftover * 0.5;
            }
        }
        const totalWeight = rustWeight + mlWeight + memoryWeight + regimeWeight;
        if (Math.abs(totalWeight - 1.0) > 0.001) {
            const scale = 1.0 / totalWeight;
            rustWeight *= scale;
            mlWeight *= scale;
            memoryWeight *= scale;
            regimeWeight *= scale;
        }
        const regimeKey = regime.current.toUpperCase().replace(/\s+/g, '_');
        const alignmentMap = REGIME_ALIGNMENT[regimeKey] ?? REGIME_ALIGNMENT['QUIET'];
        const regimeAlignment = alignmentMap[rustSignal.direction] ?? 0.5;
        const rustScore = rustSignal.confidence;
        const mlScoreValue = mlScore.available ? mlScore.winProbability : 0;
        const memoryScore = memoryRecall.historicalWinRate;
        let baseScore = rustScore * rustWeight +
            mlScoreValue * mlWeight +
            memoryScore * memoryWeight +
            regimeAlignment * regimeWeight;
        if (mlScore.expectedReturn !== undefined && mlScore.available) {
            if (mlScore.expectedReturn > 0.01) {
                baseScore = Math.min(1.0, baseScore * 1.15);
                adjustments.push(`Return prediction: +${(mlScore.expectedReturn * 100).toFixed(2)}% expected`);
            }
            else if (mlScore.expectedReturn < -0.005) {
                baseScore *= 0.8;
                adjustments.push(`Return prediction: ${(mlScore.expectedReturn * 100).toFixed(2)}% expected — penalizing`);
            }
        }
        if (strategyHealth.isDecaying) {
            baseScore *= 0.7;
            adjustments.push('Alpha decay detected — strategy effectiveness declining');
        }
        if (strategyHealth.consecutiveLosses >= 3) {
            baseScore *= 0.8;
            adjustments.push('3+ consecutive losses on this strategy');
        }
        if (mlScore.available && mlScore.winProbability < 0.3 && rustSignal.confidence > 0.6) {
            baseScore *= 0.85;
            adjustments.push('ML model disagrees with technical signal');
        }
        if (memoryRecall.cautionNotes.length > 0) {
            const cautionPenalty = Math.max(0.85, Math.pow(0.95, memoryRecall.cautionNotes.length));
            baseScore *= cautionPenalty;
            for (const note of memoryRecall.cautionNotes) {
                adjustments.push(note);
            }
        }
        if (memoryRecall.historicalWinRate > 0.7 && memoryRecall.similarCases >= 10) {
            baseScore = Math.min(1.0, baseScore * 1.1);
            adjustments.push('Strong historical support from market memory');
        }
        const finalScore = Math.round(baseScore * 1000) / 1000;
        let action;
        if (finalScore >= minExecuteScore) {
            action = 'EXECUTE';
        }
        else if (finalScore >= minWatchScore) {
            action = 'WATCH';
        }
        else {
            action = 'SKIP';
        }
        let confidence;
        if (finalScore > 0.75) {
            confidence = 'HIGH';
        }
        else if (finalScore > 0.5) {
            confidence = 'MEDIUM';
        }
        else {
            confidence = 'LOW';
        }
        const reasoning = this.buildReasoning(rustSignal, mlScore, memoryRecall, regime, strategyHealth, finalScore, action, regimeAlignment, rustWeight, mlWeight, memoryWeight, regimeWeight);
        log.info({
            symbol: rustSignal.symbol,
            action,
            finalScore,
            confidence,
            adjustmentCount: adjustments.length,
        }, 'Fusion decision computed');
        return {
            finalScore,
            action,
            reasoning,
            signalSources: {
                rust: { score: rustScore, weight: rustWeight },
                ml: { score: mlScoreValue, weight: mlWeight },
                memory: { score: memoryScore, weight: memoryWeight, sampleCount: memoryRecall.similarCases },
                regime: { current: regime.current, alignment: regimeAlignment },
            },
            memoryContext: {
                similarCases: memoryRecall.similarCases,
                historicalWinRate: memoryRecall.historicalWinRate,
                bestStrategy: memoryRecall.bestStrategy,
                cautionNotes: memoryRecall.cautionNotes,
                lessons: memoryRecall.lessons,
            },
            confidence,
            adjustments,
        };
    }
    async getAdaptiveThresholds(userId) {
        const redis = getRedis();
        if (!redis) {
            return { minExecute: this.minExecuteScore, minWatch: this.minWatchScore };
        }
        try {
            const raw = await redis.get(`cg:fusion:thresholds:${userId}`);
            if (!raw) {
                return { minExecute: this.minExecuteScore, minWatch: this.minWatchScore };
            }
            const parsed = JSON.parse(raw);
            return {
                minExecute: parsed.minExecute ?? this.minExecuteScore,
                minWatch: parsed.minWatch ?? this.minWatchScore,
            };
        }
        catch (err) {
            log.warn({ err, userId }, 'Failed to read adaptive thresholds from Redis');
            return { minExecute: this.minExecuteScore, minWatch: this.minWatchScore };
        }
    }
    async updateThresholds(userId, adjust) {
        const redis = getRedis();
        if (!redis) {
            log.warn({ userId }, 'Redis unavailable — cannot persist threshold adjustment');
            return;
        }
        try {
            const current = await this.getAdaptiveThresholds(userId);
            const updated = {
                minExecute: Math.min(0.95, Math.max(0.3, current.minExecute + adjust)),
                minWatch: Math.min(0.90, Math.max(0.2, current.minWatch + adjust)),
                updatedAt: new Date().toISOString(),
            };
            await redis.set(`cg:fusion:thresholds:${userId}`, JSON.stringify(updated), 'EX', THRESHOLD_TTL_SECONDS);
            log.info({ userId, adjust, updated }, 'Fusion thresholds updated');
        }
        catch (err) {
            log.error({ err, userId }, 'Failed to update fusion thresholds');
        }
    }
    buildReasoning(rustSignal, mlScore, memoryRecall, regime, strategyHealth, finalScore, action, regimeAlignment, rustWeight, mlWeight, memoryWeight, regimeWeight) {
        const lines = [];
        lines.push(`${rustSignal.symbol} ${rustSignal.direction} signal from Rust engine ` +
            `with ${(rustSignal.confidence * 100).toFixed(0)}% confidence ` +
            `(entry ₹${rustSignal.entry.toFixed(2)}, SL ₹${rustSignal.stopLoss.toFixed(2)}, ` +
            `target ₹${rustSignal.target.toFixed(2)}).`);
        if (mlScore.available) {
            lines.push(`ML model predicts ${(mlScore.winProbability * 100).toFixed(0)}% win probability ` +
                `(model confidence: ${(mlScore.confidence * 100).toFixed(0)}%).`);
        }
        else {
            lines.push('ML model unavailable — weights redistributed to technical and memory signals.');
        }
        if (memoryRecall.similarCases > 0) {
            lines.push(`Market memory found ${memoryRecall.similarCases} similar setups ` +
                `with ${(memoryRecall.historicalWinRate * 100).toFixed(0)}% historical win rate ` +
                `(avg PnL: ${memoryRecall.avgPnlPct >= 0 ? '+' : ''}${memoryRecall.avgPnlPct.toFixed(2)}%). ` +
                `Best strategy: ${memoryRecall.bestStrategy}.`);
        }
        else {
            lines.push('No similar historical setups found in market memory.');
        }
        lines.push(`Market regime: ${regime.current} (confidence: ${(regime.confidence * 100).toFixed(0)}%, ` +
            `source: ${regime.source}). ` +
            `Regime alignment with signal direction: ${(regimeAlignment * 100).toFixed(0)}%.`);
        lines.push(`Weighted fusion: rust=${(rustWeight * 100).toFixed(0)}%, ` +
            `ml=${(mlWeight * 100).toFixed(0)}%, ` +
            `memory=${(memoryWeight * 100).toFixed(0)}%, ` +
            `regime=${(regimeWeight * 100).toFixed(0)}%.`);
        if (strategyHealth.isDecaying || strategyHealth.consecutiveLosses >= 3) {
            lines.push(`Strategy health: win rate ${(strategyHealth.recentWinRate * 100).toFixed(0)}%, ` +
                `${strategyHealth.consecutiveLosses} consecutive losses, ` +
                `Thompson α=${strategyHealth.thompsonAlpha.toFixed(1)} β=${strategyHealth.thompsonBeta.toFixed(1)}` +
                `${strategyHealth.isDecaying ? ' — alpha decay active' : ''}.`);
        }
        lines.push(`Final score: ${(finalScore * 100).toFixed(1)}% → Action: ${action}.`);
        if (memoryRecall.lessons.length > 0) {
            lines.push(`Lessons from similar trades: ${memoryRecall.lessons.slice(0, 2).join('; ')}.`);
        }
        return lines;
    }
}
//# sourceMappingURL=decision-fusion.service.js.map