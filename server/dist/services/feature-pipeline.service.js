import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('FeaturePipeline');
const DISCRIMINATIVE_KEYS = [
    'returns1d', 'returns5d', 'rsi14', 'adx', 'atrPct',
    'bbPosition', 'volumeRatio5d', 'emaCrossoverDist', 'macdHistogram',
    'priceVsEma20', 'stochasticK', 'vixLevel', 'niftyReturn1d', 'gapPct',
    'closeVsHigh', 'closeVsLow', 'bodyRatio', 'volumeTrend',
    'realizedVol5d', 'sectorRs',
];
export class FeaturePipelineService {
    extractFeatures(symbol, bars, marketState, memoryRecall) {
        const n = bars.length;
        if (n === 0) {
            log.warn({ symbol }, 'Empty bar data — returning zero vector');
            return this.zeroVector();
        }
        const closes = bars.map((b) => b.close);
        const highs = bars.map((b) => b.high);
        const lows = bars.map((b) => b.low);
        const volumes = bars.map((b) => b.volume);
        const last = bars[n - 1];
        const lastClose = last.close;
        const ema9 = this.computeEMA(closes, 9);
        const ema21 = this.computeEMA(closes, 21);
        const ema50 = this.computeEMA(closes, 50);
        const ema20 = this.computeEMA(closes, 20);
        const sma200 = this.computeSMA(closes, 200);
        const rsi = this.computeRSI(closes, 14);
        const atr = this.computeATR(bars, 14);
        const adxResult = this.computeADX(bars, 14);
        const macdResult = this.computeMACD(closes, 12, 26, 9);
        const stoch = this.computeStochastic(bars, 14, 3);
        const bb = this.computeBollingerBands(closes, 20, 2);
        const obv = this.computeOBV(closes, volumes);
        const vwap = this.computeVWAP(bars);
        const tail = (arr) => arr[arr.length - 1];
        const safeReturn = (periodsBack) => {
            if (n <= periodsBack)
                return 0;
            const prev = closes[n - 1 - periodsBack];
            return prev !== 0 ? (lastClose - prev) / prev : 0;
        };
        const range = last.high - last.low;
        const body = Math.abs(last.close - last.open);
        const sma5Vol = this.computeSMA(volumes, 5);
        const sma20Vol = this.computeSMA(volumes, 20);
        const lastVolume = volumes[n - 1];
        const logReturns = [];
        for (let i = 1; i < closes.length; i++) {
            logReturns.push(Math.log(closes[i] / closes[i - 1]));
        }
        const histVol20 = this.stddev(logReturns.slice(-20)) * Math.sqrt(252);
        const realVol5 = this.stddev(logReturns.slice(-5)) * Math.sqrt(252);
        const obvArr = obv;
        const obvSlope = obvArr.length >= 6
            ? (obvArr[obvArr.length - 1] - obvArr[obvArr.length - 6]) /
                (Math.abs(obvArr[obvArr.length - 6]) || 1)
            : 0;
        const volTrend = sma5Vol.length > 0 && sma20Vol.length > 0
            ? (tail(sma5Vol) / (tail(sma20Vol) || 1)) - 1
            : 0;
        const lastVwap = vwap.length > 0 ? tail(vwap) : lastClose;
        const now = last.timestamp;
        return {
            priceAction: {
                returns1d: safeReturn(1),
                returns5d: safeReturn(5),
                returns10d: safeReturn(10),
                returns20d: safeReturn(20),
                gapPct: n >= 2 ? (last.open - bars[n - 2].close) / (bars[n - 2].close || 1) : 0,
                rangePct: lastClose !== 0 ? range / lastClose : 0,
                closeVsHigh: range !== 0 ? (last.close - last.low) / range : 0.5,
                closeVsLow: range !== 0 ? (last.high - last.close) / range : 0.5,
                bodyRatio: range !== 0 ? body / range : 0,
                upperShadow: range !== 0
                    ? (last.high - Math.max(last.open, last.close)) / range
                    : 0,
                lowerShadow: range !== 0
                    ? (Math.min(last.open, last.close) - last.low) / range
                    : 0,
            },
            trend: {
                ema9: ema9.length > 0 ? tail(ema9) : lastClose,
                ema21: ema21.length > 0 ? tail(ema21) : lastClose,
                ema50: ema50.length > 0 ? tail(ema50) : lastClose,
                sma200: sma200.length > 0 ? tail(sma200) : lastClose,
                priceVsEma20: ema20.length > 0
                    ? (lastClose - tail(ema20)) / (tail(ema20) || 1)
                    : 0,
                adx: adxResult.adx.length > 0 ? tail(adxResult.adx) : 0,
                plusDi: adxResult.plusDi.length > 0 ? tail(adxResult.plusDi) : 0,
                minusDi: adxResult.minusDi.length > 0 ? tail(adxResult.minusDi) : 0,
            },
            momentum: {
                rsi14: rsi.length > 0 ? tail(rsi) : 50,
                stochasticK: stoch.k.length > 0 ? tail(stoch.k) : 50,
                stochasticD: stoch.d.length > 0 ? tail(stoch.d) : 50,
                macd: macdResult.macd.length > 0 ? tail(macdResult.macd) : 0,
                macdSignal: macdResult.signal.length > 0 ? tail(macdResult.signal) : 0,
                macdHistogram: macdResult.histogram.length > 0 ? tail(macdResult.histogram) : 0,
            },
            volatility: {
                atr14: atr.length > 0 ? tail(atr) : 0,
                atrPct: atr.length > 0 && lastClose !== 0 ? tail(atr) / lastClose : 0,
                bbWidth: bb.width.length > 0 ? tail(bb.width) : 0,
                bbPosition: bb.upper.length > 0 && bb.lower.length > 0
                    ? (tail(bb.upper) - tail(bb.lower)) !== 0
                        ? (lastClose - tail(bb.lower)) / (tail(bb.upper) - tail(bb.lower))
                        : 0.5
                    : 0.5,
                historicalVol20d: histVol20,
                realizedVol5d: realVol5,
            },
            volume: {
                volumeRatio5d: sma5Vol.length > 0 && tail(sma5Vol) !== 0
                    ? lastVolume / tail(sma5Vol)
                    : 1,
                volumeRatio20d: sma20Vol.length > 0 && tail(sma20Vol) !== 0
                    ? lastVolume / tail(sma20Vol)
                    : 1,
                obvSlope,
                vwapDistance: lastVwap !== 0 ? (lastClose - lastVwap) / lastVwap : 0,
                volumeTrend: volTrend,
            },
            marketContext: {
                niftyReturn1d: marketState?.niftyChange ?? 0,
                vixLevel: marketState?.vixLevel ?? 0,
                vixChange: marketState?.vixChange ?? 0,
                fiiFlowDir: marketState?.fiiNetBuy != null
                    ? Math.sign(marketState.fiiNetBuy)
                    : 0,
                advanceDeclineRatio: marketState?.advanceDeclineRatio ?? 1,
                sectorRs: marketState?.sectorRs ?? 0,
            },
            time: {
                dayOfWeek: now.getDay(),
                hourOfDay: now.getHours(),
                isExpiryDay: now.getDay() === 4 ? 1 : 0,
                daysToExpiry: this.daysUntilNextThursday(now),
            },
            memory: {
                memoryWinRate: memoryRecall?.winRate ?? 0,
                memoryAvgPnl: memoryRecall?.avgPnl ?? 0,
                memorySampleCount: memoryRecall?.sampleCount ?? 0,
                memoryConfidence: memoryRecall?.confidence ?? 0,
            },
        };
    }
    toFlatArray(features) {
        const result = [];
        const groups = [
            features.priceAction,
            features.trend,
            features.momentum,
            features.volatility,
            features.volume,
            features.marketContext,
            features.time,
            features.memory,
        ];
        for (const group of groups) {
            for (const key of Object.keys(group)) {
                result.push(group[key]);
            }
        }
        return result;
    }
    getFingerprint(features) {
        const flat = this.toFlatArray(features);
        const pa = features.priceAction;
        const tr = features.trend;
        const mo = features.momentum;
        const vo = features.volatility;
        const vol = features.volume;
        const mc = features.marketContext;
        const emaCrossoverDist = tr.ema9 !== 0
            ? (tr.ema9 - tr.ema21) / tr.ema9
            : 0;
        const discriminative = [
            pa.returns1d, pa.returns5d, mo.rsi14, tr.adx, vo.atrPct,
            vo.bbPosition, vol.volumeRatio5d, emaCrossoverDist, mo.macdHistogram,
            tr.priceVsEma20, mo.stochasticK, mc.vixLevel, mc.niftyReturn1d, pa.gapPct,
            pa.closeVsHigh, pa.closeVsLow, pa.bodyRatio, vol.volumeTrend,
            vo.realizedVol5d, mc.sectorRs,
        ];
        return JSON.stringify(discriminative.map((v) => Math.round(v * 100) / 100));
    }
    normalizeFeatures(features, runningMean, runningStd) {
        const n = features.length;
        if (runningMean && runningStd && runningMean.length === n && runningStd.length === n) {
            return features.map((v, i) => runningStd[i] !== 0 ? (v - runningMean[i]) / runningStd[i] : 0);
        }
        const mean = features.reduce((a, b) => a + b, 0) / (n || 1);
        const variance = features.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (n || 1);
        const std = Math.sqrt(variance);
        if (std === 0)
            return features.map(() => 0);
        return features.map((v) => (v - mean) / std);
    }
    computeEMA(values, period) {
        if (values.length === 0)
            return [];
        const k = 2 / (period + 1);
        const result = [values[0]];
        for (let i = 1; i < values.length; i++) {
            result.push(values[i] * k + result[i - 1] * (1 - k));
        }
        return result;
    }
    computeSMA(values, period) {
        if (values.length < period) {
            if (values.length === 0)
                return [];
            const sum = values.reduce((a, b) => a + b, 0);
            return [sum / values.length];
        }
        const result = [];
        let windowSum = 0;
        for (let i = 0; i < period; i++)
            windowSum += values[i];
        result.push(windowSum / period);
        for (let i = period; i < values.length; i++) {
            windowSum += values[i] - values[i - period];
            result.push(windowSum / period);
        }
        return result;
    }
    computeRSI(closes, period) {
        if (closes.length < 2)
            return [];
        const deltas = [];
        for (let i = 1; i < closes.length; i++) {
            deltas.push(closes[i] - closes[i - 1]);
        }
        if (deltas.length < period)
            return [];
        let avgGain = 0;
        let avgLoss = 0;
        for (let i = 0; i < period; i++) {
            if (deltas[i] > 0)
                avgGain += deltas[i];
            else
                avgLoss += Math.abs(deltas[i]);
        }
        avgGain /= period;
        avgLoss /= period;
        const rsiValues = [];
        const rs = avgLoss === 0 ? 100 : avgGain / avgLoss;
        rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + rs));
        for (let i = period; i < deltas.length; i++) {
            const gain = deltas[i] > 0 ? deltas[i] : 0;
            const loss = deltas[i] < 0 ? Math.abs(deltas[i]) : 0;
            avgGain = (avgGain * (period - 1) + gain) / period;
            avgLoss = (avgLoss * (period - 1) + loss) / period;
            const currentRs = avgLoss === 0 ? 100 : avgGain / avgLoss;
            rsiValues.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + currentRs));
        }
        return rsiValues;
    }
    computeATR(bars, period) {
        if (bars.length < 2)
            return [];
        const trueRanges = [];
        for (let i = 1; i < bars.length; i++) {
            const hl = bars[i].high - bars[i].low;
            const hc = Math.abs(bars[i].high - bars[i - 1].close);
            const lc = Math.abs(bars[i].low - bars[i - 1].close);
            trueRanges.push(Math.max(hl, hc, lc));
        }
        return this.computeEMA(trueRanges, period);
    }
    computeADX(bars, period) {
        if (bars.length < period + 1)
            return { adx: [], plusDi: [], minusDi: [] };
        const plusDM = [];
        const minusDM = [];
        const trArr = [];
        for (let i = 1; i < bars.length; i++) {
            const upMove = bars[i].high - bars[i - 1].high;
            const downMove = bars[i - 1].low - bars[i].low;
            plusDM.push(upMove > downMove && upMove > 0 ? upMove : 0);
            minusDM.push(downMove > upMove && downMove > 0 ? downMove : 0);
            const hl = bars[i].high - bars[i].low;
            const hc = Math.abs(bars[i].high - bars[i - 1].close);
            const lc = Math.abs(bars[i].low - bars[i - 1].close);
            trArr.push(Math.max(hl, hc, lc));
        }
        const smoothedTR = this.wilderSmooth(trArr, period);
        const smoothedPlusDM = this.wilderSmooth(plusDM, period);
        const smoothedMinusDM = this.wilderSmooth(minusDM, period);
        const len = smoothedTR.length;
        const plusDi = [];
        const minusDi = [];
        const dx = [];
        for (let i = 0; i < len; i++) {
            const pdi = smoothedTR[i] !== 0 ? (smoothedPlusDM[i] / smoothedTR[i]) * 100 : 0;
            const mdi = smoothedTR[i] !== 0 ? (smoothedMinusDM[i] / smoothedTR[i]) * 100 : 0;
            plusDi.push(pdi);
            minusDi.push(mdi);
            const diSum = pdi + mdi;
            dx.push(diSum !== 0 ? (Math.abs(pdi - mdi) / diSum) * 100 : 0);
        }
        const adx = this.wilderSmooth(dx, period);
        const offset = len - adx.length;
        return {
            adx,
            plusDi: plusDi.slice(offset),
            minusDi: minusDi.slice(offset),
        };
    }
    computeMACD(closes, fast, slow, signalPeriod) {
        if (closes.length === 0)
            return { macd: [], signal: [], histogram: [] };
        const emaFast = this.computeEMA(closes, fast);
        const emaSlow = this.computeEMA(closes, slow);
        const macdLine = [];
        for (let i = 0; i < closes.length; i++) {
            macdLine.push(emaFast[i] - emaSlow[i]);
        }
        const signalLine = this.computeEMA(macdLine, signalPeriod);
        const histogram = [];
        for (let i = 0; i < macdLine.length; i++) {
            histogram.push(macdLine[i] - signalLine[i]);
        }
        return { macd: macdLine, signal: signalLine, histogram };
    }
    computeStochastic(bars, kPeriod, dPeriod) {
        if (bars.length < kPeriod)
            return { k: [], d: [] };
        const rawK = [];
        for (let i = kPeriod - 1; i < bars.length; i++) {
            let highestHigh = -Infinity;
            let lowestLow = Infinity;
            for (let j = i - kPeriod + 1; j <= i; j++) {
                if (bars[j].high > highestHigh)
                    highestHigh = bars[j].high;
                if (bars[j].low < lowestLow)
                    lowestLow = bars[j].low;
            }
            const range = highestHigh - lowestLow;
            rawK.push(range !== 0 ? ((bars[i].close - lowestLow) / range) * 100 : 50);
        }
        const d = this.computeSMA(rawK, dPeriod);
        return { k: rawK, d };
    }
    computeBollingerBands(closes, period, stdDevs) {
        const middle = this.computeSMA(closes, period);
        if (middle.length === 0)
            return { upper: [], middle: [], lower: [], width: [] };
        const upper = [];
        const lower = [];
        const width = [];
        const startIdx = closes.length - middle.length;
        for (let i = 0; i < middle.length; i++) {
            const windowStart = startIdx + i - period + 1;
            const windowEnd = startIdx + i + 1;
            const window = closes.slice(Math.max(0, windowStart), windowEnd);
            const mean = middle[i];
            const variance = window.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (window.length || 1);
            const sd = Math.sqrt(variance) * stdDevs;
            upper.push(mean + sd);
            lower.push(mean - sd);
            width.push(mean !== 0 ? (2 * sd) / mean : 0);
        }
        return { upper, middle, lower, width };
    }
    computeOBV(closes, volumes) {
        if (closes.length === 0)
            return [];
        const obv = [0];
        for (let i = 1; i < closes.length; i++) {
            if (closes[i] > closes[i - 1]) {
                obv.push(obv[i - 1] + volumes[i]);
            }
            else if (closes[i] < closes[i - 1]) {
                obv.push(obv[i - 1] - volumes[i]);
            }
            else {
                obv.push(obv[i - 1]);
            }
        }
        return obv;
    }
    computeVWAP(bars) {
        if (bars.length === 0)
            return [];
        const vwap = [];
        let cumulativeVol = 0;
        let cumulativeTP = 0;
        for (const bar of bars) {
            const tp = (bar.high + bar.low + bar.close) / 3;
            cumulativeTP += tp * bar.volume;
            cumulativeVol += bar.volume;
            vwap.push(cumulativeVol !== 0 ? cumulativeTP / cumulativeVol : tp);
        }
        return vwap;
    }
    wilderSmooth(values, period) {
        if (values.length < period)
            return [];
        let initial = 0;
        for (let i = 0; i < period; i++)
            initial += values[i];
        initial /= period;
        const result = [initial];
        for (let i = period; i < values.length; i++) {
            result.push((result[result.length - 1] * (period - 1) + values[i]) / period);
        }
        return result;
    }
    stddev(values) {
        if (values.length < 2)
            return 0;
        const mean = values.reduce((a, b) => a + b, 0) / values.length;
        const variance = values.reduce((sum, v) => sum + (v - mean) ** 2, 0) / (values.length - 1);
        return Math.sqrt(variance);
    }
    daysUntilNextThursday(date) {
        const day = date.getDay();
        const diff = (4 - day + 7) % 7;
        return diff === 0 ? 7 : diff;
    }
    zeroVector() {
        return {
            priceAction: {
                returns1d: 0, returns5d: 0, returns10d: 0, returns20d: 0,
                gapPct: 0, rangePct: 0, closeVsHigh: 0, closeVsLow: 0,
                bodyRatio: 0, upperShadow: 0, lowerShadow: 0,
            },
            trend: {
                ema9: 0, ema21: 0, ema50: 0, sma200: 0,
                priceVsEma20: 0, adx: 0, plusDi: 0, minusDi: 0,
            },
            momentum: {
                rsi14: 50, stochasticK: 50, stochasticD: 50,
                macd: 0, macdSignal: 0, macdHistogram: 0,
            },
            volatility: {
                atr14: 0, atrPct: 0, bbWidth: 0, bbPosition: 0.5,
                historicalVol20d: 0, realizedVol5d: 0,
            },
            volume: {
                volumeRatio5d: 1, volumeRatio20d: 1, obvSlope: 0,
                vwapDistance: 0, volumeTrend: 0,
            },
            marketContext: {
                niftyReturn1d: 0, vixLevel: 0, vixChange: 0,
                fiiFlowDir: 0, advanceDeclineRatio: 1, sectorRs: 0,
            },
            time: {
                dayOfWeek: 0, hourOfDay: 0, isExpiryDay: 0, daysToExpiry: 0,
            },
            memory: {
                memoryWinRate: 0, memoryAvgPnl: 0,
                memorySampleCount: 0, memoryConfidence: 0,
            },
        };
    }
}
//# sourceMappingURL=feature-pipeline.service.js.map