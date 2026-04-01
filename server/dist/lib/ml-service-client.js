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
async function mlFetch(path, body) {
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
        return await res.json();
    }
    finally {
        clearTimeout(timeout);
    }
}
export async function isMLServiceAvailable() {
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
            const health = await res.json();
            log.info({ models: health.models_loaded, uptime: health.uptime_seconds }, 'ML service healthy');
        }
    }
    catch {
        mlServiceAvailable = false;
        lastHealthCheck = Date.now();
    }
    return mlServiceAvailable;
}
export async function mlScore(req) {
    return mlFetch('/score', req);
}
export async function mlTrain(req) {
    return mlFetch('/train', req);
}
export async function mlDetectRegime(req) {
    return mlFetch('/regime', req);
}
export async function mlAllocate(req) {
    return mlFetch('/allocate', req);
}
export async function mlCalibrate(req) {
    return mlFetch('/calibrate', req);
}
export async function mlRLAction(state) {
    const resp = await fetch(`${ML_SERVICE_URL}/rl-action`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ state }),
        signal: AbortSignal.timeout(3000),
    });
    if (!resp.ok)
        return { action: 0.1, mode: 'unavailable', available: false };
    return resp.json();
}
export async function mlPredictReturns(features) {
    const resp = await fetch(`${ML_SERVICE_URL}/predict-returns`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ features }),
        signal: AbortSignal.timeout(5000),
    });
    if (!resp.ok)
        return { predictions: [0], confidence: 0, available: false };
    return resp.json();
}
export async function mlScoreSequence(bars) {
    try {
        const resp = await fetch(`${ML_SERVICE_URL}/score-sequence`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ bars, seq_len: 60 }),
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok)
            return { probability: 0.5, embedding: [], available: false };
        return resp.json();
    }
    catch {
        return { probability: 0.5, embedding: [], available: false };
    }
}
export async function mlScoreTFT(staticFeatures, sequence) {
    try {
        const resp = await fetch(`${ML_SERVICE_URL}/score-tft`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ static_features: staticFeatures, sequence, seq_len: 30 }),
            signal: AbortSignal.timeout(5000),
        });
        if (!resp.ok)
            return { probability: 0.5, expected_return: 0, attention_weights: [], feature_importance: {}, available: false };
        return resp.json();
    }
    catch {
        return { probability: 0.5, expected_return: 0, attention_weights: [], feature_importance: {}, available: false };
    }
}
export async function mlEnsembleScore(modelOutputs) {
    try {
        const resp = await fetch(`${ML_SERVICE_URL}/ensemble-score`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ model_outputs: modelOutputs }),
            signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok)
            return { ensemble_probability: 0.5, model_weights: {}, disagreement_score: 0, confidence: 0.5, available: false };
        return resp.json();
    }
    catch {
        return { ensemble_probability: 0.5, model_weights: {}, disagreement_score: 0, confidence: 0.5, available: false };
    }
}
export async function mlOnlineUpdate(features, outcome, tradeId) {
    try {
        const resp = await fetch(`${ML_SERVICE_URL}/online-update`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ features, outcome, trade_id: tradeId }),
            signal: AbortSignal.timeout(3000),
        });
        if (!resp.ok)
            return { status: 'failed', sgd_updates: 0, xgb_updates: 0, trade_id: tradeId, drift_detected: false };
        return resp.json();
    }
    catch {
        return { status: 'failed', sgd_updates: 0, xgb_updates: 0, trade_id: tradeId, drift_detected: false };
    }
}
//# sourceMappingURL=ml-service-client.js.map