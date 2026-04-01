import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
const log = createChildLogger('SniperExecutor');
export class SniperExecutorService {
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
        const executionId = `snipe_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const execution = { config, slices: [], cancelled: false };
        this.activeExecutions.set(executionId, execution);
        log.info({
            executionId, symbol: config.symbol, totalQty: config.totalQty,
            depthThreshold: config.depthThresholdMultiplier,
        }, 'Sniper execution started — watching for liquidity');
        let remainingQty = config.totalQty;
        let totalFilled = 0;
        let totalCost = 0;
        let sliceIndex = 0;
        let opportunitiesFound = 0;
        let opportunitiesTaken = 0;
        const deadline = Date.now() + config.maxDurationMinutes * 60_000;
        const depthHistory = [];
        const DEPTH_WINDOW = 20;
        while (remainingQty > 0 && !execution.cancelled && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
            try {
                const quote = await this.marketData.getQuote(config.symbol, config.exchange);
                const currentPrice = quote.ltp;
                const relevantDepth = config.side === 'BUY'
                    ? (quote.totalSellQty ?? 0)
                    : (quote.totalBuyQty ?? 0);
                depthHistory.push(relevantDepth);
                if (depthHistory.length > DEPTH_WINDOW)
                    depthHistory.shift();
                if (depthHistory.length < 3) {
                    execution.slices.push({
                        sliceIndex, qty: 0, price: 0,
                        status: 'WAITING', timestamp: new Date().toISOString(),
                        depthScore: 0,
                    });
                    sliceIndex++;
                    continue;
                }
                const medianDepth = this.computeMedian(depthHistory);
                const depthScore = medianDepth > 0 ? relevantDepth / medianDepth : 0;
                if (depthScore < config.depthThresholdMultiplier) {
                    execution.slices.push({
                        sliceIndex, qty: 0, price: 0,
                        status: 'WAITING', timestamp: new Date().toISOString(),
                        depthScore: Number(depthScore.toFixed(2)),
                    });
                    sliceIndex++;
                    continue;
                }
                opportunitiesFound++;
                let snipeQty = Math.round(remainingQty * (config.maxSlicePct / 100));
                snipeQty = Math.max(1, Math.min(snipeQty, remainingQty));
                const order = await this.tradeService.placeOrder(config.userId, {
                    portfolioId: config.portfolioId,
                    symbol: config.symbol,
                    side: config.side,
                    orderType: 'MARKET',
                    qty: snipeQty,
                    instrumentToken: config.symbol,
                    exchange: config.exchange,
                    strategyTag: `${config.strategyTag ?? 'SNIPER'}:strike${sliceIndex}`,
                });
                const fillPrice = Number(order.avgFillPrice ?? currentPrice);
                totalCost += fillPrice * snipeQty;
                totalFilled += snipeQty;
                remainingQty -= snipeQty;
                opportunitiesTaken++;
                execution.slices.push({
                    sliceIndex, qty: snipeQty, price: fillPrice,
                    status: 'FILLED', timestamp: new Date().toISOString(),
                    depthScore: Number(depthScore.toFixed(2)),
                });
                log.info({
                    executionId, sliceIndex, snipeQty, fillPrice,
                    depthScore: depthScore.toFixed(2), remainingQty,
                }, 'Sniper struck — liquidity captured');
            }
            catch (err) {
                execution.slices.push({
                    sliceIndex, qty: 0, price: 0,
                    status: 'FAILED', timestamp: new Date().toISOString(),
                    depthScore: 0,
                });
                log.error({ executionId, sliceIndex, err }, 'Sniper slice failed');
            }
            sliceIndex++;
        }
        const avgFillPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
        this.activeExecutions.delete(executionId);
        emit('execution', {
            type: 'ORDER_FILLED', userId: config.userId, orderId: executionId,
            symbol: config.symbol, fillPrice: avgFillPrice, qty: totalFilled,
            slippageBps: 0,
        }).catch(err => log.error({ err, executionId }, 'Failed to emit Sniper fill event'));
        log.info({
            executionId, totalFilled, avgFillPrice,
            opportunitiesFound, opportunitiesTaken,
        }, 'Sniper execution completed');
        return {
            executionId,
            slices: execution.slices,
            avgFillPrice,
            totalFilled,
            opportunitiesFound,
            opportunitiesTaken,
        };
    }
    computeMedian(values) {
        const sorted = [...values].sort((a, b) => a - b);
        const mid = Math.floor(sorted.length / 2);
        return sorted.length % 2 === 0
            ? (sorted[mid - 1] + sorted[mid]) / 2
            : sorted[mid];
    }
    cancel(executionId) {
        const execution = this.activeExecutions.get(executionId);
        if (!execution)
            return false;
        execution.cancelled = true;
        log.info({ executionId }, 'Sniper execution cancelled');
        return true;
    }
    getActiveExecutions() {
        return Array.from(this.activeExecutions.keys());
    }
}
//# sourceMappingURL=sniper-executor.service.js.map