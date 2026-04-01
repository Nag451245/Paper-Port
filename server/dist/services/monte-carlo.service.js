import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('MonteCarlo');
const DEFAULT_ITERATIONS = 10_000;
const DEFAULT_CONFIDENCE_LEVELS = [0.90, 0.95, 0.99];
const RUIN_THRESHOLD = 0.50;
function fisherYatesShuffle(array) {
    const shuffled = array.slice();
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        const tmp = shuffled[i];
        shuffled[i] = shuffled[j];
        shuffled[j] = tmp;
    }
    return shuffled;
}
function percentile(sorted, p) {
    if (sorted.length === 0)
        return 0;
    const idx = (p / 100) * (sorted.length - 1);
    const lo = Math.floor(idx);
    const hi = Math.ceil(idx);
    if (lo === hi)
        return sorted[lo];
    const frac = idx - lo;
    return sorted[lo] * (1 - frac) + sorted[hi] * frac;
}
function computeDistribution(values) {
    if (values.length === 0) {
        return { mean: 0, median: 0, stdev: 0, p5: 0, p10: 0, p25: 0, p75: 0, p90: 0, p95: 0, p99: 0 };
    }
    const sorted = values.slice().sort((a, b) => a - b);
    const n = sorted.length;
    const mean = sorted.reduce((s, v) => s + v, 0) / n;
    const variance = n > 1
        ? sorted.reduce((s, v) => s + (v - mean) ** 2, 0) / (n - 1)
        : 0;
    return {
        mean,
        median: percentile(sorted, 50),
        stdev: Math.sqrt(variance),
        p5: percentile(sorted, 5),
        p10: percentile(sorted, 10),
        p25: percentile(sorted, 25),
        p75: percentile(sorted, 75),
        p90: percentile(sorted, 90),
        p95: percentile(sorted, 95),
        p99: percentile(sorted, 99),
    };
}
export class MonteCarloSimulator {
    run(config) {
        const { trades, initialCapital, } = config;
        const iterations = config.iterations ?? DEFAULT_ITERATIONS;
        const confidenceLevels = config.confidenceLevels ?? DEFAULT_CONFIDENCE_LEVELS;
        if (trades.length === 0) {
            throw new Error('Cannot run Monte Carlo simulation with zero trades');
        }
        log.info({ trades: trades.length, iterations, initialCapital }, 'Starting Monte Carlo simulation');
        const pnls = trades.map(t => t.netPnl);
        const ruinLevel = initialCapital * RUIN_THRESHOLD;
        const finalReturns = new Array(iterations);
        const maxDrawdowns = new Array(iterations);
        const finalEquities = new Array(iterations);
        let ruinCount = 0;
        for (let i = 0; i < iterations; i++) {
            const shuffled = fisherYatesShuffle(pnls);
            const { finalEquity, maxDrawdownPct, hitRuin } = this.simulateEquityCurve(shuffled, initialCapital, ruinLevel);
            finalEquities[i] = finalEquity;
            finalReturns[i] = ((finalEquity - initialCapital) / initialCapital) * 100;
            maxDrawdowns[i] = maxDrawdownPct;
            if (hitRuin)
                ruinCount++;
        }
        const returnDistribution = computeDistribution(finalReturns);
        const maxDrawdownDistribution = computeDistribution(maxDrawdowns);
        const ruinProbability = ruinCount / iterations;
        const sortedEquities = finalEquities.slice().sort((a, b) => a - b);
        const medianFinalEquity = percentile(sortedEquities, 50);
        const worstCase = sortedEquities[0];
        const bestCase = sortedEquities[sortedEquities.length - 1];
        const sortedReturns = finalReturns.slice().sort((a, b) => a - b);
        const sortedDrawdowns = maxDrawdowns.slice().sort((a, b) => a - b);
        const confidenceIntervals = confidenceLevels.map(level => {
            const tailPct = ((1 - level) / 2) * 100;
            const upperPct = 100 - tailPct;
            return {
                level,
                lowerReturn: percentile(sortedReturns, tailPct),
                upperReturn: percentile(sortedReturns, upperPct),
                maxDrawdown: percentile(sortedDrawdowns, upperPct),
            };
        });
        log.info({
            medianReturn: returnDistribution.median,
            ruinProbability,
            medianFinalEquity,
            worstCase,
            bestCase,
        }, 'Monte Carlo simulation complete');
        return {
            iterations,
            returnDistribution,
            maxDrawdownDistribution,
            ruinProbability,
            confidenceIntervals,
            medianFinalEquity,
            worstCase,
            bestCase,
        };
    }
    simulateEquityCurve(pnls, initialCapital, ruinLevel) {
        let equity = initialCapital;
        let peak = initialCapital;
        let maxDrawdownPct = 0;
        let hitRuin = false;
        for (let i = 0; i < pnls.length; i++) {
            equity += pnls[i];
            if (equity > peak) {
                peak = equity;
            }
            if (peak > 0) {
                const dd = ((peak - equity) / peak) * 100;
                if (dd > maxDrawdownPct) {
                    maxDrawdownPct = dd;
                }
            }
            if (equity <= ruinLevel) {
                hitRuin = true;
            }
        }
        return { finalEquity: equity, maxDrawdownPct, hitRuin };
    }
}
//# sourceMappingURL=monte-carlo.service.js.map