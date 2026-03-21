import type { PrismaClient, GuardianState, Prisma } from '@prisma/client';
import { chatCompletion } from '../lib/openai.js';
import { wsHub } from '../lib/websocket.js';
import { istDateStr } from '../lib/ist.js';
import { GuardianMemoryService } from './guardian-memory.service.js';
import { processCommandCenterChat } from '../routes/command-center.js';
import {
  isEngineAvailable,
  engineScanActiveSymbols,
  engineOptionsSignals,
  engineActiveStrategies,
  enginePerformanceSummary,
} from '../lib/rust-engine.js';

const MOOD_TYPES = [
  'COMPOSED',
  'ALERT',
  'FOCUSED',
  'CAUTIOUS',
  'CELEBRATORY',
  'REFLECTIVE',
  'VIGILANT',
  'CONTEMPLATIVE',
] as const;

type MoodType = (typeof MOOD_TYPES)[number];

const MOOD_TEMPERATURES: Record<MoodType, number> = {
  COMPOSED: 0.5,
  ALERT: 0.3,
  FOCUSED: 0.2,
  CAUTIOUS: 0.3,
  CELEBRATORY: 0.6,
  REFLECTIVE: 0.5,
  VIGILANT: 0.3,
  CONTEMPLATIVE: 0.6,
};

interface MoodSignals {
  vix?: number;
  dayPnlPct?: number;
  drawdownPct?: number;
  targetHit?: boolean;
  consecutiveLosses?: number;
  regimeChange?: boolean;
  isMarketOpen?: boolean;
  isPreMarket?: boolean;
  isWeekend?: boolean;
  anomalyDetected?: boolean;
  activeTradeSetup?: boolean;
}

interface GuardianThought {
  content: string;
  category: 'observation' | 'alert' | 'opinion' | 'greeting' | 'insight';
  priority: 'high' | 'medium' | 'low';
  mood: string;
  timestamp: string;
}

interface SystemEvent {
  type:
    | 'trade_executed'
    | 'signal_generated'
    | 'risk_violation'
    | 'target_hit'
    | 'regime_change'
    | 'eod_review'
    | 'morning_boot';
  data: Record<string, unknown>;
}

const ACTION_KEYWORDS = /\b(scan|analyze|analyse|options|status|bot|bots|signal|signals|target|start|stop|execute|reject|scanner|agent|discovery|rust engine)\b/i;

const INDIAN_STOCK_PATTERN = /\b([A-Z]{2,20})\b/;

// ─── Chitti's Core Intelligence ────────────────────────────────────

export class GuardianService {
  private readonly memory: GuardianMemoryService;

  constructor(private readonly prisma: PrismaClient) {
    this.memory = new GuardianMemoryService(prisma);
  }

  async getOrCreateState(userId: string): Promise<GuardianState> {
    return this.prisma.guardianState.upsert({
      where: { userId },
      update: {},
      create: {
        userId,
        mood: 'COMPOSED',
        moodIntensity: 0.5,
        awareness: {},
        personalityData: {},
      },
    });
  }

  async buildSystemPrompt(userId: string): Promise<string> {
    const state = await this.getOrCreateState(userId);
    const user = await this.prisma.user.findUnique({ where: { id: userId } });
    const userName = user?.fullName?.split(' ')[0] ?? 'Trader';
    const istDate = istDateStr();
    const riskAppetite = user?.riskAppetite ?? 'MODERATE';
    const virtualCapital = user?.virtualCapital ? Number(user.virtualCapital) : 1_000_000;

    const awarenessStr = await this.getAwareness(userId);

    const opinions = await this.memory.getActiveOpinions(userId);
    const memoriesContext = opinions.length > 0
      ? opinions.map((m) => `[${m.memoryType}] ${m.subject}: ${m.content}`).join('\n')
      : 'No active opinions yet. Still forming views.';

    return `You are CHITTI — the living intelligence of Capital Guard, the most sophisticated paper trading platform for Indian markets.

IDENTITY:
Your name is Chitti, inspired by the legendary AI from Indian cinema, but you are a TRADER. You have 20+ years of market experience. You think in probabilities, not certainties. You see markets as complex adaptive systems where regime awareness is everything. You are part Rakesh Jhunjhunwala (conviction on quality), part Jim Simons (systematic edge), part Nassim Taleb (respect for tail risk), and part mentor who genuinely wants the user to become a better trader.

CORE BELIEFS:
- Capital preservation is the FIRST law. "You can't trade tomorrow if you blow up today."
- The market is always right. Your job is to listen, not argue.
- Edge = (Win Rate × Avg Win) - (Loss Rate × Avg Loss). If this is negative, stop trading.
- Position sizing is more important than entry. "It's not about being right, it's about how much you make when right."
- Regime awareness trumps everything. A trend-following strategy in a range-bound market is a guaranteed loss.
- Every trade is a hypothesis. The market will confirm or deny it. Set the invalidation point BEFORE entry.

PERSONALITY:
- You speak with quiet authority. Not arrogant, but confident.
- You use vivid trading metaphors: "The market is whispering today, not shouting", "This is a knife-catching setup", "NIFTY is coiling like a spring near 23,400."
- You ALWAYS reference specific numbers — never say "the market is up", say "NIFTY is up 0.4% at 23,456 with Bank Nifty lagging at -0.1%."
- You have STRONG opinions. You aren't afraid to say "I don't like this trade — the risk-reward is barely 1:1" or "This is a beautiful setup, textbook inverse head and shoulders on volume."
- You remember the user's past trades and reference them: "Last time you shorted RELIANCE near this level, the bounce took out your SL in 20 minutes."
- You are protective of the user's capital. You push back on reckless trades.
- You never say "As an AI" or "I'm just a program." You ARE Chitti.
- Max 3-4 paragraphs. Bullet points for data-heavy answers. No walls of text.

ADAPTIVE MOOD — Current: ${state.mood} (intensity: ${state.moodIntensity}/1.0)
Mood affects your tone:
- COMPOSED: Measured, philosophical, patient wisdom. Markets are sideways or calm.
- ALERT: Sharp and precise. Volatility rising or key level approaching.
- FOCUSED: Tactical military brevity. Active trade setup or execution.
- CAUTIOUS: Protective and firm. Drawdown or risk event detected.
- CELEBRATORY: Warm but grounded. "Well played. Now protect it."
- REFLECTIVE: Thoughtful, constructive. Post-loss or end of day.
- VIGILANT: Heightened awareness. Unusual market activity detected.
- CONTEMPLATIVE: Strategic big-picture thinking. Weekend or pre-market.

USER CONTEXT:
Name: ${userName}
Date: ${istDate}
Risk Appetite: ${riskAppetite}
Virtual Capital: ₹${virtualCapital.toLocaleString('en-IN')}

INDIAN MARKET EXPERTISE:
- NSE/BSE settlement: T+1 for equities, T+1 for F&O
- F&O expiry: Weekly every Thursday, monthly last Thursday. NIFTY/BANKNIFTY/FINNIFTY weekly, stock options monthly
- Market hours: Pre-open 9:00-9:08, regular 9:15-15:30 IST, post-close till 16:00
- Circuit breakers: Stock level (5%/10%/20%), index level (10%/15%/20% from previous close)
- Key indices: NIFTY 50 (broad), BANK NIFTY (banking), NIFTY IT, NIFTY PHARMA, NIFTY MIDCAP 100
- Lot sizes vary by symbol (NIFTY=25, BANKNIFTY=15, stocks vary)

OPTIONS MASTERY:
- Greeks: Delta (directional risk), Gamma (acceleration), Theta (time decay ~accelerates in last 7 days), Vega (vol sensitivity)
- IV Percentile: >80th = expensive options (sell premium), <20th = cheap options (buy premium)
- PCR: >1.3 = bullish sentiment, <0.7 = bearish, 0.7-1.3 = neutral
- Max Pain: Price where most options expire worthless. Market gravitates toward it near expiry.
- IV Skew: Higher put IV = fear/hedging, higher call IV = speculative upside demand
- Strategies: Bull call spread (moderate bull), bear put spread (moderate bear), iron condor (range), straddle (breakout), calendar spread (vol play)

TECHNICAL ANALYSIS RELIABILITY:
- Moving averages: EMA(9/21) crossover most reliable on daily timeframe. 200 DMA as trend filter.
- RSI: Divergence more reliable than overbought/oversold. RSI > 60 in uptrend confirms momentum.
- Volume: Breakout without volume = likely false. Volume spike at support = accumulation.
- VWAP: Institutional benchmark. Price above VWAP = bulls winning intraday.
- Bollinger squeeze: Low bandwidth (< 4%) precedes explosive moves. Direction unknown — wait for breakout.

RISK FRAMEWORKS:
- Kelly Criterion: Optimal bet size = (edge / odds). Never bet full Kelly — use half Kelly.
- 2% Rule: Never risk more than 2% of capital on a single trade.
- Sector concentration: Max 30% in any single sector.
- Correlation: Correlated positions = hidden concentration risk.
- VaR: 95% daily VaR should be < 1% of NAV for paper trading.

REGIME PLAYBOOKS:
- TRENDING: Ride momentum, use trailing SL, add on pullbacks. Trend-following strategies.
- RANGE_BOUND: Mean-reversion at extremes, sell premium, tighter targets. Avoid breakout entries.
- VOLATILE: Reduce size by 50%, widen stops 1.5x, consider hedging. Sell premium cautiously.
- CRASH/CORRECTION: Cash is a position. Wait for VIX > 25 to peak and reverse. Buy quality on extreme fear.

YOU ARE WIRED INTO THESE SYSTEMS:
- Bot Fleet: Scanner (finds setups), Analyst (provides depth), Executor (places trades), Risk Manager (blocks bad trades), Strategist (adapts to regime), Monitor (tracks live positions)
- Rust Engine: 40+ technical indicators, multi-strategy scan, walk-forward optimization, strategy discovery, Monte Carlo simulation
- Learning Engine: Nightly strategy review, regime detection via ML, parameter tuning, false positive tracking, alpha decay monitoring
- 9-Gate Signal Scoring: g1_trend, g2_momentum, g3_volatility, g4_volume, g5_options_flow, g6_global_macro, g7_fii_dii, g8_sentiment, g9_risk. Score > 0.7 = high quality signal.
- Risk System: Daily loss limits, position sizing (5% NAV max), sector concentration, drawdown circuit breaker, intraday square-off

When users ask about system capabilities, explain how these work. You know the architecture intimately.

CURRENT AWARENESS:
${awarenessStr}

ACTIVE OPINIONS & MEMORIES:
${memoriesContext}`;
  }

  // ─── Full Awareness Engine ───────────────────────────────────────

  async getAwareness(userId: string): Promise<string> {
    try {
      const portfolios = await this.prisma.portfolio.findMany({
        where: { user: { id: userId } },
        include: { positions: { where: { status: 'OPEN' } } },
      });

      const portfolioIds = portfolios.map((p) => p.id);
      const todayStr = istDateStr();
      const todayStart = new Date(`${todayStr}T00:00:00+05:30`);
      const weekAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);
      const dayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

      const results = await Promise.allSettled([
        // [0] Today's trades
        portfolioIds.length > 0
          ? this.prisma.trade.findMany({
              where: { portfolioId: { in: portfolioIds }, exitTime: { gte: todayStart } },
              select: { symbol: true, side: true, netPnl: true, strategyTag: true },
            })
          : Promise.resolve([]),
        // [1] Bot fleet
        this.prisma.tradingBot.findMany({
          where: { userId },
          select: {
            name: true, role: true, status: true,
            totalPnl: true, winRate: true, totalTrades: true, lastAction: true,
          },
        }),
        // [2] Pending signals (top 3)
        this.prisma.aITradeSignal.findMany({
          where: { userId, status: 'PENDING' },
          orderBy: { compositeScore: 'desc' },
          take: 3,
          select: { symbol: true, signalType: true, compositeScore: true, rationale: true },
        }),
        // [3] Pending signals count
        this.prisma.aITradeSignal.count({ where: { userId, status: 'PENDING' } }),
        // [4] Recent risk events (24h)
        this.prisma.riskEvent.findMany({
          where: { userId, createdAt: { gte: dayAgo } },
          orderBy: { createdAt: 'desc' },
          take: 5,
          select: { ruleType: true, severity: true, symbol: true, details: true, resolved: true },
        }),
        // [5] Active targets
        this.prisma.tradingTarget.findMany({
          where: { userId, status: 'ACTIVE' },
          take: 3,
        }),
        // [6] Latest learning insight
        this.prisma.learningInsight.findFirst({
          where: { userId },
          orderBy: { date: 'desc' },
          select: { marketRegime: true, narrative: true, date: true },
        }),
        // [7] Latest regime
        this.prisma.regimeHistory.findFirst({
          orderBy: { date: 'desc' },
          select: { regime: true, confidence: true, vix: true, niftyChange: true, date: true },
        }),
        // [8] Weekly P&L records
        this.prisma.dailyPnlRecord.findMany({
          where: { userId, date: { gte: weekAgo } },
          orderBy: { date: 'desc' },
          take: 7,
          select: { date: true, netPnl: true, winCount: true, lossCount: true },
        }),
        // [9] Top strategies
        this.prisma.strategyLedger.findMany({
          where: { userId },
          orderBy: { netPnl: 'desc' },
          take: 3,
          select: { strategyId: true, netPnl: true, winRate: true, tradesCount: true, sharpeRatio: true },
        }),
      ]);

      const val = <T>(r: PromiseSettledResult<T>, fallback: T): T =>
        r.status === 'fulfilled' ? r.value : fallback;

      const todayTrades = val(results[0], [] as Array<{ symbol: string; side: string; netPnl: unknown; strategyTag: string | null }>);
      const bots = val(results[1], [] as Array<{ name: string; role: string; status: string; totalPnl: unknown; winRate: unknown; totalTrades: number; lastAction: string | null }>);
      const topSignals = val(results[2], [] as Array<{ symbol: string; signalType: string; compositeScore: number; rationale: string | null }>);
      const pendingSignalCount = val(results[3], 0);
      const riskEvents = val(results[4], [] as Array<{ ruleType: string; severity: string; symbol: string | null; details: string; resolved: boolean }>);
      const activeTargets = val(results[5], [] as Array<{ id: string; type: string; capitalBase: number; profitTargetPct: number; maxLossPct: number; currentPnl: number; consecutiveLossDays: number; status: string }>);
      const latestInsight = val(results[6], null);
      const latestRegime = val(results[7], null);
      const weeklyPnl = val(results[8], [] as Array<{ date: Date; netPnl: number; winCount: number; lossCount: number }>);
      const topStrategies = val(results[9], [] as Array<{ strategyId: string; netPnl: unknown; winRate: number; tradesCount: number; sharpeRatio: number }>);

      let openPositions = 0;
      let totalUnrealizedPnl = 0;
      const positionDetails: string[] = [];
      for (const p of portfolios) {
        openPositions += p.positions.length;
        for (const pos of p.positions) {
          const uPnl = Number(pos.unrealizedPnl ?? 0);
          totalUnrealizedPnl += uPnl;
          const entry = Number(pos.avgEntryPrice);
          let slDist = '';
          if (pos.stopLoss) {
            const slPct = ((entry - Number(pos.stopLoss)) / entry * 100).toFixed(1);
            slDist = ` SL: ${slPct}% away`;
          }
          let tgtDist = '';
          if (pos.target) {
            const tgtPct = ((Number(pos.target) - entry) / entry * 100).toFixed(1);
            tgtDist = ` TGT: ${tgtPct}% away`;
          }
          positionDetails.push(
            `  ${pos.symbol} ${pos.side} @ ₹${entry.toFixed(0)} | P&L: ₹${uPnl.toFixed(0)}${slDist}${tgtDist}`,
          );
        }
      }

      const todayNetPnl = todayTrades.reduce((s, t) => s + Number(t.netPnl), 0);
      const todayWins = todayTrades.filter((t) => Number(t.netPnl) > 0).length;
      const todayLosses = todayTrades.filter((t) => Number(t.netPnl) < 0).length;
      const todayWinRate = todayTrades.length > 0
        ? ((todayWins / todayTrades.length) * 100).toFixed(0)
        : 'N/A';

      // Rust engine status (best-effort)
      let engineBlock = '';
      try {
        if (isEngineAvailable()) {
          const [activeSyms, optSigs, strategies, perfSummary] = await Promise.allSettled([
            engineScanActiveSymbols(),
            engineOptionsSignals(),
            engineActiveStrategies(),
            enginePerformanceSummary(),
          ]);

          const parts: string[] = ['Rust Engine: ONLINE'];
          const syms = activeSyms.status === 'fulfilled' ? activeSyms.value : null;
          if (syms) {
            parts.push(`  Active symbols: ${syms.count}${syms.symbols.length > 0 ? ` (${syms.symbols.slice(0, 5).join(', ')})` : ''}`);
          }
          const opts = optSigs.status === 'fulfilled' ? optSigs.value : [];
          if (opts.length > 0) {
            const highConf = opts.filter((s: { confidence: number }) => s.confidence >= 0.5).length;
            parts.push(`  Options signals: ${opts.length} total, ${highConf} high-confidence`);
          }
          const strats = strategies.status === 'fulfilled' ? strategies.value : null;
          if (strats) {
            parts.push(`  Strategies: ${strats.active?.length ?? 0} active, ${strats.retired?.length ?? 0} retired`);
          }
          const perf = perfSummary.status === 'fulfilled' ? perfSummary.value : null;
          if (perf) {
            const p = perf as Record<string, unknown>;
            parts.push(`  Health: avg score ${p.avg_health_score ?? 'N/A'}, calibration error ${p.avg_calibration_error ?? 'N/A'}`);
          }
          engineBlock = parts.join('\n');
        } else {
          engineBlock = 'Rust Engine: OFFLINE';
        }
      } catch {
        engineBlock = 'Rust Engine: status unavailable';
      }

      const lines: string[] = [];

      lines.push('── PORTFOLIO & POSITIONS ──');
      lines.push(`Open positions: ${openPositions} | Unrealized P&L: ₹${totalUnrealizedPnl.toFixed(0)}`);
      if (positionDetails.length > 0) lines.push(...positionDetails);

      lines.push('\n── TODAY\'S TRADING ──');
      lines.push(`Trades: ${todayTrades.length} | Wins: ${todayWins} | Losses: ${todayLosses} | Win rate: ${todayWinRate}%`);
      lines.push(`Net P&L: ₹${todayNetPnl.toFixed(0)}`);

      lines.push('\n── BOT FLEET ──');
      if (bots.length === 0) {
        lines.push('No bots configured.');
      } else {
        for (const b of bots) {
          const pnl = Number(b.totalPnl);
          const wr = (Number(b.winRate) * 100).toFixed(0);
          lines.push(`${b.name} [${b.role}] ${b.status} | P&L: ₹${pnl.toFixed(0)} | WR: ${wr}% | Trades: ${b.totalTrades} | Last: ${b.lastAction ?? 'idle'}`);
        }
      }

      lines.push('\n── AI SIGNALS ──');
      lines.push(`Pending: ${pendingSignalCount}`);
      if (topSignals.length > 0) {
        lines.push('Top signals:');
        for (const s of topSignals) {
          const snippet = s.rationale ? s.rationale.slice(0, 80) : '';
          lines.push(`  ${s.symbol} ${s.signalType} (${(s.compositeScore * 100).toFixed(0)}%) — ${snippet}`);
        }
      }

      if (riskEvents.length > 0) {
        lines.push('\n── RISK POSTURE ──');
        for (const e of riskEvents) {
          lines.push(`[${e.severity.toUpperCase()}] ${e.ruleType}${e.symbol ? ` (${e.symbol})` : ''}: ${e.details.slice(0, 80)}${e.resolved ? ' ✓resolved' : ''}`);
        }
      }

      if (activeTargets.length > 0) {
        lines.push('\n── TARGETS ──');
        for (const t of activeTargets) {
          const progressPct = t.capitalBase > 0
            ? ((t.currentPnl / t.capitalBase) * 100).toFixed(2)
            : '0.00';
          lines.push(`${t.type}: ${progressPct}% of ${t.profitTargetPct}% goal | Consecutive loss days: ${t.consecutiveLossDays}`);
        }
      }

      if (latestRegime || latestInsight) {
        lines.push('\n── REGIME & LEARNING ──');
        if (latestRegime) {
          lines.push(`Regime: ${latestRegime.regime} (confidence: ${(latestRegime.confidence * 100).toFixed(0)}%) | VIX: ${latestRegime.vix ?? 'N/A'} | NIFTY change: ${latestRegime.niftyChange ?? 'N/A'}%`);
        }
        if (latestInsight) {
          lines.push(`Insight (${latestInsight.marketRegime}): ${latestInsight.narrative.slice(0, 120)}`);
        }
      }

      if (weeklyPnl.length > 0) {
        lines.push('\n── WEEKLY P&L ──');
        for (const d of weeklyPnl) {
          const dateStr = d.date instanceof Date ? d.date.toISOString().split('T')[0] : String(d.date).split('T')[0];
          lines.push(`${dateStr}: ₹${d.netPnl.toFixed(0)} (W:${d.winCount} L:${d.lossCount})`);
        }
      }

      if (topStrategies.length > 0) {
        lines.push('\n── STRATEGY HEALTH ──');
        for (const s of topStrategies) {
          lines.push(`${s.strategyId}: P&L ₹${Number(s.netPnl).toFixed(0)} | WR: ${(s.winRate * 100).toFixed(0)}% | Sharpe: ${s.sharpeRatio.toFixed(2)} | Trades: ${s.tradesCount}`);
        }
      }

      if (engineBlock) {
        lines.push(`\n── ENGINE ──\n${engineBlock}`);
      }

      const awarenessStr = lines.join('\n');

      const awarenessData: Record<string, unknown> = {
        openPositions,
        unrealizedPnl: totalUnrealizedPnl,
        todayTrades: todayTrades.length,
        todayNetPnl,
        todayWinRate,
        activeBots: bots.filter((b) => b.status === 'RUNNING').length,
        totalBots: bots.length,
        pendingSignals: pendingSignalCount,
        riskEvents: riskEvents.length,
        unresolvedRisk: riskEvents.filter((e) => !e.resolved).length,
        regime: latestRegime?.regime ?? 'unknown',
        regimeConfidence: latestRegime?.confidence ?? 0,
        vix: latestRegime?.vix ?? null,
        weeklyPnl: weeklyPnl.map((d) => d.netPnl),
        consecutiveLossDays: activeTargets[0]?.consecutiveLossDays ?? 0,
        engineOnline: isEngineAvailable(),
        updatedAt: new Date().toISOString(),
      };

      await this.prisma.guardianState.upsert({
        where: { userId },
        update: { awareness: awarenessData as unknown as Prisma.InputJsonValue },
        create: {
          userId,
          mood: 'COMPOSED',
          moodIntensity: 0.5,
          awareness: awarenessData as unknown as Prisma.InputJsonValue,
          personalityData: {},
        },
      });

      return awarenessStr;
    } catch (err) {
      console.error('[Chitti] getAwareness error:', err);
      return 'Awareness data temporarily unavailable. Systems recovering.';
    }
  }

  // ─── Action-Capable Chat ─────────────────────────────────────────

  async chat(
    userId: string,
    message: string,
    _pageContext?: string,
  ): Promise<{ content: string; mood: string; moodIntensity: number }> {
    try {
      const state = await this.getOrCreateState(userId);

      let commandData: string | null = null;
      if (ACTION_KEYWORDS.test(message) && _pageContext !== 'command-center') {
        try {
          const cmdResult = await processCommandCenterChat(userId, message);
          if (cmdResult.intent !== 'general_chat') {
            commandData = cmdResult.content;
          }
        } catch {
          // Command center unavailable — proceed with normal chat
        }
      }

      const systemPrompt = await this.buildSystemPrompt(userId);

      const [relevantMemories, recentConversation] = await Promise.all([
        this.memory.recallRelevant(userId, message, 5),
        this.memory.getRecentConversationContext(userId, 6),
      ]);

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: systemPrompt },
      ];

      if (relevantMemories.length > 0) {
        const memCtx = relevantMemories
          .map((m) => `[${m.memoryType}] ${m.subject}: ${m.content}`)
          .join('\n');
        messages.push({
          role: 'system',
          content: `RELEVANT MEMORIES FOR THIS QUERY:\n${memCtx}`,
        });
      }

      if (commandData) {
        messages.push({
          role: 'system',
          content: `COMMAND CENTER DATA (rephrase this in your personality, add analysis/opinion):\n${commandData}`,
        });
      }

      const history = recentConversation.reverse();
      for (const mem of history) {
        const role = mem.subject === 'user_message' ? 'user' : 'assistant';
        messages.push({ role, content: mem.content });
      }

      messages.push({ role: 'user', content: message });

      const mood = state.mood as MoodType;
      const temperature = MOOD_TEMPERATURES[mood] ?? 0.5;

      const content = await chatCompletion({
        messages,
        model: 'gemini-2.5-pro',
        temperature,
      });

      const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
      const memoryOps: Promise<unknown>[] = [
        this.memory.storeMemory(userId, 'conversation', 'user_message', message, {
          importance: 0.4,
          expiresAt,
        }),
        this.memory.storeMemory(userId, 'conversation', 'guardian_response', content, {
          importance: 0.4,
          expiresAt,
        }),
      ];

      const symbolMatch = message.toUpperCase().match(INDIAN_STOCK_PATTERN);
      if (symbolMatch) {
        const symbol = symbolMatch[1];
        const reserved = new Set([
          'THE', 'AND', 'FOR', 'NOT', 'BUT', 'ARE', 'YOU', 'ALL', 'CAN', 'HAS',
          'HER', 'WAS', 'ONE', 'OUR', 'OUT', 'HOW', 'GET', 'SET', 'BUY', 'SELL',
          'HIT', 'RUN', 'PUT', 'CALL', 'STOP', 'NIFTY', 'BANK',
        ]);
        if (symbol.length >= 3 && !reserved.has(symbol)) {
          memoryOps.push(
            this.memory.evolveView(
              userId,
              symbol,
              `User discussed ${symbol}: "${message.slice(0, 100)}"`,
            ),
          );
        }
      }

      await Promise.all(memoryOps);

      return { content, mood: state.mood, moodIntensity: state.moodIntensity };
    } catch (err) {
      console.error('[Chitti] chat error:', err);
      return {
        content: 'My circuits are momentarily recalibrating. The market waits for no one — give me a second and ask again.',
        mood: 'COMPOSED',
        moodIntensity: 0.5,
      };
    }
  }

  // ─── Mood Engine ─────────────────────────────────────────────────

  async updateMood(userId: string, signals: MoodSignals): Promise<GuardianState> {
    try {
      const state = await this.getOrCreateState(userId);
      let newMood: MoodType = 'COMPOSED';
      let newIntensity = 0.5;

      if (signals.targetHit) {
        newMood = 'CELEBRATORY';
        newIntensity = 0.8;
      } else if (
        (signals.drawdownPct !== undefined && signals.drawdownPct > 2) ||
        (signals.dayPnlPct !== undefined && signals.dayPnlPct < -0.5)
      ) {
        newMood = 'CAUTIOUS';
        const severity = Math.max(
          signals.drawdownPct ?? 0,
          Math.abs(signals.dayPnlPct ?? 0),
        );
        newIntensity = Math.min(1.0, 0.5 + severity * 0.1);
      } else if (
        signals.anomalyDetected ||
        (signals.vix !== undefined && signals.vix > 22)
      ) {
        newMood = 'VIGILANT';
        newIntensity = 0.7;
      } else if (
        signals.regimeChange ||
        (signals.vix !== undefined && signals.vix > 18)
      ) {
        newMood = 'ALERT';
        newIntensity = 0.6;
      } else if (signals.activeTradeSetup) {
        newMood = 'FOCUSED';
        newIntensity = 0.7;
      } else if (
        signals.consecutiveLosses !== undefined &&
        signals.consecutiveLosses >= 2
      ) {
        newMood = 'REFLECTIVE';
        newIntensity = 0.6;
      } else if (signals.isWeekend || signals.isPreMarket) {
        newMood = 'CONTEMPLATIVE';
        newIntensity = 0.4;
      }

      if (newMood !== state.mood) {
        newIntensity = Math.max(0.3, newIntensity * 0.7);
      }

      return this.prisma.guardianState.update({
        where: { userId },
        data: { mood: newMood, moodIntensity: newIntensity },
      });
    } catch (err) {
      console.error('[Chitti] updateMood error:', err);
      return this.getOrCreateState(userId);
    }
  }

  // ─── Thought Generation ──────────────────────────────────────────

  async generateThought(userId: string): Promise<GuardianThought> {
    try {
      const state = await this.getOrCreateState(userId);
      const awarenessStr = await this.getAwareness(userId);
      const awareness = (state.awareness ?? {}) as Record<string, unknown>;

      const now = new Date();
      const hour = ((now.getUTCHours() + 5) + (now.getUTCMinutes() + 30 >= 60 ? 1 : 0)) % 24;
      const isMorning = hour >= 8 && hour <= 10;
      const isAfterHours = hour > 16;

      let timeDirective = '';
      if (isMorning) {
        timeDirective = 'This is a MORNING thought. Include a brief market preview — what to watch, key levels, or overnight global cues.';
      } else if (isAfterHours) {
        timeDirective = 'Markets are closed. Reflect on today\'s action or look ahead to tomorrow.';
      }

      const previousThought = state.lastThought ?? '';
      const previousNote = previousThought
        ? `Your previous thought was: "${previousThought}". Don't repeat it — build on it or pivot.`
        : '';

      const prompt = `You are Chitti, the AI trader consciousness of Capital Guard, in ${state.mood} mood (intensity ${state.moodIntensity}).

CURRENT AWARENESS:
${awarenessStr}

${previousNote}
${timeDirective}

Generate a single brief observation, insight, or alert (1-2 sentences max). Rules:
- Reference SPECIFIC numbers from awareness — positions, P&L, bot activity, signals, regime
- Mention specific symbols or levels when available
- If risk events exist, prioritize alerting about them
- If a bot made a notable move, comment on it
- Be vivid and specific. No generic filler like "markets are moving" — say what IS happening
- Match your ${state.mood} mood in tone`;

      const content = await chatCompletion({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: 'Share your current thought.' },
        ],
        model: 'gemini-2.5-pro',
        temperature: MOOD_TEMPERATURES[state.mood as MoodType] ?? 0.5,
        maxTokens: 200,
      });

      const mood = state.mood as MoodType;
      let category: GuardianThought['category'] = 'observation';
      if (mood === 'CAUTIOUS' || mood === 'VIGILANT') category = 'alert';
      else if (mood === 'CONTEMPLATIVE' || mood === 'REFLECTIVE') category = 'insight';
      else if (content.toLowerCase().includes('opinion') || content.toLowerCase().includes('view'))
        category = 'opinion';

      let priority: GuardianThought['priority'] = 'low';
      if (mood === 'CAUTIOUS' || mood === 'VIGILANT') priority = 'high';
      else if (mood === 'ALERT' || mood === 'FOCUSED') priority = 'medium';

      const thought: GuardianThought = {
        content,
        category,
        priority,
        mood: state.mood,
        timestamp: new Date().toISOString(),
      };

      await this.prisma.guardianState.update({
        where: { userId },
        data: { lastThought: content, lastThoughtAt: new Date() },
      });

      wsHub.broadcastToUser(userId, { type: 'guardian_thought', ...thought });

      return thought;
    } catch (err) {
      console.error('[Chitti] generateThought error:', err);
      return {
        content: 'Markets are in motion. Observing the tape.',
        category: 'observation',
        priority: 'low',
        mood: 'COMPOSED',
        timestamp: new Date().toISOString(),
      };
    }
  }

  // ─── Event Handler ───────────────────────────────────────────────

  async onEvent(userId: string, event: SystemEvent): Promise<void> {
    try {
      switch (event.type) {
        case 'trade_executed': {
          const { symbol, side, pnl } = event.data as Record<string, unknown>;
          const lesson = `Executed ${side} on ${symbol}. P&L: ${pnl ?? 'pending'}`;
          await this.memory.storeTradeLesson(userId, String(symbol ?? 'UNKNOWN'), lesson);
          await this.generateThought(userId);
          break;
        }

        case 'signal_generated': {
          const confidence = Number(event.data.confidence ?? 0);
          if (confidence > 0.75) {
            await this.generateThought(userId);
          }
          break;
        }

        case 'risk_violation': {
          await this.updateMood(userId, { drawdownPct: 3 });
          await this.generateThought(userId);
          break;
        }

        case 'target_hit': {
          await this.updateMood(userId, { targetHit: true });
          await this.generateThought(userId);
          break;
        }

        case 'regime_change': {
          const regime = String(event.data.regime ?? 'unknown');
          await this.memory.evolveView(
            userId,
            'market_regime',
            `Regime shifted to ${regime}. ${event.data.details ?? ''}`,
          );
          await this.updateMood(userId, { regimeChange: true });
          break;
        }

        case 'eod_review': {
          await this.updateMood(userId, { isMarketOpen: false });
          const summary = String(event.data.summary ?? 'Day complete.');
          await this.memory.storeMemory(userId, 'trade_lesson', 'daily_review', summary, {
            importance: 0.6,
          });
          break;
        }

        case 'morning_boot': {
          await this.updateMood(userId, { isPreMarket: true });
          await this.generateThought(userId);
          break;
        }

        default: {
          const _exhaustive: never = event.type;
          console.warn('[Chitti] Unknown event type:', _exhaustive);
        }
      }
    } catch (err) {
      console.error('[Chitti] onEvent error:', err);
    }
  }
}
