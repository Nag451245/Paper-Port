"""
Capital Guard — Python ML Microservice
Runs on port 8002, called internally by the Node.js backend.

Provides:
  - /score         — XGBoost/LightGBM signal scoring
  - /train         — Retrain scoring model on recent trade data
  - /regime        — HMM regime detection (trending-up/down, ranging, volatile)
  - /allocate      — Bayesian strategy allocation optimization
  - /health        — Health check
"""

import os
import json
import logging
import time
import asyncio
from typing import Dict, Optional
from contextlib import asynccontextmanager
from concurrent.futures import ThreadPoolExecutor

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ML imports
from model_store import ModelStore
from regime_detector import RegimeDetector
from signal_scorer import SignalScorer
from strategy_allocator import StrategyAllocator
from return_predictor import ReturnPredictor, return_predictor
from rl_execution import rl_agent
from lstm_model import lstm_model
from tft_model import tft_model
from ensemble import ensemble_learner
from online_learner import online_learner

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
log = logging.getLogger("MLService")

# Optional OpenTelemetry tracing
try:
    from opentelemetry import trace
    from opentelemetry.sdk.trace import TracerProvider
    from opentelemetry.sdk.trace.export import BatchSpanProcessor
    from opentelemetry.exporter.otlp.proto.http.trace_exporter import OTLPSpanExporter
    from opentelemetry.sdk.resources import Resource
    from opentelemetry.instrumentation.fastapi import FastAPIInstrumentor

    otel_endpoint = os.environ.get("OTEL_EXPORTER_OTLP_ENDPOINT", "")
    if otel_endpoint:
        resource = Resource.create({"service.name": "capital-guard-ml"})
        provider = TracerProvider(resource=resource)
        exporter = OTLPSpanExporter(endpoint=f"{otel_endpoint}/v1/traces")
        provider.add_span_processor(BatchSpanProcessor(exporter))
        trace.set_tracer_provider(provider)
        log.info(f"OpenTelemetry tracing enabled, exporting to {otel_endpoint}")
        _OTEL_AVAILABLE = True
    else:
        _OTEL_AVAILABLE = False
except ImportError:
    _OTEL_AVAILABLE = False

store = ModelStore()
regime_detector = RegimeDetector()
signal_scorer = SignalScorer(store)
strategy_allocator = StrategyAllocator()

startup_time = time.time()

training_pool = ThreadPoolExecutor(max_workers=2, thread_name_prefix="ml-train")


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("ML Service starting — loading models from disk")
    store.load_all()
    yield
    log.info("ML Service shutting down — persisting models")
    store.save_all()


app = FastAPI(title="Capital Guard ML Service", version="1.0.0", lifespan=lifespan)

if _OTEL_AVAILABLE:
    FastAPIInstrumentor.instrument_app(app)


# ── Request / Response Models ──


class FeatureRow(BaseModel):
    features: dict = Field(default_factory=dict)
    raw_features: list[float] = Field(default_factory=list)


class ScoreRequest(BaseModel):
    features: list[FeatureRow]
    model_type: str = "xgboost"  # "xgboost" or "lightgbm"


class ScoreResponse(BaseModel):
    scores: list[float]
    labels: list[str]
    model_type: str
    feature_importance: dict = Field(default_factory=dict)


class TrainRequest(BaseModel):
    training_data: list[dict]  # [{features: {..., raw_features: [...]}, outcome: 0/1}]
    model_type: str = "xgboost"
    walk_forward_days: int = 30
    purge_gap_days: int = 5


class TrainResponse(BaseModel):
    accuracy: float
    auc_roc: float
    feature_importance: dict
    training_samples: int
    validation_samples: int
    model_type: str


class RegimeRequest(BaseModel):
    returns: list[float]
    volatility: list[float]
    correlations: list[float] = Field(default_factory=list)
    n_states: int = 4


class RegimeResponse(BaseModel):
    current_regime: str
    regime_id: int
    regime_probabilities: dict
    transition_matrix: list[list[float]]
    regime_labels: dict


class StrategyStats(BaseModel):
    strategy_id: str
    wins: int = 0
    losses: int = 0
    sharpe: float = 0.0
    avg_return: float = 0.0
    is_decaying: bool = False


class AllocateRequest(BaseModel):
    strategy_stats: list[StrategyStats]
    total_capital: float = 1_000_000
    current_regime: str = "unknown"
    risk_budget_pct: float = 2.0


class AllocateResponse(BaseModel):
    allocations: dict  # {strategy_id: allocation_pct}
    capital_per_strategy: dict
    method: str
    exploration_rate: float


class PredictReturnsRequest(BaseModel):
    features: list[dict]


class TrainReturnModelRequest(BaseModel):
    training_data: list[dict]
    walk_forward_days: int = 30
    purge_gap_days: int = 5


class RLActionRequest(BaseModel):
    state: Dict


class RLExperienceRequest(BaseModel):
    state: Dict
    action: float
    reward: float
    next_state: Dict
    done: bool


class SequenceScoreRequest(BaseModel):
    bars: list[dict]
    seq_len: int = 60

class SequenceTrainRequest(BaseModel):
    training_data: list[dict]
    seq_len: int = 60

class TFTScoreRequest(BaseModel):
    static_features: Dict = Field(default_factory=dict)
    sequence: list[dict] = Field(default_factory=list)
    seq_len: int = 30

class TFTTrainRequest(BaseModel):
    training_data: list[dict]
    seq_len: int = 30

class EnsembleScoreRequest(BaseModel):
    model_outputs: Dict

class EnsembleTrainRequest(BaseModel):
    training_data: list[dict]

class OnlineUpdateRequest(BaseModel):
    features: Dict
    outcome: float
    trade_id: str = ""


# ── Endpoints ──


@app.get("/health")
async def health():
    return {
        "status": "ok",
        "uptime_seconds": round(time.time() - startup_time, 1),
        "models_loaded": store.list_models(),
        "service": "ml-service",
        "port": 8002,
    }


@app.post("/score", response_model=ScoreResponse)
async def score_signals(req: ScoreRequest):
    """Score trading signals using trained XGBoost/LightGBM model."""
    try:
        results = signal_scorer.score(req.features, req.model_type)
        return results
    except Exception as e:
        log.error(f"Scoring error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/train", response_model=TrainResponse)
async def train_model(req: TrainRequest):
    """Retrain signal scoring model with walk-forward validation."""
    try:
        loop = asyncio.get_event_loop()
        results = await loop.run_in_executor(
            training_pool,
            lambda: signal_scorer.train(
                req.training_data,
                req.model_type,
                req.walk_forward_days,
                req.purge_gap_days,
            ),
        )
        return results
    except Exception as e:
        log.error(f"Training error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/regime", response_model=RegimeResponse)
async def detect_regime(req: RegimeRequest):
    """Detect current market regime using Hidden Markov Model."""
    try:
        loop = asyncio.get_event_loop()
        result = await loop.run_in_executor(
            training_pool,
            lambda: regime_detector.detect(
                req.returns, req.volatility, req.correlations, req.n_states
            ),
        )
        return result
    except Exception as e:
        log.error(f"Regime detection error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/allocate", response_model=AllocateResponse)
async def allocate_strategies(req: AllocateRequest):
    """Optimize strategy capital allocation using Thompson sampling + Bayesian optimization."""
    try:
        result = strategy_allocator.allocate(
            req.strategy_stats,
            req.total_capital,
            req.current_regime,
            req.risk_budget_pct,
        )
        return result
    except Exception as e:
        log.error(f"Allocation error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.get("/models")
async def list_models():
    """List all models with version metadata."""
    metadata = store.list_all_metadata()
    return {
        "models": metadata,
        "total": len(metadata),
    }


@app.post("/models/{name}/rollback")
async def rollback_model(name: str):
    """Rollback a model to its previous version."""
    restored_version = store.rollback(name)
    if restored_version is None:
        raise HTTPException(status_code=404, detail=f"Cannot rollback '{name}': insufficient versions")
    return {
        "name": name,
        "restored_version": restored_version,
        "status": "rolled_back",
    }


@app.get("/models/{name}/metadata")
async def model_metadata(name: str):
    """Get metadata for a specific model."""
    meta = store.get_metadata(name)
    if meta is None:
        raise HTTPException(status_code=404, detail=f"Model '{name}' not found")
    return meta


@app.post("/predict-returns")
async def predict_returns(req: PredictReturnsRequest):
    """Predict forward returns using gradient-boosted regression model."""
    result = return_predictor.predict(req.features)
    return result


@app.post("/train-returns")
async def train_returns(req: TrainReturnModelRequest):
    """Train return prediction model with walk-forward validation and purge gap."""
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        training_pool,
        lambda: return_predictor.train(
            req.training_data,
            walk_forward_days=req.walk_forward_days,
            purge_gap_days=req.purge_gap_days,
        ),
    )
    return result


@app.post("/rl-action")
async def rl_action_endpoint(req: RLActionRequest):
    result = rl_agent.get_action(req.state)
    return result


@app.post("/rl-experience")
async def rl_experience(req: RLExperienceRequest):
    rl_agent.store_experience(req.state, req.action, req.reward, req.next_state, req.done)
    return {"status": "stored"}


@app.post("/rl-train")
async def rl_train():
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(training_pool, rl_agent.train)
    return result


@app.get("/rl-shadow-log")
async def rl_shadow_log():
    return {"log": rl_agent.get_shadow_log()}


# ── Deep Learning Endpoints ──


@app.post("/score-sequence")
async def score_sequence(req: SequenceScoreRequest):
    result = lstm_model.score(req.bars, req.seq_len)
    return result


@app.post("/train-sequence")
async def train_sequence(req: SequenceTrainRequest):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        training_pool,
        lambda: lstm_model.train(req.training_data, req.seq_len),
    )
    return result


@app.post("/score-tft")
async def score_tft(req: TFTScoreRequest):
    result = tft_model.score(req.static_features, req.sequence, req.seq_len)
    return result


@app.post("/train-tft")
async def train_tft(req: TFTTrainRequest):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        training_pool,
        lambda: tft_model.train(req.training_data, req.seq_len),
    )
    return result


# ── Ensemble Endpoints ──


@app.post("/ensemble-score")
async def ensemble_score(req: EnsembleScoreRequest):
    result = ensemble_learner.score(req.model_outputs)
    return result


@app.post("/ensemble-train")
async def ensemble_train(req: EnsembleTrainRequest):
    loop = asyncio.get_event_loop()
    result = await loop.run_in_executor(
        training_pool,
        lambda: ensemble_learner.train(req.training_data),
    )
    return result


# ── Online Learning Endpoints ──


@app.post("/online-update")
async def online_update(req: OnlineUpdateRequest):
    result = online_learner.update(req.features, req.outcome, req.trade_id)
    return result


@app.get("/online-stats")
async def online_stats():
    return online_learner.get_stats()


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("ML_SERVICE_PORT", 8002))
    log.info(f"Starting ML Service on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
