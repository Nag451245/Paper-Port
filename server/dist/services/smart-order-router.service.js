import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('SmartOrderRouter');
const SPREAD_TOLERANCE_BPS = 1;
const FILL_QUALITY_WINDOW = 500;
export class SmartOrderRouterService {
    fillStats = new Map();
    orderBookService;
    constructor(orderBookService) {
        this.orderBookService = orderBookService;
        this.fillStats.set('NSE', { totalFills: 0, totalSlippageBps: 0, recentSlippages: [] });
        this.fillStats.set('BSE', { totalFills: 0, totalSlippageBps: 0, recentSlippages: [] });
    }
    route(order) {
        if (order.exchange) {
            const explicit = order.exchange.toUpperCase();
            if (explicit === 'NSE' || explicit === 'BSE') {
                log.debug({ symbol: order.symbol, exchange: explicit }, 'Explicit exchange specified');
                return {
                    exchange: explicit,
                    reason: 'Explicit exchange specified by order',
                    expectedSpread: this.getExpectedSpread(order.symbol, explicit),
                    confidence: 1.0,
                };
            }
        }
        const nseSnapshot = this.orderBookService.getSnapshot(order.symbol);
        const bseSymbol = `${order.symbol}-BSE`;
        const bseSnapshot = this.orderBookService.getSnapshot(bseSymbol);
        const nseHasData = nseSnapshot.midPrice > 0;
        const bseHasData = bseSnapshot.midPrice > 0;
        if (!nseHasData && !bseHasData) {
            log.debug({ symbol: order.symbol }, 'No order book data — defaulting to NSE');
            return {
                exchange: 'NSE',
                reason: 'Default: no order book data available',
                expectedSpread: 0,
                confidence: 0.5,
            };
        }
        if (!bseHasData) {
            return {
                exchange: 'NSE',
                reason: 'Only NSE order book data available',
                expectedSpread: nseSnapshot.spreadBps,
                confidence: 0.8,
            };
        }
        if (!nseHasData) {
            return {
                exchange: 'BSE',
                reason: 'Only BSE order book data available',
                expectedSpread: bseSnapshot.spreadBps,
                confidence: 0.8,
            };
        }
        const nseSpread = nseSnapshot.spreadBps;
        const bseSpread = bseSnapshot.spreadBps;
        const spreadDiff = Math.abs(nseSpread - bseSpread);
        const nseQuality = this.getFillQualityScore('NSE');
        const bseQuality = this.getFillQualityScore('BSE');
        if (spreadDiff <= SPREAD_TOLERANCE_BPS) {
            const qualityDiff = nseQuality - bseQuality;
            if (qualityDiff > 0.5) {
                return {
                    exchange: 'BSE',
                    reason: `Spreads within ${SPREAD_TOLERANCE_BPS}bps — BSE has better fill quality (${bseQuality.toFixed(1)} vs ${nseQuality.toFixed(1)} avg slippage bps)`,
                    expectedSpread: bseSpread,
                    confidence: 0.7,
                };
            }
            return {
                exchange: 'NSE',
                reason: `Spreads within ${SPREAD_TOLERANCE_BPS}bps — preferring NSE for higher default liquidity`,
                expectedSpread: nseSpread,
                confidence: 0.75,
            };
        }
        if (nseSpread < bseSpread) {
            return {
                exchange: 'NSE',
                reason: `NSE has tighter spread (${nseSpread.toFixed(1)} vs ${bseSpread.toFixed(1)} bps)`,
                expectedSpread: nseSpread,
                confidence: this.computeConfidence(spreadDiff, nseQuality),
            };
        }
        return {
            exchange: 'BSE',
            reason: `BSE has tighter spread (${bseSpread.toFixed(1)} vs ${nseSpread.toFixed(1)} bps)`,
            expectedSpread: bseSpread,
            confidence: this.computeConfidence(spreadDiff, bseQuality),
        };
    }
    recordFillQuality(exchange, slippageBps) {
        const key = exchange.toUpperCase();
        let stats = this.fillStats.get(key);
        if (!stats) {
            stats = { totalFills: 0, totalSlippageBps: 0, recentSlippages: [] };
            this.fillStats.set(key, stats);
        }
        stats.totalFills++;
        stats.totalSlippageBps += slippageBps;
        stats.recentSlippages.push(slippageBps);
        if (stats.recentSlippages.length > FILL_QUALITY_WINDOW) {
            stats.recentSlippages = stats.recentSlippages.slice(-FILL_QUALITY_WINDOW);
        }
        log.debug({ exchange: key, slippageBps, totalFills: stats.totalFills }, 'Fill quality recorded');
    }
    getExchangeStats() {
        const result = {};
        for (const [exchange, stats] of this.fillStats) {
            const avgSlippage = stats.totalFills > 0
                ? stats.totalSlippageBps / stats.totalFills
                : 0;
            const recent = [...stats.recentSlippages];
            const recentAvg = recent.length > 0
                ? recent.reduce((a, b) => a + b, 0) / recent.length
                : 0;
            recent.sort((a, b) => a - b);
            const p50 = recent.length > 0 ? recent[Math.floor(recent.length * 0.50)] : 0;
            const p95 = recent.length > 0 ? recent[Math.floor(recent.length * 0.95)] : 0;
            result[exchange] = {
                totalFills: stats.totalFills,
                avgSlippageBps: Number(avgSlippage.toFixed(2)),
                recentAvgSlippageBps: Number(recentAvg.toFixed(2)),
                p50SlippageBps: Number(p50.toFixed(2)),
                p95SlippageBps: Number(p95.toFixed(2)),
            };
        }
        return result;
    }
    getFillQualityScore(exchange) {
        const stats = this.fillStats.get(exchange);
        if (!stats || stats.recentSlippages.length === 0)
            return 0;
        return stats.recentSlippages.reduce((a, b) => a + b, 0) / stats.recentSlippages.length;
    }
    getExpectedSpread(symbol, exchange) {
        const snapshotSymbol = exchange === 'BSE' ? `${symbol}-BSE` : symbol;
        const snapshot = this.orderBookService.getSnapshot(snapshotSymbol);
        return snapshot.spreadBps;
    }
    computeConfidence(spreadDiffBps, fillQuality) {
        let confidence = 0.6;
        if (spreadDiffBps > 5)
            confidence += 0.15;
        else if (spreadDiffBps > 2)
            confidence += 0.1;
        if (fillQuality > 0 && fillQuality < 2)
            confidence += 0.1;
        else if (fillQuality >= 2 && fillQuality < 5)
            confidence += 0.05;
        return Math.min(confidence, 0.95);
    }
}
//# sourceMappingURL=smart-order-router.service.js.map