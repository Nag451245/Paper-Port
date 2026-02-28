import type { PrismaClient } from '@prisma/client';
import type { BacktestResult } from '@prisma/client';
import { MarketDataService, type HistoricalBar } from './market-data.service.js';
import { isEngineAvailable, engineBacktest } from '../lib/rust-engine.js';

export class BacktestError extends Error {
  constructor(
    message: string,
    public readonly statusCode: number = 500
  ) {
    super(message);
    this.name = 'BacktestError';
    Object.setPrototypeOf(this, BacktestError.prototype);
  }
}

export interface RunBacktestInput {
  strategyId: string;
  symbol: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  parameters?: Record<string, unknown>;
}

interface TradeEntry {
  entryDate: string;
  exitDate: string;
  entryPrice: number;
  exitPrice: number;
  qty: number;
  side: 'LONG' | 'SHORT';
  pnl: number;
  pnlPercent: number;
}

type StrategyFn = (
  bars: HistoricalBar[],
  params: Record<string, unknown>,
  initialCapital: number,
) => { trades: TradeEntry[]; equityCurve: { date: string; value: number }[] };

const STRATEGIES: Record<string, StrategyFn> = {
  orb: runORB,
  opening_range_breakout: runORB,
  sma_crossover: runSMACrossover,
  mean_reversion: runMeanReversion,
  momentum: runMomentum,
  rsi_reversal: runRSIReversal,
};

function sma(values: number[], period: number): (number | null)[] {
  const result: (number | null)[] = [];
  for (let i = 0; i < values.length; i++) {
    if (i < period - 1) { result.push(null); continue; }
    let sum = 0;
    for (let j = i - period + 1; j <= i; j++) sum += values[j];
    result.push(sum / period);
  }
  return result;
}

function rsi(closes: number[], period = 14): (number | null)[] {
  const result: (number | null)[] = [null];
  let avgGain = 0, avgLoss = 0;

  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i - 1];
    if (i <= period) {
      if (diff > 0) avgGain += diff; else avgLoss += Math.abs(diff);
      if (i === period) {
        avgGain /= period; avgLoss /= period;
        result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
      } else {
        result.push(null);
      }
    } else {
      const gain = diff > 0 ? diff : 0;
      const loss = diff < 0 ? Math.abs(diff) : 0;
      avgGain = (avgGain * (period - 1) + gain) / period;
      avgLoss = (avgLoss * (period - 1) + loss) / period;
      result.push(avgLoss === 0 ? 100 : 100 - 100 / (1 + avgGain / avgLoss));
    }
  }
  return result;
}

function runORB(bars: HistoricalBar[], params: Record<string, unknown>, initialCapital: number) {
  const rangePeriod = Number(params.rangePeriod ?? params.range_period ?? 15);
  const targetPct = Number(params.targetPercent ?? params.target ?? 1.5) / 100;
  const slPct = Number(params.stopLoss ?? params.stop_loss ?? 0.75) / 100;

  const trades: TradeEntry[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  let capital = initialCapital;
  equityCurve.push({ date: bars[0]?.timestamp?.slice(0, 10) ?? '', value: capital });

  for (let i = 1; i < bars.length; i++) {
    const bar = bars[i];
    const prevHigh = bars[i - 1].high;
    const prevLow = bars[i - 1].low;
    const range = prevHigh - prevLow;

    if (range <= 0) continue;
    const rangeRatio = range / bars[i - 1].close;
    if (rangeRatio > 0.05) continue; // skip very volatile days

    const breakoutUp = bar.high > prevHigh;
    const breakoutDown = bar.low < prevLow;

    if (breakoutUp) {
      const entry = prevHigh;
      const target = entry * (1 + targetPct);
      const sl = entry * (1 - slPct);
      const exit = bar.high >= target ? target : (bar.low <= sl ? sl : bar.close);
      const qty = Math.floor(capital * 0.1 / entry);
      if (qty <= 0) continue;

      const pnl = (exit - entry) * qty;
      capital += pnl;
      trades.push({
        entryDate: bar.timestamp?.slice(0, 10) ?? '',
        exitDate: bar.timestamp?.slice(0, 10) ?? '',
        entryPrice: Math.round(entry * 100) / 100,
        exitPrice: Math.round(exit * 100) / 100,
        qty, side: 'LONG',
        pnl: Math.round(pnl * 100) / 100,
        pnlPercent: Math.round(((exit - entry) / entry) * 10000) / 100,
      });
    } else if (breakoutDown) {
      const entry = prevLow;
      const target = entry * (1 - targetPct);
      const sl = entry * (1 + slPct);
      const exit = bar.low <= target ? target : (bar.high >= sl ? sl : bar.close);
      const qty = Math.floor(capital * 0.1 / entry);
      if (qty <= 0) continue;

      const pnl = (entry - exit) * qty;
      capital += pnl;
      trades.push({
        entryDate: bar.timestamp?.slice(0, 10) ?? '',
        exitDate: bar.timestamp?.slice(0, 10) ?? '',
        entryPrice: Math.round(entry * 100) / 100,
        exitPrice: Math.round(exit * 100) / 100,
        qty, side: 'SHORT',
        pnl: Math.round(pnl * 100) / 100,
        pnlPercent: Math.round(((entry - exit) / entry) * 10000) / 100,
      });
    }
    equityCurve.push({ date: bar.timestamp?.slice(0, 10) ?? '', value: Math.round(capital * 100) / 100 });
  }

  return { trades, equityCurve };
}

function runSMACrossover(bars: HistoricalBar[], params: Record<string, unknown>, initialCapital: number) {
  const shortPeriod = Number(params.shortPeriod ?? 10);
  const longPeriod = Number(params.longPeriod ?? 30);
  const closes = bars.map(b => b.close);
  const shortSMA = sma(closes, shortPeriod);
  const longSMA = sma(closes, longPeriod);

  const trades: TradeEntry[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  let capital = initialCapital;
  let inTrade = false;
  let entryPrice = 0, entryDate = '', entryQty = 0;

  for (let i = 1; i < bars.length; i++) {
    const s = shortSMA[i], l = longSMA[i];
    const ps = shortSMA[i - 1], pl = longSMA[i - 1];
    if (s == null || l == null || ps == null || pl == null) continue;

    if (!inTrade && ps <= pl && s > l) {
      entryPrice = bars[i].close;
      entryDate = bars[i].timestamp?.slice(0, 10) ?? '';
      entryQty = Math.floor(capital * 0.2 / entryPrice);
      if (entryQty > 0) inTrade = true;
    } else if (inTrade && ps >= pl && s < l) {
      const exitPrice = bars[i].close;
      const pnl = (exitPrice - entryPrice) * entryQty;
      capital += pnl;
      trades.push({
        entryDate, exitDate: bars[i].timestamp?.slice(0, 10) ?? '',
        entryPrice: Math.round(entryPrice * 100) / 100,
        exitPrice: Math.round(exitPrice * 100) / 100,
        qty: entryQty, side: 'LONG',
        pnl: Math.round(pnl * 100) / 100,
        pnlPercent: Math.round(((exitPrice - entryPrice) / entryPrice) * 10000) / 100,
      });
      inTrade = false;
    }
    equityCurve.push({ date: bars[i].timestamp?.slice(0, 10) ?? '', value: Math.round(capital * 100) / 100 });
  }

  if (inTrade && bars.length > 0) {
    const last = bars[bars.length - 1];
    const pnl = (last.close - entryPrice) * entryQty;
    capital += pnl;
    trades.push({
      entryDate, exitDate: last.timestamp?.slice(0, 10) ?? '',
      entryPrice: Math.round(entryPrice * 100) / 100,
      exitPrice: Math.round(last.close * 100) / 100,
      qty: entryQty, side: 'LONG',
      pnl: Math.round(pnl * 100) / 100,
      pnlPercent: Math.round(((last.close - entryPrice) / entryPrice) * 10000) / 100,
    });
  }

  return { trades, equityCurve };
}

function runMeanReversion(bars: HistoricalBar[], params: Record<string, unknown>, initialCapital: number) {
  const period = Number(params.period ?? 20);
  const threshold = Number(params.threshold ?? 2);
  const closes = bars.map(b => b.close);
  const ma = sma(closes, period);

  const trades: TradeEntry[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  let capital = initialCapital;
  let inTrade = false;
  let entryPrice = 0, entryDate = '', entryQty = 0, side: 'LONG' | 'SHORT' = 'LONG';

  for (let i = period; i < bars.length; i++) {
    const avg = ma[i]!;
    const stdArr = closes.slice(i - period + 1, i + 1);
    const mean = stdArr.reduce((a, b) => a + b, 0) / stdArr.length;
    const variance = stdArr.reduce((s, v) => s + (v - mean) ** 2, 0) / stdArr.length;
    const std = Math.sqrt(variance);
    if (std === 0) continue;

    const zScore = (closes[i] - avg) / std;

    if (!inTrade) {
      if (zScore < -threshold) {
        entryPrice = closes[i]; entryDate = bars[i].timestamp?.slice(0, 10) ?? '';
        entryQty = Math.floor(capital * 0.15 / entryPrice); side = 'LONG';
        if (entryQty > 0) inTrade = true;
      } else if (zScore > threshold) {
        entryPrice = closes[i]; entryDate = bars[i].timestamp?.slice(0, 10) ?? '';
        entryQty = Math.floor(capital * 0.15 / entryPrice); side = 'SHORT';
        if (entryQty > 0) inTrade = true;
      }
    } else {
      const shouldExit = (side === 'LONG' && zScore >= 0) || (side === 'SHORT' && zScore <= 0);
      if (shouldExit) {
        const exitPrice = closes[i];
        const pnl = side === 'LONG' ? (exitPrice - entryPrice) * entryQty : (entryPrice - exitPrice) * entryQty;
        capital += pnl;
        trades.push({
          entryDate, exitDate: bars[i].timestamp?.slice(0, 10) ?? '',
          entryPrice: Math.round(entryPrice * 100) / 100,
          exitPrice: Math.round(exitPrice * 100) / 100,
          qty: entryQty, side,
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round((pnl / (entryPrice * entryQty)) * 10000) / 100,
        });
        inTrade = false;
      }
    }
    equityCurve.push({ date: bars[i].timestamp?.slice(0, 10) ?? '', value: Math.round(capital * 100) / 100 });
  }

  return { trades, equityCurve };
}

function runMomentum(bars: HistoricalBar[], params: Record<string, unknown>, initialCapital: number) {
  const lookback = Number(params.lookback ?? 20);
  const holdDays = Number(params.holdDays ?? 10);
  const closes = bars.map(b => b.close);

  const trades: TradeEntry[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  let capital = initialCapital;
  let holdCounter = 0;
  let entryPrice = 0, entryDate = '', entryQty = 0;

  for (let i = lookback; i < bars.length; i++) {
    if (holdCounter > 0) {
      holdCounter--;
      if (holdCounter === 0) {
        const exitPrice = closes[i];
        const pnl = (exitPrice - entryPrice) * entryQty;
        capital += pnl;
        trades.push({
          entryDate, exitDate: bars[i].timestamp?.slice(0, 10) ?? '',
          entryPrice: Math.round(entryPrice * 100) / 100,
          exitPrice: Math.round(exitPrice * 100) / 100,
          qty: entryQty, side: 'LONG',
          pnl: Math.round(pnl * 100) / 100,
          pnlPercent: Math.round(((exitPrice - entryPrice) / entryPrice) * 10000) / 100,
        });
      }
    } else {
      const pastReturn = (closes[i] - closes[i - lookback]) / closes[i - lookback];
      if (pastReturn > 0.05) {
        entryPrice = closes[i];
        entryDate = bars[i].timestamp?.slice(0, 10) ?? '';
        entryQty = Math.floor(capital * 0.15 / entryPrice);
        if (entryQty > 0) holdCounter = holdDays;
      }
    }
    equityCurve.push({ date: bars[i].timestamp?.slice(0, 10) ?? '', value: Math.round(capital * 100) / 100 });
  }

  return { trades, equityCurve };
}

function runRSIReversal(bars: HistoricalBar[], params: Record<string, unknown>, initialCapital: number) {
  const period = Number(params.period ?? 14);
  const oversold = Number(params.oversold ?? 30);
  const overbought = Number(params.overbought ?? 70);
  const closes = bars.map(b => b.close);
  const rsiVals = rsi(closes, period);

  const trades: TradeEntry[] = [];
  const equityCurve: { date: string; value: number }[] = [];
  let capital = initialCapital;
  let inTrade = false;
  let entryPrice = 0, entryDate = '', entryQty = 0;

  for (let i = 1; i < bars.length; i++) {
    const r = rsiVals[i];
    if (r == null) continue;

    if (!inTrade && r < oversold) {
      entryPrice = closes[i]; entryDate = bars[i].timestamp?.slice(0, 10) ?? '';
      entryQty = Math.floor(capital * 0.15 / entryPrice);
      if (entryQty > 0) inTrade = true;
    } else if (inTrade && r > overbought) {
      const exitPrice = closes[i];
      const pnl = (exitPrice - entryPrice) * entryQty;
      capital += pnl;
      trades.push({
        entryDate, exitDate: bars[i].timestamp?.slice(0, 10) ?? '',
        entryPrice: Math.round(entryPrice * 100) / 100,
        exitPrice: Math.round(exitPrice * 100) / 100,
        qty: entryQty, side: 'LONG',
        pnl: Math.round(pnl * 100) / 100,
        pnlPercent: Math.round(((exitPrice - entryPrice) / entryPrice) * 10000) / 100,
      });
      inTrade = false;
    }
    equityCurve.push({ date: bars[i].timestamp?.slice(0, 10) ?? '', value: Math.round(capital * 100) / 100 });
  }

  return { trades, equityCurve };
}

function computeMetrics(trades: TradeEntry[], initialCapital: number, equityCurve: { date: string; value: number }[]) {
  const totalTrades = trades.length;
  if (totalTrades === 0) {
    return { cagr: 0, maxDrawdown: 0, sharpeRatio: 0, sortinoRatio: 0, winRate: 0, profitFactor: 0, totalTrades: 0, avgWin: 0, avgLoss: 0 };
  }

  const wins = trades.filter(t => t.pnl > 0);
  const losses = trades.filter(t => t.pnl < 0);
  const winRate = (wins.length / totalTrades) * 100;
  const totalWins = wins.reduce((s, t) => s + t.pnl, 0);
  const totalLosses = Math.abs(losses.reduce((s, t) => s + t.pnl, 0));
  const profitFactor = totalLosses > 0 ? totalWins / totalLosses : (totalWins > 0 ? 99 : 0);
  const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + t.pnlPercent, 0) / wins.length : 0;
  const avgLoss = losses.length > 0 ? losses.reduce((s, t) => s + t.pnlPercent, 0) / losses.length : 0;

  const finalCapital = equityCurve.length > 0 ? equityCurve[equityCurve.length - 1].value : initialCapital;
  const startDate = equityCurve[0]?.date ? new Date(equityCurve[0].date) : new Date();
  const endDate = equityCurve.length > 0 ? new Date(equityCurve[equityCurve.length - 1].date) : new Date();
  const years = Math.max((endDate.getTime() - startDate.getTime()) / (365.25 * 86400000), 1 / 12);
  const cagr = (Math.pow(finalCapital / initialCapital, 1 / years) - 1) * 100;

  let peak = initialCapital;
  let maxDrawdown = 0;
  for (const pt of equityCurve) {
    if (pt.value > peak) peak = pt.value;
    const dd = ((peak - pt.value) / peak) * 100;
    if (dd > maxDrawdown) maxDrawdown = dd;
  }

  const returns = trades.map(t => t.pnlPercent);
  const meanReturn = returns.reduce((a, b) => a + b, 0) / returns.length;
  const variance = returns.reduce((s, r) => s + (r - meanReturn) ** 2, 0) / returns.length;
  const stdDev = Math.sqrt(variance);
  const sharpeRatio = stdDev > 0 ? (meanReturn / stdDev) * Math.sqrt(252 / Math.max(years * 252 / totalTrades, 1)) : 0;

  const negReturns = returns.filter(r => r < 0);
  const downVariance = negReturns.length > 0 ? negReturns.reduce((s, r) => s + r ** 2, 0) / negReturns.length : 0;
  const downDev = Math.sqrt(downVariance);
  const sortinoRatio = downDev > 0 ? (meanReturn / downDev) * Math.sqrt(252 / Math.max(years * 252 / totalTrades, 1)) : 0;

  return {
    cagr: Math.round(cagr * 100) / 100,
    maxDrawdown: Math.round(maxDrawdown * 100) / 100,
    sharpeRatio: Math.round(sharpeRatio * 100) / 100,
    sortinoRatio: Math.round(sortinoRatio * 100) / 100,
    winRate: Math.round(winRate * 100) / 100,
    profitFactor: Math.round(profitFactor * 100) / 100,
    totalTrades,
    avgWin: Math.round(avgWin * 100) / 100,
    avgLoss: Math.round(avgLoss * 100) / 100,
  };
}

export class BacktestService {
  private marketService: MarketDataService;

  constructor(private readonly prisma: PrismaClient) {
    this.marketService = new MarketDataService();
  }

  async run(userId: string, input: RunBacktestInput): Promise<BacktestResult> {
    const bars = await this.marketService.getHistory(
      input.symbol, '1d', input.startDate, input.endDate, userId,
    );

    if (bars.length < 5) {
      throw new BacktestError(
        `Insufficient historical data for ${input.symbol} (got ${bars.length} bars). Please configure your Breeze API key and session token in Settings.`,
        422,
      );
    }

    const strategyKey = input.strategyId.toLowerCase().replace(/[^a-z_]/g, '_');
    const allParams = { ...input.parameters, symbol: input.symbol };
    let metrics: ReturnType<typeof computeMetrics>;
    let trades: TradeEntry[];
    let equityCurve: { date: string; value: number }[];

    const useRust = isEngineAvailable() && (strategyKey === 'ema-crossover' || strategyKey === 'ema_crossover' || strategyKey === 'supertrend');

    if (useRust) {
      try {
        const rustResult = await engineBacktest({
          strategy: strategyKey.replace(/_/g, '-'),
          symbol: input.symbol,
          initial_capital: input.initialCapital,
          candles: bars.map(b => ({
            timestamp: b.timestamp, open: b.open, high: b.high,
            low: b.low, close: b.close, volume: b.volume,
          })),
          params: allParams,
        }) as any;

        metrics = {
          cagr: rustResult.cagr ?? 0,
          maxDrawdown: rustResult.max_drawdown ?? 0,
          sharpeRatio: rustResult.sharpe_ratio ?? 0,
          sortinoRatio: rustResult.sortino_ratio ?? 0,
          winRate: rustResult.win_rate ?? 0,
          profitFactor: rustResult.profit_factor ?? 0,
          totalTrades: rustResult.total_trades ?? 0,
          avgWin: rustResult.avg_win ?? 0,
          avgLoss: rustResult.avg_loss ?? 0,
        };
        trades = (rustResult.trade_log ?? []).map((t: any) => ({
          entryDate: t.entry_time, exitDate: t.exit_time,
          entryPrice: t.entry_price, exitPrice: t.exit_price,
          qty: t.qty, side: t.side as 'LONG' | 'SHORT',
          pnl: t.pnl, pnlPercent: t.entry_price > 0 ? Math.round(((t.exit_price - t.entry_price) / t.entry_price) * 10000) / 100 : 0,
        }));
        equityCurve = (rustResult.equity_curve ?? []).map((p: any) => ({
          date: p.date, value: p.nav,
        }));
      } catch {
        const strategyFn = STRATEGIES[strategyKey] ?? STRATEGIES.orb;
        const jsResult = strategyFn(bars, allParams, input.initialCapital);
        trades = jsResult.trades;
        equityCurve = jsResult.equityCurve;
        metrics = computeMetrics(trades, input.initialCapital, equityCurve);
      }
    } else {
      const strategyFn = STRATEGIES[strategyKey] ?? STRATEGIES.orb;
      const jsResult = strategyFn(bars, allParams, input.initialCapital);
      trades = jsResult.trades;
      equityCurve = jsResult.equityCurve;
      metrics = computeMetrics(trades, input.initialCapital, equityCurve);
    }

    const strategyParams = {
      ...allParams,
      symbol: input.symbol,
      initialCapital: input.initialCapital,
      barsUsed: bars.length,
      engine: useRust ? 'rust' : 'js',
    };

    const result = await this.prisma.backtestResult.create({
      data: {
        userId,
        strategyId: input.strategyId,
        strategyParams: JSON.stringify(strategyParams),
        dateFrom: new Date(input.startDate),
        dateTo: new Date(input.endDate),
        cagr: metrics.cagr,
        maxDrawdown: metrics.maxDrawdown,
        sharpeRatio: metrics.sharpeRatio,
        sortinoRatio: metrics.sortinoRatio,
        winRate: metrics.winRate,
        profitFactor: metrics.profitFactor,
        totalTrades: metrics.totalTrades,
        avgWin: metrics.avgWin,
        avgLoss: metrics.avgLoss,
        equityCurve: JSON.stringify(equityCurve),
        tradeLog: JSON.stringify(trades),
      },
    });

    return result;
  }

  async listResults(userId: string): Promise<BacktestResult[]> {
    return this.prisma.backtestResult.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async getResult(resultId: string, userId: string): Promise<BacktestResult> {
    const result = await this.prisma.backtestResult.findUnique({
      where: { id: resultId },
    });

    if (!result || result.userId !== userId) {
      throw new BacktestError('Backtest result not found', 404);
    }

    return result;
  }

  async compare(userId: string, resultIds: string[]): Promise<BacktestResult[]> {
    return this.prisma.backtestResult.findMany({
      where: { id: { in: resultIds }, userId },
    });
  }
}
