import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('FillSimulator');
const DEFAULT_DAILY_VOLATILITY = 0.02;
const DEFAULT_TYPICAL_SPREAD_BPS = 3;
export class FillSimulatorService {
    simulate(order, marketState) {
        const { side, orderType, qty } = order;
        const { ltp, avgDailyVolume } = marketState;
        const bid = marketState.bid && marketState.bid > 0
            ? marketState.bid
            : ltp * (1 - DEFAULT_TYPICAL_SPREAD_BPS / 20_000);
        const ask = marketState.ask && marketState.ask > 0
            ? marketState.ask
            : ltp * (1 + DEFAULT_TYPICAL_SPREAD_BPS / 20_000);
        const adv = avgDailyVolume && avgDailyVolume > 0 ? avgDailyVolume : 1_000_000;
        const impact = this.computeMarketImpact(qty, adv);
        const { fillQty, partial } = this.computePartialFill(qty, adv);
        let fillPrice;
        let idealPrice;
        const normalizedType = orderType.toUpperCase();
        if (normalizedType === 'MARKET' || normalizedType === 'SL-M') {
            idealPrice = side === 'BUY' ? ask : bid;
            const impactDirection = side === 'BUY' ? 1 : -1;
            fillPrice = idealPrice * (1 + impactDirection * impact);
        }
        else {
            const limitPrice = order.price;
            if (limitPrice === undefined || limitPrice <= 0) {
                log.warn({ order }, 'Limit order without valid price — rejecting');
                return {
                    fillPrice: 0,
                    fillQty: 0,
                    slippageBps: 0,
                    marketImpact: 0,
                    latencyMs: 0,
                    partial: false,
                };
            }
            if (side === 'BUY' && limitPrice < ask) {
                return {
                    fillPrice: 0,
                    fillQty: 0,
                    slippageBps: 0,
                    marketImpact: 0,
                    latencyMs: 0,
                    partial: false,
                };
            }
            if (side === 'SELL' && limitPrice > bid) {
                return {
                    fillPrice: 0,
                    fillQty: 0,
                    slippageBps: 0,
                    marketImpact: 0,
                    latencyMs: 0,
                    partial: false,
                };
            }
            idealPrice = limitPrice;
            const impactDirection = side === 'BUY' ? 1 : -1;
            fillPrice = idealPrice * (1 + impactDirection * impact * 0.5);
        }
        fillPrice = Number(fillPrice.toFixed(2));
        const slippageBps = idealPrice > 0
            ? Math.abs(fillPrice - idealPrice) / idealPrice * 10_000
            : 0;
        const latencyMs = this.simulateLatency(normalizedType);
        log.debug({
            symbol: order.symbol,
            side,
            orderType,
            fillPrice,
            fillQty,
            slippageBps: Number(slippageBps.toFixed(2)),
            latencyMs,
        }, 'Fill simulated');
        return {
            fillPrice,
            fillQty,
            slippageBps: Number(slippageBps.toFixed(2)),
            marketImpact: Number((impact * 10_000).toFixed(2)),
            latencyMs,
            partial,
        };
    }
    simulateWithOrderBook(order, orderBook) {
        const { side, qty, orderType } = order;
        const levels = side === 'BUY'
            ? [...orderBook.asks]
            : [...orderBook.bids];
        if (levels.length === 0) {
            return this.simulate(order, {
                ltp: orderBook.midPrice,
                avgDailyVolume: undefined,
            });
        }
        const normalizedType = orderType.toUpperCase();
        if (normalizedType === 'LIMIT' || normalizedType === 'SL') {
            const limitPrice = order.price;
            if (limitPrice === undefined || limitPrice <= 0) {
                return { fillPrice: 0, fillQty: 0, slippageBps: 0, marketImpact: 0, latencyMs: 0, partial: false };
            }
            if (side === 'BUY') {
                const crossingLevels = levels.filter(l => l.price <= limitPrice);
                if (crossingLevels.length === 0) {
                    return { fillPrice: 0, fillQty: 0, slippageBps: 0, marketImpact: 0, latencyMs: 0, partial: false };
                }
                return this.walkBook(crossingLevels, qty, limitPrice, normalizedType);
            }
            else {
                const crossingLevels = levels.filter(l => l.price >= limitPrice);
                if (crossingLevels.length === 0) {
                    return { fillPrice: 0, fillQty: 0, slippageBps: 0, marketImpact: 0, latencyMs: 0, partial: false };
                }
                return this.walkBook(crossingLevels, qty, limitPrice, normalizedType);
            }
        }
        const idealPrice = levels[0].price;
        return this.walkBook(levels, qty, idealPrice, normalizedType);
    }
    walkBook(levels, targetQty, idealPrice, orderType) {
        let remaining = targetQty;
        let totalCost = 0;
        let filledQty = 0;
        for (const level of levels) {
            if (remaining <= 0)
                break;
            const filled = Math.min(remaining, level.qty);
            totalCost += filled * level.price;
            filledQty += filled;
            remaining -= filled;
        }
        const partial = filledQty < targetQty;
        const fillPrice = filledQty > 0 ? Number((totalCost / filledQty).toFixed(2)) : 0;
        const slippageBps = idealPrice > 0 && filledQty > 0
            ? Number((Math.abs(fillPrice - idealPrice) / idealPrice * 10_000).toFixed(2))
            : 0;
        const marketImpact = slippageBps;
        const latencyMs = this.simulateLatency(orderType);
        return { fillPrice, fillQty: filledQty, slippageBps, marketImpact, latencyMs, partial };
    }
    computeMarketImpact(orderQty, avgDailyVolume) {
        const lambda = 0.1 * DEFAULT_DAILY_VOLATILITY;
        let impact = lambda * Math.sqrt(orderQty / avgDailyVolume);
        if (orderQty > 0.05 * avgDailyVolume) {
            const participationRatio = orderQty / avgDailyVolume;
            impact += lambda * Math.sqrt(participationRatio) * 0.5;
        }
        return impact;
    }
    computePartialFill(orderQty, avgDailyVolume) {
        if (orderQty > 0.10 * avgDailyVolume) {
            const fillRatio = 0.5 + Math.random() * 0.4;
            const fillQty = Math.round(orderQty * fillRatio);
            return { fillQty, partial: true };
        }
        return { fillQty: orderQty, partial: false };
    }
    simulateLatency(orderType) {
        if (orderType === 'MARKET' || orderType === 'SL-M') {
            return Math.round(50 + Math.random() * 150);
        }
        return Math.round(100 + Math.random() * 400);
    }
}
//# sourceMappingURL=fill-simulator.service.js.map