import type { PrismaClient } from '@prisma/client';
import { type MarketMover } from './market-data.service.js';
import { OrderManagementService } from './oms.service.js';
export interface MarketScanSignal {
    symbol: string;
    name: string;
    direction: 'BUY' | 'SELL';
    confidence: number;
    ltp: number;
    changePercent: number;
    entry: number;
    stopLoss: number;
    target: number;
    indicators: Record<string, number>;
    votes: Record<string, number>;
    moverType: 'gainer' | 'loser';
}
export interface MarketScanResult {
    timestamp: string;
    scannedCount: number;
    signals: MarketScanSignal[];
    topGainers: MarketMover[];
    topLosers: MarketMover[];
    scanDurationMs: number;
}
interface RollingAccuracy {
    outcomes: ('WIN' | 'LOSS' | 'BREAKEVEN')[];
    accuracy: number;
}
export declare class BotEngine {
    private prisma;
    private runningBots;
    private runningAgents;
    private marketData;
    private tradeService;
    private _rustAvailable;
    private lastEngineCheck;
    private scannerTimer;
    private scannerUserId;
    private lastScanResult;
    private scanInProgress;
    private _killSwitchActive;
    private cycleInProgress;
    private rollingAccuracy;
    private tickInterval;
    private signalInterval;
    private marketScanInterval;
    private targetTracker;
    private globalMarket;
    private decisionAudit;
    private calendar;
    private riskService;
    private twapExecutor;
    private portfolioOptimizer;
    private cachedStrategyParams;
    private paramsLastLoaded;
    private strategyBeta;
    private recentWinRates;
    private intradayVolatility;
    private mlWeights;
    private abTestTracker;
    private featurePipeline;
    private marketMemory;
    private decisionFusion;
    private lessonsEngine;
    private regimeDetector;
    private telegramService;
    constructor(prisma: PrismaClient, oms?: OrderManagementService);
    /**
     * Load trained ML weights from the database (persisted by nightly LearningEngine).
     * Called on startup and can be called externally after morning boot.
     */
    loadMLWeightsFromDB(userId?: string): Promise<void>;
    private alphaDecayCache;
    /**
     * Thompson sampling: select strategy by sampling from Beta(alpha, beta) posteriors.
     * Applies alpha decay penalty — decaying strategies get 50% score reduction.
     */
    thompsonSelectStrategy(availableStrategies: string[]): string | null;
    loadAlphaDecayState(userId: string): Promise<void>;
    /**
     * Bayesian update: after a trade outcome, update the Beta distribution for a strategy.
     */
    bayesianUpdate(strategyId: string, won: boolean): void;
    /**
     * Compute dynamic stop-loss based on intraday volatility.
     * Widens stops in high-vol conditions, tightens in low-vol.
     */
    computeDynamicStopLoss(symbol: string, baseStopPct: number): number;
    /**
     * Update intraday volatility estimate for a symbol using latest candle data.
     */
    updateIntradayVolatility(symbol: string, recentReturns: number[]): void;
    private loadStrategyParams;
    private get rustAvailable();
    refreshRustAvailability(): void;
    /**
     * Derive G1-G9 gate scores from Rust engine indicators/votes or from
     * confidence + signal metadata. Ensures the frontend always has G1-G9 keys.
     */
    private deriveGateScores;
    getRollingAccuracy(strategyId: string): RollingAccuracy | undefined;
    private trackOutcome;
    private checkAutoPause;
    getLastScanResult(): MarketScanResult | null;
    isScannerRunning(): boolean;
    getRunningBotCount(): number;
    startBot(botId: string, userId: string): Promise<void>;
    stopBot(botId: string): void;
    startAgent(userId: string): Promise<void>;
    stopAgent(userId: string): void;
    stopAll(): void;
    get killSwitchActive(): boolean;
    activateKillSwitch(): void;
    deactivateKillSwitch(): void;
    private detectCurrentRegime;
    private calcSimpleEma;
    startMarketScan(userId: string): Promise<void>;
    stopMarketScan(): void;
    setTickInterval(ms: number): void;
    setMarketScanInterval(ms: number): void;
    getActiveBotCount(): number;
    getActiveAgentCount(): number;
    isRunning(): boolean;
    private runMarketScan;
    private resolveStrategyTag;
    private executeTrade;
    private executeMultiLegStrategy;
    private getLotSizeForSymbol;
    private detectExchange;
    private cachedAllocations;
    private allocationsLastLoaded;
    private computeKellySize;
    private updateBotTradeStats;
    private fetchCandles;
    private runBotCycle;
    /**
     * Auto-pyramid: add to winning positions when they're in profit.
     * Only adds if position is > 0.5% in profit and total risk stays within limits.
     */
    private pyramidWinners;
    private handleRustSignals;
    private executePendingSignals;
    private runSDKStrategy;
    private gptValidateSignal;
    private mlValidateSignal;
    private fetchFnOContext;
    private computeRustIndicators;
    private runGptBotCycle;
    private runAgentCycle;
    private computePortfolioReturns;
    private getTargetContextString;
    private fetchQuotes;
    private getPortfolioPositions;
    /**
     * Execute a signal produced by the data pipeline (Python ML scored).
     * Routes through risk checks and TradeService for proper OMS lifecycle.
     */
    executePipelineSignal(signal: {
        symbol: string;
        direction: 'BUY' | 'SELL';
        confidence: number;
        strategy: string;
        mlScore: number;
        source: string;
    }): Promise<void>;
    private getStrategyHealth;
}
export {};
//# sourceMappingURL=bot-engine.d.ts.map