/**
 * Client for the Python ML microservice (port 8002).
 * Provides type-safe wrappers for scoring, training, regime detection, and allocation.
 */

import { createChildLogger } from './logger.js';
import { env } from '../config.js';

const log = createChildLogger('MLServiceClient');

const ML_SERVICE_URL = env.ML_SERVICE_URL;
const TIMEOUT_MS = 30_000;

let mlServiceAvailable = false;
let lastHealthCheck = 0;
const HEALTH_CHECK_INTERVAL_MS = 60_000;

export interface MLScoreRequest {
  features: Array<{
    features: Record<string, number>;
    raw_features?: number[];
  }>;
  model_type?: 'xgboost' | 'lightgbm';
}

export interface MLScoreResponse {
  scores: number[];
  labels: string[];
  model_type: string;
  feature_importance: Record<string, number>;
}

export interface MLTrainRequest {
  training_data: Array<{
    features: Record<string, unknown>;
    outcome: number;
  }>;
  model_type?: 'xgboost' | 'lightgbm';
  walk_forward_days?: number;
  purge_gap_days?: number;
}

export interface MLTrainResponse {
  accuracy: number;
  auc_roc: number;
  feature_importance: Record<string, number>;
  training_samples: number;
  validation_samples: number;
  model_type: string;
}

export interface RegimeRequest {
  returns: number[];
  volatility: number[];
  correlations?: number[];
  n_states?: number;
}

export interface RegimeResponse {
  current_regime: string;
  regime_id: number;
  regime_probabilities: Record<string, number>;
  transition_matrix: number[][];
  regime_labels: Record<number, string>;
}

export interface StrategyStatsInput {
  strategy_id: string;
  wins: number;
  losses: number;
  sharpe: number;
  avg_return?: number;
  is_decaying?: boolean;
}

export interface AllocateRequest {
  strategy_stats: StrategyStatsInput[];
  total_capital: number;
  current_regime?: string;
  risk_budget_pct?: number;
}

export interface AllocateResponse {
  allocations: Record<string, number>;
  capital_per_strategy: Record<string, number>;
  method: string;
  exploration_rate: number;
}

async function mlFetch<T>(path: string, body: unknown): Promise<T> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), TIMEOUT_MS);

  try {
    const res = await fetch(`${ML_SERVICE_URL}${path}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
      signal: controller.signal,
    });

    if (!res.ok) {
      const text = await res.text().catch(() => 'unknown error');
      throw new Error(`ML service ${path} returned ${res.status}: ${text}`);
    }

    return await res.json() as T;
  } finally {
    clearTimeout(timeout);
  }
}

export async function isMLServiceAvailable(): Promise<boolean> {
  if (Date.now() - lastHealthCheck < HEALTH_CHECK_INTERVAL_MS) {
    return mlServiceAvailable;
  }

  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 3000);
    const res = await fetch(`${ML_SERVICE_URL}/health`, { signal: controller.signal });
    clearTimeout(timeout);
    mlServiceAvailable = res.ok;
    lastHealthCheck = Date.now();

    if (mlServiceAvailable) {
      const health = await res.json() as Record<string, unknown>;
      log.info({ models: health.models_loaded, uptime: health.uptime_seconds }, 'ML service healthy');
    }
  } catch {
    mlServiceAvailable = false;
    lastHealthCheck = Date.now();
  }

  return mlServiceAvailable;
}

export async function mlScore(req: MLScoreRequest): Promise<MLScoreResponse> {
  return mlFetch<MLScoreResponse>('/score', req);
}

export async function mlTrain(req: MLTrainRequest): Promise<MLTrainResponse> {
  return mlFetch<MLTrainResponse>('/train', req);
}

export async function mlDetectRegime(req: RegimeRequest): Promise<RegimeResponse> {
  return mlFetch<RegimeResponse>('/regime', req);
}

export async function mlAllocate(req: AllocateRequest): Promise<AllocateResponse> {
  return mlFetch<AllocateResponse>('/allocate', req);
}

export interface CalibrateRequest {
  predictions: number[];
  actuals: number[];
  model_type?: 'xgboost' | 'lightgbm';
}

export interface CalibrateResponse {
  brier_score: number;
  calibrated: boolean;
  adjustments: Record<string, number>;
  message: string;
}

export async function mlCalibrate(req: CalibrateRequest): Promise<CalibrateResponse> {
  return mlFetch<CalibrateResponse>('/calibrate', req);
}

export interface MLPredictReturnsResponse {
  predictions: number[];
  confidence: number;
  available: boolean;
}

export interface MLRLActionResponse {
  action: number;
  rl_suggestion?: number;
  mode: string;
  available: boolean;
}

export async function mlRLAction(state: Record<string, number>): Promise<MLRLActionResponse> {
  const resp = await fetch(`${ML_SERVICE_URL}/rl-action`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ state }),
    signal: AbortSignal.timeout(3000),
  });
  if (!resp.ok) return { action: 0.1, mode: 'unavailable', available: false };
  return resp.json() as Promise<MLRLActionResponse>;
}

export async function mlPredictReturns(features: Record<string, number>[]): Promise<MLPredictReturnsResponse> {
  const resp = await fetch(`${ML_SERVICE_URL}/predict-returns`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ features }),
    signal: AbortSignal.timeout(5000),
  });
  if (!resp.ok) return { predictions: [0], confidence: 0, available: false };
  return resp.json() as Promise<MLPredictReturnsResponse>;
}

export interface MLSequenceScoreResponse {
  probability: number;
  embedding: number[];
  available: boolean;
}

export async function mlScoreSequence(bars: Array<Record<string, number>>): Promise<MLSequenceScoreResponse> {
  try {
    const resp = await fetch(`${ML_SERVICE_URL}/score-sequence`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ bars, seq_len: 60 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { probability: 0.5, embedding: [], available: false };
    return resp.json() as Promise<MLSequenceScoreResponse>;
  } catch {
    return { probability: 0.5, embedding: [], available: false };
  }
}

export interface MLTFTScoreResponse {
  probability: number;
  expected_return: number;
  attention_weights: number[];
  feature_importance: Record<string, number>;
  available: boolean;
}

export async function mlScoreTFT(
  staticFeatures: Record<string, number>,
  sequence: Array<Record<string, number>>,
): Promise<MLTFTScoreResponse> {
  try {
    const resp = await fetch(`${ML_SERVICE_URL}/score-tft`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ static_features: staticFeatures, sequence, seq_len: 30 }),
      signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok) return { probability: 0.5, expected_return: 0, attention_weights: [], feature_importance: {}, available: false };
    return resp.json() as Promise<MLTFTScoreResponse>;
  } catch {
    return { probability: 0.5, expected_return: 0, attention_weights: [], feature_importance: {}, available: false };
  }
}

export interface MLEnsembleScoreResponse {
  ensemble_probability: number;
  model_weights: Record<string, number>;
  disagreement_score: number;
  confidence: number;
  available: boolean;
}

export async function mlEnsembleScore(modelOutputs: Record<string, number>): Promise<MLEnsembleScoreResponse> {
  try {
    const resp = await fetch(`${ML_SERVICE_URL}/ensemble-score`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ model_outputs: modelOutputs }),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return { ensemble_probability: 0.5, model_weights: {}, disagreement_score: 0, confidence: 0.5, available: false };
    return resp.json() as Promise<MLEnsembleScoreResponse>;
  } catch {
    return { ensemble_probability: 0.5, model_weights: {}, disagreement_score: 0, confidence: 0.5, available: false };
  }
}

export interface MLOnlineUpdateResponse {
  status: string;
  sgd_updates: number;
  xgb_updates: number;
  trade_id: string;
  drift_detected: boolean;
}

export async function mlOnlineUpdate(
  features: Record<string, number>,
  outcome: number,
  tradeId: string,
): Promise<MLOnlineUpdateResponse> {
  try {
    const resp = await fetch(`${ML_SERVICE_URL}/online-update`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ features, outcome, trade_id: tradeId }),
      signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok) return { status: 'failed', sgd_updates: 0, xgb_updates: 0, trade_id: tradeId, drift_detected: false };
    return resp.json() as Promise<MLOnlineUpdateResponse>;
  } catch {
    return { status: 'failed', sgd_updates: 0, xgb_updates: 0, trade_id: tradeId, drift_detected: false };
  }
}
