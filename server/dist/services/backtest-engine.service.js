import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('BacktestEngine');
const DEFAULT_COMMISSION_PCT = 0.03;
const DEFAULT_SLIPPAGE_BPS = 5;
function stdev(values) {
    if (values.length < 2)
        return 0;
    const mean = values.reduce((s, v) => s + v, 0) / values.length;
    const variance = values.reduce((s, v) => s + (v - mean) ** 2, 0) / (values.length - 1);
    return Math.sqrt(variance);
}
function mean(values) {
    if (values.length === 0)
        return 0;
    return values.reduce((s, v) => s + v, 0) / values.length;
}
export class BacktestEngine {
    run(config) {
        const { strategy, bars, initialCapital, symbol, } = config;
        const commissionPct = config.commissionPct ?? DEFAULT_COMMISSION_PCT;
        const slippageBps = config.slippageBps ?? DEFAULT_SLIPPAGE_BPS;
        if (bars.length === 0) {
            throw new Error('Cannot run backtest with zero bars');
        }
        log.info({ symbol, bars: bars.length, initialCapital }, 'Starting backtest');
        let cash = initialCapital;
        const openPositions = [];
        const closedTrades = [];
        const equityCurve = [];
        let peakEquity = initialCapital;
        let drawdownStartBar = 0;
        let maxDrawdownDuration = 0;
        let currentDrawdownStartBar = -1;
        const context = this.buildContext(cash, openPositions, bars[0], symbol);
        strategy.onInit(context);
        for (let i = 0; i < bars.length; i++) {
            const bar = bars[i];
            this.checkStopsAndTargets(bar, openPositions, closedTrades, i, symbol, commissionPct, slippageBps, strategy);
            const ctx = this.buildContext(cash, openPositions, bar, symbol);
            const signal = strategy.onBar(bar, ctx);
            if (signal) {
                const filled = this.executeSignal(signal, bar, cash, openPositions, symbol, i, commissionPct, slippageBps);
                if (filled) {
                    cash -= filled.cost;
                    openPositions.push(filled.position);
                    if (strategy.onFill) {
                        const fill = {
                            orderId: `bt-${i}-${closedTrades.length}`,
                            symbol,
                            side: signal.direction,
                            qty: filled.position.qty,
                            price: filled.position.entryPrice,
                            timestamp: bar.timestamp,
                        };
                        strategy.onFill(fill, this.buildContext(cash, openPositions, bar, symbol));
                    }
                }
            }
            const equity = this.computeEquity(cash, openPositions, bar);
            const drawdown = peakEquity - equity;
            const drawdownPct = peakEquity > 0 ? (drawdown / peakEquity) * 100 : 0;
            if (equity > peakEquity) {
                peakEquity = equity;
                if (currentDrawdownStartBar >= 0) {
                    const duration = i - currentDrawdownStartBar;
                    if (duration > maxDrawdownDuration) {
                        maxDrawdownDuration = duration;
                    }
                    currentDrawdownStartBar = -1;
                }
            }
            else if (drawdown > 0 && currentDrawdownStartBar < 0) {
                currentDrawdownStartBar = i;
            }
            equityCurve.push({
                timestamp: bar.timestamp,
                equity,
                drawdown,
                drawdownPct,
            });
        }
        if (currentDrawdownStartBar >= 0) {
            const duration = bars.length - 1 - currentDrawdownStartBar;
            if (duration > maxDrawdownDuration) {
                maxDrawdownDuration = duration;
            }
        }
        this.closeAllPositions(bars[bars.length - 1], openPositions, closedTrades, bars.length - 1, symbol, commissionPct, slippageBps);
        if (strategy.onExit) {
            strategy.onExit('backtest_complete');
        }
        const finalEquity = equityCurve.length > 0
            ? equityCurve[equityCurve.length - 1].equity
            : initialCapital;
        const metrics = this.computeMetrics(closedTrades, equityCurve, initialCapital, finalEquity, bars.length, maxDrawdownDuration);
        log.info({ symbol, totalTrades: metrics.totalTrades, totalReturn: metrics.totalReturn, sharpe: metrics.sharpeRatio }, 'Backtest complete');
        return {
            equityCurve,
            trades: closedTrades,
            metrics,
            config: {
                symbol,
                initialCapital,
                startDate: bars[0].timestamp,
                endDate: bars[bars.length - 1].timestamp,
                totalBars: bars.length,
            },
        };
    }
    buildContext(cash, openPositions, bar, symbol) {
        const investedValue = openPositions.reduce((sum, pos) => {
            const currentValue = pos.qty * bar.close;
            return sum + currentValue;
        }, 0);
        return {
            portfolio: {
                capital: cash + investedValue,
                investedValue,
                availableCash: cash,
            },
            positions: openPositions.map(pos => ({
                symbol: pos.symbol,
                side: pos.side,
                qty: pos.qty,
                avgPrice: pos.entryPrice,
                unrealizedPnl: pos.side === 'BUY'
                    ? (bar.close - pos.entryPrice) * pos.qty
                    : (pos.entryPrice - bar.close) * pos.qty,
            })),
            regime: 'QUIET',
            timestamp: bar.timestamp,
            indicators: new Map(),
        };
    }
    applySlippage(price, side, slippageBps) {
        const slippageFraction = slippageBps / 10_000;
        return side === 'BUY'
            ? price * (1 + slippageFraction)
            : price * (1 - slippageFraction);
    }
    computeCommission(price, qty, commissionPct) {
        return (price * qty * commissionPct) / 100;
    }
    executeSignal(signal, bar, cash, openPositions, symbol, barIndex, commissionPct, slippageBps) {
        const fillPrice = this.applySlippage(signal.entryPrice, signal.direction, slippageBps);
        const commission = this.computeCommission(fillPrice, signal.qty, commissionPct);
        const totalCost = fillPrice * signal.qty + commission;
        if (totalCost > cash) {
            log.debug({ required: totalCost, available: cash }, 'Insufficient cash for signal');
            return null;
        }
        const position = {
            symbol,
            side: signal.direction,
            qty: signal.qty,
            entryPrice: fillPrice,
            entryDate: bar.timestamp,
            entryBarIndex: barIndex,
            stopLoss: signal.stopLoss,
            target: signal.target,
            mae: 0,
            mfe: 0,
        };
        return { position, cost: totalCost };
    }
    checkStopsAndTargets(bar, openPositions, closedTrades, barIndex, symbol, commissionPct, slippageBps, strategy) {
        for (let j = openPositions.length - 1; j >= 0; j--) {
            const pos = openPositions[j];
            if (pos.side === 'BUY') {
                const adverseExcursion = (pos.entryPrice - bar.low) / pos.entryPrice * 100;
                const favorableExcursion = (bar.high - pos.entryPrice) / pos.entryPrice * 100;
                pos.mae = Math.max(pos.mae, adverseExcursion);
                pos.mfe = Math.max(pos.mfe, favorableExcursion);
            }
            else {
                const adverseExcursion = (bar.high - pos.entryPrice) / pos.entryPrice * 100;
                const favorableExcursion = (pos.entryPrice - bar.low) / pos.entryPrice * 100;
                pos.mae = Math.max(pos.mae, adverseExcursion);
                pos.mfe = Math.max(pos.mfe, favorableExcursion);
            }
            let exitPrice = null;
            let exitReason = '';
            if (pos.side === 'BUY') {
                if (bar.low <= pos.stopLoss) {
                    exitPrice = pos.stopLoss;
                    exitReason = 'stop_loss';
                }
                else if (bar.high >= pos.target) {
                    exitPrice = pos.target;
                    exitReason = 'target';
                }
            }
            else {
                if (bar.high >= pos.stopLoss) {
                    exitPrice = pos.stopLoss;
                    exitReason = 'stop_loss';
                }
                else if (bar.low <= pos.target) {
                    exitPrice = pos.target;
                    exitReason = 'target';
                }
            }
            if (exitPrice !== null) {
                const slippedExit = this.applySlippage(exitPrice, pos.side === 'BUY' ? 'SELL' : 'BUY', slippageBps);
                const entryCommission = this.computeCommission(pos.entryPrice, pos.qty, commissionPct);
                const exitCommission = this.computeCommission(slippedExit, pos.qty, commissionPct);
                const totalCommission = entryCommission + exitCommission;
                const entrySlippage = Math.abs(pos.entryPrice - bar.close) * pos.qty;
                const exitSlippage = Math.abs(slippedExit - exitPrice) * pos.qty;
                const totalSlippage = entrySlippage + exitSlippage;
                const grossPnl = pos.side === 'BUY'
                    ? (slippedExit - pos.entryPrice) * pos.qty
                    : (pos.entryPrice - slippedExit) * pos.qty;
                closedTrades.push({
                    entryDate: pos.entryDate,
                    exitDate: bar.timestamp,
                    symbol: pos.symbol,
                    side: pos.side,
                    entryPrice: pos.entryPrice,
                    exitPrice: slippedExit,
                    qty: pos.qty,
                    grossPnl,
                    commission: totalCommission,
                    slippage: totalSlippage,
                    netPnl: grossPnl - totalCommission,
                    holdingBars: barIndex - pos.entryBarIndex,
                    mae: pos.mae,
                    mfe: pos.mfe,
                });
                if (strategy.onFill) {
                    const fill = {
                        orderId: `bt-exit-${barIndex}-${j}`,
                        symbol: pos.symbol,
                        side: pos.side === 'BUY' ? 'SELL' : 'BUY',
                        qty: pos.qty,
                        price: slippedExit,
                        timestamp: bar.timestamp,
                    };
                    strategy.onFill(fill, this.buildContext(0, openPositions, bar, pos.symbol));
                }
                openPositions.splice(j, 1);
            }
        }
    }
    closeAllPositions(bar, openPositions, closedTrades, barIndex, symbol, commissionPct, slippageBps) {
        for (let j = openPositions.length - 1; j >= 0; j--) {
            const pos = openPositions[j];
            const slippedExit = this.applySlippage(bar.close, pos.side === 'BUY' ? 'SELL' : 'BUY', slippageBps);
            const entryCommission = this.computeCommission(pos.entryPrice, pos.qty, commissionPct);
            const exitCommission = this.computeCommission(slippedExit, pos.qty, commissionPct);
            const totalCommission = entryCommission + exitCommission;
            const totalSlippage = Math.abs(slippedExit - bar.close) * pos.qty;
            const grossPnl = pos.side === 'BUY'
                ? (slippedExit - pos.entryPrice) * pos.qty
                : (pos.entryPrice - slippedExit) * pos.qty;
            closedTrades.push({
                entryDate: pos.entryDate,
                exitDate: bar.timestamp,
                symbol: pos.symbol,
                side: pos.side,
                entryPrice: pos.entryPrice,
                exitPrice: slippedExit,
                qty: pos.qty,
                grossPnl,
                commission: totalCommission,
                slippage: totalSlippage,
                netPnl: grossPnl - totalCommission,
                holdingBars: barIndex - pos.entryBarIndex,
                mae: pos.mae,
                mfe: pos.mfe,
            });
            openPositions.splice(j, 1);
        }
    }
    computeEquity(cash, openPositions, bar) {
        const positionValue = openPositions.reduce((sum, pos) => {
            if (pos.side === 'BUY') {
                return sum + pos.qty * bar.close;
            }
            return sum + pos.qty * pos.entryPrice + (pos.entryPrice - bar.close) * pos.qty;
        }, 0);
        return cash + positionValue;
    }
    computeMetrics(trades, equityCurve, initialCapital, finalEquity, totalBars, maxDrawdownDuration) {
        const totalReturn = ((finalEquity - initialCapital) / initialCapital) * 100;
        const cagr = totalBars > 0
            ? (Math.pow(finalEquity / initialCapital, 252 / totalBars) - 1) * 100
            : 0;
        const dailyReturns = [];
        for (let i = 1; i < equityCurve.length; i++) {
            const prev = equityCurve[i - 1].equity;
            if (prev > 0) {
                dailyReturns.push((equityCurve[i].equity - prev) / prev);
            }
        }
        const meanDailyReturn = mean(dailyReturns);
        const dailyStdev = stdev(dailyReturns);
        const sharpeRatio = dailyStdev > 0
            ? (meanDailyReturn / dailyStdev) * Math.sqrt(252)
            : 0;
        const negativeReturns = dailyReturns.filter(r => r < 0);
        const downStdev = stdev(negativeReturns);
        const sortinoRatio = downStdev > 0
            ? (meanDailyReturn / downStdev) * Math.sqrt(252)
            : 0;
        const maxDrawdown = equityCurve.length > 0
            ? Math.max(...equityCurve.map(p => p.drawdownPct))
            : 0;
        const wins = trades.filter(t => t.netPnl > 0);
        const losses = trades.filter(t => t.netPnl <= 0);
        const totalTrades = trades.length;
        const winRate = totalTrades > 0 ? (wins.length / totalTrades) * 100 : 0;
        const grossWins = wins.reduce((s, t) => s + t.netPnl, 0);
        const grossLosses = Math.abs(losses.reduce((s, t) => s + t.netPnl, 0));
        const profitFactor = grossLosses > 0 ? grossWins / grossLosses : (grossWins > 0 ? Infinity : 0);
        const avgWin = wins.length > 0
            ? wins.reduce((s, t) => s + t.netPnl, 0) / wins.length
            : 0;
        const avgLoss = losses.length > 0
            ? losses.reduce((s, t) => s + t.netPnl, 0) / losses.length
            : 0;
        const avgHoldingPeriod = totalTrades > 0
            ? trades.reduce((s, t) => s + t.holdingBars, 0) / totalTrades
            : 0;
        const calmarRatio = maxDrawdown > 0 ? cagr / maxDrawdown : 0;
        const winRateFrac = winRate / 100;
        const expectancy = totalTrades > 0
            ? winRateFrac * avgWin - (1 - winRateFrac) * Math.abs(avgLoss)
            : 0;
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
//# sourceMappingURL=backtest-engine.service.js.map