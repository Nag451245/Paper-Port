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
from typing import Optional
from contextlib import asynccontextmanager

import numpy as np
from fastapi import FastAPI, HTTPException
from pydantic import BaseModel, Field

# ML imports
from model_store import ModelStore
from regime_detector import RegimeDetector
from signal_scorer import SignalScorer
from strategy_allocator import StrategyAllocator

logging.basicConfig(level=logging.INFO, format="%(asctime)s [%(name)s] %(message)s")
log = logging.getLogger("MLService")

store = ModelStore()
regime_detector = RegimeDetector()
signal_scorer = SignalScorer(store)
strategy_allocator = StrategyAllocator()

startup_time = time.time()


@asynccontextmanager
async def lifespan(app: FastAPI):
    log.info("ML Service starting — loading models from disk")
    store.load_all()
    yield
    log.info("ML Service shutting down — persisting models")
    store.save_all()


app = FastAPI(title="Capital Guard ML Service", version="1.0.0", lifespan=lifespan)


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
        results = signal_scorer.train(
            req.training_data,
            req.model_type,
            req.walk_forward_days,
            req.purge_gap_days,
        )
        return results
    except Exception as e:
        log.error(f"Training error: {e}")
        raise HTTPException(status_code=500, detail=str(e))


@app.post("/regime", response_model=RegimeResponse)
async def detect_regime(req: RegimeRequest):
    """Detect current market regime using Hidden Markov Model."""
    try:
        result = regime_detector.detect(
            req.returns, req.volatility, req.correlations, req.n_states
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


if __name__ == "__main__":
    import uvicorn

    port = int(os.environ.get("ML_SERVICE_PORT", 8002))
    log.info(f"Starting ML Service on port {port}")
    uvicorn.run(app, host="0.0.0.0", port=port, log_level="info")
