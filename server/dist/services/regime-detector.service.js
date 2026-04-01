import { createChildLogger } from '../lib/logger.js';
import { isMLServiceAvailable, mlDetectRegime } from '../lib/ml-service-client.js';
import { getPrisma } from '../lib/prisma.js';
const log = createChildLogger('RegimeDetector');
function ema(values, period) {
    if (values.length === 0)
        return [];
    const k = 2 / (period + 1);
    const result = [values[0]];
    for (let i = 1; i < values.length; i++) {
        result.push(values[i] * k + result[i - 1] * (1 - k));
    }
    return result;
}
function trueRange(bars) {
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
        const high = bars[i].high;
        const low = bars[i].low;
        const prevClose = bars[i - 1].close;
        trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
    }
    return trs;
}
function computeATRSeries(bars, period) {
    const trs = trueRange(bars);
    if (trs.length < period)
        return [];
    let atr = trs.slice(0, period).reduce((s, v) => s + v, 0) / period;
    const result = [atr];
    for (let i = period; i < trs.length; i++) {
        atr = (atr * (period - 1) + trs[i]) / period;
        result.push(atr);
    }
    return result;
}
function computeADX(bars, period = 14) {
    if (bars.length < period * 2 + 1)
        return 0;
    const plusDM = [];
    const minusDM = [];
    const trs = [];
    for (let i = 1; i < bars.length; i++) {
        const upMove = bars[i].high - bars[i - 1].high;
        const downMove = bars[i - 1].low - bars[i].low;
        plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
        minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
        trs.push(Math.max(bars[i].high - bars[i].low, Math.abs(bars[i].high - bars[i - 1].close), Math.abs(bars[i].low - bars[i - 1].close)));
    }
    let smoothedPlusDM = plusDM.slice(0, period).reduce((s, v) => s + v, 0);
    let smoothedMinusDM = minusDM.slice(0, period).reduce((s, v) => s + v, 0);
    let smoothedTR = trs.slice(0, period).reduce((s, v) => s + v, 0);
    const dx = [];
    for (let i = period; i < plusDM.length; i++) {
        smoothedPlusDM = smoothedPlusDM - smoothedPlusDM / period + plusDM[i];
        smoothedMinusDM = smoothedMinusDM - smoothedMinusDM / period + minusDM[i];
        smoothedTR = smoothedTR - smoothedTR / period + trs[i];
        const plusDI = smoothedTR > 0 ? (smoothedPlusDM / smoothedTR) * 100 : 0;
        const minusDI = smoothedTR > 0 ? (smoothedMinusDM / smoothedTR) * 100 : 0;
        const diSum = plusDI + minusDI;
        dx.push(diSum > 0 ? Math.abs(plusDI - minusDI) / diSum * 100 : 0);
    }
    if (dx.length < period)
        return dx.length > 0 ? dx[dx.length - 1] : 0;
    let adx = dx.slice(0, period).reduce((s, v) => s + v, 0) / period;
    for (let i = period; i < dx.length; i++) {
        adx = (adx * (period - 1) + dx[i]) / period;
    }
    return adx;
}
function computeBBWidth(closes, period = 20) {
    const widths = [];
    for (let i = period - 1; i < closes.length; i++) {
        const slice = closes.slice(i - period + 1, i + 1);
        const mean = slice.reduce((s, v) => s + v, 0) / period;
        const variance = slice.reduce((s, v) => s + (v - mean) ** 2, 0) / period;
        const stdDev = Math.sqrt(variance);
        const upper = mean + 2 * stdDev;
        const lower = mean - 2 * stdDev;
        widths.push(mean > 0 ? (upper - lower) / mean : 0);
    }
    return {
        width: widths.length > 0 ? widths[widths.length - 1] : 0,
        series: widths,
    };
}
function computeTrendStrength(bars, period = 20) {
    if (bars.length < period)
        return 0;
    const recent = bars.slice(-period);
    const closes = recent.map(b => b.close);
    const n = closes.length;
    const xMean = (n - 1) / 2;
    const yMean = closes.reduce((s, v) => s + v, 0) / n;
    let numerator = 0;
    let denominator = 0;
    for (let i = 0; i < n; i++) {
        numerator += (i - xMean) * (closes[i] - yMean);
        denominator += (i - xMean) ** 2;
    }
    const slope = denominator > 0 ? numerator / denominator : 0;
    const normalizedSlope = yMean > 0 ? slope / yMean * n : 0;
    return Math.max(-1, Math.min(1, normalizedSlope * 10));
}
function percentileRank(values, current) {
    if (values.length === 0)
        return 50;
    const below = values.filter(v => v < current).length;
    return (below / values.length) * 100;
}
function median(values) {
    if (values.length === 0)
        return 0;
    const sorted = [...values].sort((a, b) => a - b);
    const mid = Math.floor(sorted.length / 2);
    return sorted.length % 2 === 0 ? (sorted[mid - 1] + sorted[mid]) / 2 : sorted[mid];
}
export class RegimeDetectorService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    detect(bars, vix) {
        if (bars.length < 60) {
            log.warn({ barCount: bars.length }, 'Insufficient bars for reliable regime detection, defaulting');
            return {
                regime: 'MEAN_REVERTING',
                confidence: 0.3,
                indicators: { adx: 0, atr: 0, atrPercentile: 50, bbWidth: 0, trendStrength: 0, volatilityRank: 50 },
            };
        }
        const adx = computeADX(bars);
        const atrSeries = computeATRSeries(bars, 14);
        const currentATR = atrSeries.length > 0 ? atrSeries[atrSeries.length - 1] : 0;
        const atrPctile = percentileRank(atrSeries, currentATR);
        const closes = bars.map(b => b.close);
        const { width: bbWidth, series: bbSeries } = computeBBWidth(closes, 20);
        const lookbackBBSeries = bbSeries.slice(-60);
        const medianBBWidth = median(lookbackBBSeries);
        const trendStrength = computeTrendStrength(bars, 20);
        const ema20 = ema(closes, 20);
        const currentEma20 = ema20[ema20.length - 1];
        const currentClose = closes[closes.length - 1];
        const volatilityRank = atrPctile;
        const indicators = {
            adx,
            atr: currentATR,
            atrPercentile: atrPctile,
            bbWidth,
            trendStrength,
            volatilityRank,
        };
        let regime;
        let confidence;
        if (atrPctile > 80 || (vix !== undefined && vix > 20)) {
            regime = 'VOLATILE';
            const vixFactor = vix !== undefined ? Math.min(1, (vix - 20) / 20) : 0;
            confidence = Math.min(1, (atrPctile / 100) * 0.6 + vixFactor * 0.4);
        }
        else if (adx > 25 && currentClose > currentEma20 && trendStrength > 0.6) {
            regime = 'TRENDING_UP';
            confidence = Math.min(1, ((adx - 25) / 25) * 0.4 + trendStrength * 0.4 + 0.2);
        }
        else if (adx > 25 && currentClose < currentEma20 && trendStrength < -0.6) {
            regime = 'TRENDING_DOWN';
            confidence = Math.min(1, ((adx - 25) / 25) * 0.4 + Math.abs(trendStrength) * 0.4 + 0.2);
        }
        else if (atrPctile < 20 && adx < 15) {
            regime = 'QUIET';
            confidence = Math.min(1, ((20 - atrPctile) / 20) * 0.5 + ((15 - adx) / 15) * 0.5);
        }
        else if (adx < 20 && bbWidth < medianBBWidth) {
            regime = 'MEAN_REVERTING';
            const bbRatio = medianBBWidth > 0 ? 1 - bbWidth / medianBBWidth : 0;
            confidence = Math.min(1, ((20 - adx) / 20) * 0.5 + bbRatio * 0.5);
        }
        else {
            regime = 'MEAN_REVERTING';
            confidence = 0.35;
        }
        log.info({ regime, confidence: confidence.toFixed(2), adx: adx.toFixed(1), atrPctile: atrPctile.toFixed(0) }, 'Regime detected');
        return { regime, confidence, indicators };
    }
    async detectFromHistory(symbol, exchange, days) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        const historicalBars = await this.prisma.historicalBar.findMany({
            where: {
                symbol,
                exchange,
                timeframe: '1d',
                timestamp: { gte: since },
            },
            orderBy: { timestamp: 'asc' },
        });
        const bars = historicalBars.map((hb) => ({
            timestamp: hb.timestamp,
            open: hb.open,
            high: hb.high,
            low: hb.low,
            close: hb.close,
            volume: Number(hb.volume),
        }));
        if (bars.length === 0) {
            log.warn({ symbol, exchange, days }, 'No historical bars found');
            return {
                regime: 'MEAN_REVERTING',
                confidence: 0,
                indicators: { adx: 0, atr: 0, atrPercentile: 50, bbWidth: 0, trendStrength: 0, volatilityRank: 50 },
            };
        }
        return this.detect(bars);
    }
    async detectHybrid(bars, vix) {
        const ruleResult = this.detect(bars, vix);
        let mlRegime;
        let source = 'rule_based';
        try {
            if (await isMLServiceAvailable() && bars.length >= 30) {
                const closes = bars.map(b => b.close);
                const returns = [];
                const volatility = [];
                for (let i = 1; i < closes.length; i++) {
                    returns.push((closes[i] - closes[i - 1]) / closes[i - 1]);
                }
                for (let i = 20; i < closes.length; i++) {
                    const window = returns.slice(i - 20, i);
                    const mean = window.reduce((s, v) => s + v, 0) / window.length;
                    const variance = window.reduce((s, v) => s + (v - mean) ** 2, 0) / window.length;
                    volatility.push(Math.sqrt(variance) * Math.sqrt(252));
                }
                const trimmedReturns = returns.slice(returns.length - volatility.length);
                const mlResult = await mlDetectRegime({
                    returns: trimmedReturns,
                    volatility,
                });
                mlRegime = mlResult.current_regime;
                const mlToRegime = {
                    trending_up: 'TRENDING_UP',
                    trending_down: 'TRENDING_DOWN',
                    ranging: 'MEAN_REVERTING',
                    volatile: 'VOLATILE',
                };
                const mappedMlRegime = mlToRegime[mlRegime] ?? 'MEAN_REVERTING';
                if (mappedMlRegime === ruleResult.regime) {
                    source = 'hybrid';
                    return {
                        regime: ruleResult.regime,
                        confidence: Math.min(ruleResult.confidence * 1.2, 1.0),
                        indicators: ruleResult.indicators,
                        source,
                        ruleBasedRegime: ruleResult.regime,
                        mlRegime,
                    };
                }
                const ruleWeight = 0.6;
                const mlWeight = 0.4;
                const mlConfidence = mlResult.confidence ?? 0.6;
                if (mlConfidence * mlWeight > ruleResult.confidence * ruleWeight) {
                    source = 'hybrid';
                    return {
                        regime: mappedMlRegime,
                        confidence: mlConfidence * mlWeight + ruleResult.confidence * ruleWeight,
                        indicators: ruleResult.indicators,
                        source,
                        ruleBasedRegime: ruleResult.regime,
                        mlRegime,
                    };
                }
                source = 'hybrid';
                return {
                    regime: ruleResult.regime,
                    confidence: ruleResult.confidence * ruleWeight + mlConfidence * mlWeight * 0.5,
                    indicators: ruleResult.indicators,
                    source,
                    ruleBasedRegime: ruleResult.regime,
                    mlRegime,
                };
            }
        }
        catch (err) {
            log.warn({ err }, 'ML regime detection failed — using rule-based only');
        }
        return {
            regime: ruleResult.regime,
            confidence: ruleResult.confidence,
            indicators: ruleResult.indicators,
            source,
            ruleBasedRegime: ruleResult.regime,
            mlRegime,
        };
    }
    async detectAndStore(bars, vix, symbol, exchange) {
        const result = await this.detectHybrid(bars, vix);
        try {
            const prisma = getPrisma();
            const today = new Date();
            today.setHours(0, 0, 0, 0);
            await prisma.regimeHistory.upsert({
                where: { date: today },
                create: {
                    date: today,
                    regime: result.regime,
                    confidence: result.confidence,
                    vix: vix ?? null,
                    metadata: JSON.stringify({
                        source: result.source,
                        ruleBasedRegime: result.ruleBasedRegime,
                        mlRegime: result.mlRegime,
                        indicators: result.indicators,
                    }),
                },
                update: {
                    regime: result.regime,
                    confidence: result.confidence,
                    vix: vix ?? null,
                    metadata: JSON.stringify({
                        source: result.source,
                        ruleBasedRegime: result.ruleBasedRegime,
                        mlRegime: result.mlRegime,
                        indicators: result.indicators,
                    }),
                },
            });
        }
        catch (err) {
            log.warn({ err }, 'Failed to store regime history');
        }
        return { regime: result.regime, confidence: result.confidence, source: result.source };
    }
}
//# sourceMappingURL=regime-detector.service.js.map