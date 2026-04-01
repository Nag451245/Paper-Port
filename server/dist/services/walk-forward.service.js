import { createChildLogger } from '../lib/logger.js';
import { BacktestEngine } from './backtest-engine.service.js';
const log = createChildLogger('WalkForward');
const DEFAULT_WINDOW_COUNT = 5;
const DEFAULT_IN_SAMPLE_RATIO = 0.7;
function generateParamCombinations(ranges) {
    if (ranges.length === 0)
        return [{}];
    const [first, ...rest] = ranges;
    const restCombinations = generateParamCombinations(rest);
    const combinations = [];
    for (const value of first.values) {
        for (const restCombo of restCombinations) {
            combinations.push({ [first.name]: value, ...restCombo });
        }
    }
    return combinations;
}
export class WalkForwardOptimizer {
    engine = new BacktestEngine();
    run(config) {
        const { strategy, bars, paramRanges, symbol, initialCapital, } = config;
        const windowCount = config.windowCount ?? DEFAULT_WINDOW_COUNT;
        const inSampleRatio = config.inSampleRatio ?? DEFAULT_IN_SAMPLE_RATIO;
        const anchoredStart = config.anchoredStart ?? false;
        if (bars.length < windowCount * 10) {
            throw new Error(`Insufficient bars (${bars.length}) for ${windowCount} windows`);
        }
        const paramCombinations = generateParamCombinations(paramRanges);
        log.info({ symbol, windows: windowCount, combinations: paramCombinations.length, bars: bars.length }, 'Starting walk-forward optimization');
        const windowSize = Math.floor(bars.length / windowCount);
        const windows = [];
        const allOOSTrades = [];
        for (let w = 0; w < windowCount; w++) {
            const windowStart = anchoredStart ? 0 : w * windowSize;
            const windowEnd = Math.min((w + 1) * windowSize + Math.floor(windowSize * (1 - inSampleRatio)), bars.length);
            const totalWindowBars = windowEnd - windowStart;
            const isBars = Math.floor(totalWindowBars * inSampleRatio);
            const isEnd = windowStart + isBars;
            const inSampleBars = bars.slice(windowStart, isEnd);
            const outOfSampleBars = bars.slice(isEnd, windowEnd);
            if (inSampleBars.length < 5 || outOfSampleBars.length < 2) {
                log.warn({ window: w, isBars: inSampleBars.length, oosBars: outOfSampleBars.length }, 'Skipping small window');
                continue;
            }
            log.debug({ window: w, isBars: inSampleBars.length, oosBars: outOfSampleBars.length }, 'Processing window');
            let bestSharpe = -Infinity;
            let bestParams = {};
            for (const params of paramCombinations) {
                const clonedStrategy = this.cloneStrategyWithParams(strategy, params);
                try {
                    const result = this.engine.run({
                        strategy: clonedStrategy,
                        bars: inSampleBars,
                        initialCapital,
                        symbol,
                    });
                    if (result.metrics.sharpeRatio > bestSharpe) {
                        bestSharpe = result.metrics.sharpeRatio;
                        bestParams = params;
                    }
                }
                catch (e) {
                    log.debug({ params, error: e.message }, 'Parameter combination failed');
                }
            }
            const oosStrategy = this.cloneStrategyWithParams(strategy, bestParams);
            const oosResult = this.engine.run({
                strategy: oosStrategy,
                bars: outOfSampleBars,
                initialCapital,
                symbol,
            });
            const degradation = bestSharpe > 0
                ? 1 - oosResult.metrics.sharpeRatio / bestSharpe
                : 0;
            windows.push({
                windowIndex: w,
                inSampleStart: inSampleBars[0].timestamp,
                inSampleEnd: inSampleBars[inSampleBars.length - 1].timestamp,
                outOfSampleStart: outOfSampleBars[0].timestamp,
                outOfSampleEnd: outOfSampleBars[outOfSampleBars.length - 1].timestamp,
                bestParams,
                inSampleSharpe: bestSharpe,
                outOfSampleSharpe: oosResult.metrics.sharpeRatio,
                outOfSampleReturn: oosResult.metrics.totalReturn,
                degradation,
            });
            allOOSTrades.push(...oosResult.trades);
        }
        const aggregateMetrics = this.computeAggregateMetrics(allOOSTrades, initialCapital);
        const overfitRatio = windows.length > 0
            ? windows.reduce((s, w) => s + w.degradation, 0) / windows.length
            : 1;
        const profitableWindows = windows.filter(w => w.outOfSampleReturn > 0).length;
        const robustnessScore = windows.length > 0
            ? profitableWindows / windows.length
            : 0;
        const aggregateOOSReturn = windows.reduce((s, w) => s + w.outOfSampleReturn, 0);
        log.info({ overfitRatio, robustnessScore, isOOSProfitable: aggregateOOSReturn > 0, windows: windows.length }, 'Walk-forward optimization complete');
        return {
            windows,
            aggregateMetrics,
            overfitRatio,
            robustnessScore,
            bestParams: windows.map(w => w.bestParams),
            isOOSProfitable: aggregateOOSReturn > 0,
        };
    }
    cloneStrategyWithParams(strategy, params) {
        const Constructor = strategy.constructor;
        return new Constructor(params);
    }
    computeAggregateMetrics(trades, initialCapital) {
        const totalTrades = trades.length;
        if (totalTrades === 0) {
            return {
                totalReturn: 0, cagr: 0, sharpeRatio: 0, sortinoRatio: 0,
                maxDrawdown: 0, maxDrawdownDuration: 0, winRate: 0, profitFactor: 0,
                avgWin: 0, avgLoss: 0, avgHoldingPeriod: 0, totalTrades: 0,
                calmarRatio: 0, expectancy: 0, payoffRatio: 0,
            };
        }
        const wins = trades.filter(t => t.netPnl > 0);
        const losses = trades.filter(t => t.netPnl <= 0);
        const winRate = (wins.length / totalTrades) * 100;
        const avgWin = wins.length > 0
            ? wins.reduce((s, t) => s + t.netPnl, 0) / wins.length
            : 0;
        const avgLoss = losses.length > 0
            ? losses.reduce((s, t) => s + t.netPnl, 0) / losses.length
            : 0;
        const grossWins = wins.reduce((s, t) => s + t.netPnl, 0);
        const grossLosses = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
        const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);
        let equity = initialCapital;
        let peak = initialCapital;
        let maxDrawdown = 0;
        let maxDrawdownDuration = 0;
        let ddStart = -1;
        const tradeReturns = [];
        for (let i = 0; i < trades.length; i++) {
            equity += trades[i].netPnl;
            tradeReturns.push(trades[i].netPnl / initialCapital);
            if (equity > peak) {
                peak = equity;
                if (ddStart >= 0) {
                    const dur = i - ddStart;
                    if (dur > maxDrawdownDuration)
                        maxDrawdownDuration = dur;
                    ddStart = -1;
                }
            }
            else {
                const dd = ((peak - equity) / peak) * 100;
                if (dd > maxDrawdown)
                    maxDrawdown = dd;
                if (ddStart < 0)
                    ddStart = i;
            }
        }
        if (ddStart >= 0) {
            const dur = trades.length - ddStart;
            if (dur > maxDrawdownDuration)
                maxDrawdownDuration = dur;
        }
        const totalReturn = ((equity - initialCapital) / initialCapital) * 100;
        const meanReturn = tradeReturns.reduce((s, v) => s + v, 0) / tradeReturns.length;
        const variance = tradeReturns.reduce((s, v) => s + (v - meanReturn) ** 2, 0) / (tradeReturns.length - 1 || 1);
        const stdDev = Math.sqrt(variance);
        const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;
        const negReturns = tradeReturns.filter(r => r < 0);
        const downVariance = negReturns.length > 1
            ? negReturns.reduce((s, v) => s + (v - meanReturn) ** 2, 0) / (negReturns.length - 1)
            : 0;
        const downDev = Math.sqrt(downVariance);
        const sortinoRatio = downDev > 0 ? (meanReturn / downDev) * Math.sqrt(252) : 0;
        const cagr = totalTrades > 0
            ? (Math.pow(equity / initialCapital, 252 / totalTrades) - 1) * 100
            : 0;
        const calmarRatio = maxDrawdown > 0 ? cagr / maxDrawdown : 0;
        const avgHoldingPeriod = trades.reduce((s, t) => s + t.holdingBars, 0) / totalTrades;
        const winRateFrac = winRate / 100;
        const expectancy = winRateFrac * avgWin - (1 - winRateFrac) * Math.abs(avgLoss);
        const payoffRatio = avgLoss !== 0 ? Math.abs(avgWin / avgLoss) : 0;
        return {
            totalReturn,
            cagr,
            sharpeRatio,
            sortinoRatio,
            maxDrawdown,
            maxDrawdownDuration,
            winRate,
            profitFactor,
            avgWin,
            avgLoss,
            avgHoldingPeriod,
            totalTrades,
            calmarRatio,
            expectancy,
            payoffRatio,
        };
    }
}
//# sourceMappingURL=walk-forward.service.js.map