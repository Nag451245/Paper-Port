export declare function isEngineAvailable(): boolean;
export declare function ensureEngineAvailable(): Promise<boolean>;
export declare function startDaemon(): boolean;
export declare function stopDaemon(): void;
export declare function engineBacktest(data: unknown): Promise<unknown>;
export declare function engineSignals(data: unknown): Promise<unknown>;
export declare function engineRisk(data: unknown): Promise<unknown>;
export declare function engineGreeks(data: unknown): Promise<unknown>;
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
    candles: Array<{
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
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
export declare function engineOptimize(data: OptimizeInput): Promise<OptimizeResult>;
export interface WalkForwardInput {
    strategy: string;
    symbol: string;
    initial_capital: number;
    candles: Array<{
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
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
export declare function engineWalkForward(data: WalkForwardInput): Promise<WalkForwardResult>;
export interface AdvancedSignalInput {
    candles: Array<{
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
    compute: string[];
}
export interface AdvancedSignalResult {
    vwap?: {
        vwap: number;
        upper_band_1: number;
        lower_band_1: number;
        signal: string;
        series: Array<{
            timestamp: string;
            vwap: number;
        }>;
    };
    volume_profile?: {
        poc: number;
        value_area_high: number;
        value_area_low: number;
        signal: string;
        levels: Array<{
            price: number;
            volume: number;
            is_poc: boolean;
        }>;
    };
    order_flow?: {
        buy_volume: number;
        sell_volume: number;
        imbalance_ratio: number;
        delta: number;
        signal: string;
    };
    market_profile?: {
        poc: number;
        initial_balance_high: number;
        initial_balance_low: number;
        value_area_high: number;
        value_area_low: number;
        profile_type: string;
        signal: string;
    };
}
export declare function engineAdvancedSignals(data: AdvancedSignalInput): Promise<AdvancedSignalResult>;
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
    surface: Array<{
        strike: number;
        expiry_days: number;
        moneyness: number;
        call_iv: number;
        put_iv: number;
        avg_iv: number;
    }>;
    skew_analysis: {
        current_skew: number;
        skew_direction: string;
        put_call_iv_ratio: number;
        atm_iv: number;
        smile_curvature: number;
    };
    anomalies: Array<{
        strike: number;
        expiry_days: number;
        anomaly_type: string;
        severity: number;
        description: string;
    }>;
    term_structure: Array<{
        expiry_days: number;
        atm_iv: number;
    }>;
    summary: {
        overall_iv_level: string;
        skew_regime: string;
        term_structure_shape: string;
        mispriced_options_count: number;
        signal: string;
    };
}
export declare function engineIVSurface(data: IVSurfaceInput): Promise<IVSurfaceResult>;
export declare function engineScan(data: {
    symbols: Array<{
        symbol: string;
        candles: Array<{
            open?: number;
            close: number;
            high: number;
            low: number;
            volume: number;
            timestamp?: string;
        }>;
    }>;
    aggressiveness?: 'high' | 'medium' | 'low';
    strategy_params?: Record<string, unknown>;
    vote_weights?: Record<string, number>;
    regime?: string;
    current_date?: string;
}): Promise<ScanResult>;
export declare function engineMonteCarlo(data: {
    returns: number[];
    initial_capital: number;
    num_simulations?: number;
    time_horizon?: number;
}): Promise<unknown>;
export declare function enginePortfolioOptimize(data: {
    assets: Array<{
        symbol: string;
        returns: number[];
        expected_return?: number;
    }>;
    risk_free_rate?: number;
    num_portfolios?: number;
    views?: Array<{
        asset_index: number;
        expected_return: number;
        confidence: number;
    }>;
}): Promise<unknown>;
export declare function engineOptionsStrategy(data: {
    legs: Array<{
        option_type: string;
        strike: number;
        premium: number;
        quantity: number;
        expiry_days?: number;
        iv?: number;
    }>;
    spot: number;
    risk_free_rate?: number;
    price_range?: [number, number];
}): Promise<unknown>;
export declare function engineCorrelation(data: {
    pairs: Array<{
        symbol_a: string;
        symbol_b: string;
        prices_a: number[];
        prices_b: number[];
    }>;
    lookback?: number;
    zscore_threshold?: number;
}): Promise<unknown>;
export declare function engineFeatureStore(data: {
    command: string;
    candles?: Array<{
        timestamp: string;
        open: number;
        high: number;
        low: number;
        close: number;
        volume: number;
    }>;
    lookback?: number;
}): Promise<unknown>;
export declare function engineMultiTimeframeScan(data: unknown): Promise<unknown>;
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
export declare function engineMLScore(data: {
    command: 'predict' | 'train' | 'allocate';
    features?: Array<Record<string, unknown>>;
    weights?: Record<string, unknown>;
    training_data?: Array<{
        features: Record<string, unknown>;
        outcome: number;
    }>;
    learning_rate?: number;
    epochs?: number;
    strategy_stats?: Array<{
        strategy_id: string;
        wins: number;
        losses: number;
        sharpe: number;
        is_decaying: boolean;
    }>;
    total_capital?: number;
}): Promise<MLScoreResult | MLTrainResult | Record<string, unknown>>;
export interface EngineHealthResult {
    status: string;
    uptime_seconds: number;
    version: string;
    positions: number;
}
export declare function engineHealth(): Promise<EngineHealthResult>;
export declare function engineListStrategies(): Promise<{
    strategies: string[];
}>;
export declare function enginePortfolioSnapshot(): Promise<unknown>;
export declare function engineListPositions(): Promise<unknown>;
export declare function engineKillSwitch(activate: boolean): Promise<unknown>;
export declare function engineAuditLog(): Promise<unknown>;
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
export declare function engineOMSSubmitOrder(data: OMSOrderInput): Promise<unknown>;
export declare function engineOMSCancelOrder(orderId: string): Promise<unknown>;
export declare function engineOMSModifyOrder(orderId: string, updates: {
    quantity?: number;
    price?: number;
    trigger_price?: number;
}): Promise<unknown>;
export declare function engineOMSCancelAll(): Promise<unknown>;
export declare function engineOMSOrders(strategyId?: string): Promise<unknown>;
export declare function engineOMSReconcile(): Promise<unknown>;
export declare function engineAlerts(minSeverity?: string, limit?: number): Promise<unknown>;
export declare function engineAlertCounts(): Promise<unknown>;
export declare function engineAlertAcknowledge(alertId: string): Promise<unknown>;
export declare function engineBrokerStatus(): Promise<{
    broker: string;
    connected: boolean;
}>;
export declare function engineBrokerInitSession(): Promise<unknown>;
export declare function engineBrokerOptionChain(symbol: string, expiry?: string): Promise<unknown>;
export declare function engineBrokerExpiries(symbol: string): Promise<unknown>;
export declare function engineBrokerLotSizes(): Promise<unknown>;
export declare function engineBrokerQuote(symbol: string): Promise<unknown>;
export declare function engineMarketDataPrices(): Promise<unknown>;
export declare function engineScanActiveSymbols(): Promise<{
    count: number;
    symbols: string[];
}>;
export declare function engineScanStatus(): Promise<unknown>;
export interface OptionsSignalResult {
    symbol: string;
    strategy: string;
    side: string;
    confidence: number;
    reason: string;
}
export declare function engineOptionsSignals(): Promise<OptionsSignalResult[]>;
export declare function engineOptionsData(symbol: string): Promise<Record<string, unknown> | null>;
export declare function engineUniverseRefresh(): Promise<unknown>;
/**
 * Non-blocking check: returns true if the Rust engine kill switch is active.
 * Returns false if the engine is unreachable (fail-open to avoid breaking existing flow).
 */
export declare function isKillSwitchActive(): Promise<boolean>;
export interface StrategyHealth {
    strategy_id: string;
    total_signals: number;
    recent_signals: number;
    win_rate_all: number;
    win_rate_recent: number;
    avg_pnl_pct: number;
    sharpe: number;
    consistency_score: number;
    health_score: number;
    is_retired: boolean;
    retirement_reason: string | null;
    regime_performance: Record<string, {
        wins: number;
        losses: number;
        win_rate: number;
        avg_pnl: number;
    }>;
}
export declare function enginePerformanceSummary(): Promise<Record<string, unknown> | null>;
export declare function engineStrategyHealth(strategy?: string): Promise<StrategyHealth[] | StrategyHealth | null>;
export declare function engineCalibrateConfidence(confidence: number, strategy: string, regime?: string): Promise<{
    raw: number;
    calibrated: number;
    regime_adjusted: number;
} | null>;
export declare function engineRecordOutcome(outcome: {
    symbol: string;
    strategy: string;
    direction: string;
    predicted_confidence: number;
    entry_price: number;
    exit_price: number;
    pnl_pct: number;
    won: boolean;
    regime: string;
}): Promise<boolean>;
export declare function engineActiveStrategies(): Promise<{
    active: string[];
    retired: Array<[string, string]>;
} | null>;
export interface ExecutionPlan {
    symbol: string;
    side: string;
    total_qty: number;
    recommended_algo: string;
    num_slices: number;
    slice_interval_secs: number;
    urgency: number;
    estimated_slippage_bps: number;
    estimated_market_impact_bps: number;
    estimated_total_cost_bps: number;
    optimal_execution_window: {
        avoid_open_minutes: number;
        avoid_close_minutes: number;
        preferred_start_ist: string;
        preferred_end_ist: string;
        reason: string;
    };
    risk_warnings: string[];
    confidence: number;
}
export interface ExecutionQuality {
    symbol: string;
    side: string;
    qty: number;
    avg_fill_price: number;
    vwap: number;
    arrival_price: number;
    implementation_shortfall_bps: number;
    vwap_slippage_bps: number;
    market_impact_bps: number;
    timing_cost_bps: number;
    total_cost_bps: number;
    grade: string;
}
export declare function engineExecutionPlan(params: {
    symbol: string;
    side: string;
    quantity: number;
    price: number;
    avg_daily_volume?: number;
    daily_volatility?: number;
    urgency?: string;
    signal_confidence?: number;
}): Promise<ExecutionPlan | null>;
export declare function engineExecutionQuality(params: {
    symbol: string;
    side: string;
    qty: number;
    avg_fill_price: number;
    arrival_price: number;
    vwap?: number;
    avg_daily_volume?: number;
}): Promise<ExecutionQuality | null>;
export declare function engineOptimalSize(params: {
    price: number;
    capital: number;
    risk_pct?: number;
    stop_loss_pct?: number;
    avg_daily_volume?: number;
    daily_volatility?: number;
    confidence?: number;
}): Promise<Record<string, unknown> | null>;
export declare function engineTrainingData(): Promise<{
    outcomes: Array<Record<string, unknown>>;
    training_log: Array<Record<string, unknown>>;
    total_outcomes: number;
    total_log_entries: number;
} | null>;
export declare function engineTickData(symbol: string): Promise<Record<string, unknown> | null>;
export declare function engineDiscoveryRun(candles_by_symbol?: Record<string, unknown[]>): Promise<Record<string, unknown> | null>;
export declare function engineDiscoveryResults(): Promise<Record<string, unknown> | null>;
export declare function engineDiscoveryApply(): Promise<Record<string, unknown> | null>;
export declare function engineOrderbookAnalyze(data: unknown): Promise<Record<string, unknown> | null>;
export declare function engineCorrelationGuard(data: unknown): Promise<Record<string, unknown> | null>;
export declare function engineExecutionAnalytics(data: unknown): Promise<Record<string, unknown> | null>;
export declare function engineSignalRanker(data: unknown): Promise<Record<string, unknown> | null>;
export declare function enginePaperLiveBridge(data: unknown): Promise<Record<string, unknown> | null>;
export declare function _getCircuitBreakerState(): {
    crashCount: number;
    lastCrashTime: number;
    circuitOpenSince: number;
    MAX_CRASHES: number;
    CRASH_WINDOW_MS: number;
    CIRCUIT_COOLDOWN_MS: number;
};
export declare function _resetCircuitBreakerForTesting(): void;
//# sourceMappingURL=rust-engine.d.ts.map