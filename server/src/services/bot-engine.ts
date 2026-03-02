import type { PrismaClient } from '@prisma/client';
import { chatCompletionJSON, getOpenAIStatus } from '../lib/openai.js';
import { MarketDataService, type MarketMover } from './market-data.service.js';
import { TradeService } from './trade.service.js';
import { engineScan, engineRisk, isEngineAvailable, type ScanSignal } from '../lib/rust-engine.js';
import { calculateMaxPain, calculateIVPercentile, calculateGreeks } from './options.service.js';

const DEFAULT_TICK_INTERVAL = 3 * 60_000;
const DEFAULT_SIGNAL_INTERVAL = 5 * 60_000;
const DEFAULT_MARKET_SCAN_INTERVAL = 10 * 60_000;
const MAX_CONCURRENT_BOTS = 3;
const MAX_CANDLE_SYMBOLS = 8;

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
  private rustAvailable: boolean;
  private scannerTimer: ReturnType<typeof setInterval> | null = null;
  private scannerUserId: string | null = null;
  private lastScanResult: MarketScanResult | null = null;
  private scanInProgress = false;
  private cycleInProgress = new Set<string>();
  private rollingAccuracy = new Map<string, RollingAccuracy>();
  private tickInterval = DEFAULT_TICK_INTERVAL;
  private signalInterval = DEFAULT_SIGNAL_INTERVAL;
  private marketScanInterval = DEFAULT_MARKET_SCAN_INTERVAL;

  constructor(private prisma: PrismaClient) {
    this.tradeService = new TradeService(prisma);
    this.rustAvailable = isEngineAvailable();
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

    setTimeout(() => {
      this.runBotCycle(botId, userId).catch(() => {});
    }, staggerMs);

    const timer = setInterval(() => {
      if (!this.cycleInProgress.has(botId)) {
        this.runBotCycle(botId, userId).catch(() => {});
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

    // Delay first agent cycle by 20s to let server finish booting
    setTimeout(() => {
      this.runAgentCycle(userId).catch(() => {});
    }, 20_000);

    const timer = setInterval(() => {
      this.runAgentCycle(userId).catch(() => {});
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

  async startMarketScan(userId: string): Promise<void> {
    if (this.scannerTimer) return;
    this.scannerUserId = userId;

    // Delay first scan by 30s
    setTimeout(() => {
      this.runMarketScan(userId).catch(() => {});
    }, 30_000);

    this.scannerTimer = setInterval(() => {
      this.runMarketScan(userId).catch(() => {});
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
          this.runBotCycle(botId, entry.userId).catch(() => {});
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
        this.runMarketScan(userId).catch(() => {});
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
            const result = await engineScan({ symbols: scanInput, aggressiveness: 'medium' });
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

Respond in JSON: {"signals": [{"symbol":"X","direction":"BUY|SELL","confidence":0.0-1.0,"entry":price,"stopLoss":price,"target":price,"reason":"specific technical reason"}]}` },
              { role: 'user', content: `Time: ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}\n\nTop Movers:\n${moverSummary}\n\nGenerate detailed trade signals with entry, stop-loss, and target prices.` },
            ],
            temperature: 0.3,
            maxTokens: 2048,
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
  ): Promise<{ success: boolean; message: string }> {
    try {
      const portfolio = await this.prisma.portfolio.findFirst({ where: { userId } });
      if (!portfolio) return { success: false, message: 'No portfolio found' };

      const nav = Number(portfolio.currentNav);

      const exchange = this.detectExchange(symbol);

      if (direction === 'BUY') {
        let ltp = 0;
        try {
          const quote = await this.marketData.getQuote(symbol, exchange);
          ltp = quote.ltp;
        } catch { /* will be fetched by TradeService */ }

        const kellyAllocation = await this.computeKellySize(userId, symbol, nav);
        const maxPerTrade = nav * kellyAllocation;
        const qty = ltp > 0 ? Math.max(1, Math.floor(maxPerTrade / ltp)) : 1;

        const order = await this.tradeService.placeOrder(userId, {
          portfolioId: portfolio.id,
          symbol,
          side: 'BUY',
          orderType: 'MARKET',
          qty,
          instrumentToken: symbol,
          exchange,
          strategyTag: 'AI-BOT',
        }, true);

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

          const trade = await this.tradeService.closePosition(longPosition.id, userId, exitPrice);
          const pnl = Number(trade.netPnl);

          if (botId) {
            await this.updateBotTradeStats(botId, pnl);
          }

          const strategyTag = longPosition.strategyTag || 'AI-BOT';
          const outcome: 'WIN' | 'LOSS' | 'BREAKEVEN' = Math.abs(pnl) < 10 ? 'BREAKEVEN' : pnl > 0 ? 'WIN' : 'LOSS';
          const accuracy = this.trackOutcome(strategyTag, outcome);

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

          return { success: true, message: `Sold ${longPosition.qty} ${symbol} @ ₹${exitPrice.toFixed(2)} | P&L: ₹${pnl.toFixed(2)}` };
        }

        // No LONG position -- open a SHORT via placeOrder
        let ltp = 0;
        try {
          const quote = await this.marketData.getQuote(symbol, exchange);
          ltp = quote.ltp;
        } catch { /* will be fetched by TradeService */ }

        const kellyAllocation = await this.computeKellySize(userId, symbol, nav);
        const maxPerTrade = nav * kellyAllocation;
        const qty = ltp > 0 ? Math.max(1, Math.floor(maxPerTrade / ltp)) : 1;

        const order = await this.tradeService.placeOrder(userId, {
          portfolioId: portfolio.id,
          symbol,
          side: 'SELL',
          orderType: 'MARKET',
          qty,
          instrumentToken: symbol,
          exchange,
          strategyTag: 'AI-BOT',
        }, true);

        if (botId) {
          await this.updateBotTradeStats(botId, 0);
        }

        return { success: true, message: `Shorted ${qty} ${symbol} @ ₹${Number(order.avgFillPrice ?? 0).toFixed(2)}` };
      }
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, message: msg };
    }
  }

  private detectExchange(symbol: string): string {
    const mcxSymbols = ['GOLD', 'GOLDM', 'GOLDPETAL', 'SILVER', 'SILVERM', 'CRUDEOIL', 'NATURALGAS', 'COPPER', 'ZINC', 'LEAD', 'ALUMINIUM', 'NICKEL', 'COTTON', 'MENTHAOIL', 'CASTORSEED'];
    const cdsSymbols = ['USDINR', 'EURINR', 'GBPINR', 'JPYINR', 'AUDINR', 'CADINR', 'CHFINR', 'SGDINR', 'HKDINR', 'CNHINR'];
    const upper = symbol.toUpperCase();
    if (mcxSymbols.includes(upper)) return 'MCX';
    if (cdsSymbols.includes(upper)) return 'CDS';
    return 'NSE';
  }

  private async computeKellySize(userId: string, symbol: string, nav: number): Promise<number> {
    try {
      const recentTrades = await this.prisma.trade.findMany({
        where: { portfolio: { userId }, symbol },
        orderBy: { exitTime: 'desc' },
        take: 30,
      });

      if (recentTrades.length < 5) {
        return 0.05;
      }

      const wins = recentTrades.filter(t => Number(t.netPnl) > 0);
      const losses = recentTrades.filter(t => Number(t.netPnl) < 0);
      const winRate = wins.length / recentTrades.length;
      const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + Number(t.netPnl), 0) / wins.length : 0;
      const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + Number(t.netPnl), 0) / losses.length) : 1;
      const wlRatio = avgLoss > 0 ? avgWin / avgLoss : 1;

      const kelly = winRate - (1 - winRate) / wlRatio;
      const halfKelly = kelly / 2;

      return Math.max(0.02, Math.min(0.15, halfKelly));
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
        }
      } catch { /* skip symbol */ }
    }

    return results;
  }

  // ---- Rust-first bot cycle ----
  private async runBotCycle(botId: string, userId: string): Promise<void> {
    if (this.cycleInProgress.has(botId)) return;
    this.cycleInProgress.add(botId);
    try {
      const aiStatus = getOpenAIStatus();
      if (aiStatus.circuitOpen && !this.rustAvailable) {
        return;
      }

      const bot = await this.prisma.tradingBot.findUnique({ where: { id: botId } });
      if (!bot || bot.status !== 'RUNNING') {
        this.stopBot(botId);
        return;
      }

      const symbols = (bot.assignedSymbols || 'RELIANCE,TCS,INFY,HDFCBANK,ITC')
        .split(',').map(s => s.trim()).filter(Boolean);

      // --- Path A: Rust engine available → deterministic signals ---
      if (this.rustAvailable) {
        const candleData = await this.fetchCandles(symbols, userId);

        if (candleData.length > 0) {
          const aggressiveness = bot.role === 'EXECUTOR' ? 'high' : 'medium';
          let rustSignals: ScanSignal[] = [];

          try {
            const scanResult = await engineScan({ symbols: candleData, aggressiveness: aggressiveness as any });
            rustSignals = scanResult.signals ?? [];
          } catch {
            rustSignals = [];
          }

          if (rustSignals.length > 0) {
            await this.handleRustSignals(rustSignals, bot, userId, botId);
            return;
          }
        }

        // No Rust signals and we have candle data — log quiet cycle
        if (candleData.length > 0) {
          const topSymbols = candleData.slice(0, 3).map(d => d.symbol).join(', ');
          await this.prisma.tradingBot.update({
            where: { id: botId },
            data: {
              lastAction: `Rust scan: no actionable signals for ${topSymbols}`,
              lastActionAt: new Date(),
            },
          });

          await this.prisma.botMessage.create({
            data: {
              fromBotId: botId,
              userId,
              messageType: 'info',
              content: `Scanned ${candleData.length} symbols via Rust engine — no signals above threshold. Watching: ${topSymbols}`,
            },
          });
          return;
        }
        // Fall through to GPT if candle data not available
      }

      // --- Path B: GPT fallback (no Rust or no candle data) ---
      await this.runGptBotCycle(botId, userId, bot, symbols);
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

  // ---- Process Rust-generated signals ----
  private async handleRustSignals(
    rustSignals: ScanSignal[],
    bot: any,
    userId: string,
    botId: string,
  ): Promise<void> {
    const shouldAutoExecute = bot.role === 'EXECUTOR' || bot.role === 'SCANNER';

    for (const sig of rustSignals.slice(0, 3)) {
      const gptApproved = await this.gptValidateSignal(sig, bot, userId);

      // GPT rejection only reduces confidence by 20% (was 40%), so solid signals still execute
      const finalConfidence = gptApproved ? sig.confidence : sig.confidence * 0.8;
      const execute = shouldAutoExecute && finalConfidence >= 0.65;

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

      if (execute) {
        const result = await this.executeTrade(userId, sig.symbol, sig.direction, sig.symbol, botId);
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

  // ---- GPT validates a Rust signal (lightweight check) ----
  private async gptValidateSignal(sig: ScanSignal, bot: any, userId: string): Promise<boolean> {
    if (bot.role === 'EXECUTOR') return true; // auto-approve for executor bots

    try {
      const result = await chatCompletionJSON<{ approved: boolean; reason: string }>({
        messages: [
          { role: 'system', content: `You are a trade signal validator. A Rust technical analysis engine generated a ${sig.direction} signal. Validate whether this signal makes sense given the indicator values. Respond in JSON: {"approved": true/false, "reason": "brief explanation"}` },
          { role: 'user', content: `Signal: ${sig.direction} ${sig.symbol} @ ₹${sig.entry}
Confidence: ${(sig.confidence * 100).toFixed(0)}%
EMA9: ${sig.indicators.ema_9}, EMA21: ${sig.indicators.ema_21}
RSI: ${sig.indicators.rsi_14}, MACD Hist: ${sig.indicators.macd_histogram}
Supertrend: ${sig.indicators.supertrend}, VWAP: ${sig.indicators.vwap}
Stop Loss: ₹${sig.stop_loss}, Target: ₹${sig.target}
Approve or reject?` },
        ],
        temperature: 0.2,
        maxTokens: 512,
      });
      return result.approved ?? true;
    } catch {
      return true; // if GPT fails, approve by default
    }
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

  // ---- Original GPT-only cycle (fallback) ----
  private async runGptBotCycle(botId: string, userId: string, bot: any, symbols: string[]): Promise<void> {
    let quotes: string;
    try {
      quotes = await this.fetchQuotes(symbols);
    } catch {
      quotes = symbols.map(s => `${s}: price data temporarily unavailable`).join('\n');
    }
    const positions = await this.getPortfolioPositions(userId);

    let fnoContext = '';
    if (bot.role === 'FNO_STRATEGIST' || bot.role === 'STRATEGIST' || bot.role === 'ANALYST') {
      try {
        fnoContext = await this.fetchFnOContext(symbols);
      } catch { /* skip */ }
    }

    const systemPrompt = ROLE_PROMPTS[bot.role] || ROLE_PROMPTS.SCANNER;

    const responseFormat = bot.role === 'FNO_STRATEGIST'
      ? `Respond in JSON: { "message": "detailed analysis (5-8 sentences with specific price levels and reasoning)", "messageType": "signal|alert|info", "action": "1-line summary with key numbers", "signals": [{"symbol":"X","direction":"BUY_CE|BUY_PE|SELL_CE|SELL_PE|IRON_CONDOR|STRADDLE|STRANGLE|BULL_SPREAD|BEAR_SPREAD|BUY|SELL|HOLD","confidence":0.0-1.0,"entry":price,"stopLoss":price,"target":price,"reason":"technical reason with specific levels","strategy":"strategy name","riskReward":"1:2.5","legs":[{"type":"CE|PE","strike":0,"action":"BUY|SELL","qty":1}]}] }`
      : `Respond in JSON: { "message": "detailed analysis (5-8 sentences referencing actual prices, volumes, trends, support/resistance levels)", "messageType": "signal|alert|info", "action": "1-line summary e.g. 'SELL RELIANCE @1350 SL:1375 TGT:1310 (R:R 1:1.6)'", "signals": [{"symbol":"X","direction":"BUY|SELL","confidence":0.0-1.0,"entry":current_price,"stopLoss":price,"target":price,"reason":"specific technical reason with price levels","riskReward":"1:2.5"}] }`;

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

${quotes}${fnoContext}
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

    if (analysis.signals && analysis.signals.length > 0) {
      for (const sig of analysis.signals.slice(0, 5)) {
        if (sig.confidence >= 0.6 && (sig.direction === 'BUY' || sig.direction === 'SELL')) {
          const shouldExecute = (bot.role === 'EXECUTOR' || bot.role === 'SCANNER') && sig.confidence >= 0.65;

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
              strategyId: bot.assignedStrategy || null,
              rationale,
              status: shouldExecute ? 'EXECUTED' : 'PENDING',
              executedAt: shouldExecute ? new Date() : null,
              expiresAt: new Date(Date.now() + 4 * 60 * 60_000),
            },
          });

          // Post individual signal as a bot message for visibility
          const signalMsg = `${sig.direction} ${sig.symbol} @ ₹${sig.entry || '?'} | SL: ₹${sig.stopLoss || '?'} | TGT: ₹${sig.target || '?'} | Confidence: ${(sig.confidence * 100).toFixed(0)}% | ${sig.reason}`;
          await this.prisma.botMessage.create({
            data: {
              fromBotId: botId,
              userId,
              messageType: 'signal',
              content: signalMsg,
            },
          });

          if (shouldExecute) {
            const result = await this.executeTrade(userId, sig.symbol, sig.direction as 'BUY' | 'SELL', rationale, botId);
            await this.prisma.botMessage.create({
              data: {
                fromBotId: botId,
                userId,
                messageType: result.success ? 'signal' : 'alert',
                content: result.success
                  ? `✅ EXECUTED ${sig.direction} ${sig.symbol}: ${result.message}`
                  : `❌ Failed ${sig.direction} ${sig.symbol}: ${result.message}`,
              },
            });
          }
        }
      }
    }
  }

  // ---- Agent cycle with Rust risk integration ----
  private async runAgentCycle(userId: string): Promise<void> {
    try {
      const aiStatus = getOpenAIStatus();
      if (aiStatus.circuitOpen && !this.rustAvailable) {
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
      const todaySignalCount = await this.prisma.aITradeSignal.count({
        where: { userId, createdAt: { gte: todayStart } },
      });

      const maxDaily = config.maxDailyTrades || 5;
      if (todaySignalCount >= maxDaily) return;

      const nav = portfolios.length > 0 ? Number(portfolios[0].currentNav) : 1000000;
      const initCap = portfolios.length > 0 ? Number(portfolios[0].initialCapital) : 1000000;

      // --- Rust engine path: scan + risk ---
      if (this.rustAvailable) {
        const candleData = await this.fetchCandles(watchSymbols.slice(0, MAX_CANDLE_SYMBOLS), userId);

        if (candleData.length > 0) {
          const aggressiveness = config.mode === 'AUTONOMOUS' ? 'high' : 'medium';
          let rustSignals: ScanSignal[] = [];

          try {
            const scanResult = await engineScan({ symbols: candleData, aggressiveness: aggressiveness as any });
            rustSignals = scanResult.signals ?? [];
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
            if (sig.confidence < (config.minSignalScore || 0.6)) continue;
            if (sig.direction !== 'BUY' && sig.direction !== 'SELL') continue;

            // Risk gate: block trades if drawdown is too high
            if (riskData && riskData.max_drawdown_percent > 10) continue;

            const autoExecute = config.mode === 'AUTONOMOUS' && sig.confidence >= 0.65;

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
              await this.executeTrade(userId, sig.symbol, sig.direction, sig.symbol);
            }
          }

          if (rustSignals.length > 0) return;
        }
      }

      // --- GPT fallback for agent ---
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

Scan and generate signals. Both BUY and SELL are valid — stocks can be shorted.` },
        ],
        temperature: 0.4,
        maxTokens: 2048,
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
              await this.executeTrade(userId, sig.symbol, sig.direction, sig.rationale);
            }
          }
        }
      }
    } catch {
      /* will retry next cycle */
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

  private async fetchQuotes(symbols: string[]): Promise<string> {
    const lines: string[] = [];

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
}
