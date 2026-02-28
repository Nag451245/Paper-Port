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
