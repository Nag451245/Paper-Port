import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('StrategySDK');

export interface ParameterSpec {
  name: string;
  type: 'number' | 'boolean' | 'string';
  min?: number;
  max?: number;
  step?: number;
  default: unknown;
  description?: string;
}

export interface Bar {
  timestamp: Date;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface Tick {
  symbol: string;
  ltp: number;
  bid?: number;
  ask?: number;
  volume: number;
  timestamp: Date;
}

export interface Fill {
  orderId: string;
  symbol: string;
  side: 'BUY' | 'SELL';
  qty: number;
  price: number;
  timestamp: Date;
}

export interface Signal {
  symbol: string;
  direction: 'BUY' | 'SELL';
  confidence: number;
  entryPrice: number;
  stopLoss: number;
  target: number;
  qty: number;
  reason?: string;
}

export type MarketRegime =
  | 'TRENDING_UP'
  | 'TRENDING_DOWN'
  | 'MEAN_REVERTING'
  | 'VOLATILE'
  | 'QUIET';

export interface StrategyContext {
  portfolio: {
    capital: number;
    investedValue: number;
    availableCash: number;
  };
  positions: Array<{
    symbol: string;
    side: string;
    qty: number;
    avgPrice: number;
    unrealizedPnl: number;
  }>;
  regime: MarketRegime;
  timestamp: Date;
  indicators: Map<string, number>;
}

export abstract class Strategy {
  abstract readonly name: string;
  abstract readonly version: string;
  abstract readonly parameters: ParameterSpec[];

  onInit(_context: StrategyContext): void {}

  abstract onBar(bar: Bar, context: StrategyContext): Signal | null;

  onTick?(tick: Tick, context: StrategyContext): Signal | null;
  onFill?(fill: Fill, context: StrategyContext): void;
  onExit?(reason: string): void;

  protected getParamValue<T>(params: Record<string, unknown>, name: string): T {
    const spec = this.parameters.find(p => p.name === name);
    const value = params[name] ?? spec?.default;
    return value as T;
  }
}

export class StrategyRegistry {
  private static instance: StrategyRegistry;
  private strategies = new Map<string, Strategy>();

  private constructor() {}

  static getInstance(): StrategyRegistry {
    if (!StrategyRegistry.instance) {
      StrategyRegistry.instance = new StrategyRegistry();
    }
    return StrategyRegistry.instance;
  }

  register(strategy: Strategy): void {
    if (this.strategies.has(strategy.name)) {
      log.warn({ name: strategy.name }, 'Overwriting existing strategy registration');
    }
    this.strategies.set(strategy.name, strategy);
    log.info({ name: strategy.name, version: strategy.version }, 'Strategy registered');
  }

  get(name: string): Strategy | undefined {
    return this.strategies.get(name);
  }

  list(): Strategy[] {
    return Array.from(this.strategies.values());
  }

  createInstance(name: string, params: Record<string, unknown>): Strategy {
    const template = this.strategies.get(name);
    if (!template) {
      throw new Error(`Strategy "${name}" not found in registry`);
    }

    const Constructor = template.constructor as new (params: Record<string, unknown>) => Strategy;
    return new Constructor(params);
  }
}

function computeSMA(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const slice = values.slice(-period);
  return slice.reduce((s, v) => s + v, 0) / period;
}

function computeRSI(closes: number[], period: number): number | null {
  if (closes.length < period + 1) return null;
  const recent = closes.slice(-(period + 1));
  let avgGain = 0;
  let avgLoss = 0;

  for (let i = 1; i <= period; i++) {
    const change = recent[i] - recent[i - 1];
    if (change > 0) avgGain += change;
    else avgLoss += Math.abs(change);
  }

  avgGain /= period;
  avgLoss /= period;

  if (avgLoss === 0) return 100;
  const rs = avgGain / avgLoss;
  return 100 - 100 / (1 + rs);
}

function computeATR(bars: Bar[], period: number): number | null {
  if (bars.length < period + 1) return null;
  const recent = bars.slice(-(period + 1));
  const trs: number[] = [];

  for (let i = 1; i < recent.length; i++) {
    const high = recent[i].high;
    const low = recent[i].low;
    const prevClose = recent[i - 1].close;
    trs.push(Math.max(high - low, Math.abs(high - prevClose), Math.abs(low - prevClose)));
  }

  return trs.reduce((s, v) => s + v, 0) / trs.length;
}

export class SMACrossoverStrategy extends Strategy {
  readonly name = 'SMA_CROSSOVER';
  readonly version = '1.0.0';
  readonly parameters: ParameterSpec[] = [
    { name: 'fastPeriod', type: 'number', min: 2, max: 50, step: 1, default: 10, description: 'Fast SMA period' },
    { name: 'slowPeriod', type: 'number', min: 5, max: 200, step: 1, default: 20, description: 'Slow SMA period' },
  ];

  private barHistory: Bar[] = [];
  private fastPeriod: number;
  private slowPeriod: number;
  private prevFastSMA: number | null = null;
  private prevSlowSMA: number | null = null;

  constructor(params: Record<string, unknown> = {}) {
    super();
    this.fastPeriod = (params.fastPeriod as number) ?? 10;
    this.slowPeriod = (params.slowPeriod as number) ?? 20;
  }

  onInit(_context: StrategyContext): void {
    this.barHistory = [];
    this.prevFastSMA = null;
    this.prevSlowSMA = null;
  }

  onBar(bar: Bar, context: StrategyContext): Signal | null {
    this.barHistory.push(bar);

    const closes = this.barHistory.map(b => b.close);
    const fastSMA = computeSMA(closes, this.fastPeriod);
    const slowSMA = computeSMA(closes, this.slowPeriod);

    if (fastSMA === null || slowSMA === null || this.prevFastSMA === null || this.prevSlowSMA === null) {
      this.prevFastSMA = fastSMA;
      this.prevSlowSMA = slowSMA;
      return null;
    }

    const prevCross = this.prevFastSMA - this.prevSlowSMA;
    const currCross = fastSMA - slowSMA;

    this.prevFastSMA = fastSMA;
    this.prevSlowSMA = slowSMA;

    const atr = computeATR(this.barHistory, 14) ?? bar.close * 0.02;
    const positionSize = Math.max(1, Math.floor(context.portfolio.availableCash * 0.02 / atr));

    if (prevCross <= 0 && currCross > 0) {
      return {
        symbol: '',
        direction: 'BUY',
        confidence: Math.min(1, Math.abs(currCross) / bar.close * 100),
        entryPrice: bar.close,
        stopLoss: bar.close - 2 * atr,
        target: bar.close + 3 * atr,
        qty: positionSize,
        reason: `Fast SMA (${this.fastPeriod}) crossed above Slow SMA (${this.slowPeriod})`,
      };
    }

    if (prevCross >= 0 && currCross < 0) {
      return {
        symbol: '',
        direction: 'SELL',
        confidence: Math.min(1, Math.abs(currCross) / bar.close * 100),
        entryPrice: bar.close,
        stopLoss: bar.close + 2 * atr,
        target: bar.close - 3 * atr,
        qty: positionSize,
        reason: `Fast SMA (${this.fastPeriod}) crossed below Slow SMA (${this.slowPeriod})`,
      };
    }

    return null;
  }
}

export class RSIMeanReversionStrategy extends Strategy {
  readonly name = 'RSI_MEAN_REVERSION';
  readonly version = '1.0.0';
  readonly parameters: ParameterSpec[] = [
    { name: 'period', type: 'number', min: 2, max: 50, step: 1, default: 14, description: 'RSI lookback period' },
    { name: 'oversold', type: 'number', min: 10, max: 40, step: 1, default: 30, description: 'Oversold threshold' },
    { name: 'overbought', type: 'number', min: 60, max: 90, step: 1, default: 70, description: 'Overbought threshold' },
  ];

  private barHistory: Bar[] = [];
  private period: number;
  private oversold: number;
  private overbought: number;
  private prevRSI: number | null = null;

  constructor(params: Record<string, unknown> = {}) {
    super();
    this.period = (params.period as number) ?? 14;
    this.oversold = (params.oversold as number) ?? 30;
    this.overbought = (params.overbought as number) ?? 70;
  }

  onInit(_context: StrategyContext): void {
    this.barHistory = [];
    this.prevRSI = null;
  }

  onBar(bar: Bar, context: StrategyContext): Signal | null {
    this.barHistory.push(bar);

    const closes = this.barHistory.map(b => b.close);
    const rsi = computeRSI(closes, this.period);

    if (rsi === null || this.prevRSI === null) {
      this.prevRSI = rsi;
      return null;
    }

    const atr = computeATR(this.barHistory, 14) ?? bar.close * 0.02;
    const positionSize = Math.max(1, Math.floor(context.portfolio.availableCash * 0.02 / atr));

    let signal: Signal | null = null;

    if (this.prevRSI <= this.oversold && rsi > this.oversold) {
      const distFromOversold = (50 - rsi) / (50 - this.oversold);
      signal = {
        symbol: '',
        direction: 'BUY',
        confidence: Math.min(1, Math.max(0.3, distFromOversold)),
        entryPrice: bar.close,
        stopLoss: bar.close - 2 * atr,
        target: bar.close + 3 * atr,
        qty: positionSize,
        reason: `RSI crossed above oversold (${this.oversold}): prev=${this.prevRSI.toFixed(1)}, curr=${rsi.toFixed(1)}`,
      };
    } else if (this.prevRSI >= this.overbought && rsi < this.overbought) {
      const distFromOverbought = (rsi - 50) / (this.overbought - 50);
      signal = {
        symbol: '',
        direction: 'SELL',
        confidence: Math.min(1, Math.max(0.3, distFromOverbought)),
        entryPrice: bar.close,
        stopLoss: bar.close + 2 * atr,
        target: bar.close - 3 * atr,
        qty: positionSize,
        reason: `RSI crossed below overbought (${this.overbought}): prev=${this.prevRSI.toFixed(1)}, curr=${rsi.toFixed(1)}`,
      };
    }

    this.prevRSI = rsi;
    return signal;
  }
}

export class MomentumBreakoutStrategy extends Strategy {
  readonly name = 'MOMENTUM_BREAKOUT';
  readonly version = '1.0.0';
  readonly parameters: ParameterSpec[] = [
    { name: 'lookback', type: 'number', min: 5, max: 100, step: 1, default: 20, description: 'Breakout lookback period' },
    { name: 'atrMultiplier', type: 'number', min: 0.5, max: 5, step: 0.5, default: 2, description: 'ATR multiplier for stop-loss' },
  ];

  private barHistory: Bar[] = [];
  private lookback: number;
  private atrMultiplier: number;

  constructor(params: Record<string, unknown> = {}) {
    super();
    this.lookback = (params.lookback as number) ?? 20;
    this.atrMultiplier = (params.atrMultiplier as number) ?? 2;
  }

  onInit(_context: StrategyContext): void {
    this.barHistory = [];
  }

  onBar(bar: Bar, context: StrategyContext): Signal | null {
    this.barHistory.push(bar);

    if (this.barHistory.length < this.lookback + 1) return null;

    const lookbackBars = this.barHistory.slice(-(this.lookback + 1), -1);
    const highestHigh = Math.max(...lookbackBars.map(b => b.high));
    const lowestLow = Math.min(...lookbackBars.map(b => b.low));

    const atr = computeATR(this.barHistory, 14);
    if (atr === null) return null;

    const positionSize = Math.max(1, Math.floor(context.portfolio.availableCash * 0.01 / (atr * this.atrMultiplier)));

    if (bar.close > highestHigh && bar.volume > lookbackBars.reduce((s, b) => s + b.volume, 0) / lookbackBars.length) {
      return {
        symbol: '',
        direction: 'BUY',
        confidence: Math.min(1, (bar.close - highestHigh) / atr * 0.5),
        entryPrice: bar.close,
        stopLoss: bar.close - this.atrMultiplier * atr,
        target: bar.close + this.atrMultiplier * 2 * atr,
        qty: positionSize,
        reason: `Breakout above ${this.lookback}-day high (${highestHigh.toFixed(2)}) with above-average volume`,
      };
    }

    if (bar.close < lowestLow && bar.volume > lookbackBars.reduce((s, b) => s + b.volume, 0) / lookbackBars.length) {
      return {
        symbol: '',
        direction: 'SELL',
        confidence: Math.min(1, (lowestLow - bar.close) / atr * 0.5),
        entryPrice: bar.close,
        stopLoss: bar.close + this.atrMultiplier * atr,
        target: bar.close - this.atrMultiplier * 2 * atr,
        qty: positionSize,
        reason: `Breakdown below ${this.lookback}-day low (${lowestLow.toFixed(2)}) with above-average volume`,
      };
    }

    return null;
  }
}

export class OUMeanReversionStrategy extends Strategy {
  readonly name = 'OU_MEAN_REVERSION';
  readonly version = '1.0.0';
  readonly parameters: ParameterSpec[] = [
    { name: 'lookback', type: 'number', min: 30, max: 250, step: 10, default: 60, description: 'Lookback for OU parameter estimation' },
    { name: 'entryZScore', type: 'number', min: 1.0, max: 3.0, step: 0.25, default: 1.5, description: 'Z-score threshold for entry' },
    { name: 'exitZScore', type: 'number', min: 0.0, max: 1.0, step: 0.1, default: 0.25, description: 'Z-score threshold for exit' },
    { name: 'minHalfLife', type: 'number', min: 1, max: 20, step: 1, default: 2, description: 'Minimum half-life in bars' },
    { name: 'maxHalfLife', type: 'number', min: 20, max: 200, step: 10, default: 60, description: 'Maximum half-life in bars' },
  ];

  private barHistory: Bar[] = [];
  private lookback: number;
  private entryZ: number;
  private exitZ: number;
  private minHL: number;
  private maxHL: number;

  constructor(params: Record<string, unknown> = {}) {
    super();
    this.lookback = (params.lookback as number) ?? 60;
    this.entryZ = (params.entryZScore as number) ?? 1.5;
    this.exitZ = (params.exitZScore as number) ?? 0.25;
    this.minHL = (params.minHalfLife as number) ?? 2;
    this.maxHL = (params.maxHalfLife as number) ?? 60;
  }

  onInit(_context: StrategyContext): void {
    this.barHistory = [];
  }

  onBar(bar: Bar, context: StrategyContext): Signal | null {
    this.barHistory.push(bar);
    if (this.barHistory.length < this.lookback + 1) return null;

    const closes = this.barHistory.slice(-this.lookback).map(b => b.close);
    const logPrices = closes.map(p => Math.log(p));

    const ouParams = this.estimateOU(logPrices);
    if (!ouParams) return null;

    const { theta, mu, sigma, halfLife } = ouParams;

    if (halfLife < this.minHL || halfLife > this.maxHL) return null;
    if (theta <= 0) return null;

    const hurst = this.computeHurst(closes);
    if (hurst >= 0.5) return null;

    const currentLog = Math.log(bar.close);
    const zScore = (currentLog - mu) / (sigma / Math.sqrt(2 * theta));

    const atr = computeATR(this.barHistory, 14) ?? bar.close * 0.02;
    const confidence = Math.min(1, Math.abs(zScore) / 3 * (0.5 - hurst) * 4);
    const positionSize = Math.max(1, Math.floor(context.portfolio.availableCash * 0.02 / atr));

    const equilibriumPrice = Math.exp(mu);

    if (zScore < -this.entryZ) {
      return {
        symbol: '',
        direction: 'BUY',
        confidence: Math.max(0.3, confidence),
        entryPrice: bar.close,
        stopLoss: bar.close - 2.5 * atr,
        target: equilibriumPrice,
        qty: positionSize,
        reason: `OU mean reversion BUY: z=${zScore.toFixed(2)}, half-life=${halfLife.toFixed(1)} bars, hurst=${hurst.toFixed(2)}, eq=${equilibriumPrice.toFixed(2)}`,
      };
    }

    if (zScore > this.entryZ) {
      return {
        symbol: '',
        direction: 'SELL',
        confidence: Math.max(0.3, confidence),
        entryPrice: bar.close,
        stopLoss: bar.close + 2.5 * atr,
        target: equilibriumPrice,
        qty: positionSize,
        reason: `OU mean reversion SELL: z=${zScore.toFixed(2)}, half-life=${halfLife.toFixed(1)} bars, hurst=${hurst.toFixed(2)}, eq=${equilibriumPrice.toFixed(2)}`,
      };
    }

    return null;
  }

  private estimateOU(logPrices: number[]): { theta: number; mu: number; sigma: number; halfLife: number } | null {
    if (logPrices.length < 10) return null;

    const y = logPrices.slice(1);
    const x = logPrices.slice(0, -1);

    let sumX = 0, sumY = 0, sumXX = 0, sumXY = 0;
    for (let i = 0; i < x.length; i++) {
      sumX += x[i];
      sumY += y[i];
      sumXX += x[i] * x[i];
      sumXY += x[i] * y[i];
    }
    const m = x.length;
    const denom = m * sumXX - sumX * sumX;
    if (Math.abs(denom) < 1e-12) return null;

    const a = (m * sumXY - sumX * sumY) / denom;
    const b = (sumY - a * sumX) / m;

    if (a >= 1 || a <= 0) return null;

    const theta = -Math.log(a);
    const mu = b / (1 - a);

    let sse = 0;
    for (let i = 0; i < x.length; i++) {
      const residual = y[i] - a * x[i] - b;
      sse += residual * residual;
    }
    const sigmaEq = Math.sqrt(sse / m);
    const sigma = sigmaEq * Math.sqrt(2 * theta / (1 - a * a));

    const halfLife = Math.log(2) / theta;

    return { theta, mu, sigma, halfLife };
  }

  private computeHurst(data: number[]): number {
    const n = data.length;
    if (n < 20) return 0.5;
    const lags = [2, 4, 8, 16].filter(l => l < n / 2);
    if (lags.length < 2) return 0.5;

    const logLags: number[] = [];
    const logRS: number[] = [];

    for (const lag of lags) {
      const rsVals: number[] = [];
      const chunks = Math.floor(n / lag);
      for (let c = 0; c < chunks; c++) {
        const slice = data.slice(c * lag, (c + 1) * lag);
        const mean = slice.reduce((s, v) => s + v, 0) / lag;
        let cumS = 0;
        const cumDev: number[] = [];
        for (const v of slice) { cumS += v - mean; cumDev.push(cumS); }
        const range = Math.max(...cumDev) - Math.min(...cumDev);
        const std = Math.sqrt(slice.reduce((s, v) => s + (v - mean) ** 2, 0) / lag);
        if (std > 0) rsVals.push(range / std);
      }
      if (rsVals.length > 0) {
        logLags.push(Math.log(lag));
        logRS.push(Math.log(rsVals.reduce((s, v) => s + v, 0) / rsVals.length));
      }
    }

    if (logLags.length < 2) return 0.5;
    const n2 = logLags.length;
    const xm = logLags.reduce((s, v) => s + v, 0) / n2;
    const ym = logRS.reduce((s, v) => s + v, 0) / n2;
    let num = 0, den = 0;
    for (let i = 0; i < n2; i++) { num += (logLags[i] - xm) * (logRS[i] - ym); den += (logLags[i] - xm) ** 2; }
    return den > 0 ? num / den : 0.5;
  }
}

const registry = StrategyRegistry.getInstance();
registry.register(new SMACrossoverStrategy());
registry.register(new RSIMeanReversionStrategy());
registry.register(new MomentumBreakoutStrategy());
registry.register(new OUMeanReversionStrategy());
