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
