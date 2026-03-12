import type { PrismaClient } from '@prisma/client';
import { chatCompletionJSON, getOpenAIStatus } from '../lib/openai.js';
import { MarketDataService, type MarketMover } from './market-data.service.js';
import { TradeService } from './trade.service.js';
import { OrderManagementService } from './oms.service.js';
import { engineScan, engineRisk, engineSignals, isEngineAvailable, type ScanSignal } from '../lib/rust-engine.js';
import { calculateMaxPain, calculateIVPercentile, calculateGreeks } from './options.service.js';
import { TargetTracker, type TargetProgress } from './target-tracker.service.js';
import { GlobalMarketService } from './global-market.service.js';
import { DecisionAuditService, type DecisionRecord } from './decision-audit.service.js';
import { MarketCalendar } from './market-calendar.js';
import { RiskService } from './risk.service.js';
import { TWAPExecutor, selectOrderType } from './twap-executor.service.js';
import { ExitCoordinator } from './exit-coordinator.service.js';
import { emit } from '../lib/event-bus.js';
import { createChildLogger } from '../lib/logger.js';
import { env } from '../config.js';

const log = createChildLogger('BotEngine');

const DEFAULT_TICK_INTERVAL = 30_000;         // 30 seconds — Rust scan is fast, skip if still running
const DEFAULT_SIGNAL_INTERVAL = 2 * 60_000;   // 2 minutes
const DEFAULT_MARKET_SCAN_INTERVAL = 3 * 60_000; // 3 minutes
const MAX_CONCURRENT_BOTS = 10;
const MAX_CANDLE_SYMBOLS = 30;

interface RunningBot {
  botId: string;
  userId: string;
  timer: ReturnType<typeof setInterval>;
}

interface RunningAgent {
  userId: string;
  timer: ReturnType<typeof setInterval>;
}

const ROLE_PROMPTS: Record<string, string> = {
  SCANNER: `You are an expert equity SCANNER bot for the Indian markets (NSE/BSE).
You perform REAL technical analysis on live market data. You are NOT a generic chatbot — you are a professional trading tool.

Your analysis MUST include:
- Exact price levels (support, resistance, entry, stop-loss, target) with ₹ values
- Volume analysis: is today's volume above/below average? Unusual activity?
- Price action: gap up/down from previous close, intraday range, trend direction
- Momentum: is the stock accelerating or decelerating in its move?
- Risk/reward ratio for each signal (e.g. "R:R = 1:2.5")

Rules:
- In a FALLING market (NIFTY down >0.5%), prioritize SELL/SHORT signals on weak stocks breaking support
- In a RISING market (NIFTY up >0.5%), prioritize BUY signals on stocks breaking out with volume
- Stocks CAN be shorted (SELL = short for profit). This is paper trading, be aggressive
- ALWAYS generate 2-5 signals with specific entry, stop-loss, and target prices
- Use the actual price data provided — never make up prices`,

  ANALYST: `You are a professional technical ANALYST bot for the Indian markets.
You provide institutional-grade analysis with specific price levels and actionable recommendations.

Your analysis MUST include for each stock:
- Current trend (bullish/bearish/sideways) with reasoning from price data
- Key support and resistance levels derived from the price data (OHLC)
- Entry price, stop-loss, and target with exact ₹ values
- Risk/reward ratio
- Volume confirmation (high volume = strong signal, low volume = weak signal)
- A clear BUY/SELL/HOLD recommendation with confidence score (0.0-1.0)

Do NOT give vague analysis. Every statement must reference actual numbers from the data.`,

  EXECUTOR: `You are a trade EXECUTOR bot for paper trading.
When you see a high-confidence signal (>0.8), EXECUTE the trade immediately.
Evaluate: current price vs entry, slippage risk, position sizing (max 10% of capital per trade).
Report executed trades with exact quantities, prices, and reasoning.
Be aggressive in paper trading — the purpose is to learn and test strategies.`,

  RISK_MANAGER: `You are a professional RISK MANAGER bot.
Analyze portfolio positions with quantitative rigor:
- Position sizing: is any single position >15% of portfolio? Flag it.
- Sector concentration: are we overexposed to any sector?
- Drawdown: calculate unrealized loss as % of portfolio. Alert if >5%.
- Correlation risk: multiple positions in same direction in correlated stocks.
- Stop-loss compliance: are all positions within acceptable loss limits?
Give specific numbers and percentages, not vague warnings.`,

  STRATEGIST: `You are an advanced STRATEGIST bot.
Analyze the current market regime and recommend strategy adjustments:
- Is the market trending or range-bound? (use NIFTY data)
- Which sectors are showing relative strength/weakness?
- Should we be more defensive (reduce position sizes, tighter stops)?
- Or more aggressive (larger positions, wider stops for momentum)?
- Specific parameter suggestions with numbers (e.g. "tighten stops to 1.5% from 2%")`,

  MONITOR: `You are a real-time portfolio MONITOR bot.
For each open position, report:
- Current P&L in ₹ and %
- Distance from stop-loss and target
- Whether the trade thesis is still valid based on current price action
- Any positions that need immediate attention (hitting stop, unusual volume)
Use actual prices from the data — never estimate or approximate.`,

  FNO_STRATEGIST: `You are an expert F&O STRATEGIST for Indian derivatives (NSE F&O).
Analyze options chain, IV, OI patterns, PCR, and max pain for actionable strategies.

Your analysis MUST include:
- Current IV percentile and whether options are cheap/expensive
- PCR (Put-Call Ratio) and what it signals about market sentiment
- Max pain level and its significance for the current expiry
- OI build-up analysis: which strikes have highest OI and what it means
- Specific strategy recommendations with exact strikes, lots, premium, max profit, max loss, and breakeven
- Risk/reward ratio for each strategy

Strategies to consider: Iron Condors, Straddles, Strangles, Bull/Bear Spreads, Butterflies, Calendar Spreads.
Give specific strike prices and expiry dates — never be vague.`,
};

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

const ROLLING_WINDOW = 20;
const AUTO_PAUSE_ACCURACY = 0.35;

interface RollingAccuracy {
  outcomes: ('WIN' | 'LOSS' | 'BREAKEVEN')[];
  accuracy: number;
}

export class BotEngine {
  private runningBots = new Map<string, RunningBot>();
  private runningAgents = new Map<string, RunningAgent>();
  private marketData = new MarketDataService();
  private tradeService: TradeService;
  private _rustAvailable: boolean;
  private lastEngineCheck = 0;
  private scannerTimer: ReturnType<typeof setInterval> | null = null;
  private scannerUserId: string | null = null;
  private lastScanResult: MarketScanResult | null = null;
  private scanInProgress = false;
  private _killSwitchActive = false;
  private cycleInProgress = new Set<string>();
  private cycleCandles = new Map<string, any[]>();
  private rollingAccuracy = new Map<string, RollingAccuracy>();
  private tickInterval = DEFAULT_TICK_INTERVAL;
  private signalInterval = DEFAULT_SIGNAL_INTERVAL;
  private marketScanInterval = DEFAULT_MARKET_SCAN_INTERVAL;

  private targetTracker: TargetTracker;
  private globalMarket: GlobalMarketService;
  private decisionAudit: DecisionAuditService;
  private calendar: MarketCalendar;
  private riskService: RiskService;
  private twapExecutor: TWAPExecutor;

  private cachedStrategyParams = new Map<string, Record<string, unknown>>();
  private paramsLastLoaded = 0;

  // Online learning state
  private strategyBeta = new Map<string, { alpha: number; beta: number }>();
  private recentWinRates = new Map<string, { wins: number; total: number; emaWinRate: number }>();
  private intradayVolatility = new Map<string, number>();
  private mlWeights: Record<string, unknown> | null = null;
  private abTestTracker = { rustCorrect: 0, pythonCorrect: 0, total: 0 };

  constructor(private prisma: PrismaClient, oms?: OrderManagementService) {
    this.tradeService = new TradeService(prisma, oms);
    this.targetTracker = new TargetTracker(prisma);
    this.globalMarket = new GlobalMarketService();
    this.decisionAudit = new DecisionAuditService(prisma);
    this.calendar = new MarketCalendar();
    this.riskService = new RiskService(prisma);
    this.twapExecutor = new TWAPExecutor(prisma);
    this.twapExecutor.setTradeService(this.tradeService);
    this._rustAvailable = isEngineAvailable();
    console.log(`[BotEngine] Initialized — Rust engine: ${this._rustAvailable ? 'AVAILABLE' : 'NOT FOUND (using Gemini AI only)'}`);

    this.loadMLWeightsFromDB().catch(err => log.warn({ err }, 'Failed to load ML weights at startup'));
  }

  /**
   * Load trained ML weights from the database (persisted by nightly LearningEngine).
   * Called on startup and can be called externally after morning boot.
   */
  async loadMLWeightsFromDB(userId?: string): Promise<void> {
    try {
      const whereClause: any = { strategyId: 'ml_scorer_weights', isActive: true };
      if (userId) whereClause.userId = userId;

      const weightParam = await this.prisma.strategyParam.findFirst({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
      });

      if (weightParam) {
        const parsed = JSON.parse(weightParam.params);
        if (parsed.w && Array.isArray(parsed.w)) {
          this.mlWeights = parsed;
          log.info({
            weightDim: parsed.w.length,
            version: weightParam.version,
            accuracy: parsed.training_accuracy,
          }, 'ML weights loaded from DB');
        }
      }
    } catch (err) {
      log.warn({ err }, 'Failed to load ML weights from DB');
    }
  }

  private alphaDecayCache = new Map<string, { isDecaying: boolean; ts: number }>();

  /**
   * Thompson sampling: select strategy by sampling from Beta(alpha, beta) posteriors.
   * Applies alpha decay penalty — decaying strategies get 50% score reduction.
   */
  thompsonSelectStrategy(availableStrategies: string[]): string | null {
    if (availableStrategies.length === 0) return null;

    let bestStrategy = availableStrategies[0];
    let bestSample = -1;

    for (const stratId of availableStrategies) {
      const prior = this.strategyBeta.get(stratId) ?? { alpha: 1, beta: 1 };
      const mean = prior.alpha / (prior.alpha + prior.beta);
      const n = prior.alpha + prior.beta;
      const explorationBonus = Math.sqrt(2 * Math.log(n + 1) / (n + 1));
      let sample = mean + explorationBonus;

      // Apply alpha decay penalty from Redis cache
      const decayEntry = this.alphaDecayCache.get(stratId);
      if (decayEntry?.isDecaying) {
        sample *= 0.5;
      }

      if (sample > bestSample) {
        bestSample = sample;
        bestStrategy = stratId;
      }
    }

    return bestStrategy;
  }

  async loadAlphaDecayState(userId: string): Promise<void> {
    try {
      const decayRecords = await this.prisma.alphaDecay.findMany({
        where: { userId },
        orderBy: { date: 'desc' },
        distinct: ['strategyId'],
      });
      for (const d of decayRecords) {
        this.alphaDecayCache.set(d.strategyId, {
          isDecaying: d.isDecaying,
          ts: d.date.getTime(),
        });
      }
      log.info({ userId, strategies: decayRecords.length }, 'Alpha decay state loaded');
    } catch (err) {
      log.warn({ err, userId }, 'Failed to load alpha decay state');
    }
  }

  /**
   * Bayesian update: after a trade outcome, update the Beta distribution for a strategy.
   */
  bayesianUpdate(strategyId: string, won: boolean): void {
    const prior = this.strategyBeta.get(strategyId) ?? { alpha: 1, beta: 1 };
    if (won) {
      prior.alpha += 1;
    } else {
      prior.beta += 1;
    }
    this.strategyBeta.set(strategyId, prior);

    // Also update EMA win rate
    const rates = this.recentWinRates.get(strategyId) ?? { wins: 0, total: 0, emaWinRate: 0.5 };
    rates.total += 1;
    if (won) rates.wins += 1;
    const decay = 0.05; // EMA decay factor
    const outcome = won ? 1.0 : 0.0;
    rates.emaWinRate = rates.emaWinRate * (1 - decay) + outcome * decay;
    this.recentWinRates.set(strategyId, rates);

    log.info({
      strategyId,
      outcome: won ? 'WIN' : 'LOSS',
      alpha: prior.alpha,
      beta: prior.beta,
      emaWinRate: Math.round(rates.emaWinRate * 1000) / 1000,
    }, 'Bayesian update applied');
  }

  /**
   * Compute dynamic stop-loss based on intraday volatility.
   * Widens stops in high-vol conditions, tightens in low-vol.
   */
  computeDynamicStopLoss(symbol: string, baseStopPct: number): number {
    const volMultiplier = this.intradayVolatility.get(symbol) ?? 1.0;
    // Base stop adjusted by volatility: wider in high-vol, tighter in low-vol
    const adjustedStop = baseStopPct * Math.max(0.5, Math.min(2.0, volMultiplier));
    return Math.round(adjustedStop * 100) / 100;
  }

  /**
   * Update intraday volatility estimate for a symbol using latest candle data.
   */
  updateIntradayVolatility(symbol: string, recentReturns: number[]): void {
    if (recentReturns.length < 5) return;
    const mean = recentReturns.reduce((a, b) => a + b, 0) / recentReturns.length;
    const variance = recentReturns.reduce((s, r) => s + (r - mean) ** 2, 0) / recentReturns.length;
    const currentVol = Math.sqrt(variance);

    // Compare to baseline (annualized ~20% vol → daily ~1.26% → 15min ~ 0.14%)
    const baseline = 0.0014;
    const ratio = baseline > 0 ? currentVol / baseline : 1.0;

    const prevRatio = this.intradayVolatility.get(symbol) ?? 1.0;
    const smoothed = prevRatio * 0.7 + ratio * 0.3;
    this.intradayVolatility.set(symbol, smoothed);
  }

  private async loadStrategyParams(userId: string): Promise<Record<string, unknown>> {
    const now = Date.now();
    const cacheKey = userId;
    if (now - this.paramsLastLoaded < 5 * 60_000 && this.cachedStrategyParams.has(cacheKey)) {
      return this.cachedStrategyParams.get(cacheKey)!;
    }

    try {
      const activeParams = await this.prisma.strategyParam.findMany({
        where: { userId, isActive: true },
        select: { strategyId: true, params: true, version: true, source: true },
      });

      const merged: Record<string, unknown> = {};
      for (const p of activeParams) {
        try {
          merged[p.strategyId] = JSON.parse(p.params);
        } catch { /* malformed params, skip */ }
      }

      this.cachedStrategyParams.set(cacheKey, merged);
      this.paramsLastLoaded = now;

      if (Object.keys(merged).length > 0) {
        console.log(`[BotEngine] Loaded ${Object.keys(merged).length} optimized strategy params for user ${userId}`);
      }
      return merged;
    } catch {
      return {};
    }
  }

  private get rustAvailable(): boolean {
    const now = Date.now();
    if (now - this.lastEngineCheck > 30_000) {
      this.lastEngineCheck = now;
      this._rustAvailable = isEngineAvailable();
    }
    return this._rustAvailable;
  }

  refreshRustAvailability(): void {
    this._rustAvailable = isEngineAvailable();
    this.lastEngineCheck = Date.now();
    console.log(`[BotEngine] Rust engine availability refreshed: ${this._rustAvailable}`);
  }

  /**
   * Derive G1-G9 gate scores from Rust engine indicators/votes or from
   * confidence + signal metadata. Ensures the frontend always has G1-G9 keys.
   */
  private deriveGateScores(
    confidence: number,
    indicators?: Record<string, number>,
    votes?: Record<string, number>,
    extra?: Record<string, any>,
  ): Record<string, any> {
    const c = confidence * 100;
    const ind = indicators ?? {};
    const v = votes ?? {};

    // G1 Trend: EMA alignment, SuperTrend, ADX
    const emaCross = v.ema_cross ?? v.ema ?? 0;
    const superTrend = v.supertrend ?? 0;
    const adx = ind.adx ?? 0;
    const g1 = Math.min(100, Math.max(0,
      adx > 0 ? adx + (emaCross > 0 ? 20 : -10) + (superTrend > 0 ? 15 : -5)
              : c + (emaCross > 0 ? 10 : -10)));

    // G2 Momentum: RSI, MACD, Stochastic
    const rsi = ind.rsi ?? 50;
    const macdVote = v.macd ?? 0;
    const g2 = Math.min(100, Math.max(0,
      (rsi > 50 ? rsi - 10 : 100 - rsi - 10) + (macdVote > 0 ? 25 : macdVote < 0 ? -10 : 5)));

    // G3 Volatility: ATR, Bollinger, VIX
    const atr = ind.atr ?? 0;
    const vix = ind.vix ?? 15;
    const bbVote = v.bollinger ?? 0;
    const g3 = Math.min(100, Math.max(0,
      vix < 20 ? 70 + (bbVote > 0 ? 15 : -5) : vix < 30 ? 50 : 30));

    // G4 Volume: volume confirmation
    const volVote = v.volume ?? 0;
    const g4 = Math.min(100, Math.max(0, c * 0.6 + (volVote > 0 ? 30 : volVote < 0 ? -10 : 10)));

    // G5 Options Flow: derived from OI data if available
    const g5 = Math.min(100, Math.max(0, extra?.optionsFlow ?? c * 0.5 + 20));

    // G6 Global Macro: VIX-based proxy
    const g6 = Math.min(100, Math.max(0, vix < 15 ? 80 : vix < 20 ? 65 : vix < 25 ? 50 : 35));

    // G7 FII/DII: proxy from market breadth
    const g7 = Math.min(100, Math.max(0, extra?.fiiDii ?? c * 0.5 + 25));

    // G8 Sentiment: composite of multiple votes
    const totalVotes = Object.values(v).reduce((s, x) => s + (x > 0 ? 1 : 0), 0);
    const totalKeys = Math.max(1, Object.keys(v).length);
    const g8 = Math.min(100, Math.max(0, (totalVotes / totalKeys) * 80 + 10));

    // G9 Risk: risk-reward quality
    const g9 = Math.min(100, Math.max(0, c * 0.8 + (extra?.riskReward ? 15 : 5)));

    return {
      ...(extra?.source ? { source: extra.source } : {}),
      g1_trend: Math.round(g1),
      g2_momentum: Math.round(g2),
      g3_volatility: Math.round(g3),
      g4_volume: Math.round(g4),
      g5_options_flow: Math.round(g5),
      g6_global_macro: Math.round(g6),
      g7_fii_dii: Math.round(g7),
      g8_sentiment: Math.round(g8),
      g9_risk: Math.round(g9),
      ...(indicators ? { indicators } : {}),
      ...(votes ? { votes } : {}),
    };
  }

  getRollingAccuracy(strategyId: string): RollingAccuracy | undefined {
    return this.rollingAccuracy.get(strategyId);
  }

  private trackOutcome(strategyId: string, outcome: 'WIN' | 'LOSS' | 'BREAKEVEN'): number {
    let entry = this.rollingAccuracy.get(strategyId);
    if (!entry) {
      entry = { outcomes: [], accuracy: 0 };
      this.rollingAccuracy.set(strategyId, entry);
    }
    entry.outcomes.push(outcome);
    if (entry.outcomes.length > ROLLING_WINDOW) {
      entry.outcomes.shift();
    }
    const wins = entry.outcomes.filter(o => o === 'WIN').length;
    entry.accuracy = entry.outcomes.length > 0 ? wins / entry.outcomes.length : 0;
    return entry.accuracy;
  }

  private async checkAutoPause(userId: string, strategyId: string, botId?: string): Promise<boolean> {
    const entry = this.rollingAccuracy.get(strategyId);
    if (!entry || entry.outcomes.length < 5) return false;

    if (entry.accuracy < AUTO_PAUSE_ACCURACY) {
      if (botId) {
        const bot = await this.prisma.tradingBot.findUnique({ where: { id: botId } });
        if (bot && bot.status === 'RUNNING') {
          await this.prisma.tradingBot.update({
            where: { id: botId },
            data: {
              status: 'IDLE',
              lastAction: `Auto-paused: ${strategyId} rolling accuracy ${(entry.accuracy * 100).toFixed(0)}% < ${AUTO_PAUSE_ACCURACY * 100}% threshold`,
              lastActionAt: new Date(),
            },
          });
          this.stopBot(botId);

          await this.prisma.botMessage.create({
            data: {
              fromBotId: botId,
              userId,
              messageType: 'alert',
              content: `⚠️ Strategy **${strategyId}** auto-paused. Rolling accuracy: ${(entry.accuracy * 100).toFixed(0)}% (last ${entry.outcomes.length} trades). Threshold: ${AUTO_PAUSE_ACCURACY * 100}%.`,
            },
          });
          return true;
        }
      }
    }
    return false;
  }

  getLastScanResult(): MarketScanResult | null {
    return this.lastScanResult;
  }

  isScannerRunning(): boolean {
    return this.scannerTimer !== null;
  }

  getRunningBotCount(): number {
    return this.runningBots.size;
  }

  async startBot(botId: string, userId: string): Promise<void> {
    if (this.runningBots.has(botId)) return;
    if (this.runningBots.size >= MAX_CONCURRENT_BOTS) {
      const oldest = this.runningBots.keys().next().value;
      if (oldest) this.stopBot(oldest);
    }

    const botIndex = this.runningBots.size;
    const staggerMs = botIndex * 30_000 + 10_000;

    console.log(`[BotEngine] Starting bot ${botId} (stagger: ${staggerMs}ms, tick: ${this.tickInterval}ms)`);

    this.loadAlphaDecayState(userId).catch(err => log.warn({ err, userId }, 'Failed to load alpha decay state'));

    setTimeout(() => {
      this.runBotCycle(botId, userId).catch(err => {
        console.error(`[BotEngine] Initial cycle failed for bot ${botId}:`, (err as Error).message);
      });
    }, staggerMs);

    const timer = setInterval(() => {
      if (!this.cycleInProgress.has(botId)) {
        this.runBotCycle(botId, userId).catch(err => {
          console.error(`[BotEngine] Cycle failed for bot ${botId}:`, (err as Error).message);
        });
      }
    }, this.tickInterval);

    this.runningBots.set(botId, { botId, userId, timer });
  }

  stopBot(botId: string): void {
    const entry = this.runningBots.get(botId);
    if (entry) {
      clearInterval(entry.timer);
      this.runningBots.delete(botId);
      this.cycleInProgress.delete(botId);
    }
  }

  async startAgent(userId: string): Promise<void> {
    if (this.runningAgents.has(userId)) return;

    console.log(`[BotEngine] Starting agent for user ${userId} (interval: ${this.signalInterval}ms)`);

    setTimeout(() => {
      this.runAgentCycle(userId).catch(err => {
        console.error(`[BotEngine] Initial agent cycle failed:`, (err as Error).message);
      });
    }, 20_000);

    const timer = setInterval(() => {
      this.runAgentCycle(userId).catch(err => {
        console.error(`[BotEngine] Agent cycle failed:`, (err as Error).message);
      });
    }, this.signalInterval);

    this.runningAgents.set(userId, { userId, timer });
  }

  stopAgent(userId: string): void {
    const entry = this.runningAgents.get(userId);
    if (entry) {
      clearInterval(entry.timer);
      this.runningAgents.delete(userId);
    }
  }

  stopAll(): void {
    for (const [id] of this.runningBots) this.stopBot(id);
    for (const [id] of this.runningAgents) this.stopAgent(id);
    this.stopMarketScan();
  }

  get killSwitchActive(): boolean { return this._killSwitchActive; }

  activateKillSwitch(): void {
    this._killSwitchActive = true;
    this.stopAll();
    log.fatal('KILL SWITCH ACTIVATED — all trading halted');
  }

  deactivateKillSwitch(): void {
    this._killSwitchActive = false;
    log.warn('Kill switch deactivated — trading re-enabled');
  }

  private async detectCurrentRegime(
    candleData: Array<{ symbol: string; candles: any[] }>,
  ): Promise<string | null> {
    try {
      if (candleData.length === 0 || candleData[0].candles.length < 20) return null;
      const closes = candleData[0].candles.map((c: any) => c.close);

      const shortEma = this.calcSimpleEma(closes, 10);
      const longEma = this.calcSimpleEma(closes, 30);
      const returns = closes.slice(1).map((c: number, i: number) => (c - closes[i]) / closes[i]);
      const volatility = Math.sqrt(returns.reduce((s: number, r: number) => s + r * r, 0) / returns.length) * Math.sqrt(252);

      const trend = shortEma > longEma ? 'up' : 'down';
      const trendStrength = Math.abs(shortEma - longEma) / longEma;

      if (volatility > 0.30) return 'volatile';
      if (trendStrength > 0.02 && trend === 'up') return 'trending';
      if (trendStrength > 0.02 && trend === 'down') return 'trending';
      if (volatility < 0.12) return 'low_vol';
      return 'mean_reverting';
    } catch {
      return null;
    }
  }

  private calcSimpleEma(data: number[], period: number): number {
    if (data.length === 0) return 0;
    const k = 2 / (period + 1);
    let ema = data[0];
    for (let i = 1; i < data.length; i++) {
      ema = data[i] * k + ema * (1 - k);
    }
    return ema;
  }

  async startMarketScan(userId: string): Promise<void> {
    if (this.scannerTimer) return;
    this.scannerUserId = userId;

    // Delay first scan by 30s
    setTimeout(() => {
      this.runMarketScan(userId).catch(err => log.error({ err, userId }, 'Market scan failed'));
    }, 30_000);

    this.scannerTimer = setInterval(() => {
      this.runMarketScan(userId).catch(err => log.error({ err, userId }, 'Market scan failed'));
    }, this.marketScanInterval);
  }

  stopMarketScan(): void {
    if (this.scannerTimer) {
      clearInterval(this.scannerTimer);
      this.scannerTimer = null;
      this.scannerUserId = null;
    }
  }

  setTickInterval(ms: number): void {
    if (ms <= 0) return;
    this.tickInterval = ms;
    // Restart running bots with new interval
    const entries = [...this.runningBots.entries()];
    for (const [botId, entry] of entries) {
      clearInterval(entry.timer);
      const timer = setInterval(() => {
        if (!this.cycleInProgress.has(botId)) {
          this.runBotCycle(botId, entry.userId).catch(err => log.error({ err, botId }, 'Bot cycle failed'));
        }
      }, this.tickInterval);
      this.runningBots.set(botId, { ...entry, timer });
    }
    if (entries.length > 0) {
      console.log(`[BotEngine] Tick interval updated to ${ms}ms for ${entries.length} bots`);
    }
  }

  setMarketScanInterval(ms: number): void {
    if (ms <= 0) return;
    this.marketScanInterval = ms;
    if (this.scannerTimer && this.scannerUserId) {
      clearInterval(this.scannerTimer);
      const userId = this.scannerUserId;
      this.scannerTimer = setInterval(() => {
        this.runMarketScan(userId).catch(err => log.error({ err, userId }, 'Market scan failed'));
      }, this.marketScanInterval);
      console.log(`[BotEngine] Market scan interval updated to ${ms}ms`);
    }
  }

  getActiveBotCount(): number {
    return this.runningBots.size;
  }

  getActiveAgentCount(): number {
    return this.runningAgents.size;
  }

  isRunning(): boolean {
    return this.runningBots.size > 0 || this.runningAgents.size > 0 || this.scannerTimer !== null;
  }

  private async runMarketScan(userId: string): Promise<void> {
    if (this.scanInProgress) return;

    // STRICT: No scanning outside market hours
    if (!this.calendar.isMarketOpen()) return;

    this.scanInProgress = true;

    const start = Date.now();
    try {
      const { gainers, losers } = await this.marketData.getTopMovers(15);

      if (gainers.length === 0 && losers.length === 0) {
        this.scanInProgress = false;
        return;
      }

      const allMovers = [
        ...gainers.map(m => ({ ...m, moverType: 'gainer' as const })),
        ...losers.map(m => ({ ...m, moverType: 'loser' as const })),
      ];

      const uniqueSymbols = [...new Map(allMovers.map(m => [m.symbol, m])).values()];
      const moverMap = new Map(uniqueSymbols.map(m => [m.symbol, m]));

      let signals: MarketScanSignal[] = [];

      if (this.rustAvailable) {
        // --- Rust engine path ---
        const candleData: Array<{
          symbol: string;
          candles: Array<{ close: number; high: number; low: number; volume: number }>;
          mover: typeof uniqueSymbols[0];
        }> = [];

        const now = new Date();
        const toDate = now.toISOString().split('T')[0];
        const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
        const fromDate = twoDaysAgo.toISOString().split('T')[0];

        for (const mover of uniqueSymbols.slice(0, MAX_CANDLE_SYMBOLS * 2)) {
          try {
            const bars = await this.marketData.getHistory(
              mover.symbol, '5m', fromDate, toDate, userId,
            );
            if (bars.length >= 26) {
              candleData.push({
                symbol: mover.symbol,
                candles: bars.slice(-50).map(b => ({
                  close: b.close, high: b.high, low: b.low, volume: b.volume,
                })),
                mover,
              });
            }
          } catch { /* skip */ }
        }

        if (candleData.length > 0) {
          const scanInput = candleData.map(d => ({ symbol: d.symbol, candles: d.candles }));
          let rustSignals: ScanSignal[] = [];
          try {
            const result = await engineScan({ symbols: scanInput, aggressiveness: 'high' });
            rustSignals = result.signals ?? [];
          } catch { /* scan failed */ }

          signals = rustSignals.map(sig => {
            const mover = moverMap.get(sig.symbol);
            return {
              symbol: sig.symbol,
              name: mover?.name ?? sig.symbol,
              direction: sig.direction,
              confidence: sig.confidence,
              ltp: mover?.ltp ?? sig.entry,
              changePercent: mover?.changePercent ?? 0,
              entry: sig.entry,
              stopLoss: sig.stop_loss,
              target: sig.target,
              indicators: sig.indicators,
              votes: sig.votes,
              moverType: (mover as any)?.moverType ?? 'gainer',
            };
          });
        }
      }

      // --- GPT fallback: runs when Rust is unavailable OR Rust produced no signals ---
      if (signals.length === 0 && uniqueSymbols.length > 0) {
        try {
          const topMovers = uniqueSymbols.slice(0, 15);
          const moverSummary = topMovers.map(m => {
            const dayRange = m.high > 0 ? `Range: ₹${m.low.toFixed(2)}-₹${m.high.toFixed(2)}` : '';
            const volStr = m.volume > 0 ? `Vol: ${(m.volume / 100000).toFixed(1)}L` : '';
            return `${m.symbol} (${(m as any).moverType}): ₹${m.ltp.toFixed(2)} (${m.changePercent >= 0 ? '+' : ''}${m.changePercent.toFixed(1)}%) | Open: ₹${m.open.toFixed(2)} | PrevClose: ₹${m.previousClose.toFixed(2)} | ${dayRange} | ${volStr}`;
          }).join('\n');

          const gptResult = await chatCompletionJSON<{
            signals: Array<{
              symbol: string;
              direction: 'BUY' | 'SELL';
              confidence: number;
              entry: number;
              stopLoss: number;
              target: number;
              reason: string;
            }>;
          }>({
            messages: [
              { role: 'system', content: `You are a professional market scanner for Indian equities (NSE).
Analyze the top movers and generate 3-5 actionable trade signals with precise price levels.

For each signal, you MUST provide:
- entry: the exact price to enter (use current LTP or a level nearby)
- stopLoss: a specific price level (typically 1-2% from entry for intraday)
- target: a specific price level (minimum 1:1.5 risk/reward ratio)
- reason: a technical reason referencing actual prices and patterns from the data

Rules:
- In a falling market, generate MORE SELL/SHORT signals
- In a rising market, generate MORE BUY signals
- Use the actual OHLC data to set stop-loss at previous support/resistance
- Calculate risk/reward: (target-entry)/(entry-stopLoss) should be >= 1.5
- This is paper trading — be aggressive, generate at least 3 signals

Respond in JSON: {"signals": [{"symbol":"X","direction":"BUY|SELL","confidence":0.0-1.0,"entry":price,"stopLoss":price,"target":price,"reason":"specific technical reason"}]}
IMPORTANT: Keep each reason under 30 words. Return at most 5 signals. No extra text outside JSON.` },
              { role: 'user', content: `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\nTop Movers:\n${moverSummary}\n\nGenerate detailed trade signals with entry, stop-loss, and target prices.` },
            ],
            temperature: 0.3,
            maxTokens: 4096,
          });

          if (gptResult.signals) {
            for (const sig of gptResult.signals) {
              if (sig.confidence < 0.6) continue;
              const mover = moverMap.get(sig.symbol);
              signals.push({
                symbol: sig.symbol,
                name: mover?.name ?? sig.symbol,
                direction: sig.direction,
                confidence: sig.confidence,
                ltp: mover?.ltp ?? sig.entry,
                changePercent: mover?.changePercent ?? 0,
                entry: sig.entry,
                stopLoss: sig.stopLoss,
                target: sig.target,
                indicators: {},
                votes: {},
                moverType: (mover as any)?.moverType ?? 'gainer',
              });
            }
          }
        } catch {
          /* GPT scan failed — will retry next cycle */
        }
      }

      // Enrich scan signals with VIX context when available
      try {
        const vixData = await this.marketData.getVIX().catch(() => null);
        if (vixData?.value) {
          for (const sig of signals) {
            sig.indicators = { ...sig.indicators, vix: vixData.value };
          }
        }
      } catch { /* skip enrichment */ }

      // Dynamic stop-loss: adjust based on intraday volatility
      for (const sig of signals) {
        if (sig.entry > 0 && sig.stopLoss > 0) {
          const baseStopPct = Math.abs(sig.entry - sig.stopLoss) / sig.entry * 100;
          const adjustedPct = this.computeDynamicStopLoss(sig.symbol, baseStopPct);
          if (adjustedPct !== baseStopPct) {
            sig.stopLoss = sig.direction === 'BUY'
              ? sig.entry * (1 - adjustedPct / 100)
              : sig.entry * (1 + adjustedPct / 100);
            sig.stopLoss = Math.round(sig.stopLoss * 100) / 100;
          }
        }
      }

      // Store high-confidence signals in the database
      for (const sig of signals.filter(s => s.confidence >= 0.65)) {
        try {
          const scanGateScores = this.deriveGateScores(
            sig.confidence, sig.indicators, sig.votes,
            { source: this.rustAvailable ? 'market-scanner' : 'gpt-market-scanner' },
          );
          await this.prisma.aITradeSignal.create({
            data: {
              userId,
              symbol: sig.symbol,
              signalType: sig.direction,
              compositeScore: sig.confidence,
              gateScores: JSON.stringify(scanGateScores),
              rationale: `Market Scan: ${sig.direction} ${sig.symbol} (${sig.moverType}) @ ₹${sig.entry} | Change: ${sig.changePercent.toFixed(1)}% | SL: ₹${sig.stopLoss} | Target: ₹${sig.target} | Confidence: ${(sig.confidence * 100).toFixed(0)}%`,
              status: 'PENDING',
              expiresAt: new Date(Date.now() + 2 * 60 * 60_000),
            },
          });
        } catch { /* duplicate or DB error */ }
      }

      this.lastScanResult = {
        timestamp: new Date().toISOString(),
        scannedCount: uniqueSymbols.length,
        signals: signals.sort((a, b) => b.confidence - a.confidence).slice(0, 20),
        topGainers: gainers.slice(0, 10),
        topLosers: losers.slice(0, 10),
        scanDurationMs: Date.now() - start,
      };
    } catch {
      /* scan cycle failed — will retry */
    } finally {
      this.scanInProgress = false;
    }
  }

  private async executeTrade(
    userId: string,
    symbol: string,
    direction: 'BUY' | 'SELL',
    rationale: string,
    botId?: string,
    signalMeta?: { confidence?: number; indicators?: string; ltp?: number; signalSource?: string },
  ): Promise<{ success: boolean; message: string }> {
    try {
      if (this._killSwitchActive) {
        return { success: false, message: 'KILL SWITCH ACTIVE — all trading halted' };
      }

      const exchange = this.detectExchange(symbol);
      if (!this.calendar.isMarketOpen(exchange)) {
        console.log(`[BotEngine] BLOCKED: ${direction} ${symbol} — market closed`);
        return { success: false, message: `Market is closed. Bot orders blocked outside trading hours.` };
      }

      const portfolio = await this.prisma.portfolio.findFirst({ where: { userId } });
      if (!portfolio) return { success: false, message: 'No portfolio found' };

      const nav = Number(portfolio.currentNav);

      // Record the decision in audit trail, enriched with vote data for the learning loop
      let auditId: string | undefined;
      const parsedIndicators = signalMeta?.indicators ? (() => {
        try { return JSON.parse(signalMeta.indicators); } catch { return {}; }
      })() : {};

      try {
        auditId = await this.decisionAudit.recordDecision({
          userId,
          botId,
          symbol,
          decisionType: 'ENTRY_SIGNAL',
          direction: direction === 'BUY' ? 'LONG' : 'SHORT',
          confidence: signalMeta?.confidence ?? 0.5,
          signalSource: signalMeta?.signalSource ?? (this.rustAvailable ? 'RUST+AI' : 'AI'),
          marketDataSnapshot: {
            ltp: signalMeta?.ltp,
            indicators: signalMeta?.indicators,
            nav,
            // Preserve vote decomposition for Feature Store → Model Training loop
            ema_vote: parsedIndicators.ema_crossover ?? parsedIndicators.ema ?? 0,
            rsi_vote: parsedIndicators.rsi ?? 0,
            macd_vote: parsedIndicators.macd ?? 0,
            supertrend_vote: parsedIndicators.supertrend ?? 0,
            bollinger_vote: parsedIndicators.bollinger ?? 0,
            vwap_vote: parsedIndicators.vwap ?? 0,
            momentum_vote: parsedIndicators.momentum ?? 0,
            volume_vote: parsedIndicators.volume ?? 0,
          },
          reasoning: rationale,
        });
      } catch { /* audit best-effort */ }

      if (direction === 'BUY') {
        let ltp = 0;
        try {
          const quote = await this.marketData.getQuote(symbol, exchange);
          ltp = quote.ltp;
        } catch { /* will be fetched by TradeService */ }

        const kellyAllocation = await this.computeKellySize(userId, symbol, nav);
        const maxPerTrade = nav * kellyAllocation;
        const qty = ltp > 0 ? Math.max(1, Math.floor(maxPerTrade / ltp)) : 1;

        // Enforce all risk limits before placing the order
        const riskCheck = await this.riskService.preTradeCheck(userId, symbol, 'BUY', qty, ltp > 0 ? ltp : nav * kellyAllocation);
        if (!riskCheck.allowed) {
          const msg = `RISK BLOCKED: ${riskCheck.violations.join('; ')}`;
          console.log(`[BotEngine] ${msg}`);
          if (auditId) {
            try { await this.decisionAudit.resolveDecision(auditId, { exitPrice: 0, pnl: 0, predictionAccuracy: 0, outcomeNotes: msg }); } catch {}
          }
          return { success: false, message: msg };
        }
        if (riskCheck.warnings.length > 0) {
          log.warn({ warnings: riskCheck.warnings }, 'Risk warnings');
        }

        const orderTypeDecision = selectOrderType({
          qty,
          ltp: ltp > 0 ? ltp : nav * kellyAllocation,
          avgDailyVolume: 500_000,
          confidence: signalMeta?.confidence ?? 0.5,
          spreadPct: 0.05,
        });
        log.info({ symbol, orderType: orderTypeDecision.orderType, reason: orderTypeDecision.reason }, 'Order type selected');

        if ((orderTypeDecision.orderType === 'TWAP' || orderTypeDecision.orderType === 'VWAP') && qty > 10) {
          const execFn = orderTypeDecision.orderType === 'VWAP'
            ? this.twapExecutor.executeVWAP.bind(this.twapExecutor)
            : this.twapExecutor.executeTWAP.bind(this.twapExecutor);
          const twapResult = await execFn({
            totalQty: qty, numSlices: Math.min(5, qty),
            durationMinutes: 10, maxDeviationPct: 1.0,
            symbol, side: 'BUY', exchange,
            portfolioId: portfolio.id, userId, strategyTag: 'AI-BOT',
          });

          if (botId) await this.updateBotTradeStats(botId, 0);
          return { success: true, message: `TWAP: Bought ${twapResult.totalFilled} ${symbol} @ avg ₹${twapResult.avgFillPrice.toFixed(2)} (slippage: ${twapResult.slippageBps}bps)` };
        }

        const order = await this.tradeService.placeOrder(userId, {
          portfolioId: portfolio.id,
          symbol,
          side: 'BUY',
          orderType: orderTypeDecision.orderType === 'LIMIT' ? 'LIMIT' : 'MARKET',
          qty,
          price: orderTypeDecision.orderType === 'LIMIT' && ltp > 0 ? Number((ltp * 1.001).toFixed(2)) : undefined,
          instrumentToken: symbol,
          exchange,
          strategyTag: 'AI-BOT',
        });

        if (botId) {
          await this.updateBotTradeStats(botId, 0);
        }

        return { success: true, message: `Bought ${qty} ${symbol} @ ₹${Number(order.avgFillPrice ?? 0).toFixed(2)}` };
      } else {
        // Check for existing LONG position to close
        const longPosition = await this.prisma.position.findFirst({
          where: { portfolioId: portfolio.id, symbol, side: 'LONG', status: 'OPEN' },
        });

        if (longPosition) {
          let exitPrice = 0;
          try {
            const quote = await this.marketData.getQuote(symbol, exchange);
            exitPrice = quote.ltp;
          } catch { /* will be fetched by closePosition */ }

          if (exitPrice <= 0) return { success: false, message: `Cannot sell ${symbol}: no price available` };

          const exitResult = await ExitCoordinator.closePosition({
            positionId: longPosition.id,
            userId,
            exitPrice,
            reason: `Bot SELL signal for ${symbol}`,
            source: 'BOT_ENGINE',
            decisionType: 'EXIT_SIGNAL',
            prisma: this.prisma,
            tradeService: this.tradeService,
            decisionAudit: this.decisionAudit,
            extraSnapshot: { botId, aggressiveness: 'MODERATE' },
          });

          if (!exitResult.success) {
            return { success: false, message: exitResult.error ?? 'Exit failed' };
          }
          const pnl = exitResult.pnl ?? 0;

          if (botId) {
            await this.updateBotTradeStats(botId, pnl);
          }

          const strategyTag = longPosition.strategyTag || 'AI-BOT';
          const outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' = Math.abs(pnl) < 10 ? 'BREAKEVEN' : pnl > 0 ? 'WIN' : 'LOSS';
          const accuracy = this.trackOutcome(strategyTag, outcome);

          // Bayesian update for Thompson sampling
          this.bayesianUpdate(strategyTag, outcome === 'WIN');

          try {
            const signal = await this.prisma.aITradeSignal.findFirst({
              where: { userId, symbol, status: 'EXECUTED', outcomeTag: null },
              orderBy: { createdAt: 'desc' },
            });
            if (signal) {
              await this.prisma.aITradeSignal.update({
                where: { id: signal.id },
                data: { outcomeTag: outcome, outcomeNotes: `PnL: ₹${pnl.toFixed(2)} | Rolling accuracy: ${(accuracy * 100).toFixed(0)}%` },
              });
            }
          } catch { /* best effort signal tagging */ }

          if (botId) {
            await this.checkAutoPause(userId, strategyTag, botId);
          }

          // Resolve the decision audit with outcome
          if (auditId) {
            try {
              await this.decisionAudit.resolveDecision(auditId, {
                exitPrice,
                pnl,
                predictionAccuracy: outcome === 'WIN' ? 1 : outcome === 'LOSS' ? 0 : 0.5,
                outcomeNotes: `${outcome}: P&L ₹${pnl.toFixed(2)} | ${rationale}`,
              });
            } catch { /* audit best-effort */ }
          }

          return { success: true, message: `Sold ${longPosition.qty} ${symbol} @ ₹${exitPrice.toFixed(2)} | P&L: ₹${pnl.toFixed(2)}` };
        }

        // No LONG position -- open a SHORT via placeOrder
        let ltp = 0;
        try {
          const quote = await this.marketData.getQuote(symbol, exchange);
          ltp = quote.ltp;
        } catch { /* will be fetched by TradeService */ }

        if (ltp <= 0) return { success: false, message: `Cannot short ${symbol}: no price available` };

        const kellyAllocation = await this.computeKellySize(userId, symbol, nav);
        const maxPerTrade = nav * kellyAllocation;
        const qty = Math.max(1, Math.floor(maxPerTrade / ltp));

        const sellRiskCheck = await this.riskService.preTradeCheck(userId, symbol, 'SELL', qty, ltp);
        if (!sellRiskCheck.allowed) {
          const msg = `RISK BLOCKED SHORT: ${sellRiskCheck.violations.join('; ')}`;
          log.info({ symbol, violations: sellRiskCheck.violations }, msg);
          if (auditId) {
            try { await this.decisionAudit.resolveDecision(auditId, { exitPrice: 0, pnl: 0, predictionAccuracy: 0, outcomeNotes: msg }); } catch {}
          }
          return { success: false, message: msg };
        }

        const order = await this.tradeService.placeOrder(userId, {
          portfolioId: portfolio.id,
          symbol,
          side: 'SELL',
          orderType: 'MARKET',
          qty,
          instrumentToken: symbol,
          exchange,
          strategyTag: 'AI-BOT',
        });

        if (botId) {
          await this.updateBotTradeStats(botId, 0);
        }

        return { success: true, message: `Shorted ${qty} ${symbol} @ ₹${Number(order.avgFillPrice ?? 0).toFixed(2)}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);

      // Record blocked decisions in audit trail
      if (msg.includes('Risk') || msg.includes('capital') || msg.includes('Market is closed') || msg.includes('STRICT')) {
        try {
          await this.decisionAudit.recordDecision({
            userId,
            botId,
            symbol,
            decisionType: 'RISK_BLOCK',
            direction: direction === 'BUY' ? 'LONG' : 'SHORT',
            confidence: signalMeta?.confidence ?? 0,
            signalSource: signalMeta?.signalSource ?? 'BOT',
            marketDataSnapshot: { ltp: signalMeta?.ltp },
            reasoning: `BLOCKED: ${msg}`,
          });
        } catch { /* audit best-effort */ }
      }

      return { success: false, message: msg };
    }
  }

  private async executeMultiLegStrategy(
    userId: string,
    symbol: string,
    strategyName: string,
    legs: { type: string; strike: number; action: string; qty?: number }[],
    botId?: string,
  ): Promise<{ success: boolean; message: string }> {
    try {
      const portfolio = await this.prisma.portfolio.findFirst({ where: { userId } });
      if (!portfolio) return { success: false, message: 'No portfolio found' };

      const tag = `BOT:${strategyName}`;
      let filled = 0;
      let failed = 0;

      // Get lot size for the underlying
      const lotSize = await this.getLotSizeForSymbol(symbol);

      for (const leg of legs) {
        const qty = (leg.qty || 1) * lotSize;
        const optSymbol = `${symbol}${leg.strike}${leg.type}`;
        try {
          await this.tradeService.placeOrder(userId, {
            portfolioId: portfolio.id,
            symbol: optSymbol,
            side: leg.action as 'BUY' | 'SELL',
            orderType: 'MARKET',
            qty,
            instrumentToken: `${symbol}-NFO-${leg.strike}-${leg.type}`,
            exchange: 'NFO',
            strategyTag: tag,
          });
          filled++;
        } catch {
          failed++;
        }
      }

      if (botId) {
        await this.updateBotTradeStats(botId, 0);
      }

      if (failed === 0) {
        return { success: true, message: `${strategyName}: ${filled} legs placed for ${symbol}` };
      }
      return { success: filled > 0, message: `${strategyName}: ${filled} filled, ${failed} failed` };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg };
    }
  }

  private async getLotSizeForSymbol(symbol: string): Promise<number> {
    try {
      const res = await fetch(`${env.BREEZE_BRIDGE_URL}/lot-size/${encodeURIComponent(symbol)}`, {
        signal: AbortSignal.timeout(5_000),
      });
      if (res.ok) {
        const data = await res.json() as any;
        if (data.lotSize > 0) return data.lotSize;
      }
    } catch { /* fallback */ }
    const defaults: Record<string, number> = { NIFTY: 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120 };
    return defaults[symbol.toUpperCase()] || 50;
  }

  private detectExchange(symbol: string): string {
    const mcxSymbols = ['GOLD', 'GOLDM', 'GOLDPETAL', 'SILVER', 'SILVERM', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL', 'COTTON', 'MENTHAOIL', 'CASTORSEED'];
    const cdsSymbols = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR', 'AUDINR', 'CADINR', 'CHFINR', 'SGDINR', 'HKDINR', 'CNHINR'];
    const upper = symbol.toUpperCase();
    if (mcxSymbols.includes(upper)) return 'MCX';
    if (cdsSymbols.includes(upper)) return 'CDS';
    return 'NSE';
  }

  private cachedAllocations: Record<string, number> | null = null;
  private allocationsLastLoaded = 0;

  private async computeKellySize(userId: string, symbol: string, nav: number, strategyTag?: string): Promise<number> {
    try {
      // Check persisted strategy allocations from nightly optimization
      const now = Date.now();
      if (!this.cachedAllocations || now - this.allocationsLastLoaded > 30 * 60_000) {
        try {
          const allocParam = await this.prisma.strategyParam.findFirst({
            where: { userId, strategyId: 'strategy_allocations', isActive: true },
            orderBy: { createdAt: 'desc' },
          });
          if (allocParam) {
            const parsed = JSON.parse(allocParam.params);
            const allocMap: Record<string, number> = {};
            for (const a of (parsed.allocations ?? [])) {
              allocMap[a.strategy_id] = (a.allocation_pct / 100);
            }
            this.cachedAllocations = allocMap;
          }
        } catch { /* use Kelly fallback */ }
        this.allocationsLastLoaded = now;
      }

      // If we have an allocation for this strategy, use it as the cap
      let allocationCap = 0.15;
      if (strategyTag && this.cachedAllocations?.[strategyTag]) {
        allocationCap = this.cachedAllocations[strategyTag];
      }

      const recentTrades = await this.prisma.trade.findMany({
        where: { portfolio: { userId }, symbol },
        orderBy: { exitTime: 'desc' },
        take: 30,
      });

      if (recentTrades.length < 5) {
        return Math.min(0.05, allocationCap);
      }

      const wins = recentTrades.filter(t => Number(t.netPnl) > 0);
      const losses = recentTrades.filter(t => Number(t.netPnl) < 0);
      const winRate = wins.length / recentTrades.length;
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + Number(t.netPnl), 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + Number(t.netPnl), 0) / losses.length) : 1;
      const wlRatio = avgLoss > 0 ? avgWin / avgLoss : 1;

      const kelly = winRate - (1 - winRate) / wlRatio;
      const halfKelly = kelly / 2;

      return Math.max(0.02, Math.min(allocationCap, halfKelly));
    } catch {
      return 0.05;
    }
  }

  private async updateBotTradeStats(botId: string, pnl: number): Promise<void> {
    try {
      const bot = await this.prisma.tradingBot.findUnique({ where: { id: botId } });
      if (!bot) return;

      const newTotal = (bot.totalTrades || 0) + 1;
      const oldPnl = Number(bot.totalPnl || 0);
      const newPnl = oldPnl + pnl;

      const wins = pnl > 0 ? 1 : 0;
      const oldWinCount = Math.round(Number(bot.winRate || 0) / 100 * (bot.totalTrades || 0));
      const newWinRate = newTotal > 0 ? ((oldWinCount + wins) / newTotal) * 100 : 0;

      await this.prisma.tradingBot.update({
        where: { id: botId },
        data: {
          totalTrades: newTotal,
          totalPnl: newPnl,
          winRate: newWinRate,
          usedCapital: { increment: Math.abs(pnl) > 0 ? Math.abs(pnl) : 0 },
        },
      });
    } catch { /* best effort */ }
  }

  // ---- Fetch 50 candles (5-min interval) for a list of symbols ----
  private async fetchCandles(
    symbols: string[],
    userId: string,
  ): Promise<Array<{ symbol: string; candles: Array<{ close: number; high: number; low: number; volume: number }> }>> {
    const now = new Date();
    const toDate = now.toISOString().split('T')[0];
    const twoDaysAgo = new Date(now.getTime() - 2 * 86_400_000);
    const fromDate = twoDaysAgo.toISOString().split('T')[0];

    const results: Array<{ symbol: string; candles: Array<{ close: number; high: number; low: number; volume: number }> }> = [];

    for (const sym of symbols.slice(0, MAX_CANDLE_SYMBOLS)) {
      try {
        const bars = await this.marketData.getHistory(sym, '5m', fromDate, toDate, userId);
        if (bars.length >= 26) {
          const last50 = bars.slice(-50);
          results.push({
            symbol: sym,
            candles: last50.map(b => ({
              close: b.close,
              high: b.high,
              low: b.low,
              volume: b.volume,
            })),
          });
        } else {
          console.log(`[BotEngine] fetchCandles: ${sym} returned only ${bars.length} bars (need 26+)`);
        }
      } catch (err) {
        console.log(`[BotEngine] fetchCandles: ${sym} failed — ${(err as Error).message}`);
      }
    }

    return results;
  }

  // ---- Rust-first bot cycle ----
  private async runBotCycle(botId: string, userId: string): Promise<void> {
    if (this.cycleInProgress.has(botId)) return;
    this.cycleInProgress.add(botId);
    try {
      // STRICT: No bot cycles outside market hours
      if (!this.calendar.isMarketOpen()) {
        console.log(`[BotEngine] Bot ${botId}: skipping cycle — market is closed`);
        return;
      }

      const aiStatus = getOpenAIStatus();
      if (aiStatus.circuitOpen && !this.rustAvailable) {
        console.log(`[BotEngine] Bot ${botId}: skipping cycle — AI circuit open and no Rust engine (cooldown: ${aiStatus.cooldownRemainingMs}ms)`);
        return;
      }

      const bot = await this.prisma.tradingBot.findUnique({ where: { id: botId } });
      if (!bot || bot.status !== 'RUNNING') {
        console.log(`[BotEngine] Bot ${botId}: not found or not RUNNING, stopping`);
        this.stopBot(botId);
        return;
      }

      const symbols = (bot.assignedSymbols || 'RELIANCE,TCS,INFY,HDFCBANK,ITC,SBIN,BHARTIARTL,ICICIBANK,KOTAKBANK,AXISBANK,LT,BAJFINANCE,TATAMOTORS,SUNPHARMA,TITAN,WIPRO,HCLTECH,MARUTI,NTPC,POWERGRID,ADANIENT,JSWSTEEL,TATASTEEL,HINDALCO,ONGC,NIFTY,BANKNIFTY')
        .split(',').map(s => s.trim()).filter(Boolean);

      // Target-aware: check if trading is allowed
      let targetProgress: TargetProgress | null = null;
      try {
        targetProgress = await this.targetTracker.updateProgress(userId);
      } catch { /* no target set — proceed normally */ }

      if (targetProgress && !targetProgress.tradingAllowed) {
        console.log(`[BotEngine] Bot ${botId}: trading blocked — ${targetProgress.reason}`);
        await this.prisma.tradingBot.update({
          where: { id: botId },
          data: { lastAction: `Halted: ${targetProgress.reason}`, lastActionAt: new Date() },
        });
        return;
      }

      const aggression = targetProgress?.aggression ?? 'high';
      console.log(`[BotEngine] Bot ${botId} (${bot.name}/${bot.role}): starting cycle for ${symbols.length} symbols, Rust: ${this.rustAvailable}, aggression: ${aggression}`);

      // --- Step 1: Rust engine scan (fast, deterministic) ---
      if (this.rustAvailable) {
        const candleData = await this.fetchCandles(symbols, userId);

        if (candleData.length > 0) {
          // Update intraday volatility estimates from candle data
          for (const cd of candleData) {
            if (cd.candles && cd.candles.length >= 10) {
              const recentCloses = cd.candles.slice(-20).map((c: any) => c.close);
              const rets = [];
              for (let j = 1; j < recentCloses.length; j++) {
                if (recentCloses[j - 1] > 0) {
                  rets.push((recentCloses[j] - recentCloses[j - 1]) / recentCloses[j - 1]);
                }
              }
              this.updateIntradayVolatility(cd.symbol, rets);
            }
          }

          const aggressiveness = aggression === 'none' ? 'low' : aggression;
          let rustSignals: ScanSignal[] = [];

          const strategyParams = await this.loadStrategyParams(userId);
          const regime = await this.detectCurrentRegime(candleData);
          try {
            const scanResult = await engineScan({
              symbols: candleData,
              aggressiveness: aggressiveness as any,
              strategy_params: Object.keys(strategyParams).length > 0 ? strategyParams : undefined,
              regime: regime ?? undefined,
            });
            rustSignals = scanResult.signals ?? [];
            log.info({ botId, signalCount: rustSignals.length, regime }, 'Rust scan completed');
          } catch (err) {
            console.error(`[BotEngine] Bot ${botId}: Rust scan error:`, (err as Error).message);
            rustSignals = [];
          }

          if (rustSignals.length > 0) {
            await this.handleRustSignals(rustSignals, bot, userId, botId);
            // Don't return — still run GPT for additional analysis
          }
        }
      }

      // --- Step 1b: Pyramid into winning positions ---
      await this.pyramidWinners(bot, userId, botId);

      // --- Step 2: GPT/Gemini analysis (always runs for market commentary + AI signals) ---
      console.log(`[BotEngine] Bot ${botId}: running GPT/Gemini analysis cycle`);
      await this.runGptBotCycle(botId, userId, bot, symbols);

      // --- Step 3: Executor bots pick up pending high-confidence signals ---
      if (bot.role === 'EXECUTOR' || bot.role === 'SCANNER') {
        await this.executePendingSignals(botId, userId, symbols);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      const shortErr = errMsg.length > 200 ? errMsg.substring(0, 200) : errMsg;
      try {
        await this.prisma.tradingBot.update({
          where: { id: botId },
          data: { lastAction: `Error: ${shortErr}`, lastActionAt: new Date() },
        });
      } catch { /* ignore */ }
    } finally {
      this.cycleInProgress.delete(botId);
    }
  }

  /**
   * Auto-pyramid: add to winning positions when they're in profit.
   * Only adds if position is > 0.5% in profit and total risk stays within limits.
   */
  private async pyramidWinners(bot: any, userId: string, botId: string): Promise<void> {
    try {
      const portfolios = await this.prisma.portfolio.findMany({
        where: { userId },
        select: { id: true, initialCapital: true },
      });
      if (portfolios.length === 0) return;

      const capital = Number(portfolios[0].initialCapital);
      const openPositions = await this.prisma.position.findMany({
        where: { portfolioId: portfolios[0].id, status: 'OPEN' },
      });

      for (const pos of openPositions) {
        const entryPrice = Number(pos.avgEntryPrice);
        if (entryPrice <= 0) continue;

        // Use unrealizedPnl from position monitoring to gauge profit
        const unrealizedPnl = Number(pos.unrealizedPnl ?? 0);
        const positionValue = entryPrice * pos.qty;
        const unrealizedPnlPct = positionValue > 0 ? (unrealizedPnl / positionValue) * 100 : 0;

        // Only pyramid if position is > 0.5% in profit
        if (unrealizedPnlPct < 0.5) continue;

        // Estimate current price from unrealized PnL
        const currentPrice = pos.side === 'LONG'
          ? entryPrice + unrealizedPnl / pos.qty
          : entryPrice - unrealizedPnl / pos.qty;
        if (currentPrice <= 0) continue;

        // Don't pyramid if already scaled in (check qty vs original)
        const originalQty = pos.qty;
        if (originalQty <= 0) continue;

        // Check how many times we've already pyramided (max 2 add-ons)
        const existingOrders = await this.prisma.order.count({
          where: {
            positionId: pos.id,
            side: pos.side === 'LONG' ? 'BUY' : 'SELL',
            status: 'FILLED',
          },
        });
        if (existingOrders >= 3) continue; // original + 2 pyramids max

        // Add 50% of original position size
        const addQty = Math.max(1, Math.floor(originalQty * 0.5));
        const addValue = addQty * currentPrice;

        // Risk check: total position shouldn't exceed 2% of capital
        const totalValue = (originalQty + addQty) * currentPrice;
        if (totalValue / capital > 0.02) continue;

        // Move stop-loss to breakeven before adding
        log.info({
          symbol: pos.symbol,
          unrealizedPnlPct: unrealizedPnlPct.toFixed(2),
          addQty,
          existingOrders,
        }, 'Pyramiding into winning position');

        // Route through TradeService for proper OMS lifecycle
        try {
          await this.tradeService.placeOrder(userId, {
            portfolioId: portfolios[0].id,
            symbol: pos.symbol,
            side: pos.side === 'LONG' ? 'BUY' : 'SELL',
            orderType: 'MARKET',
            qty: addQty,
            price: currentPrice,
            instrumentToken: pos.instrumentToken ?? pos.symbol,
            exchange: pos.exchange,
            strategyTag: pos.strategyTag ?? 'pyramid',
          });
        } catch (err) {
          log.warn({ symbol: pos.symbol, err }, 'Pyramid order failed (risk/capital block)');
        }
      }
    } catch (err) {
      log.warn({ botId, err }, 'Pyramid winners check failed (non-fatal)');
    }
  }

  // ---- Process Rust-generated signals ----
  private async handleRustSignals(
    rustSignals: ScanSignal[],
    bot: any,
    userId: string,
    botId: string,
  ): Promise<void> {
    const shouldAutoExecute = bot.role === 'EXECUTOR' || bot.role === 'SCANNER';

    // Thompson sampling: prioritize signals from strategies with better posteriors
    let prioritized = rustSignals;
    if (rustSignals.length > 1) {
      const strategyIds = [...new Set(rustSignals.map(s => s.strategy ?? bot.assignedStrategy ?? 'default'))];
      const selectedStrategy = this.thompsonSelectStrategy(strategyIds);

      if (selectedStrategy) {
        prioritized = [
          ...rustSignals.filter(s => (s.strategy ?? bot.assignedStrategy) === selectedStrategy),
          ...rustSignals.filter(s => (s.strategy ?? bot.assignedStrategy) !== selectedStrategy),
        ];
        log.info({ selectedStrategy, totalSignals: rustSignals.length }, 'Thompson sampling prioritized strategy');
      }
    }

    for (const sig of prioritized.slice(0, 3)) {
      const gptApproved = await this.gptValidateSignal(sig, bot, userId);

      const finalConfidence = gptApproved ? sig.confidence : sig.confidence * 0.8;
      const execute = shouldAutoExecute && finalConfidence >= 0.45;

      const gateScores = this.deriveGateScores(finalConfidence, sig.indicators, sig.votes, { source: 'rust-engine', gptApproved });

      const signal = await this.prisma.aITradeSignal.create({
        data: {
          userId,
          symbol: sig.symbol,
          signalType: sig.direction,
          compositeScore: finalConfidence,
          gateScores: JSON.stringify(gateScores),
          strategyId: bot.assignedStrategy || null,
          rationale: `Rust engine: ${sig.direction} @ ₹${sig.entry} | SL: ₹${sig.stop_loss} | Target: ₹${sig.target} | Confidence: ${(sig.confidence * 100).toFixed(0)}%${gptApproved ? ' [GPT approved]' : ' [GPT filtered]'}`,
          status: execute ? 'EXECUTED' : 'PENDING',
          executedAt: execute ? new Date() : null,
          expiresAt: new Date(Date.now() + 4 * 60 * 60_000),
        },
      });

      emit('signals', {
        type: 'SIGNAL_GENERATED', userId, botId,
        symbol: sig.symbol, direction: sig.direction, confidence: finalConfidence,
        entry: sig.entry, stopLoss: sig.stop_loss, target: sig.target,
        source: sig.strategy ?? 'rust-engine',
      }).catch(err => log.error({ err, userId }, 'Failed to emit SIGNAL_GENERATED event'));

      if (execute) {
        const result = await this.executeTrade(userId, sig.symbol, sig.direction, sig.symbol, botId, {
          confidence: sig.confidence,
          indicators: JSON.stringify(sig.indicators),
          ltp: sig.entry,
          signalSource: 'RUST_ENGINE',
        });
        await this.prisma.botMessage.create({
          data: {
            fromBotId: botId,
            userId,
            messageType: result.success ? 'signal' : 'alert',
            content: result.success
              ? `EXECUTED ${sig.direction}: ${result.message} (Rust confidence: ${(sig.confidence * 100).toFixed(0)}%)`
              : `Failed ${sig.direction} ${sig.symbol}: ${result.message}`,
          },
        });
      } else {
        await this.prisma.botMessage.create({
          data: {
            fromBotId: botId,
            userId,
            messageType: 'signal',
            content: `${sig.direction} Signal: ${sig.symbol} @ ₹${sig.entry} (${(finalConfidence * 100).toFixed(0)}% confidence) | SL: ₹${sig.stop_loss} | Target: ₹${sig.target}`,
          },
        });
      }
    }

    await this.prisma.tradingBot.update({
      where: { id: botId },
      data: {
        lastAction: `Rust: ${rustSignals.length} signal(s) — ${rustSignals.map(s => `${s.direction} ${s.symbol}`).join(', ')}`,
        lastActionAt: new Date(),
      },
    });
  }

  private async executePendingSignals(botId: string, userId: string, symbols: string[]): Promise<void> {
    try {
      const oneHourAgo = new Date(Date.now() - 60 * 60_000);
      const pendingSignals = await this.prisma.aITradeSignal.findMany({
        where: {
          userId,
          status: 'PENDING',
          compositeScore: { gte: 0.65 },
          createdAt: { gte: oneHourAgo },
          expiresAt: { gt: new Date() },
          signalType: { in: ['BUY', 'SELL'] },
          symbol: { in: symbols.map(s => s.toUpperCase()) },
        },
        orderBy: { compositeScore: 'desc' },
        take: 3,
      });

      if (pendingSignals.length === 0) return;
      console.log(`[BotEngine] Bot ${botId}: found ${pendingSignals.length} pending signals to execute`);

      for (const sig of pendingSignals) {
        const result = await this.executeTrade(userId, sig.symbol, sig.signalType as 'BUY' | 'SELL', sig.rationale ?? '', botId, {
          confidence: sig.compositeScore,
          signalSource: 'PENDING_SIGNAL',
        });

        await this.prisma.aITradeSignal.update({
          where: { id: sig.id },
          data: { status: result.success ? 'EXECUTED' : 'REJECTED', executedAt: result.success ? new Date() : null },
        });

        await this.prisma.botMessage.create({
          data: {
            fromBotId: botId,
            userId,
            messageType: result.success ? 'signal' : 'alert',
            content: result.success
              ? `EXECUTED pending signal: ${sig.signalType} ${sig.symbol} — ${result.message}`
              : `REJECTED pending signal: ${sig.signalType} ${sig.symbol} — ${result.message}`,
          },
        });

        console.log(`[BotEngine] Bot ${botId}: ${result.success ? 'EXECUTED' : 'REJECTED'} pending ${sig.signalType} ${sig.symbol} (${(sig.compositeScore * 100).toFixed(0)}%): ${result.message}`);
      }
    } catch (err) {
      console.log(`[BotEngine] Bot ${botId}: executePendingSignals error: ${(err as Error).message}`);
    }
  }

  // ---- GPT validates a Rust signal (lightweight check) ----
  private async gptValidateSignal(sig: ScanSignal, bot: any, _userId: string): Promise<boolean> {
    // For EXECUTOR bots: use deterministic ML scorer (fast, reproducible, backtestable)
    if (bot.role === 'EXECUTOR') {
      return this.mlValidateSignal(sig);
    }

    // For ADVISOR/ANALYST bots: use LLM validation
    try {
      const result = await chatCompletionJSON<{ approved: boolean; reason: string }>({
        messages: [
          { role: 'system', content: `You are a trade signal validator. A Rust technical analysis engine generated a ${sig.direction} signal. Validate whether this signal makes sense given the indicator values. Respond in JSON: {"approved": true/false, "reason": "brief explanation"}` },
          { role: 'user', content: `Signal: ${sig.direction} ${sig.symbol} @ ₹${sig.entry}
Confidence: ${(sig.confidence * 100).toFixed(0)}%
EMA9: ${sig.indicators.ema_9}, EMA21: ${sig.indicators.ema_21}
RSI: ${sig.indicators.rsi_14}, MACD Hist: ${sig.indicators.macd_histogram}
Supertrend: ${sig.indicators.supertrend}, VWAP: ${sig.indicators.vwap}
Momentum: ${sig.indicators.momentum_score ?? 'N/A'}, Volume Ratio: ${sig.indicators.volume_ratio ?? 'N/A'}
Stop Loss: ₹${sig.stop_loss}, Target: ₹${sig.target}
Approve or reject?` },
        ],
        temperature: 0.2,
        maxTokens: 1024,
      });
      return result.approved ?? true;
    } catch {
      return true;
    }
  }

  private async mlValidateSignal(sig: ScanSignal): Promise<boolean> {
    const now = new Date();
    let rustScore = -1;
    let pythonScore = -1;
    let usedModel: 'rust' | 'python' | 'confidence' = 'confidence';

    const featureObj = {
      ema_vote: sig.votes?.ema_crossover ?? 0,
      rsi_vote: sig.votes?.rsi ?? 0,
      macd_vote: sig.votes?.macd ?? 0,
      supertrend_vote: sig.votes?.supertrend ?? 0,
      bollinger_vote: sig.votes?.bollinger ?? 0,
      vwap_vote: sig.votes?.vwap ?? 0,
      momentum_vote: sig.votes?.momentum ?? 0,
      volume_vote: sig.votes?.volume ?? 0,
      composite_score: sig.confidence,
      regime: 1.0,
      hour_of_day: now.getHours(),
      day_of_week: now.getDay(),
    };

    // ── Step 1: Rust scorer (fast, always available if weights exist) ──
    try {
      const { engineMLScore } = await import('../lib/rust-engine.js');

      if (this.mlWeights) {
        const result = await engineMLScore({
          command: 'predict',
          features: [featureObj],
          weights: this.mlWeights,
        }) as { scores: number[] };
        rustScore = result.scores?.[0] ?? -1;
        usedModel = 'rust';
      }
    } catch { /* Rust scorer unavailable */ }

    // ── Step 2: Python scorer (higher quality, may be unavailable) ──
    try {
      const { isMLServiceAvailable, mlScore } = await import('../lib/ml-service-client.js');
      const pyAvailable = await isMLServiceAvailable();

      if (pyAvailable) {
        const pyResult = await mlScore({
          features: [{ features: featureObj }],
          model_type: 'xgboost',
        });
        pythonScore = pyResult.scores?.[0] ?? -1;
        if (pythonScore >= 0) usedModel = 'python';
      }
    } catch { /* Python service unavailable, no-op */ }

    // ── Step 2b: Challenger model (LightGBM) for A/B testing ──
    let challengerScore = -1;
    try {
      const { isMLServiceAvailable, mlScore } = await import('../lib/ml-service-client.js');
      if (await isMLServiceAvailable()) {
        const lgbResult = await mlScore({
          features: [{ features: featureObj }],
          model_type: 'lightgbm',
        });
        challengerScore = lgbResult.scores?.[0] ?? -1;
      }
    } catch { /* challenger unavailable */ }

    // ── Step 3: A/B logging with challenger tracking ──
    const agreed = rustScore >= 0 && pythonScore >= 0
      ? (rustScore >= 0.5) === (pythonScore >= 0.5)
      : null;

    log.info({
      symbol: sig.symbol, confidence: sig.confidence,
      rustScore: rustScore >= 0 ? rustScore.toFixed(4) : 'N/A',
      pythonScore: pythonScore >= 0 ? pythonScore.toFixed(4) : 'N/A',
      challengerScore: challengerScore >= 0 ? challengerScore.toFixed(4) : 'N/A',
      agreed, usedModel,
    }, 'ML A/B score comparison');

    // ── Step 4: Record in DecisionAudit for A/B analysis ──
    try {
      await this.decisionAudit.recordDecision({
        userId: 'system',
        decisionType: 'ML_AB_TEST',
        symbol: sig.symbol,
        direction: sig.direction === 'BUY' ? 'LONG' : 'SHORT',
        confidence: sig.confidence,
        signalSource: sig.strategy ?? 'rust-engine',
        marketDataSnapshot: {
          rustScore, pythonScore, challengerScore, agreed, usedModel,
          entry: sig.entry, stopLoss: sig.stop_loss, target: sig.target,
        },
        reasoning: `Rust: ${rustScore >= 0 ? rustScore.toFixed(4) : 'N/A'}, Python(XGB): ${pythonScore >= 0 ? pythonScore.toFixed(4) : 'N/A'}, Challenger(LGB): ${challengerScore >= 0 ? challengerScore.toFixed(4) : 'N/A'}, Used: ${usedModel}`,
      });
    } catch { /* audit is best-effort */ }

    // ── Step 4b: A/B test auto-promotion check (every 50 trades) ──
    this.abTestTracker.total++;
    if (this.abTestTracker.total % 50 === 0 && this.abTestTracker.total > 0) {
      try {
        const recentABTests = await this.prisma.decisionAudit.findMany({
          where: { decisionType: 'ML_AB_TEST', resolvedAt: { not: null } },
          orderBy: { createdAt: 'desc' },
          take: 50,
          select: { marketDataSnapshot: true, pnl: true },
        });

        let xgbWins = 0;
        let lgbWins = 0;
        for (const test of recentABTests) {
          const snap = typeof test.marketDataSnapshot === 'string'
            ? JSON.parse(test.marketDataSnapshot) : test.marketDataSnapshot;
          const won = (test.pnl ?? 0) > 0;
          const xgbPredicted = (snap?.pythonScore ?? 0) >= 0.5;
          const lgbPredicted = (snap?.challengerScore ?? 0) >= 0.5;
          if (xgbPredicted === won) xgbWins++;
          if (lgbPredicted === won) lgbWins++;
        }

        if (recentABTests.length >= 30 && lgbWins > xgbWins + 5) {
          log.info({ xgbWins, lgbWins, samples: recentABTests.length },
            'Challenger model (LightGBM) outperforming — promoting as primary');
          emit('system', {
            type: 'ML_WEIGHTS_UPDATED',
            userId: 'system',
            version: -1,
            timestamp: new Date().toISOString(),
            note: 'LightGBM promoted via A/B test',
          } as any).catch(() => {});
        }
      } catch { /* A/B evaluation is best-effort */ }
    }

    // ── Step 5: Ensemble blending — use weighted average when both available ──
    if (rustScore >= 0 && pythonScore >= 0) {
      let rw = 0.5;
      let pw = 0.5;
      try {
        const blendParam = await this.prisma.strategyParam.findFirst({
          where: { strategyId: 'model_blend_weights', isActive: true },
          orderBy: { createdAt: 'desc' },
        });
        if (blendParam) {
          const blend = JSON.parse(blendParam.params);
          rw = blend.rustWeight ?? 0.5;
          pw = blend.pythonWeight ?? 0.5;
        }
      } catch { /* fallback to equal weights */ }
      const ensembleScore = rw * rustScore + pw * pythonScore;
      log.info({ symbol: sig.symbol, ensembleScore, rw, pw }, 'Ensemble ML score');
      return ensembleScore >= 0.5;
    }
    if (pythonScore >= 0) return pythonScore >= 0.5;
    if (rustScore >= 0) return rustScore >= 0.5;
    return sig.confidence >= 0.45;
  }

  private async fetchFnOContext(symbols: string[]): Promise<string> {
    const parts: string[] = [];
    try {
      const vixData = await this.marketData.getVIX().catch(() => null);
      if (vixData?.value) parts.push(`India VIX: ${vixData.value}`);
    } catch { /* skip */ }

    for (const sym of symbols.slice(0, 3)) {
      try {
        const chain = await this.marketData.getOptionsChain(sym);
        if (!chain?.strikes?.length) continue;

        const callOI: Record<number, number> = {};
        const putOI: Record<number, number> = {};
        for (const s of chain.strikes) {
          callOI[s.strike] = s.callOI || 0;
          putOI[s.strike] = s.putOI || 0;
        }
        const strikeVals = chain.strikes.map((s: any) => s.strike);
        const maxPain = calculateMaxPain(strikeVals, callOI, putOI);

        const totalCallOI = Object.values(callOI).reduce((a, b) => a + b, 0);
        const totalPutOI = Object.values(putOI).reduce((a, b) => a + b, 0);
        const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : 'N/A';

        const ivValues = chain.strikes.map((s: any) => s.callIV || s.putIV || 0).filter((v: number) => v > 0);
        const currentIV = ivValues.length > 0 ? ivValues[Math.floor(ivValues.length / 2)] : 0;
        const ivPct = calculateIVPercentile(currentIV, ivValues);

        const topCallStrikes = [...strikeVals].sort((a, b) => (callOI[b] || 0) - (callOI[a] || 0)).slice(0, 3);
        const topPutStrikes = [...strikeVals].sort((a, b) => (putOI[b] || 0) - (putOI[a] || 0)).slice(0, 3);

        parts.push(`${sym}: MaxPain=${maxPain.maxPainStrike} PCR=${pcr} IV%=${ivPct} Spot=${chain.underlyingValue || '?'}`);
        parts.push(`  Resistance(Call OI): ${topCallStrikes.join(',')} | Support(Put OI): ${topPutStrikes.join(',')}`);
      } catch { /* skip symbol */ }
    }

    return parts.length > 0 ? `\nF&O Data:\n${parts.join('\n')}` : '';
  }

  private async computeRustIndicators(symbols: string[], userId: string): Promise<string> {
    if (!this.rustAvailable) return '';
    const candleData = await this.fetchCandles(symbols, userId);
    if (candleData.length === 0) return '';

    const parts: string[] = ['\n=== RUST ENGINE INDICATORS ==='];
    for (const { symbol, candles } of candleData.slice(0, 5)) {
      try {
        const result = await engineSignals({ candles }) as any;
        if (!result) continue;
        const n = candles.length - 1;
        const last = (arr: number[]) => arr?.length > 0 ? arr[arr.length - 1] : null;
        const ema9 = last(result.ema_9);
        const ema21 = last(result.ema_21);
        const rsi = last(result.rsi_14);
        const macdH = last(result.macd_histogram);
        const bbU = last(result.bollinger_upper);
        const bbL = last(result.bollinger_lower);
        const vwap = last(result.vwap);
        const st = last(result.supertrend);
        const close = candles[n].close;

        const emaTrend = ema9 !== null && ema21 !== null
          ? (ema9 > ema21 ? 'BULLISH' : 'BEARISH') : '?';
        const rsiLabel = rsi !== null
          ? (rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'NEUTRAL') : '?';

        parts.push(`${symbol}: EMA9=${ema9?.toFixed(1)} EMA21=${ema21?.toFixed(1)} [${emaTrend}] | RSI=${rsi?.toFixed(1)} [${rsiLabel}] | MACD-H=${macdH?.toFixed(2)} | BB[${bbL?.toFixed(1)}-${bbU?.toFixed(1)}] | VWAP=${vwap?.toFixed(1)} | SuperTrend=${st?.toFixed(1)} | Close=${close.toFixed(1)}`);
      } catch { /* skip symbol */ }
    }
    return parts.length > 1 ? parts.join('\n') : '';
  }

  // ---- GPT/Gemini analysis cycle ----
  private async runGptBotCycle(botId: string, userId: string, bot: any, symbols: string[]): Promise<void> {
    console.log(`[BotEngine] GPT cycle for bot ${botId} (${bot.name}): fetching quotes for ${symbols.join(', ')}`);
    let quotes: string;
    try {
      quotes = await this.fetchQuotes(symbols);
      console.log(`[BotEngine] GPT cycle: quotes fetched (${quotes.length} chars)`);
    } catch (err) {
      console.error(`[BotEngine] GPT cycle: quote fetch failed:`, (err as Error).message);
      quotes = symbols.map(s => `${s}: price data temporarily unavailable`).join('\n');
    }
    const positions = await this.getPortfolioPositions(userId);

    let fnoContext = '';
    if (bot.role === 'FNO_STRATEGIST' || bot.role === 'STRATEGIST' || bot.role === 'ANALYST') {
      try {
        fnoContext = await this.fetchFnOContext(symbols);
      } catch { /* skip */ }
    }

    let rustIndicators = '';
    try {
      rustIndicators = await this.computeRustIndicators(symbols, userId);
    } catch { /* Rust indicators unavailable */ }

    const systemPrompt = ROLE_PROMPTS[bot.role] || ROLE_PROMPTS.SCANNER;

    const responseFormat = bot.role === 'FNO_STRATEGIST'
      ? `Respond in JSON: { "message": "analysis (3-5 sentences with price levels)", "messageType": "signal|alert|info", "action": "1-line summary", "signals": [{"symbol":"X","direction":"BUY_CE|BUY_PE|SELL_CE|SELL_PE|IRON_CONDOR|STRADDLE|STRANGLE|BULL_SPREAD|BEAR_SPREAD|BUY|SELL|HOLD","confidence":0.0-1.0,"entry":price,"stopLoss":price,"target":price,"reason":"<25 words","strategy":"name","riskReward":"1:2.5","legs":[{"type":"CE|PE","strike":0,"action":"BUY|SELL","qty":1}]}] }
IMPORTANT: Max 4 signals. Keep total response under 1500 chars. No extra text outside JSON.`
      : `Respond in JSON: { "message": "analysis (3-5 sentences with prices and trends)", "messageType": "signal|alert|info", "action": "1-line summary e.g. 'SELL RELIANCE @1350 SL:1375 TGT:1310'", "signals": [{"symbol":"X","direction":"BUY|SELL","confidence":0.0-1.0,"entry":price,"stopLoss":price,"target":price,"reason":"<25 words","riskReward":"1:2.5"}] }
IMPORTANT: Max 4 signals. Keep total response under 1500 chars. No extra text outside JSON.`;

    const analysis = await chatCompletionJSON<{
      message: string;
      messageType: string;
      action?: string;
      signals?: Array<{ symbol: string; direction: string; confidence: number; entry?: number; stopLoss?: number; target?: number; reason: string; riskReward?: string; strategy?: string; legs?: any[] }>;
    }>({
      messages: [
        { role: 'system', content: `${systemPrompt}\n${responseFormat}` },
        { role: 'user', content: `Bot: ${bot.name} | Strategy: ${bot.assignedStrategy || 'General'}
Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
${await this.getTargetContextString(userId)}
${quotes}${fnoContext}${rustIndicators}
${positions ? `\nOpen Positions:\n${positions}` : ''}

INSTRUCTIONS:
1. Analyze each stock's price action, volume, and 5-day trend from the data above
2. Identify stocks with the strongest moves (>1% change or unusual volume)
3. Generate 2-5 actionable signals with EXACT entry, stop-loss, and target prices
4. For each signal, calculate risk/reward ratio
5. Your message MUST reference specific prices and percentages from the data
6. This is PAPER TRADING — be aggressive and decisive, not cautious
7. Include both BUY and SELL signals as appropriate for the market condition` },
      ],
      temperature: 0.4,
      maxTokens: 4096,
    });

    if (analysis.message) {
      await this.prisma.botMessage.create({
        data: {
          fromBotId: botId,
          userId,
          messageType: analysis.messageType || 'info',
          content: analysis.message,
        },
      });
    }

    const actionText = analysis.action || analysis.message?.substring(0, 80) || 'Cycle completed';
    await this.prisma.tradingBot.update({
      where: { id: botId },
      data: {
        lastAction: `GPT: ${actionText}`,
        lastActionAt: new Date(),
      },
    });

    if (!analysis.signals || analysis.signals.length === 0) {
      console.log(`[BotEngine] Bot ${botId} GPT: no signals returned (message: ${analysis.message?.substring(0, 80)})`);
    }

    if (analysis.signals && analysis.signals.length > 0) {
      console.log(`[BotEngine] Bot ${botId} GPT signals: ${analysis.signals.map(s => `${s.direction} ${s.symbol} @${s.confidence?.toFixed(2)}`).join(', ')}`);
      for (const sig of analysis.signals.slice(0, 5)) {
        if (sig.confidence < 0.5) {
          console.log(`[BotEngine] Bot ${botId}: skipping ${sig.direction} ${sig.symbol} — confidence ${(sig.confidence * 100).toFixed(0)}% < 50%`);
          continue;
        }

        const isSimple = sig.direction === 'BUY' || sig.direction === 'SELL';
        const isMultiLeg = !isSimple && sig.legs && Array.isArray(sig.legs) && sig.legs.length > 0;
        if (!isSimple && !isMultiLeg) continue;

          const execThreshold = bot.role === 'EXECUTOR' ? 0.55 : 0.65;
          const shouldExecute = (bot.role === 'EXECUTOR' || bot.role === 'SCANNER' || bot.role === 'FNO_STRATEGIST') && sig.confidence >= execThreshold;

          const rationale = sig.entry
            ? `${sig.reason} | Entry: ₹${sig.entry} | SL: ₹${sig.stopLoss || 'N/A'} | Target: ₹${sig.target || 'N/A'} | R:R: ${sig.riskReward || 'N/A'}`
            : sig.reason;

          const botGateScores = this.deriveGateScores(
            sig.confidence, undefined, undefined,
            { source: 'gemini-analysis', riskReward: sig.riskReward },
          );
          await this.prisma.aITradeSignal.create({
            data: {
              userId,
              symbol: sig.symbol,
              signalType: sig.direction,
              compositeScore: sig.confidence,
              gateScores: JSON.stringify(botGateScores),
              strategyId: sig.strategy || bot.assignedStrategy || null,
              rationale: isMultiLeg
                ? `${sig.strategy || sig.direction}: ${sig.legs!.map((l: any) => `${l.action} ${l.type}@${l.strike}`).join(' + ')} | ${rationale}`
                : rationale,
              status: shouldExecute ? 'EXECUTED' : 'PENDING',
              executedAt: shouldExecute ? new Date() : null,
              expiresAt: new Date(Date.now() + 4 * 60 * 60_000),
            },
          });

          const signalMsg = isMultiLeg
            ? `${sig.strategy || sig.direction} ${sig.symbol}: ${sig.legs!.map((l: any) => `${l.action} ${l.qty || 1}x ${l.type}@${l.strike}`).join(' + ')} | Conf: ${(sig.confidence * 100).toFixed(0)}% | ${sig.reason}`
            : `${sig.direction} ${sig.symbol} @ ₹${sig.entry || '?'} | SL: ₹${sig.stopLoss || '?'} | TGT: ₹${sig.target || '?'} | Confidence: ${(sig.confidence * 100).toFixed(0)}% | ${sig.reason}`;
          await this.prisma.botMessage.create({
            data: {
              fromBotId: botId,
              userId,
              messageType: 'signal',
              content: signalMsg,
            },
          });

          if (shouldExecute) {
            let result: { success: boolean; message: string };
            if (isMultiLeg) {
              result = await this.executeMultiLegStrategy(userId, sig.symbol, sig.strategy || sig.direction, sig.legs!, botId);
            } else {
              result = await this.executeTrade(userId, sig.symbol, sig.direction as 'BUY' | 'SELL', rationale, botId, {
                confidence: sig.confidence,
                ltp: sig.entry,
                signalSource: 'AI_AGENT',
              });
            }
            await this.prisma.botMessage.create({
              data: {
                fromBotId: botId,
                userId,
                messageType: result.success ? 'signal' : 'alert',
                content: result.success
                  ? `Executed ${sig.direction} ${sig.symbol}: ${result.message}`
                  : `Failed ${sig.direction} ${sig.symbol}: ${result.message}`,
              },
            });
          }
        }
      }
    }


  // ---- Agent cycle with Rust risk integration ----
  private async runAgentCycle(userId: string): Promise<void> {
    try {
      const aiStatus = getOpenAIStatus();
      if (aiStatus.circuitOpen && !this.rustAvailable) {
        console.log(`[BotEngine] Agent: skipping cycle — AI circuit open and no Rust engine (cooldown: ${aiStatus.cooldownRemainingMs}ms)`);
        return;
      }
      console.log(`[BotEngine] Agent cycle starting for user ${userId}, Rust: ${this.rustAvailable}`);

      // Target-aware: check if trading is allowed
      let agentTargetProgress: TargetProgress | null = null;
      try {
        agentTargetProgress = await this.targetTracker.updateProgress(userId);
      } catch { /* no target — proceed */ }

      if (agentTargetProgress && !agentTargetProgress.tradingAllowed) {
        console.log(`[BotEngine] Agent: trading blocked — ${agentTargetProgress.reason}`);
        return;
      }

      const config = await this.prisma.aIAgentConfig.findUnique({ where: { userId } });
      if (!config || !config.isActive) {
        this.stopAgent(userId);
        return;
      }

      const portfolios = await this.prisma.portfolio.findMany({
        where: { userId },
        select: { id: true, initialCapital: true, currentNav: true },
      });

      const positions = await this.prisma.position.findMany({
        where: {
          portfolioId: { in: portfolios.map(p => p.id) },
          status: 'OPEN',
        },
      });

      const watchSymbols = positions.length > 0
        ? [...new Set(positions.map(p => p.symbol))]
        : ['NIFTY 50', 'RELIANCE', 'TCS', 'HDFCBANK', 'GOLD', 'USDINR'];

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayExecutedCount = await this.prisma.aITradeSignal.count({
        where: { userId, createdAt: { gte: todayStart }, status: 'EXECUTED' },
      });

      const maxDaily = Math.max(config.maxDailyTrades || 50, 50);
      if (todayExecutedCount >= maxDaily) {
        console.log(`[BotEngine] Agent: daily trade limit reached (${todayExecutedCount}/${maxDaily}), skipping`);
        return;
      }
      const todaySignalCount = await this.prisma.aITradeSignal.count({
        where: { userId, createdAt: { gte: todayStart } },
      });

      const nav = portfolios.length > 0 ? Number(portfolios[0].currentNav) : 1000000;
      const initCap = portfolios.length > 0 ? Number(portfolios[0].initialCapital) : 1000000;

      // --- Step 1: Rust engine scan + risk (fast, runs first) ---
      if (this.rustAvailable) {
        const candleData = await this.fetchCandles(watchSymbols.slice(0, MAX_CANDLE_SYMBOLS), userId);

        if (candleData.length > 0) {
          const aggressiveness = 'high';
          let rustSignals: ScanSignal[] = [];

          const agentStrategyParams = await this.loadStrategyParams(userId);
          const agentRegime = await this.detectCurrentRegime(candleData);
          try {
            const scanResult = await engineScan({
              symbols: candleData,
              aggressiveness: aggressiveness as any,
              strategy_params: Object.keys(agentStrategyParams).length > 0 ? agentStrategyParams : undefined,
              regime: agentRegime ?? undefined,
            });
            rustSignals = scanResult.signals ?? [];
            log.info({ signalCount: rustSignals.length, regime: agentRegime }, 'Agent Rust scan completed');
          } catch { /* fall through */ }

          // Compute portfolio risk via Rust
          let riskData: any = null;
          if (positions.length > 0) {
            try {
              const returns = this.computePortfolioReturns(positions);
              riskData = await engineRisk({ returns, initial_capital: initCap });
            } catch { /* risk computation failed, continue */ }
          }

          for (const sig of rustSignals.slice(0, 3)) {
            if (sig.confidence < (config.minSignalScore || 0.35)) continue;
            if (sig.direction !== 'BUY' && sig.direction !== 'SELL') continue;

            if (riskData && riskData.max_drawdown_percent > 10) continue;

            const autoExecute = config.mode === 'AUTONOMOUS' && sig.confidence >= 0.45;

            const agentRustGates = this.deriveGateScores(sig.confidence, sig.indicators, sig.votes, { source: 'rust-engine' });
            await this.prisma.aITradeSignal.create({
              data: {
                userId,
                symbol: sig.symbol,
                signalType: sig.direction,
                compositeScore: sig.confidence,
                gateScores: JSON.stringify(agentRustGates),
                rationale: `Rust: ${sig.direction} @ ₹${sig.entry} | SL: ₹${sig.stop_loss} | Target: ₹${sig.target} | Confidence: ${(sig.confidence * 100).toFixed(0)}%`,
                status: autoExecute ? 'EXECUTED' : 'PENDING',
                executedAt: autoExecute ? new Date() : null,
                expiresAt: new Date(Date.now() + 4 * 60 * 60_000),
              },
            });

            if (autoExecute) {
              await this.executeTrade(userId, sig.symbol, sig.direction, sig.symbol, undefined, {
                confidence: sig.confidence,
                ltp: sig.entry,
                signalSource: 'RUST_ENGINE',
              });
            }
          }
          // Don't return — always continue to GPT for full market analysis
        }
      }

      // --- Step 2: GPT/Gemini analysis (always runs for market view + signals) ---
      let quotes: string;
      try {
        quotes = await this.fetchQuotes(watchSymbols);
      } catch {
        quotes = watchSymbols.map(s => `${s}: price data temporarily unavailable`).join('\n');
      }

      let fnoCtx = '';
      try {
        fnoCtx = await this.fetchFnOContext(watchSymbols.slice(0, 3));
      } catch { /* skip */ }

      const pnlPct = initCap > 0 ? ((nav - initCap) / initCap * 100).toFixed(2) : '0';

      const posInfo = positions.map(p =>
        `${p.symbol} | ${p.side} ${p.qty}@₹${Number(p.avgEntryPrice).toFixed(1)} | P&L: ₹${Number(p.unrealizedPnl).toFixed(0)}`
      ).join('\n') || 'No open positions';

      const result = await chatCompletionJSON<{
        signals: Array<{
          symbol: string;
          direction: 'BUY' | 'SELL' | 'HOLD';
          score: number;
          rationale: string;
          entry: number;
          stopLoss: number;
          target: number;
          gateScores: Record<string, number>;
        }>;
        marketView: string;
        riskAlerts: string[];
      }>({
        messages: [
          { role: 'system', content: `You are an AI trading agent for the Indian markets (NSE/BSE for equities, MCX for commodities, CDS for forex).
Mode: ${config.mode} | Min score: ${config.minSignalScore}
Analyze the market data and portfolio across all markets. Generate actionable trade signals.

Score each signal through 9 gates (0-100 each):
g1_trend, g2_momentum, g3_volatility, g4_volume, g5_options_flow,
g6_global_macro, g7_fii_dii, g8_sentiment, g9_risk

Respond in JSON:
{
  "signals": [{"symbol":"X","direction":"BUY|SELL","score":0.0-1.0,"rationale":"why",
    "entry":0,"stopLoss":0,"target":0,
    "gateScores":{"g1_trend":75,"g2_momentum":60,...}}],
  "marketView": "1-2 sentence market view",
  "riskAlerts": ["any risk warnings"]
}
Generate 0-3 signals. Only include high-conviction ones (score >= ${config.minSignalScore}).` },
          { role: 'user', content: `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}
Portfolio: NAV ₹${nav.toFixed(0)} | P&L: ${pnlPct}% | Signals today: ${todaySignalCount}/${maxDaily}

Positions:\n${posInfo}

Market Data:\n${quotes}${fnoCtx}

Scan and generate signals. Both BUY and SELL are valid — stocks can be shorted. Keep reasons concise (<30 words each).` },
        ],
        temperature: 0.4,
        maxTokens: 4096,
      });

      if (result.signals) {
        for (const sig of result.signals) {
          if (sig.score >= (config.minSignalScore || 0.6) && (sig.direction === 'BUY' || sig.direction === 'SELL')) {
            const autoExecute = config.mode === 'AUTONOMOUS' && sig.score >= 0.65;

            // Use GPT-provided gate scores if they have G1-G9 keys, otherwise derive them
            const hasGates = sig.gateScores && Object.keys(sig.gateScores).some(k => k.startsWith('g1'));
            const finalGateScores = hasGates
              ? { source: 'gpt-fallback', ...sig.gateScores }
              : this.deriveGateScores(sig.score, undefined, undefined, { source: 'gpt-fallback', riskReward: true });

            await this.prisma.aITradeSignal.create({
              data: {
                userId,
                symbol: sig.symbol,
                signalType: sig.direction,
                compositeScore: sig.score,
                gateScores: JSON.stringify(finalGateScores),
                rationale: `${sig.rationale} | Entry: ₹${sig.entry} | SL: ₹${sig.stopLoss} | Target: ₹${sig.target}`,
                status: autoExecute ? 'EXECUTED' : 'PENDING',
                executedAt: autoExecute ? new Date() : null,
                expiresAt: new Date(Date.now() + 4 * 60 * 60_000),
              },
            });

            if (autoExecute) {
              await this.executeTrade(userId, sig.symbol, sig.direction, sig.rationale, undefined, {
                confidence: sig.score,
                ltp: sig.entry,
                signalSource: 'AI_AGENT',
              });
            }
          }
        }
        console.log(`[BotEngine] Agent cycle completed — ${result.signals?.length ?? 0} signals, view: ${result.marketView?.substring(0, 80) ?? 'N/A'}`);
      }
    } catch (err) {
      console.error(`[BotEngine] Agent cycle error:`, (err as Error).message);
    }
  }

  private computePortfolioReturns(positions: any[]): number[] {
    const returns: number[] = [];
    for (const pos of positions) {
      const entry = Number(pos.avgEntryPrice);
      const unrealized = Number(pos.unrealizedPnl);
      if (entry > 0) {
        returns.push(unrealized / (entry * Number(pos.qty)));
      }
    }
    if (returns.length === 0) returns.push(0);
    return returns;
  }

  private async getTargetContextString(userId: string): Promise<string> {
    try {
      const progress = await this.targetTracker.updateProgress(userId);
      if (!progress) return '';
      const pnlSign = progress.currentPnl >= 0 ? '+' : '';
      return `\nTRADING TARGET: Capital ₹${(progress.capitalBase / 100000).toFixed(1)}L | Target: ${pnlSign}₹${progress.profitTargetAbs.toFixed(0)} (${progress.profitTargetPct}%) | Max Loss: -₹${progress.maxLossAbs.toFixed(0)} (${progress.maxLossPct}%) | Current P&L: ${pnlSign}₹${progress.currentPnl.toFixed(0)} (${progress.progressPct.toFixed(0)}% of target) | Aggression: ${progress.aggression.toUpperCase()} | Status: ${progress.status}`;
    } catch {
      return '';
    }
  }

  private async fetchQuotes(symbols: string[]): Promise<string> {
    const lines: string[] = [];

    // Global market intelligence context
    const globalContext = this.globalMarket.getIntelligenceContextForBots();
    if (globalContext) {
      lines.push(globalContext);
      lines.push('');
    }

    // Fetch NIFTY 50 as market context
    try {
      const nifty = await Promise.race([
        this.marketData.getQuote('NIFTY 50'),
        new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
      ]);
      if (nifty.ltp > 0) {
        const trend = nifty.changePercent < -0.5 ? 'BEARISH' : nifty.changePercent > 0.5 ? 'BULLISH' : 'SIDEWAYS';
        lines.push(`=== MARKET CONTEXT ===`);
        lines.push(`NIFTY 50: ₹${nifty.ltp.toFixed(2)} (${nifty.change >= 0 ? '+' : ''}${nifty.change.toFixed(2)}, ${nifty.changePercent >= 0 ? '+' : ''}${nifty.changePercent.toFixed(2)}%) | Day Range: ₹${nifty.low.toFixed(2)}-₹${nifty.high.toFixed(2)} | Prev Close: ₹${nifty.close.toFixed(2)} | Trend: ${trend}`);
        lines.push('');
      }
    } catch { /* skip nifty context */ }

    lines.push(`=== STOCK DATA ===`);

    const toDate = new Date().toISOString().split('T')[0];
    const fromDate = new Date(Date.now() - 7 * 86_400_000).toISOString().split('T')[0];

    for (const sym of symbols.slice(0, MAX_CANDLE_SYMBOLS)) {
      try {
        const [quote, history] = await Promise.all([
          Promise.race([
            this.marketData.getQuote(sym),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
          ]),
          Promise.race([
            this.marketData.getHistory(sym, '1day', fromDate, toDate),
            new Promise<never>((_, rej) => setTimeout(() => rej(new Error('timeout')), 8000)),
          ]).catch(() => []),
        ]);

        if (quote.ltp > 0) {
          const dayRange = quote.high > 0 ? `Day: ₹${quote.low.toFixed(2)}-₹${quote.high.toFixed(2)}` : '';
          const volStr = quote.volume > 0 ? `Vol: ${(quote.volume / 100000).toFixed(1)}L` : 'Vol: N/A';

          let historyStr = '';
          if (Array.isArray(history) && history.length >= 2) {
            const recent = history.slice(-5);
            const avgVol = recent.reduce((s, b) => s + b.volume, 0) / recent.length;
            const volRatio = avgVol > 0 ? (quote.volume / avgVol) : 0;
            const fiveDayHigh = Math.max(...recent.map(b => b.high));
            const fiveDayLow = Math.min(...recent.map(b => b.low));
            const priceRange = `5D-Range: ₹${fiveDayLow.toFixed(2)}-₹${fiveDayHigh.toFixed(2)}`;
            const volSignal = volRatio > 1.5 ? '🔥HIGH' : volRatio < 0.5 ? 'LOW' : 'NORMAL';
            const trend5d = recent.length >= 2 ? (recent[recent.length - 1].close > recent[0].close ? '↑UP' : '↓DOWN') : '';
            historyStr = ` | ${priceRange} | VolRatio: ${volRatio.toFixed(1)}x (${volSignal}) | 5D-Trend: ${trend5d}`;

            const closes = recent.map(b => `₹${b.close.toFixed(2)}`).join('→');
            historyStr += ` | Closes: ${closes}`;
          }

          lines.push(`${sym}: ₹${quote.ltp.toFixed(2)} (${quote.change >= 0 ? '+' : ''}${quote.change.toFixed(2)}, ${quote.changePercent >= 0 ? '+' : ''}${quote.changePercent.toFixed(2)}%) | Open: ₹${quote.open.toFixed(2)} | ${dayRange} | ${volStr}${historyStr}`);
        } else {
          lines.push(`${sym}: price data not available`);
        }
      } catch {
        lines.push(`${sym}: data temporarily unavailable`);
      }
    }
    return lines.join('\n');
  }

  private async getPortfolioPositions(userId: string): Promise<string> {
    try {
      const portfolios = await this.prisma.portfolio.findMany({
        where: { userId },
        select: { id: true },
      });
      if (portfolios.length === 0) return '';

      const positions = await this.prisma.position.findMany({
        where: {
          portfolioId: { in: portfolios.map(p => p.id) },
          status: 'OPEN',
        },
      });

      if (positions.length === 0) return '';

      return positions.map(p =>
        `${p.symbol} | ${p.side} ${p.qty}@₹${Number(p.avgEntryPrice).toFixed(1)} | Unrealized: ₹${Number(p.unrealizedPnl).toFixed(0)}`
      ).join('\n');
    } catch {
      return '';
    }
  }

  /**
   * Execute a signal produced by the data pipeline (Python ML scored).
   * Routes through risk checks and TradeService for proper OMS lifecycle.
   */
  async executePipelineSignal(signal: {
    symbol: string;
    direction: 'BUY' | 'SELL';
    confidence: number;
    strategy: string;
    mlScore: number;
    source: string;
  }): Promise<void> {
    const runningBots = [...this.runningBots.values()];
    if (runningBots.length === 0) {
      log.warn({ symbol: signal.symbol }, 'Pipeline signal ignored — no running bots');
      return;
    }

    const bot = runningBots[0];
    const portfolio = await this.prisma.portfolio.findFirst({ where: { userId: bot.userId } });
    if (!portfolio) return;

    const nav = Number(portfolio.currentNav);
    const estimatedPrice = nav * 0.05 / 1; // placeholder, refined below with real LTP
    const riskResult = await this.riskService.preTradeCheck(bot.userId, signal.symbol, signal.direction, 1, estimatedPrice);
    if (!riskResult.allowed) {
      log.info({ symbol: signal.symbol, violations: riskResult.violations }, 'Pipeline signal rejected by risk');
      return;
    }

    if (signal.direction === 'SELL') {
      const longPos = await this.prisma.position.findFirst({
        where: { portfolioId: portfolio.id, symbol: signal.symbol, side: 'LONG', status: 'OPEN' },
      });
      if (longPos) {
        let exitPrice = 0;
        try {
          const q = await this.marketData.getQuote(signal.symbol);
          exitPrice = q.ltp;
        } catch { /* fallback to entry price */ }
        if (exitPrice <= 0) exitPrice = Number(longPos.avgEntryPrice);

        const exitResult = await ExitCoordinator.closePosition({
          positionId: longPos.id,
          userId: bot.userId,
          exitPrice,
          reason: `Pipeline ML signal (confidence: ${signal.confidence.toFixed(2)}, strategy: ${signal.strategy})`,
          source: 'PIPELINE_ML',
          decisionType: 'EXIT_SIGNAL',
          prisma: this.prisma,
          tradeService: this.tradeService,
          decisionAudit: this.decisionAudit,
        });
        log.info({ symbol: signal.symbol, success: exitResult.success }, 'Pipeline SELL signal executed');
      }
      return;
    }

    const existingPos = await this.prisma.position.findFirst({
      where: { portfolioId: portfolio.id, symbol: signal.symbol, status: 'OPEN' },
    });
    if (existingPos) return;

    const positionSizePct = Math.min(signal.confidence * 15, 10);
    const positionValue = nav * positionSizePct / 100;
    let ltp = 0;
    try {
      const quote = await this.marketData.getQuote(signal.symbol);
      ltp = quote.ltp;
    } catch { /* price fetch failed */ }
    if (ltp <= 0) return;
    const qty = Math.max(1, Math.floor(positionValue / ltp));

    try {
      await this.tradeService.placeOrder(bot.userId, {
        portfolioId: portfolio.id,
        symbol: signal.symbol,
        side: 'BUY',
        orderType: 'MARKET',
        qty,
        price: ltp,
        instrumentToken: signal.symbol,
        exchange: 'NSE',
        strategyTag: `PIPELINE_${signal.strategy}`,
      });
      log.info({ symbol: signal.symbol, qty, ltp, confidence: signal.confidence }, 'Pipeline BUY signal executed');
    } catch (err) {
      log.error({ err, symbol: signal.symbol }, 'Failed to execute pipeline signal');
    }
  }
}
