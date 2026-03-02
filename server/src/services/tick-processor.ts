import { wsHub } from '../lib/websocket.js';
import { engineSignals, engineFeatureStore, isEngineAvailable } from '../lib/rust-engine.js';

interface TickBuffer {
  symbol: string;
  candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>;
  lastProcessed: number;
}

const MIN_PROCESS_INTERVAL_MS = 5_000;
const MAX_BUFFER_SIZE = 200;
const tickBuffers = new Map<string, TickBuffer>();

export function ingestTick(symbol: string, tick: { price: number; volume: number; timestamp?: string }) {
  const now = Date.now();
  const ts = tick.timestamp ?? new Date().toISOString();

  let buf = tickBuffers.get(symbol);
  if (!buf) {
    buf = { symbol, candles: [], lastProcessed: 0 };
    tickBuffers.set(symbol, buf);
  }

  const last = buf.candles[buf.candles.length - 1];
  const minuteKey = ts.substring(0, 16);
  const lastMinuteKey = last?.timestamp?.substring(0, 16);

  if (last && minuteKey === lastMinuteKey) {
    last.high = Math.max(last.high, tick.price);
    last.low = Math.min(last.low, tick.price);
    last.close = tick.price;
    last.volume += tick.volume;
  } else {
    buf.candles.push({ timestamp: ts, open: tick.price, high: tick.price, low: tick.price, close: tick.price, volume: tick.volume });
    if (buf.candles.length > MAX_BUFFER_SIZE) buf.candles.shift();
  }

  if (buf.candles.length >= 15 && now - buf.lastProcessed > MIN_PROCESS_INTERVAL_MS) {
    buf.lastProcessed = now;
    processBuffer(buf).catch(() => {});
  }
}

async function processBuffer(buf: TickBuffer) {
  if (!isEngineAvailable()) return;

  try {
    const result = await engineSignals({ candles: buf.candles }) as any;
    if (!result) return;

    const n = buf.candles.length - 1;
    const last = (arr: number[]) => arr?.length > 0 ? arr[arr.length - 1] : null;

    const indicators: Record<string, number> = {};
    const ema9 = last(result.ema_9);
    const ema21 = last(result.ema_21);
    const rsi = last(result.rsi_14);
    const macdH = last(result.macd_histogram);

    if (ema9 !== null) indicators.ema9 = round2(ema9);
    if (ema21 !== null) indicators.ema21 = round2(ema21);
    if (rsi !== null) indicators.rsi = round2(rsi);
    if (macdH !== null) indicators.macd_histogram = round2(macdH);

    let signal = 'NEUTRAL';
    let confidence = 0.5;
    if (ema9 !== null && ema21 !== null && rsi !== null) {
      if (ema9 > ema21 && rsi < 70) { signal = 'BULLISH'; confidence = 0.5 + Math.min((ema9 - ema21) / ema21 * 10, 0.3); }
      else if (ema9 < ema21 && rsi > 30) { signal = 'BEARISH'; confidence = 0.5 + Math.min((ema21 - ema9) / ema21 * 10, 0.3); }
    }

    wsHub.broadcastEngineSignal(buf.symbol, {
      indicators,
      signal,
      confidence: round2(confidence),
      timestamp: new Date().toISOString(),
    });
  } catch { /* silently continue */ }
}

export async function processRegimeDetection(candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>) {
  if (!isEngineAvailable() || candles.length < 50) return;

  try {
    const result = await engineFeatureStore({ command: 'detect_regime', candles }) as any;
    if (result?.regime?.current_regime) {
      wsHub.broadcastRegime({
        regime: result.regime.current_regime,
        confidence: result.regime.regime_history?.slice(-1)[0]?.confidence ?? 0.5,
        timestamp: new Date().toISOString(),
      });
    }
  } catch { /* silently continue */ }
}

export async function processAnomalyDetection(candles: Array<{ timestamp: string; open: number; high: number; low: number; close: number; volume: number }>, symbol: string) {
  if (!isEngineAvailable() || candles.length < 30) return;

  try {
    const result = await engineFeatureStore({ command: 'detect_anomalies', candles }) as any;
    if (result?.anomalies?.length > 0) {
      for (const anomaly of result.anomalies.slice(0, 3)) {
        wsHub.broadcastAnomaly({
          symbol,
          anomaly_type: anomaly.anomaly_type,
          score: anomaly.score,
          details: anomaly.details,
          timestamp: anomaly.timestamp,
        });
      }
    }
  } catch { /* silently continue */ }
}

export function getActiveBuffers(): string[] {
  return [...tickBuffers.keys()];
}

function round2(v: number): number {
  return Math.round(v * 100) / 100;
}
