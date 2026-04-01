import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
const log = createChildLogger('ISExecutor');
export class ISExecutorService {
    tradeService;
    marketData;
    activeExecutions = new Map();
    setTradeService(ts) {
        this.tradeService = ts;
    }
    setMarketData(md) {
        this.marketData = md;
    }
    async execute(config) {
        const executionId = `is_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const execution = { config, slices: [], cancelled: false };
        this.activeExecutions.set(executionId, execution);
        const numSlices = config.numSlices ?? Math.max(5, Math.min(20, Math.ceil(config.durationMinutes / 3)));
        const trajectory = this.computeOptimalTrajectory(config, numSlices);
        const intervalMs = (config.durationMinutes * 60_000) / numSlices;
        log.info({
            executionId, symbol: config.symbol, totalQty: config.totalQty,
            numSlices, urgency: config.urgency, durationMin: config.durationMinutes,
        }, 'IS execution started');
        let remainingQty = config.totalQty;
        let totalCost = 0;
        let totalFilled = 0;
        for (let i = 0; i < numSlices; i++) {
            if (execution.cancelled || remainingQty <= 0)
                break;
            const targetRemaining = trajectory[i] ?? 0;
            const prevTarget = i === 0 ? config.totalQty : trajectory[i - 1];
            let sliceQty = Math.round(prevTarget - targetRemaining);
            try {
                const currentQuote = await this.marketData.getQuote(config.symbol, config.exchange);
                const currentPrice = currentQuote.ltp;
                const priceMove = (currentPrice - config.decisionPrice) / config.decisionPrice;
                const adverseMove = config.side === 'BUY' ? priceMove > 0 : priceMove < 0;
                if (adverseMove && Math.abs(priceMove) > 0.005) {
                    sliceQty = Math.round(sliceQty * 1.3);
                }
                else if (!adverseMove && Math.abs(priceMove) > 0.003) {
                    sliceQty = Math.round(sliceQty * 0.8);
                }
                sliceQty = Math.max(1, Math.min(sliceQty, remainingQty));
                const limitPrice = config.side === 'BUY'
                    ? currentPrice * (1 + 0.0015)
                    : currentPrice * (1 - 0.0015);
                const order = await this.tradeService.placeOrder(config.userId, {
                    portfolioId: config.portfolioId,
                    symbol: config.symbol,
                    side: config.side,
                    orderType: 'LIMIT',
                    qty: sliceQty,
                    price: Number(limitPrice.toFixed(2)),
                    instrumentToken: config.symbol,
                    exchange: config.exchange,
                    strategyTag: `${config.strategyTag ?? 'IS'}:slice${i}`,
                });
                const fillPrice = Number(order.avgFillPrice ?? limitPrice);
                totalCost += fillPrice * sliceQty;
                totalFilled += sliceQty;
                remainingQty -= sliceQty;
                const cumShortfall = config.decisionPrice > 0
                    ? ((totalCost / totalFilled) - config.decisionPrice) / config.decisionPrice * 10000
                    : 0;
                execution.slices.push({
                    sliceIndex: i, qty: sliceQty, price: fillPrice,
                    status: 'FILLED', timestamp: new Date().toISOString(),
                    cumulativeShortfallBps: Number(cumShortfall.toFixed(2)),
                });
                log.info({
                    executionId, sliceIndex: i, qty: sliceQty, fillPrice,
                    remainingQty, shortfallBps: cumShortfall.toFixed(2),
                }, 'IS slice filled');
            }
            catch (err) {
                execution.slices.push({
                    sliceIndex: i, qty: sliceQty, price: 0,
                    status: 'FAILED', timestamp: new Date().toISOString(),
                    cumulativeShortfallBps: 0,
                });
                log.error({ executionId, sliceIndex: i, err }, 'IS slice failed');
            }
            if (i < numSlices - 1 && remainingQty > 0) {
                await new Promise(resolve => setTimeout(resolve, intervalMs));
            }
        }
        const avgFillPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
        const totalShortfallBps = config.decisionPrice > 0
            ? Math.abs(avgFillPrice - config.decisionPrice) / config.decisionPrice * 10000
            : 0;
        this.activeExecutions.delete(executionId);
        emit('execution', {
            type: 'ORDER_FILLED', userId: config.userId, orderId: executionId,
            symbol: config.symbol, fillPrice: avgFillPrice, qty: totalFilled,
            slippageBps: Number(totalShortfallBps.toFixed(2)),
        }).catch(err => log.error({ err, executionId }, 'Failed to emit IS fill event'));
        log.info({
            executionId, totalFilled, avgFillPrice, totalShortfallBps: totalShortfallBps.toFixed(2),
        }, 'IS execution completed');
        return {
            executionId,
            slices: execution.slices,
            avgFillPrice,
            totalFilled,
            totalShortfallBps: Number(totalShortfallBps.toFixed(2)),
            optimalTrajectory: trajectory,
        };
    }
    computeOptimalTrajectory(config, numSlices) {
        const kappa = this.computeTradeOffParam(config);
        const trajectory = [];
        for (let j = 1; j <= numSlices; j++) {
            const t = j / numSlices;
            const remaining = config.totalQty * Math.sinh(kappa * (1 - t)) / Math.sinh(kappa);
            trajectory.push(Math.max(0, Math.round(remaining)));
        }
        return trajectory;
    }
    computeTradeOffParam(config) {
        const sigma = 0.015;
        const eta = 0.01;
        const gamma = config.urgency;
        const participationRate = config.avgDailyVolume > 0
            ? config.totalQty / config.avgDailyVolume
            : 0.01;
        const kappa = Math.sqrt(gamma * sigma * sigma / (eta * participationRate));
        return Math.max(0.5, Math.min(5.0, kappa));
    }
    cancel(executionId) {
        const execution = this.activeExecutions.get(executionId);
        if (!execution)
            return false;
        execution.cancelled = true;
        log.info({ executionId }, 'IS execution cancelled');
        return true;
    }
    getActiveExecutions() {
        return Array.from(this.activeExecutions.keys());
    }
}
//# sourceMappingURL=is-executor.service.js.map