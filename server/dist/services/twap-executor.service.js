import { MarketDataService } from './market-data.service.js';
import { MarketCalendar } from './market-calendar.js';
import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
const log = createChildLogger('TWAPExecutor');
export class TWAPExecutor {
    prisma;
    tradeService;
    marketData;
    calendar;
    activeExecutions = new Map();
    constructor(prisma) {
        this.prisma = prisma;
        this.marketData = new MarketDataService();
        this.calendar = new MarketCalendar();
    }
    setTradeService(ts) {
        this.tradeService = ts;
    }
    async executeTWAP(config) {
        const executionId = `twap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const execution = { config, slices: [], cancelled: false };
        this.activeExecutions.set(executionId, execution);
        log.info({ executionId, symbol: config.symbol, totalQty: config.totalQty, numSlices: config.numSlices }, 'TWAP execution started');
        const quote = await this.marketData.getQuote(config.symbol, config.exchange);
        const idealPrice = quote.ltp;
        if (idealPrice <= 0) {
            throw new Error(`Cannot start TWAP: no price available for ${config.symbol}`);
        }
        const sliceQty = Math.floor(config.totalQty / config.numSlices);
        const remainder = config.totalQty - sliceQty * config.numSlices;
        const intervalMs = (config.durationMinutes * 60_000) / config.numSlices;
        for (let i = 0; i < config.numSlices; i++) {
            if (execution.cancelled)
                break;
            if (!this.calendar.isMarketOpen(config.exchange)) {
                log.warn({ executionId, sliceIndex: i }, 'Market closed — stopping TWAP');
                break;
            }
            const qty = i === config.numSlices - 1 ? sliceQty + remainder : sliceQty;
            if (qty <= 0)
                continue;
            try {
                const currentQuote = await this.marketData.getQuote(config.symbol, config.exchange);
                const currentPrice = currentQuote.ltp;
                const deviationPct = Math.abs(currentPrice - idealPrice) / idealPrice * 100;
                if (deviationPct > config.maxDeviationPct) {
                    log.warn({ executionId, sliceIndex: i, deviationPct, maxDeviationPct: config.maxDeviationPct }, 'Price deviation exceeds limit — using LIMIT order');
                }
                const limitPrice = config.side === 'BUY'
                    ? currentPrice * (1 + 0.001)
                    : currentPrice * (1 - 0.001);
                const orderInput = {
                    portfolioId: config.portfolioId,
                    symbol: config.symbol,
                    side: config.side,
                    orderType: 'LIMIT',
                    qty,
                    price: Number(limitPrice.toFixed(2)),
                    instrumentToken: config.symbol,
                    exchange: config.exchange,
                    strategyTag: config.strategyTag,
                };
                const order = await this.tradeService.placeOrder(config.userId, orderInput);
                const fillPrice = Number(order.avgFillPrice ?? limitPrice);
                execution.slices.push({
                    sliceIndex: i, qty, price: fillPrice,
                    status: 'FILLED', timestamp: new Date().toISOString(),
                });
                log.info({ executionId, sliceIndex: i, qty, fillPrice }, 'TWAP slice filled');
            }
            catch (err) {
                execution.slices.push({
                    sliceIndex: i, qty, price: 0,
                    status: 'FAILED', timestamp: new Date().toISOString(),
                });
                log.error({ executionId, sliceIndex: i, err }, 'TWAP slice failed');
            }
            if (i < config.numSlices - 1) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }
        const filledSlices = execution.slices.filter(s => s.status === 'FILLED');
        const totalFilled = filledSlices.reduce((s, sl) => s + sl.qty, 0);
        const totalCost = filledSlices.reduce((s, sl) => s + sl.qty * sl.price, 0);
        const avgFillPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
        const slippageBps = idealPrice > 0 ? Math.abs(avgFillPrice - idealPrice) / idealPrice * 10000 : 0;
        this.activeExecutions.delete(executionId);
        emit('execution', {
            type: 'ORDER_FILLED', userId: config.userId, orderId: executionId,
            symbol: config.symbol, fillPrice: avgFillPrice, qty: totalFilled,
            slippageBps: Number(slippageBps.toFixed(2)),
        }).catch(err => log.error({ err, executionId }, 'Failed to emit TWAP ORDER_FILLED event'));
        log.info({ executionId, totalFilled, avgFillPrice, slippageBps: slippageBps.toFixed(2) }, 'TWAP execution completed');
        return { executionId, slices: execution.slices, avgFillPrice, totalFilled, idealPrice, slippageBps: Number(slippageBps.toFixed(2)) };
    }
    async executeVWAP(config) {
        const executionId = `vwap_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const execution = { config, slices: [], cancelled: false };
        this.activeExecutions.set(executionId, execution);
        const volumeProfile = config.volumeProfile ?? this.getDefaultVolumeProfile(config.numSlices);
        const totalWeight = volumeProfile.reduce((a, b) => a + b, 0);
        const normalizedWeights = volumeProfile.map(w => w / totalWeight);
        const quote = await this.marketData.getQuote(config.symbol, config.exchange);
        const idealPrice = quote.ltp;
        const decisionPrice = idealPrice;
        if (idealPrice <= 0) {
            throw new Error(`Cannot start adaptive VWAP: no price for ${config.symbol}`);
        }
        const intervalMs = (config.durationMinutes * 60_000) / config.numSlices;
        let remainingQty = config.totalQty;
        let prevVolume = quote.volume ?? 0;
        let expectedCumVolume = 0;
        let actualCumVolume = 0;
        log.info({ executionId, symbol: config.symbol, totalQty: config.totalQty, numSlices: config.numSlices }, 'Adaptive VWAP started');
        for (let i = 0; i < config.numSlices; i++) {
            if (execution.cancelled || remainingQty <= 0)
                break;
            if (!this.calendar.isMarketOpen(config.exchange)) {
                log.warn({ executionId, sliceIndex: i }, 'Market closed — stopping VWAP');
                break;
            }
            let baseSliceQty = Math.max(1, Math.round(normalizedWeights[i] * config.totalQty));
            try {
                const currentQuote = await this.marketData.getQuote(config.symbol, config.exchange);
                const currentPrice = currentQuote.ltp;
                const currentVolume = currentQuote.volume ?? prevVolume;
                const volumeDelta = Math.max(0, currentVolume - prevVolume);
                expectedCumVolume += normalizedWeights[i] * (currentVolume > 0 ? currentVolume : 100000);
                actualCumVolume += volumeDelta;
                const volumeRatio = expectedCumVolume > 0 ? actualCumVolume / expectedCumVolume : 1.0;
                const volumeAdj = Math.max(0.5, Math.min(2.0, volumeRatio));
                let priceUrgency = 1.0;
                const priceMovePct = (currentPrice - decisionPrice) / decisionPrice;
                if ((config.side === 'BUY' && priceMovePct > 0.005) || (config.side === 'SELL' && priceMovePct < -0.005)) {
                    priceUrgency = 1.5;
                }
                else if ((config.side === 'BUY' && priceMovePct < -0.003) || (config.side === 'SELL' && priceMovePct > 0.003)) {
                    priceUrgency = 0.7;
                }
                let adaptedQty = Math.round(baseSliceQty * volumeAdj * priceUrgency);
                adaptedQty = Math.min(adaptedQty, remainingQty);
                adaptedQty = Math.max(1, adaptedQty);
                const limitPrice = config.side === 'BUY'
                    ? currentPrice * (1 + 0.001)
                    : currentPrice * (1 - 0.001);
                const orderInput = {
                    portfolioId: config.portfolioId,
                    symbol: config.symbol,
                    side: config.side,
                    orderType: 'LIMIT',
                    qty: adaptedQty,
                    price: Number(limitPrice.toFixed(2)),
                    instrumentToken: config.symbol,
                    exchange: config.exchange,
                    strategyTag: config.strategyTag,
                };
                const order = await this.tradeService.placeOrder(config.userId, orderInput);
                const fillPrice = Number(order.avgFillPrice ?? limitPrice);
                execution.slices.push({
                    sliceIndex: i, qty: adaptedQty, price: fillPrice,
                    status: 'FILLED', timestamp: new Date().toISOString(),
                });
                remainingQty -= adaptedQty;
                prevVolume = currentVolume;
                log.info({
                    executionId, sliceIndex: i, baseQty: baseSliceQty, adaptedQty,
                    volumeAdj: volumeAdj.toFixed(2), priceUrgency: priceUrgency.toFixed(2),
                    fillPrice, remainingQty,
                }, 'Adaptive VWAP slice filled');
            }
            catch (err) {
                execution.slices.push({
                    sliceIndex: i, qty: baseSliceQty, price: 0,
                    status: 'FAILED', timestamp: new Date().toISOString(),
                });
                log.error({ executionId, sliceIndex: i, err }, 'Adaptive VWAP slice failed');
            }
            if (i < config.numSlices - 1 && remainingQty > 0) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }
        const filledSlices = execution.slices.filter(s => s.status === 'FILLED');
        const totalFilled = filledSlices.reduce((s, sl) => s + sl.qty, 0);
        const totalCost = filledSlices.reduce((s, sl) => s + sl.qty * sl.price, 0);
        const avgFillPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
        const slippageBps = idealPrice > 0 ? Math.abs(avgFillPrice - idealPrice) / idealPrice * 10000 : 0;
        this.activeExecutions.delete(executionId);
        emit('execution', {
            type: 'ORDER_FILLED', userId: config.userId, orderId: executionId,
            symbol: config.symbol, fillPrice: avgFillPrice, qty: totalFilled,
            slippageBps: Number(slippageBps.toFixed(2)),
        }).catch(err => log.error({ err, executionId }, 'Failed to emit VWAP ORDER_FILLED event'));
        log.info({ executionId, totalFilled, avgFillPrice, slippageBps: slippageBps.toFixed(2) }, 'Adaptive VWAP completed');
        return { executionId, slices: execution.slices, avgFillPrice, totalFilled, idealPrice, slippageBps: Number(slippageBps.toFixed(2)) };
    }
    getDefaultVolumeProfile(numSlices) {
        // U-shaped intraday volume: high at open, low midday, high at close
        const profile = [];
        for (let i = 0; i < numSlices; i++) {
            const t = i / (numSlices - 1 || 1);
            const weight = 1.5 - Math.sin(t * Math.PI) * 0.8;
            profile.push(Math.max(0.2, weight));
        }
        return profile;
    }
    cancelExecution(executionId) {
        const execution = this.activeExecutions.get(executionId);
        if (!execution)
            return false;
        execution.cancelled = true;
        log.info({ executionId }, 'TWAP execution cancelled');
        return true;
    }
    getActiveExecutions() {
        return Array.from(this.activeExecutions.keys());
    }
    /**
     * Compute implementation shortfall: the cost of execution vs. decision price.
     * IS = (Execution VWAP - Decision Price) / Decision Price * 10000 (in bps)
     * Decomposed into: delay cost + market impact + timing cost
     */
    computeImplementationShortfall(decisionPrice, arrivalPrice, executionVwap, totalQty, avgDailyVolume) {
        if (decisionPrice <= 0) {
            return { totalShortfallBps: 0, delayCostBps: 0, marketImpactBps: 0, timingCostBps: 0, participationRate: 0 };
        }
        const totalIS = (executionVwap - decisionPrice) / decisionPrice * 10000;
        const delayCost = (arrivalPrice - decisionPrice) / decisionPrice * 10000;
        const marketImpact = this.estimateMarketImpact(totalQty, decisionPrice, avgDailyVolume);
        const timingCost = totalIS - delayCost - marketImpact;
        return {
            totalShortfallBps: round2(totalIS),
            delayCostBps: round2(delayCost),
            marketImpactBps: round2(marketImpact),
            timingCostBps: round2(timingCost),
            participationRate: avgDailyVolume > 0 ? round2(totalQty / avgDailyVolume * 100) : 0,
        };
    }
    /**
     * Square-root market impact model: Impact = σ * sqrt(Q / V) * constant
     * Based on Almgren-Chriss framework, simplified for Indian equities.
     */
    estimateMarketImpact(qty, price, avgDailyVolume) {
        if (avgDailyVolume <= 0 || price <= 0)
            return 0;
        const participationRate = qty / avgDailyVolume;
        // Empirical constant for Indian equities (~0.5-1.5 based on NSE studies)
        const impactConstant = 0.8;
        // Assumed daily volatility of 1.5% for Indian large-caps
        const dailyVol = 0.015;
        const impactPct = impactConstant * dailyVol * Math.sqrt(participationRate);
        return impactPct * 10000;
    }
}
function round2(v) {
    return Math.round(v * 100) / 100;
}
export function selectOrderType(params) {
    const { qty, ltp, avgDailyVolume, confidence, spreadPct } = params;
    const participationRate = avgDailyVolume > 0 ? qty / avgDailyVolume : 0;
    // Square-root impact model
    const dailyVol = 0.015;
    const impactBps = avgDailyVolume > 0
        ? round2(0.8 * dailyVol * Math.sqrt(participationRate) * 10000)
        : 0;
    const urgency = params.urgency ?? 0;
    const stealth = params.stealth ?? false;
    if (urgency > 0.7 && participationRate > 0.01) {
        return { orderType: 'IS', reason: `High urgency (${urgency.toFixed(1)}) with ${(participationRate * 100).toFixed(2)}% participation — IS to minimize shortfall`, estimatedImpactBps: impactBps };
    }
    if (urgency < 0.3 && participationRate > 0.02 && qty * ltp > 500_000) {
        return { orderType: 'SNIPER', reason: `Low urgency large order — Sniper to seek natural liquidity`, estimatedImpactBps: impactBps };
    }
    if (stealth && participationRate > 0.005) {
        return { orderType: 'POV', reason: `Stealth mode — POV at ${(participationRate * 100).toFixed(2)}% to stay invisible`, estimatedImpactBps: impactBps };
    }
    // High participation (>2%) — use VWAP for volume-weighted distribution
    if (participationRate > 0.02) {
        return { orderType: 'VWAP', reason: `Order is ${(participationRate * 100).toFixed(2)}% of daily volume — VWAP to match volume profile`, estimatedImpactBps: impactBps };
    }
    // Moderate participation (>1%) — use TWAP for time-weighted slicing
    if (participationRate > 0.01) {
        return { orderType: 'TWAP', reason: `Order is ${(participationRate * 100).toFixed(2)}% of daily volume — TWAP to reduce impact`, estimatedImpactBps: impactBps };
    }
    // Mid-cap with noticeable estimated impact (>5 bps) — use TWAP regardless
    if (impactBps > 5 && qty * ltp > 50_000) {
        return { orderType: 'TWAP', reason: `Estimated market impact ${impactBps.toFixed(1)} bps — TWAP to reduce slippage`, estimatedImpactBps: impactBps };
    }
    if (qty * ltp > 200_000 && participationRate > 0.005) {
        return { orderType: 'ICEBERG', reason: `Large order — Iceberg to hide full size`, estimatedImpactBps: impactBps };
    }
    if (confidence >= 0.7) {
        return { orderType: 'MARKET', reason: 'High confidence signal — MARKET for immediate fill', estimatedImpactBps: impactBps };
    }
    if (spreadPct > 0.1) {
        return { orderType: 'LIMIT', reason: `Wide spread (${spreadPct.toFixed(2)}%) — LIMIT at mid-price to reduce cost`, estimatedImpactBps: impactBps };
    }
    if (confidence < 0.5) {
        return { orderType: 'LIMIT', reason: 'Low confidence — LIMIT at favorable price', estimatedImpactBps: impactBps };
    }
    return { orderType: 'MARKET', reason: 'Standard execution', estimatedImpactBps: impactBps };
}
//# sourceMappingURL=twap-executor.service.js.map