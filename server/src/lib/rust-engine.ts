import { spawn } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync } from 'fs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const ENGINE_PATHS = [
  resolve(__dirname, '..', '..', 'bin', 'capital-guard-engine.exe'),
  resolve(__dirname, '..', '..', 'bin', 'capital-guard-engine'),
  resolve(__dirname, '..', '..', '..', 'engine', 'target', 'release', 'capital-guard-engine.exe'),
  resolve(__dirname, '..', '..', '..', 'engine', 'target', 'release', 'capital-guard-engine'),
];

function findBinary(): string | null {
  for (const p of ENGINE_PATHS) {
    if (existsSync(p)) return p;
  }
  return null;
}

let cachedBinary: string | null | undefined;

function getBinary(): string | null {
  if (cachedBinary === undefined) {
    cachedBinary = findBinary();
  }
  return cachedBinary;
}

export function isEngineAvailable(): boolean {
  return getBinary() !== null;
}

interface EngineResponse {
  success: boolean;
  data: unknown;
  error?: string;
}

const ENGINE_TIMEOUT_MS = 30_000;
const MAX_INPUT_SIZE = 2 * 1024 * 1024; // 2 MB (reduced from 10 MB)
const MAX_CONCURRENT_ENGINE = 2;
let activeEngineCount = 0;
const engineQueue: Array<{ resolve: () => void }> = [];

async function acquireEngine(): Promise<void> {
  if (activeEngineCount < MAX_CONCURRENT_ENGINE) {
    activeEngineCount++;
    return;
  }
  return new Promise<void>((resolve) => {
    engineQueue.push({ resolve });
  });
}

function releaseEngine(): void {
  activeEngineCount--;
  const next = engineQueue.shift();
  if (next) {
    activeEngineCount++;
    next.resolve();
  }
}

async function runEngine(command: string, data: unknown): Promise<EngineResponse> {
  const binary = getBinary();
  if (!binary) {
    throw new Error('Rust engine binary not found');
  }

  const input = JSON.stringify({ command, data });
  if (input.length > MAX_INPUT_SIZE) {
    throw new Error('Input too large for engine');
  }

  await acquireEngine();
  try {
    return await new Promise<EngineResponse>((resolve, reject) => {
      const proc = spawn(binary, [], {
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: ENGINE_TIMEOUT_MS,
      });

      const chunks: Buffer[] = [];
      const errChunks: Buffer[] = [];
      let settled = false;

      const timer = setTimeout(() => {
        if (!settled) {
          settled = true;
          proc.kill('SIGKILL');
          reject(new Error('Engine timed out'));
        }
      }, ENGINE_TIMEOUT_MS);

      proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
      proc.stderr.on('data', (chunk: Buffer) => errChunks.push(chunk));

      proc.on('error', (err) => {
        if (!settled) {
          settled = true;
          clearTimeout(timer);
          reject(err);
        }
      });

      proc.on('close', (code) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);

        const stdout = Buffer.concat(chunks).toString('utf-8').trim();

        if (code !== 0) {
          const stderr = Buffer.concat(errChunks).toString('utf-8').trim();
          reject(new Error(`Engine exited with code ${code}: ${stderr.slice(0, 500)}`));
          return;
        }

        try {
          const parsed = JSON.parse(stdout) as EngineResponse;
          resolve(parsed);
        } catch {
          reject(new Error('Engine returned invalid JSON'));
        }
      });

      proc.stdin.write(input);
      proc.stdin.end();
    });
  } finally {
    releaseEngine();
  }
}

export async function engineBacktest(data: unknown): Promise<unknown> {
  const res = await runEngine('backtest', data);
  if (!res.success) throw new Error(res.error ?? 'Backtest failed');
  return res.data;
}

export async function engineSignals(data: unknown): Promise<unknown> {
  const res = await runEngine('signals', data);
  if (!res.success) throw new Error(res.error ?? 'Signals computation failed');
  return res.data;
}

export async function engineRisk(data: unknown): Promise<unknown> {
  const res = await runEngine('risk', data);
  if (!res.success) throw new Error(res.error ?? 'Risk computation failed');
  return res.data;
}

export async function engineGreeks(data: unknown): Promise<unknown> {
  const res = await runEngine('greeks', data);
  if (!res.success) throw new Error(res.error ?? 'Greeks computation failed');
  return res.data;
}

export interface ScanSignal {
  symbol: string;
  direction: 'BUY' | 'SELL';
  confidence: number;
  entry: number;
  stop_loss: number;
  target: number;
  indicators: Record<string, number>;
  votes: Record<string, number>;
}

export interface ScanResult {
  signals: ScanSignal[];
}

export interface OptimizeInput {
  strategy: string;
  symbol: string;
  initial_capital: number;
  candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  param_grid: Record<string, number[]>;
}

export interface ParamResult {
  params: Record<string, number>;
  sharpe_ratio: number;
  win_rate: number;
  profit_factor: number;
  cagr: number;
  max_drawdown: number;
  total_trades: number;
}

export interface OptimizeResult {
  best_params: Record<string, number>;
  best_sharpe: number;
  best_win_rate: number;
  best_profit_factor: number;
  all_results: ParamResult[];
}

export async function engineOptimize(data: OptimizeInput): Promise<OptimizeResult> {
  if (!isEngineAvailable()) {
    return jsOptimizeFallback(data);
  }
  try {
    const res = await runEngine('optimize', data);
    if (!res.success) throw new Error(res.error ?? 'Optimize failed');
    return res.data as OptimizeResult;
  } catch {
    return jsOptimizeFallback(data);
  }
}

function jsOptimizeFallback(data: OptimizeInput): OptimizeResult {
  const keys = Object.keys(data.param_grid);
  const combos = generateCombos(keys, data.param_grid);
  const results: ParamResult[] = [];

  for (const combo of combos) {
    const { sharpe, winRate, pf, cagr, mdd, trades } = jsBacktestWithParams(data, combo);
    results.push({
      params: combo,
      sharpe_ratio: sharpe,
      win_rate: winRate,
      profit_factor: pf,
      cagr,
      max_drawdown: mdd,
      total_trades: trades,
    });
  }

  results.sort((a, b) => b.sharpe_ratio - a.sharpe_ratio);
  const best = results[0] ?? { params: {}, sharpe_ratio: 0, win_rate: 0, profit_factor: 0, cagr: 0, max_drawdown: 0, total_trades: 0 };

  return {
    best_params: best.params,
    best_sharpe: best.sharpe_ratio,
    best_win_rate: best.win_rate,
    best_profit_factor: best.profit_factor,
    all_results: results,
  };
}

function generateCombos(keys: string[], grid: Record<string, number[]>): Record<string, number>[] {
  if (keys.length === 0) return [{}];
  const [first, ...rest] = keys;
  const subCombos = generateCombos(rest, grid);
  const result: Record<string, number>[] = [];
  for (const val of grid[first]) {
    for (const sub of subCombos) {
      result.push({ [first]: val, ...sub });
    }
  }
  return result;
}

function jsBacktestWithParams(
  data: OptimizeInput,
  params: Record<string, number>,
): { sharpe: number; winRate: number; pf: number; cagr: number; mdd: number; trades: number } {
  const emaShort = params.ema_short ?? 9;
  const emaLong = params.ema_long ?? 21;
  const candles = data.candles;
  let nav = data.initial_capital;
  let peak = nav;
  let maxDD = 0;
  const pnls: number[] = [];
  let position: { price: number } | null = null;

  for (let i = 0; i < candles.length; i++) {
    if (i >= emaLong) {
      const eShort = computeEMA(candles, i, emaShort);
      const eLong = computeEMA(candles, i, emaLong);
      if (!position && eShort > eLong) {
        position = { price: candles[i].close };
      } else if (position && eShort < eLong) {
        const qty = Math.floor((nav * 0.1) / position.price);
        const pnl = (candles[i].close - position.price) * qty;
        nav += pnl;
        pnls.push(pnl);
        position = null;
      }
    }
    if (nav > peak) peak = nav;
    const dd = (peak - nav) / peak;
    if (dd > maxDD) maxDD = dd;
  }

  const wins = pnls.filter(p => p > 0);
  const losses = pnls.filter(p => p < 0);
  const winRate = pnls.length > 0 ? (wins.length / pnls.length) * 100 : 0;
  const totalWin = wins.reduce((s, v) => s + v, 0);
  const totalLoss = losses.reduce((s, v) => s + Math.abs(v), 0);
  const pf = totalLoss > 0 ? totalWin / totalLoss : 0;

  const returns = pnls.map(p => p / data.initial_capital);
  const mean = returns.length > 0 ? returns.reduce((s, v) => s + v, 0) / returns.length : 0;
  const variance = returns.length > 1 ? returns.reduce((s, v) => s + (v - mean) ** 2, 0) / returns.length : 0;
  const std = Math.sqrt(variance);
  const sharpe = std > 0 ? (mean / std) * Math.sqrt(252) : 0;

  const totalReturn = (nav - data.initial_capital) / data.initial_capital;
  const years = candles.length / 252;
  const cagr = years > 0 ? ((1 + totalReturn) ** (1 / years) - 1) * 100 : 0;

  return {
    sharpe: round2(sharpe),
    winRate: round2(winRate),
    pf: round2(pf),
    cagr: round2(cagr),
    mdd: round2(maxDD * 100),
    trades: pnls.length,
  };
}

function computeEMA(candles: Array<{ close: number }>, endIdx: number, period: number): number {
  if (endIdx < period - 1) return 0;
  const mul = 2 / (period + 1);
  let ema = candles[endIdx - period + 1].close;
  for (let i = endIdx - period + 2; i <= endIdx; i++) {
    ema = (candles[i].close - ema) * mul + ema;
  }
  return ema;
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}

// ── Walk-Forward Optimization ──

export interface WalkForwardInput {
  strategy: string;
  symbol: string;
  initial_capital: number;
  candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  param_grid: Record<string, number[]>;
  in_sample_ratio?: number;
  num_folds?: number;
}

export interface WalkForwardFold {
  fold: number;
  in_sample_sharpe: number;
  out_sample_sharpe: number;
  in_sample_win_rate: number;
  out_sample_win_rate: number;
  best_params: Record<string, number>;
  out_sample_trades: number;
  out_sample_pnl: number;
  degradation: number;
}

export interface WalkForwardResult {
  folds: WalkForwardFold[];
  aggregate: {
    avg_in_sample_sharpe: number;
    avg_out_sample_sharpe: number;
    avg_degradation: number;
    total_out_sample_trades: number;
    total_out_sample_pnl: number;
    consistency_score: number;
  };
  best_robust_params: Record<string, number>;
  overfitting_score: number;
}

export async function engineWalkForward(data: WalkForwardInput): Promise<WalkForwardResult> {
  if (!isEngineAvailable()) {
    return jsWalkForwardFallback(data);
  }
  try {
    const res = await runEngine('walk_forward', data);
    if (!res.success) throw new Error(res.error ?? 'Walk-forward failed');
    return res.data as WalkForwardResult;
  } catch {
    return jsWalkForwardFallback(data);
  }
}

function jsWalkForwardFallback(data: WalkForwardInput): WalkForwardResult {
  const numFolds = Math.min(Math.max(data.num_folds ?? 5, 2), 10);
  const isRatio = data.in_sample_ratio ?? 0.7;
  const foldSize = Math.floor(data.candles.length / numFolds);
  const folds: WalkForwardFold[] = [];

  for (let f = 0; f < numFolds; f++) {
    const start = f * foldSize;
    const end = f === numFolds - 1 ? data.candles.length : (f + 1) * foldSize;
    const foldCandles = data.candles.slice(start, end);
    const split = Math.floor(foldCandles.length * isRatio);
    if (split < 15 || foldCandles.length - split < 5) continue;

    const inSample = { ...data, candles: foldCandles.slice(0, split) };
    const isResult = jsBacktestWithParams(inSample as OptimizeInput, {});
    const oosResult = jsBacktestWithParams({ ...data, candles: foldCandles.slice(split) } as OptimizeInput, {});
    const deg = isResult.sharpe > 0 ? 1 - oosResult.sharpe / isResult.sharpe : 0;

    folds.push({
      fold: f, in_sample_sharpe: isResult.sharpe, out_sample_sharpe: oosResult.sharpe,
      in_sample_win_rate: isResult.winRate, out_sample_win_rate: oosResult.winRate,
      best_params: {}, out_sample_trades: oosResult.trades, out_sample_pnl: 0, degradation: round2(deg),
    });
  }

  const n = folds.length || 1;
  return {
    folds,
    aggregate: {
      avg_in_sample_sharpe: round2(folds.reduce((s, f) => s + f.in_sample_sharpe, 0) / n),
      avg_out_sample_sharpe: round2(folds.reduce((s, f) => s + f.out_sample_sharpe, 0) / n),
      avg_degradation: round2(folds.reduce((s, f) => s + f.degradation, 0) / n),
      total_out_sample_trades: folds.reduce((s, f) => s + f.out_sample_trades, 0),
      total_out_sample_pnl: 0,
      consistency_score: round2(folds.filter(f => f.out_sample_sharpe > 0).length / n),
    },
    best_robust_params: {},
    overfitting_score: 0,
  };
}

// ── Advanced Signals (VWAP, Volume Profile, Order Flow, Market Profile) ──

export interface AdvancedSignalInput {
  candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  compute: string[];
}

export interface AdvancedSignalResult {
  vwap?: { vwap: number; upper_band_1: number; lower_band_1: number; signal: string; series: Array<{ timestamp: string; vwap: number }> };
  volume_profile?: { poc: number; value_area_high: number; value_area_low: number; signal: string; levels: Array<{ price: number; volume: number; is_poc: boolean }> };
  order_flow?: { buy_volume: number; sell_volume: number; imbalance_ratio: number; delta: number; signal: string };
  market_profile?: { poc: number; initial_balance_high: number; initial_balance_low: number; value_area_high: number; value_area_low: number; profile_type: string; signal: string };
}

export async function engineAdvancedSignals(data: AdvancedSignalInput): Promise<AdvancedSignalResult> {
  if (!isEngineAvailable()) {
    return {} as AdvancedSignalResult;
  }
  try {
    const res = await runEngine('advanced_signals', data);
    if (!res.success) throw new Error(res.error ?? 'Advanced signals failed');
    return res.data as AdvancedSignalResult;
  } catch {
    return {} as AdvancedSignalResult;
  }
}

// ── IV Surface Modeling ──

export interface IVSurfaceInput {
  spot: number;
  risk_free_rate?: number;
  strikes: Array<{
    strike: number;
    expiry_days: number;
    call_price?: number;
    put_price?: number;
    call_iv?: number;
    put_iv?: number;
  }>;
}

export interface IVSurfaceResult {
  surface: Array<{ strike: number; expiry_days: number; moneyness: number; call_iv: number; put_iv: number; avg_iv: number }>;
  skew_analysis: { current_skew: number; skew_direction: string; put_call_iv_ratio: number; atm_iv: number; smile_curvature: number };
  anomalies: Array<{ strike: number; expiry_days: number; anomaly_type: string; severity: number; description: string }>;
  term_structure: Array<{ expiry_days: number; atm_iv: number }>;
  summary: { overall_iv_level: string; skew_regime: string; term_structure_shape: string; mispriced_options_count: number; signal: string };
}

export async function engineIVSurface(data: IVSurfaceInput): Promise<IVSurfaceResult> {
  if (!isEngineAvailable()) {
    return { surface: [], skew_analysis: { current_skew: 0, skew_direction: 'BALANCED', put_call_iv_ratio: 1, atm_iv: 0.2, smile_curvature: 0 }, anomalies: [], term_structure: [], summary: { overall_iv_level: 'MODERATE', skew_regime: 'FLAT', term_structure_shape: 'FLAT', mispriced_options_count: 0, signal: 'NEUTRAL' } };
  }
  try {
    const res = await runEngine('iv_surface', data);
    if (!res.success) throw new Error(res.error ?? 'IV surface failed');
    return res.data as IVSurfaceResult;
  } catch {
    return { surface: [], skew_analysis: { current_skew: 0, skew_direction: 'BALANCED', put_call_iv_ratio: 1, atm_iv: 0.2, smile_curvature: 0 }, anomalies: [], term_structure: [], summary: { overall_iv_level: 'MODERATE', skew_regime: 'FLAT', term_structure_shape: 'FLAT', mispriced_options_count: 0, signal: 'NEUTRAL' } };
  }
}

export async function engineScan(data: {
  symbols: Array<{
    symbol: string;
    candles: Array<{ close: number; high: number; low: number; volume: number }>;
  }>;
  aggressiveness?: 'high' | 'medium' | 'low';
}): Promise<ScanResult> {
  const res = await runEngine('scan', data);
  if (!res.success) throw new Error(res.error ?? 'Scan computation failed');
  return res.data as ScanResult;
}
