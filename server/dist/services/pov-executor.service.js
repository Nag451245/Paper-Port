import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
const log = createChildLogger('POVExecutor');
export class POVExecutorService {
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
        const executionId = `pov_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const execution = { config, slices: [], cancelled: false };
        this.activeExecutions.set(executionId, execution);
        log.info({
            executionId, symbol: config.symbol, totalQty: config.totalQty,
            targetPct: config.targetPct, maxDurationMin: config.maxDurationMinutes,
        }, 'POV execution started');
        const initialQuote = await this.marketData.getQuote(config.symbol, config.exchange);
        let prevVolume = initialQuote.volume ?? 0;
        let remainingQty = config.totalQty;
        let totalFilled = 0;
        let totalCost = 0;
        let totalMarketVolume = 0;
        let sliceIndex = 0;
        const deadline = Date.now() + config.maxDurationMinutes * 60_000;
        while (remainingQty > 0 && !execution.cancelled && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
            try {
                const currentQuote = await this.marketData.getQuote(config.symbol, config.exchange);
                const currentVolume = currentQuote.volume ?? prevVolume;
                const volumeDelta = Math.max(0, currentVolume - prevVolume);
                prevVolume = currentVolume;
                totalMarketVolume += volumeDelta;
                if (volumeDelta < 10) {
                    execution.slices.push({
                        sliceIndex, qty: 0, price: 0,
                        status: 'SKIPPED', timestamp: new Date().toISOString(),
                        marketVolumeDelta: volumeDelta,
                    });
                    sliceIndex++;
                    continue;
                }
                let sliceQty = Math.round(volumeDelta * (config.targetPct / 100));
                sliceQty = Math.max(config.minSliceQty, Math.min(sliceQty, remainingQty));
                const currentPrice = currentQuote.ltp;
                const limitPrice = config.side === 'BUY'
                    ? currentPrice * (1 + 0.001)
                    : currentPrice * (1 - 0.001);
                const order = await this.tradeService.placeOrder(config.userId, {
                    portfolioId: config.portfolioId,
                    symbol: config.symbol,
                    side: config.side,
                    orderType: 'LIMIT',
                    qty: sliceQty,
                    price: Number(limitPrice.toFixed(2)),
                    instrumentToken: config.symbol,
                    exchange: config.exchange,
                    strategyTag: `${config.strategyTag ?? 'POV'}:slice${sliceIndex}`,
                });
                const fillPrice = Number(order.avgFillPrice ?? limitPrice);
                totalCost += fillPrice * sliceQty;
                totalFilled += sliceQty;
                remainingQty -= sliceQty;
                execution.slices.push({
                    sliceIndex, qty: sliceQty, price: fillPrice,
                    status: 'FILLED', timestamp: new Date().toISOString(),
                    marketVolumeDelta: volumeDelta,
                });
                log.info({
                    executionId, sliceIndex, sliceQty, fillPrice,
                    volumeDelta, remainingQty,
                }, 'POV slice filled');
            }
            catch (err) {
                execution.slices.push({
                    sliceIndex, qty: 0, price: 0,
                    status: 'FAILED', timestamp: new Date().toISOString(),
                    marketVolumeDelta: 0,
                });
                log.error({ executionId, sliceIndex, err }, 'POV slice failed');
            }
            sliceIndex++;
        }
        const avgFillPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
        const effectivePct = totalMarketVolume > 0 ? (totalFilled / totalMarketVolume) * 100 : 0;
        this.activeExecutions.delete(executionId);
        emit('execution', {
            type: 'ORDER_FILLED', userId: config.userId, orderId: executionId,
            symbol: config.symbol, fillPrice: avgFillPrice, qty: totalFilled,
            slippageBps: 0,
        }).catch(err => log.error({ err, executionId }, 'Failed to emit POV fill event'));
        log.info({
            executionId, totalFilled, avgFillPrice,
            effectiveParticipationPct: effectivePct.toFixed(2),
            totalSlices: sliceIndex,
        }, 'POV execution completed');
        return {
            executionId,
            slices: execution.slices,
            avgFillPrice,
            totalFilled,
            effectiveParticipationPct: Number(effectivePct.toFixed(2)),
        };
    }
    cancel(executionId) {
        const execution = this.activeExecutions.get(executionId);
        if (!execution)
            return false;
        execution.cancelled = true;
        log.info({ executionId }, 'POV execution cancelled');
        return true;
    }
    getActiveExecutions() {
        return Array.from(this.activeExecutions.keys());
    }
}
//# sourceMappingURL=pov-executor.service.js.map