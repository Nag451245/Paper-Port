import { createChildLogger } from '../lib/logger.js';
import type { Strategy, Bar, Signal, StrategyContext } from './strategy-sdk.js';

const log = createChildLogger('ParamOptimizer');

export interface GridParamRange {
  name: string;
  values: number[];
}

export interface RandomParamRange {
  name: string;
  min: number;
  max: number;
}

export type ParamRange = GridParamRange | RandomParamRange;

export interface OptimizationResult {
  params: Record<string, number>;
  sharpe: number;
  returns: number;
  maxDrawdown: number;
  winRate: number;
  trades: number;
  overfitScore: number;
}

interface BacktestState {
  capital: number;
  position: { side: 'BUY' | 'SELL'; qty: number; entryPrice: number } | null;
  trades: Array<{ pnl: number; returnPct: number }>;
  equity: number[];
}

function isGridRange(r: ParamRange): r is GridParamRange {
  return 'values' in r;
}

function runBacktest(strategy: Strategy, bars: Bar[], initialCapital: number): BacktestState {
  const state: BacktestState = {
    capital: initialCapital,
    position: null,
    trades: [],
    equity: [initialCapital],
  };

  const context: StrategyContext = {
    portfolio: { capital: initialCapital, investedValue: 0, availableCash: initialCapital },
    positions: [],
    regime: 'MEAN_REVERTING',
    timestamp: new Date(),
    indicators: new Map(),
  };

  strategy.onInit(context);

  for (const bar of bars) {
    context.timestamp = bar.timestamp;
    context.portfolio.availableCash = state.position
      ? state.capital - state.position.qty * state.position.entryPrice
      : state.capital;
    context.portfolio.investedValue = state.position
      ? state.position.qty * bar.close
      : 0;

    if (state.position) {
      const unrealized = state.position.side === 'BUY'
        ? (bar.close - state.position.entryPrice) * state.position.qty
        : (state.position.entryPrice - bar.close) * state.position.qty;

      context.positions = [{
        symbol: '',
        side: state.position.side,
        qty: state.position.qty,
        avgPrice: state.position.entryPrice,
        unrealizedPnl: unrealized,
      }];
    } else {
      context.positions = [];
    }

    const signal: Signal | null = strategy.onBar(bar, context);

    if (signal && state.position) {
      const positionMatchesSell = state.position.side === 'BUY' && signal.direction === 'SELL';
      const positionMatchesBuy = state.position.side === 'SELL' && signal.direction === 'BUY';

      if (positionMatchesSell || positionMatchesBuy) {
        const pnl = state.position.side === 'BUY'
          ? (bar.close - state.position.entryPrice) * state.position.qty
          : (state.position.entryPrice - bar.close) * state.position.qty;

        state.capital += pnl;
        state.trades.push({
          pnl,
          returnPct: pnl / (state.position.entryPrice * state.position.qty),
        });
        state.position = null;
      }
    }

    if (signal && !state.position) {
      const qty = Math.min(signal.qty, Math.floor(state.capital / bar.close));
      if (qty > 0) {
        state.position = { side: signal.direction, qty, entryPrice: bar.close };
      }
    }

    if (state.position) {
      const mtm = state.position.side === 'BUY'
        ? (bar.close - state.position.entryPrice) * state.position.qty
        : (state.position.entryPrice - bar.close) * state.position.qty;
      state.equity.push(state.capital + mtm);
    } else {
      state.equity.push(state.capital);
    }
  }

  if (state.position && bars.length > 0) {
    const lastBar = bars[bars.length - 1];
    const pnl = state.position.side === 'BUY'
      ? (lastBar.close - state.position.entryPrice) * state.position.qty
      : (state.position.entryPrice - lastBar.close) * state.position.qty;
    state.capital += pnl;
    state.trades.push({
      pnl,
      returnPct: pnl / (state.position.entryPrice * state.position.qty),
    });
    state.position = null;
  }

  return state;
}

function computeMetrics(state: BacktestState, initialCapital: number): Omit<OptimizationResult, 'params' | 'overfitScore'> {
  const totalReturn = (state.capital - initialCapital) / initialCapital;

  const wins = state.trades.filter(t => t.pnl > 0);
  const winRate = state.trades.length > 0 ? wins.length / state.trades.length : 0;

  let maxDrawdown = 0;
  let peak = state.equity[0];
  for (const eq of state.equity) {
    if (eq > peak) peak = eq;
    const dd = (peak - eq) / peak;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const returns = state.trades.map(t => t.returnPct);
  const meanReturn = returns.length > 0 ? returns.reduce((s, r) => s + r, 0) / returns.length : 0;
  const variance = returns.length > 1
    ? returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / (returns.length - 1)
    : 0;
  const stdDev = Math.sqrt(variance);
  const sharpe = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252) : 0;

  return {
    sharpe,
    returns: totalReturn,
    maxDrawdown,
    winRate,
    trades: state.trades.length,
  };
}

function cartesianProduct(ranges: GridParamRange[]): Array<Record<string, number>> {
  if (ranges.length === 0) return [{}];

  const [first, ...rest] = ranges;
  const subProduct = cartesianProduct(rest);
  const result: Array<Record<string, number>> = [];

  for (const value of first.values) {
    for (const sub of subProduct) {
      result.push({ [first.name]: value, ...sub });
    }
  }

  return result;
}

export class ParameterOptimizerService {
  gridSearch(
    strategy: Strategy,
    bars: Bar[],
    paramRanges: GridParamRange[],
    initialCapital: number,
  ): OptimizationResult[] {
    const combos = cartesianProduct(paramRanges);
    log.info({ strategy: strategy.name, combinations: combos.length }, 'Starting grid search');

    const splitIndex = Math.floor(bars.length * 0.7);
    const inSampleBars = bars.slice(0, splitIndex);
    const outOfSampleBars = bars.slice(splitIndex);

    const results: OptimizationResult[] = [];

    for (const params of combos) {
      try {
        const Constructor = strategy.constructor as new (p: Record<string, unknown>) => Strategy;
        const instance = new Constructor(params);

        const isState = runBacktest(instance, inSampleBars, initialCapital);
        const isMetrics = computeMetrics(isState, initialCapital);

        const oosInstance = new Constructor(params);
        const oosState = runBacktest(oosInstance, outOfSampleBars, initialCapital);
        const oosMetrics = computeMetrics(oosState, initialCapital);

        const overfitScore = isMetrics.sharpe > 0
          ? Math.max(0, 1 - oosMetrics.sharpe / isMetrics.sharpe)
          : 0;

        results.push({
          params,
          sharpe: isMetrics.sharpe,
          returns: isMetrics.returns,
          maxDrawdown: isMetrics.maxDrawdown,
          winRate: isMetrics.winRate,
          trades: isMetrics.trades,
          overfitScore,
        });
      } catch (err) {
        log.warn({ err, params }, 'Backtest failed for parameter set');
      }
    }

    results.sort((a, b) => b.sharpe - a.sharpe);
    log.info({ strategy: strategy.name, resultsCount: results.length, bestSharpe: results[0]?.sharpe }, 'Grid search complete');
    return results;
  }

  randomSearch(
    strategy: Strategy,
    bars: Bar[],
    paramRanges: RandomParamRange[],
    initialCapital: number,
    iterations: number,
  ): OptimizationResult[] {
    log.info({ strategy: strategy.name, iterations }, 'Starting random search');

    const splitIndex = Math.floor(bars.length * 0.7);
    const inSampleBars = bars.slice(0, splitIndex);
    const outOfSampleBars = bars.slice(splitIndex);

    const results: OptimizationResult[] = [];

    for (let i = 0; i < iterations; i++) {
      const params: Record<string, number> = {};
      for (const range of paramRanges) {
        params[range.name] = range.min + Math.random() * (range.max - range.min);
        const spec = strategy.parameters.find(p => p.name === range.name);
        if (spec?.type === 'number' && spec.step) {
          params[range.name] = Math.round(params[range.name] / spec.step) * spec.step;
        }
      }

      try {
        const Constructor = strategy.constructor as new (p: Record<string, unknown>) => Strategy;
        const instance = new Constructor(params);

        const isState = runBacktest(instance, inSampleBars, initialCapital);
        const isMetrics = computeMetrics(isState, initialCapital);

        const oosInstance = new Constructor(params);
        const oosState = runBacktest(oosInstance, outOfSampleBars, initialCapital);
        const oosMetrics = computeMetrics(oosState, initialCapital);

        const overfitScore = isMetrics.sharpe > 0
          ? Math.max(0, 1 - oosMetrics.sharpe / isMetrics.sharpe)
          : 0;

        results.push({
          params,
          sharpe: isMetrics.sharpe,
          returns: isMetrics.returns,
          maxDrawdown: isMetrics.maxDrawdown,
          winRate: isMetrics.winRate,
          trades: isMetrics.trades,
          overfitScore,
        });
      } catch (err) {
        log.warn({ err, params, iteration: i }, 'Random search iteration failed');
      }
    }

    results.sort((a, b) => b.sharpe - a.sharpe);
    log.info({ strategy: strategy.name, resultsCount: results.length, bestSharpe: results[0]?.sharpe }, 'Random search complete');
    return results;
  }
}
