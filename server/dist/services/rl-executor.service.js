import { createChildLogger } from '../lib/logger.js';
import { mlRLAction } from '../lib/ml-service-client.js';
import { emit } from '../lib/event-bus.js';
const log = createChildLogger('RLExecutor');
export class RLExecutorService {
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
        const executionId = `rl_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
        const execution = { config, slices: [], cancelled: false };
        this.activeExecutions.set(executionId, execution);
        log.info({
            executionId, symbol: config.symbol, totalQty: config.totalQty,
            durationMin: config.durationMinutes,
        }, 'RL execution started');
        let remainingQty = config.totalQty;
        let totalFilled = 0;
        let totalCost = 0;
        let sliceIndex = 0;
        let rlMode = 'unknown';
        let rlActionSum = 0;
        let rlActionCount = 0;
        const startTime = Date.now();
        const deadline = startTime + config.durationMinutes * 60_000;
        let prevVolume = 0;
        try {
            const initQuote = await this.marketData.getQuote(config.symbol, config.exchange);
            prevVolume = initQuote.volume ?? 0;
        }
        catch { /* use 0 */ }
        while (remainingQty > 0 && !execution.cancelled && Date.now() < deadline) {
            await new Promise(resolve => setTimeout(resolve, config.pollIntervalMs));
            try {
                const quote = await this.marketData.getQuote(config.symbol, config.exchange);
                const currentPrice = quote.ltp;
                const currentVolume = quote.volume ?? prevVolume;
                const volumeDelta = Math.max(0, currentVolume - prevVolume);
                prevVolume = currentVolume;
                const elapsed = Date.now() - startTime;
                const totalDuration = config.durationMinutes * 60_000;
                const state = {
                    remaining_pct: remainingQty / config.totalQty,
                    time_elapsed_pct: elapsed / totalDuration,
                    price_move_pct: (currentPrice - config.decisionPrice) / config.decisionPrice,
                    volume_ratio: config.avgDailyVolume > 0 ? (volumeDelta * 78) / config.avgDailyVolume : 1.0,
                    spread_bps: 5.0,
                    shortfall_bps: totalFilled > 0
                        ? Math.abs((totalCost / totalFilled - config.decisionPrice) / config.decisionPrice * 10000)
                        : 0,
                    volatility: 0.015,
                    momentum: (currentPrice - config.decisionPrice) / config.decisionPrice,
                };
                const rlResult = await mlRLAction(state);
                rlMode = rlResult.mode;
                const action = rlResult.action;
                rlActionSum += action;
                rlActionCount++;
                let sliceQty = Math.round(remainingQty * action);
                sliceQty = Math.max(1, Math.min(sliceQty, remainingQty));
                if (sliceQty < 1) {
                    execution.slices.push({
                        sliceIndex, qty: 0, price: 0,
                        status: 'SKIPPED', timestamp: new Date().toISOString(),
                        rlAction: action, mode: rlMode,
                    });
                    sliceIndex++;
                    continue;
                }
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
                    strategyTag: `${config.strategyTag ?? 'RL'}:step${sliceIndex}`,
                });
                const fillPrice = Number(order.avgFillPrice ?? limitPrice);
                totalCost += fillPrice * sliceQty;
                totalFilled += sliceQty;
                remainingQty -= sliceQty;
                execution.slices.push({
                    sliceIndex, qty: sliceQty, price: fillPrice,
                    status: 'FILLED', timestamp: new Date().toISOString(),
                    rlAction: action, mode: rlMode,
                });
                log.info({
                    executionId, sliceIndex, sliceQty, fillPrice,
                    rlAction: action.toFixed(3), mode: rlMode, remainingQty,
                }, 'RL slice filled');
            }
            catch (err) {
                execution.slices.push({
                    sliceIndex, qty: 0, price: 0,
                    status: 'FAILED', timestamp: new Date().toISOString(),
                    rlAction: 0, mode: rlMode,
                });
                log.error({ executionId, sliceIndex, err }, 'RL slice failed');
            }
            sliceIndex++;
        }
        const avgFillPrice = totalFilled > 0 ? totalCost / totalFilled : 0;
        const avgRLAction = rlActionCount > 0 ? rlActionSum / rlActionCount : 0;
        this.activeExecutions.delete(executionId);
        emit('execution', {
            type: 'ORDER_FILLED', userId: config.userId, orderId: executionId,
            symbol: config.symbol, fillPrice: avgFillPrice, qty: totalFilled,
            slippageBps: 0,
        }).catch(err => log.error({ err, executionId }, 'Failed to emit RL fill event'));
        log.info({
            executionId, totalFilled, avgFillPrice,
            rlMode, avgRLAction: avgRLAction.toFixed(3),
        }, 'RL execution completed');
        return {
            executionId,
            slices: execution.slices,
            avgFillPrice,
            totalFilled,
            rlMode,
            avgRLAction: Number(avgRLAction.toFixed(4)),
        };
    }
    cancel(executionId) {
        const execution = this.activeExecutions.get(executionId);
        if (!execution)
            return false;
        execution.cancelled = true;
        log.info({ executionId }, 'RL execution cancelled');
        return true;
    }
    getActiveExecutions() {
        return Array.from(this.activeExecutions.keys());
    }
}
//# sourceMappingURL=rl-executor.service.js.map