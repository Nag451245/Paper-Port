/**
 * Client for the Python ML microservice (port 8002).
 * Provides type-safe wrappers for scoring, training, regime detection, and allocation.
 */
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
export declare function isMLServiceAvailable(): Promise<boolean>;
export declare function mlScore(req: MLScoreRequest): Promise<MLScoreResponse>;
export declare function mlTrain(req: MLTrainRequest): Promise<MLTrainResponse>;
export declare function mlDetectRegime(req: RegimeRequest): Promise<RegimeResponse>;
export declare function mlAllocate(req: AllocateRequest): Promise<AllocateResponse>;
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
export declare function mlCalibrate(req: CalibrateRequest): Promise<CalibrateResponse>;
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
export declare function mlRLAction(state: Record<string, number>): Promise<MLRLActionResponse>;
export declare function mlPredictReturns(features: Record<string, number>[]): Promise<MLPredictReturnsResponse>;
export interface MLSequenceScoreResponse {
    probability: number;
    embedding: number[];
    available: boolean;
}
export declare function mlScoreSequence(bars: Array<Record<string, number>>): Promise<MLSequenceScoreResponse>;
export interface MLTFTScoreResponse {
    probability: number;
    expected_return: number;
    attention_weights: number[];
    feature_importance: Record<string, number>;
    available: boolean;
}
export declare function mlScoreTFT(staticFeatures: Record<string, number>, sequence: Array<Record<string, number>>): Promise<MLTFTScoreResponse>;
export interface MLEnsembleScoreResponse {
    ensemble_probability: number;
    model_weights: Record<string, number>;
    disagreement_score: number;
    confidence: number;
    available: boolean;
}
export declare function mlEnsembleScore(modelOutputs: Record<string, number>): Promise<MLEnsembleScoreResponse>;
export interface MLOnlineUpdateResponse {
    status: string;
    sgd_updates: number;
    xgb_updates: number;
    trade_id: string;
    drift_detected: boolean;
}
export declare function mlOnlineUpdate(features: Record<string, number>, outcome: number, tradeId: string): Promise<MLOnlineUpdateResponse>;
//# sourceMappingURL=ml-service-client.d.ts.map