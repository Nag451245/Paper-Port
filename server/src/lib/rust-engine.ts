import { spawn, ChildProcess } from 'child_process';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { existsSync, mkdirSync, createWriteStream, chmodSync, statSync, unlinkSync } from 'fs';
import https from 'https';
import { createInterface, Interface as ReadlineInterface } from 'readline';
import { randomUUID } from 'crypto';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

const RELEASE_URL = 'https://github.com/Nag451245/Paper-Port/releases/download/engine-latest/capital-guard-engine';
const DOWNLOAD_TARGET = resolve(__dirname, '..', '..', 'bin', 'capital-guard-engine');

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

function followRedirects(url: string, redirects = 0): Promise<import('http').IncomingMessage> {
  if (redirects > 5) return Promise.reject(new Error('Too many redirects'));
  return new Promise((resolve, reject) => {
    https.get(url, { headers: { 'User-Agent': 'CapitalGuard/1.0' } }, (res) => {
      if (res.statusCode && res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        console.log(`  ↳ Redirect ${res.statusCode} → ${res.headers.location.substring(0, 80)}...`);
        res.resume();
        followRedirects(res.headers.location, redirects + 1).then(resolve, reject);
      } else {
        resolve(res);
      }
    }).on('error', reject);
  });
}

export async function ensureEngineAvailable(): Promise<boolean> {
  if (isEngineAvailable()) {
    console.log(`[rust-engine] Binary already available at ${cachedBinary}`);
    return true;
  }

  console.log(`[rust-engine] Binary not found, downloading from GitHub Releases...`);
  console.log(`[rust-engine] URL: ${RELEASE_URL}`);
  console.log(`[rust-engine] Target: ${DOWNLOAD_TARGET}`);

  try {
    mkdirSync(dirname(DOWNLOAD_TARGET), { recursive: true });

    const res = await followRedirects(RELEASE_URL);

    if (res.statusCode !== 200) {
      console.error(`[rust-engine] Download failed: HTTP ${res.statusCode}`);
      res.resume();
      return false;
    }

    await new Promise<void>((resolve, reject) => {
      const file = createWriteStream(DOWNLOAD_TARGET);
      res.pipe(file);
      file.on('finish', () => { file.close(); resolve(); });
      file.on('error', reject);
      res.on('error', reject);
    });

    try { chmodSync(DOWNLOAD_TARGET, 0o755); } catch { /* Windows doesn't need chmod */ }

    const size = statSync(DOWNLOAD_TARGET).size;
    console.log(`[rust-engine] Downloaded ${size} bytes`);

    if (size < 10_000) {
      console.error(`[rust-engine] Binary too small (${size} bytes), likely an error page. Removing.`);
      unlinkSync(DOWNLOAD_TARGET);
      return false;
    }

    cachedBinary = undefined;
    const available = isEngineAvailable();
    console.log(`[rust-engine] Engine available: ${available}`);
    return available;
  } catch (err: any) {
    console.error(`[rust-engine] Download error: ${err.message}`);
    return false;
  }
}

interface EngineResponse {
  id?: string;
  success: boolean;
  data: unknown;
  error?: string;
}

const ENGINE_TIMEOUT_MS = 30_000;
const MAX_INPUT_SIZE = 2 * 1024 * 1024;

// ── Persistent Daemon ──

let daemonProc: ChildProcess | null = null;
let daemonRL: ReadlineInterface | null = null;
const pendingRequests = new Map<string, { resolve: (v: EngineResponse) => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }>();
let daemonReady = false;

// Circuit breaker: stop respawning if daemon crashes too often
let crashCount = 0;
let lastCrashTime = 0;
const MAX_CRASHES = 5;
const CRASH_WINDOW_MS = 60_000;

function checkCircuitBreaker(): boolean {
  const now = Date.now();
  if (now - lastCrashTime > CRASH_WINDOW_MS) {
    crashCount = 0;
  }
  if (crashCount >= MAX_CRASHES) {
    console.error(`[rust-engine] Circuit breaker open: ${crashCount} crashes in ${CRASH_WINDOW_MS / 1000}s. Not respawning.`);
    return false;
  }
  return true;
}

function recordCrash(): void {
  crashCount++;
  lastCrashTime = Date.now();
  console.warn(`[rust-engine] Crash count: ${crashCount}/${MAX_CRASHES}`);
}

function spawnDaemon(): boolean {
  const binary = getBinary();
  if (!binary) return false;
  if (!checkCircuitBreaker()) return false;

  try {
    const proc = spawn(binary, ['--daemon'], { stdio: ['pipe', 'pipe', 'pipe'] });
    proc.on('error', (err) => {
      console.error(`[rust-engine] Daemon error: ${err.message}`);
      recordCrash();
      teardownDaemon();
    });
    proc.on('exit', (code) => {
      console.warn(`[rust-engine] Daemon exited with code ${code}`);
      if (code !== 0) recordCrash();
      teardownDaemon();
    });

    const rl = createInterface({ input: proc.stdout!, crlfDelay: Infinity });
    rl.on('line', (line) => {
      try {
        const resp = JSON.parse(line) as EngineResponse;
        const reqId = resp.id;
        if (reqId && pendingRequests.has(reqId)) {
          const pending = pendingRequests.get(reqId)!;
          clearTimeout(pending.timer);
          pendingRequests.delete(reqId);
          pending.resolve(resp);
        }
      } catch { /* skip malformed lines */ }
    });

    proc.stderr?.on('data', (chunk: Buffer) => {
      const msg = chunk.toString().trim();
      if (msg) console.log(`[rust-engine:stderr] ${msg}`);
    });

    daemonProc = proc;
    daemonRL = rl;
    daemonReady = true;
    console.log(`[rust-engine] Daemon started (PID ${proc.pid})`);
    return true;
  } catch (err: any) {
    console.error(`[rust-engine] Failed to start daemon: ${err.message}`);
    return false;
  }
}

function teardownDaemon() {
  daemonReady = false;
  for (const [id, pending] of pendingRequests) {
    clearTimeout(pending.timer);
    pending.reject(new Error('Daemon terminated'));
    pendingRequests.delete(id);
  }
  if (daemonRL) { daemonRL.close(); daemonRL = null; }
  if (daemonProc) {
    try { daemonProc.kill(); } catch { /* already dead */ }
    daemonProc = null;
  }
}

async function sendToDaemon(command: string, data: unknown): Promise<EngineResponse> {
  if (!daemonReady || !daemonProc || daemonProc.exitCode !== null) {
    if (!spawnDaemon()) throw new Error('Cannot start engine daemon');
  }

  const id = randomUUID();
  const input = JSON.stringify({ id, command, data });
  if (input.length > MAX_INPUT_SIZE) throw new Error('Input too large for engine');

  return new Promise<EngineResponse>((resolve, reject) => {
    const timer = setTimeout(() => {
      pendingRequests.delete(id);
      reject(new Error('Engine request timed out'));
    }, ENGINE_TIMEOUT_MS);

    pendingRequests.set(id, { resolve, reject, timer });

    try {
      daemonProc!.stdin!.write(input + '\n');
    } catch (err: any) {
      clearTimeout(timer);
      pendingRequests.delete(id);
      teardownDaemon();
      reject(new Error(`Failed to write to daemon: ${err.message}`));
    }
  });
}

// ── Single-shot fallback (used when daemon fails) ──

async function runEngineSingleShot(command: string, data: unknown): Promise<EngineResponse> {
  const binary = getBinary();
  if (!binary) throw new Error('Rust engine binary not found');

  const input = JSON.stringify({ command, data });
  if (input.length > MAX_INPUT_SIZE) throw new Error('Input too large for engine');

  return new Promise<EngineResponse>((resolve, reject) => {
    const proc = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], timeout: ENGINE_TIMEOUT_MS });
    const chunks: Buffer[] = [];
    let settled = false;

    const timer = setTimeout(() => {
      if (!settled) { settled = true; proc.kill('SIGKILL'); reject(new Error('Engine timed out')); }
    }, ENGINE_TIMEOUT_MS);

    proc.stdout.on('data', (chunk: Buffer) => chunks.push(chunk));
    proc.on('error', (err) => { if (!settled) { settled = true; clearTimeout(timer); reject(err); } });
    proc.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const stdout = Buffer.concat(chunks).toString('utf-8').trim();
      if (code !== 0) { reject(new Error(`Engine exited with code ${code}`)); return; }
      try { resolve(JSON.parse(stdout) as EngineResponse); } catch { reject(new Error('Engine returned invalid JSON')); }
    });

    proc.stdin.write(input);
    proc.stdin.end();
  });
}

async function runEngine(command: string, data: unknown): Promise<EngineResponse> {
  try {
    return await sendToDaemon(command, data);
  } catch {
    return runEngineSingleShot(command, data);
  }
}

export function startDaemon(): boolean {
  return spawnDaemon();
}

export function stopDaemon(): void {
  teardownDaemon();
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
  strategy?: string;
}

export type Aggressiveness = 'high' | 'medium' | 'low';

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
  strategy_params?: Record<string, unknown>;
  vote_weights?: Record<string, number>;
  regime?: string;
}): Promise<ScanResult> {
  const res = await runEngine('scan', data);
  if (!res.success) throw new Error(res.error ?? 'Scan computation failed');
  return res.data as ScanResult;
}

// ── Monte Carlo Simulation ──

export async function engineMonteCarlo(data: {
  returns: number[];
  initial_capital: number;
  num_simulations?: number;
  time_horizon?: number;
}): Promise<unknown> {
  const res = await runEngine('monte_carlo', data);
  if (!res.success) throw new Error(res.error ?? 'Monte Carlo failed');
  return res.data;
}

// ── Portfolio Optimization (Markowitz + Black-Litterman) ──

export async function enginePortfolioOptimize(data: {
  assets: Array<{ symbol: string; returns: number[]; expected_return?: number }>;
  risk_free_rate?: number;
  num_portfolios?: number;
  views?: Array<{ asset_index: number; expected_return: number; confidence: number }>;
}): Promise<unknown> {
  const res = await runEngine('optimize_portfolio', data);
  if (!res.success) throw new Error(res.error ?? 'Portfolio optimization failed');
  return res.data;
}

// ── Options Strategy Analyzer ──

export async function engineOptionsStrategy(data: {
  legs: Array<{ option_type: string; strike: number; premium: number; quantity: number; expiry_days?: number; iv?: number }>;
  spot: number;
  risk_free_rate?: number;
  price_range?: [number, number];
}): Promise<unknown> {
  const res = await runEngine('options_strategy', data);
  if (!res.success) throw new Error(res.error ?? 'Options strategy analysis failed');
  return res.data;
}

// ── Pairs Trading Correlation Scanner ──

export async function engineCorrelation(data: {
  pairs: Array<{ symbol_a: string; symbol_b: string; prices_a: number[]; prices_b: number[] }>;
  lookback?: number;
  zscore_threshold?: number;
}): Promise<unknown> {
  const res = await runEngine('correlation', data);
  if (!res.success) throw new Error(res.error ?? 'Correlation analysis failed');
  return res.data;
}

// ── ML Feature Store (Feature Extraction, Regime Detection, Anomaly Detection) ──

export async function engineFeatureStore(data: {
  command: string;
  candles?: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  lookback?: number;
}): Promise<unknown> {
  const res = await runEngine('feature_store', data);
  if (!res.success) throw new Error(res.error ?? 'Feature store operation failed');
  return res.data;
}

// ── Multi-Timeframe Scan ──

export async function engineMultiTimeframeScan(data: unknown): Promise<unknown> {
  const res = await runEngine('multi_timeframe_scan', data);
  if (!res.success) throw new Error(res.error ?? 'Multi-timeframe scan failed');
  return res.data;
}

// ── ML Scorer ──

export interface MLScoreResult {
  scores: number[];
  model_version: string;
}

export interface MLTrainResult {
  weights: {
    w: number[];
    bias: number;
    feature_names: string[];
    training_samples: number;
    training_accuracy: number;
  };
  training_accuracy: number;
  samples_used: number;
}

export async function engineMLScore(data: {
  command: 'predict' | 'train' | 'allocate';
  features?: Array<Record<string, unknown>>;
  weights?: Record<string, unknown>;
  training_data?: Array<{ features: Record<string, unknown>; outcome: number }>;
  learning_rate?: number;
  epochs?: number;
  strategy_stats?: Array<{ strategy_id: string; wins: number; losses: number; sharpe: number; is_decaying: boolean }>;
  total_capital?: number;
}): Promise<MLScoreResult | MLTrainResult | Record<string, unknown>> {
  const res = await runEngine('ml_score', data);
  if (!res.success) throw new Error(res.error ?? 'ML scorer failed');
  return res.data as MLScoreResult | MLTrainResult | Record<string, unknown>;
}

// ── Engine Health / Meta ──

export interface EngineHealthResult {
  status: string;
  uptime_seconds: number;
  version: string;
  positions: number;
}

export async function engineHealth(): Promise<EngineHealthResult> {
  const res = await runEngine('health', {});
  if (!res.success) throw new Error(res.error ?? 'Health check failed');
  return res.data as EngineHealthResult;
}

export async function engineListStrategies(): Promise<{ strategies: string[] }> {
  const res = await runEngine('list_strategies', {});
  if (!res.success) throw new Error(res.error ?? 'List strategies failed');
  return res.data as { strategies: string[] };
}

export async function enginePortfolioSnapshot(): Promise<unknown> {
  const res = await runEngine('portfolio_snapshot', {});
  if (!res.success) throw new Error(res.error ?? 'Portfolio snapshot failed');
  return res.data;
}

export async function engineListPositions(): Promise<unknown> {
  const res = await runEngine('list_positions', {});
  if (!res.success) throw new Error(res.error ?? 'List positions failed');
  return res.data;
}

// ── Kill Switch ──

export async function engineKillSwitch(activate: boolean): Promise<unknown> {
  const cmd = activate ? 'kill_switch' : 'kill_switch_off';
  const res = await runEngine(cmd, {});
  if (!res.success) throw new Error(res.error ?? 'Kill switch operation failed');
  return res.data;
}

// ── Audit Log ──

export async function engineAuditLog(): Promise<unknown> {
  const res = await runEngine('audit_log', {});
  if (!res.success) throw new Error(res.error ?? 'Audit log retrieval failed');
  return res.data;
}

// ── OMS (Order Management System) ──

export interface OMSOrderInput {
  symbol: string;
  exchange?: string;
  side: 'buy' | 'sell';
  order_type?: 'market' | 'limit' | 'stop_loss' | 'stop_loss_market';
  quantity: number;
  price?: number;
  trigger_price?: number;
  product?: 'intraday' | 'delivery';
  strategy_id?: string;
  reference_price?: number;
  tag?: string;
}

export async function engineOMSSubmitOrder(data: OMSOrderInput): Promise<unknown> {
  const res = await runEngine('oms_submit_order', data);
  if (!res.success) throw new Error(res.error ?? 'OMS order submission failed');
  return res.data;
}

export async function engineOMSCancelOrder(orderId: string): Promise<unknown> {
  const res = await runEngine('oms_cancel_order', { order_id: orderId });
  if (!res.success) throw new Error(res.error ?? 'OMS cancel failed');
  return res.data;
}

export async function engineOMSCancelAll(): Promise<unknown> {
  const res = await runEngine('oms_cancel_all', {});
  if (!res.success) throw new Error(res.error ?? 'OMS cancel all failed');
  return res.data;
}

export async function engineOMSOrders(strategyId?: string): Promise<unknown> {
  const data = strategyId ? { strategy_id: strategyId } : {};
  const res = await runEngine('oms_orders', data);
  if (!res.success) throw new Error(res.error ?? 'OMS orders retrieval failed');
  return res.data;
}

export async function engineOMSReconcile(): Promise<unknown> {
  const res = await runEngine('oms_reconcile', {});
  if (!res.success) throw new Error(res.error ?? 'OMS reconciliation failed');
  return res.data;
}

// ── Alerts ──

export async function engineAlerts(minSeverity?: string, limit?: number): Promise<unknown> {
  const data: Record<string, unknown> = {};
  if (minSeverity) data.min_severity = minSeverity;
  if (limit) data.limit = limit;
  const res = await runEngine('alerts', data);
  if (!res.success) throw new Error(res.error ?? 'Alerts retrieval failed');
  return res.data;
}

export async function engineAlertCounts(): Promise<unknown> {
  const res = await runEngine('alert_counts', {});
  if (!res.success) throw new Error(res.error ?? 'Alert counts retrieval failed');
  return res.data;
}

export async function engineAlertAcknowledge(alertId: string): Promise<unknown> {
  const res = await runEngine('alert_acknowledge', { alert_id: alertId });
  if (!res.success) throw new Error(res.error ?? 'Alert acknowledge failed');
  return res.data;
}

// ── Broker ──

export async function engineBrokerStatus(): Promise<{ broker: string; connected: boolean }> {
  const res = await runEngine('broker_refresh_status', {});
  if (!res.success) throw new Error(res.error ?? 'Broker status failed');
  return res.data as { broker: string; connected: boolean };
}

export async function engineBrokerInitSession(): Promise<unknown> {
  const res = await runEngine('broker_init_session', {});
  if (!res.success) throw new Error(res.error ?? 'Broker session init failed');
  return res.data;
}
