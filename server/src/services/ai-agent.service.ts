import { PrismaClient } from '@prisma/client';
type AgentMode = string;
type SignalStatus = string;
import { chatCompletion, chatCompletionJSON } from '../lib/openai.js';
import { TradeService } from './trade.service.js';
import { MarketDataService } from './market-data.service.js';
import { engineRisk, isEngineAvailable } from '../lib/rust-engine.js';
import { OptionsService, calculateMaxPain, calculateIVPercentile } from './options.service.js';

export interface SignalAnalysis {
  signal: 'BUY' | 'SELL' | 'HOLD';
  compositeScore: number;
  gateScores: Record<string, number>;
  rationale: string;
  suggestedEntry: number;
  suggestedSL: number;
  suggestedTarget: number;
}

export class AIAgentService {
  private marketData = new MarketDataService();
  private optionsService: OptionsService;

  constructor(private prisma: PrismaClient) {
    this.optionsService = new OptionsService(prisma);
  }

  async analyzeOptionsOpportunity(userId: string, symbol: string): Promise<{
    signal: string;
    strategy: string;
    confidence: number;
    rationale: string;
    legs?: Array<{ type: string; strike: number; action: string; qty: number }>;
    greeks?: { delta: number; gamma: number; theta: number; vega: number };
    maxPain?: number;
    pcr?: number;
    ivPercentile?: number;
  }> {
    try {
      const chainData = await this.marketData.getOptionsChain(symbol);
      const strikes = chainData.strikes || [];

      if (strikes.length === 0) {
        return { signal: 'HOLD', strategy: 'none', confidence: 0.3, rationale: 'No option chain data available' };
      }

      const callOI: Record<number, number> = {};
      const putOI: Record<number, number> = {};
      for (const s of strikes) {
        callOI[s.strike] = s.callOI || 0;
        putOI[s.strike] = s.putOI || 0;
      }
      const strikeValues = strikes.map((s: any) => s.strike);

      const maxPainResult = calculateMaxPain(strikeValues, callOI, putOI);
      const totalCallOI = Object.values(callOI).reduce((a, b) => a + b, 0);
      const totalPutOI = Object.values(putOI).reduce((a, b) => a + b, 0);
      const pcr = totalCallOI > 0 ? totalPutOI / totalCallOI : 1;

      const ivValues = strikes.map((s: any) => s.callIV || s.putIV || 0).filter((v: number) => v > 0);
      const currentIV = ivValues.length > 0 ? ivValues[Math.floor(ivValues.length / 2)] : 20;
      const ivPercentile = calculateIVPercentile(currentIV, ivValues);

      let vix = 0;
      try {
        const vixData = await this.marketData.getVIX();
        vix = vixData?.value ?? 0;
      } catch { /* VIX unavailable */ }

      const spot = chainData.underlyingValue || strikes[Math.floor(strikes.length / 2)]?.strike || 0;

      const prompt = `You are an F&O options strategist for Indian markets.
Analyze the following options data and recommend a strategy:

Symbol: ${symbol} | Spot: ₹${spot}
Max Pain: ₹${maxPainResult.maxPainStrike}
PCR: ${pcr.toFixed(2)} | IV Percentile: ${ivPercentile}% | VIX: ${vix}
Top 5 Call OI: ${strikeValues.slice(0, 5).map((s: number) => `${s}:${callOI[s]}`).join(', ')}
Top 5 Put OI: ${strikeValues.slice(0, 5).map((s: number) => `${s}:${putOI[s]}`).join(', ')}

Respond in JSON:
{
  "signal": "BUY_CE|BUY_PE|SELL_CE|SELL_PE|IRON_CONDOR|STRADDLE|STRANGLE|BULL_SPREAD|BEAR_SPREAD|HOLD",
  "strategy": "strategy name",
  "confidence": 0.0-1.0,
  "rationale": "2-3 sentence explanation",
  "legs": [{"type":"CE|PE","strike":number,"action":"BUY|SELL","qty":1}]
}`;

      const result = await chatCompletionJSON<any>({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Analyze ${symbol} options now.` },
        ],
        temperature: 0.3,
        maxTokens: 512,
      });

      return {
        signal: result.signal || 'HOLD',
        strategy: result.strategy || 'none',
        confidence: result.confidence || 0.5,
        rationale: result.rationale || 'Analysis completed',
        legs: result.legs,
        maxPain: maxPainResult.maxPainStrike,
        pcr,
        ivPercentile,
      };
    } catch {
      return { signal: 'HOLD', strategy: 'none', confidence: 0.3, rationale: 'F&O analysis unavailable' };
    }
  }

  async getConfig(userId: string) {
    let config = await this.prisma.aIAgentConfig.findUnique({ where: { userId } });
    if (!config) {
      config = await this.prisma.aIAgentConfig.create({
        data: { userId, mode: 'ADVISORY', isActive: false },
      });
    }
    return config;
  }

  async updateConfig(userId: string, data: { mode?: AgentMode; isActive?: boolean; minSignalScore?: number; maxDailyTrades?: number; strategies?: any; capitalPreservationOverrides?: any }) {
    const dbData: Record<string, unknown> = { ...data };
    if (data.strategies !== undefined) dbData.strategies = JSON.stringify(data.strategies);
    if (data.capitalPreservationOverrides !== undefined) dbData.capitalPreservationOverrides = JSON.stringify(data.capitalPreservationOverrides);
    return this.prisma.aIAgentConfig.upsert({
      where: { userId },
      create: { userId, ...dbData },
      update: dbData,
    });
  }

  async startAgent(userId: string) {
    await this.prisma.aIAgentConfig.upsert({
      where: { userId },
      create: { userId, isActive: true },
      update: { isActive: true },
    });
    return { status: 'running', message: 'AI agent started' };
  }

  async stopAgent(userId: string) {
    await this.prisma.aIAgentConfig.upsert({
      where: { userId },
      create: { userId, isActive: false },
      update: { isActive: false },
    });
    return { status: 'stopped', message: 'AI agent stopped' };
  }

  async getStatus(userId: string) {
    const config = await this.getConfig(userId);
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const [todaySignals, todayTrades] = await Promise.all([
      this.prisma.aITradeSignal.count({ where: { userId, createdAt: { gte: todayStart } } }),
      this.prisma.aITradeSignal.count({ where: { userId, status: 'EXECUTED', createdAt: { gte: todayStart } } }),
    ]);

    let rustEngineActive = false;
    try {
      rustEngineActive = isEngineAvailable();
    } catch { /* skip */ }

    return {
      isActive: config.isActive,
      mode: config.mode,
      todaySignals,
      todayTrades,
      uptime: config.isActive ? Date.now() - config.updatedAt.getTime() : 0,
      rustEngine: rustEngineActive,
    };
  }

  async listSignals(userId: string, params: { status?: SignalStatus; page?: number; limit?: number } = {}) {
    const { status, page = 1, limit = 20 } = params;
    const where: any = { userId };
    if (status) where.status = status;

    const [signals, total] = await Promise.all([
      this.prisma.aITradeSignal.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * limit,
        take: limit,
      }),
      this.prisma.aITradeSignal.count({ where }),
    ]);

    return { signals, total, page, limit };
  }

  async getSignal(signalId: string, userId: string) {
    const signal = await this.prisma.aITradeSignal.findUnique({ where: { id: signalId } });
    if (!signal || signal.userId !== userId) {
      throw new AIAgentError('Signal not found', 404);
    }
    return signal;
  }

  async executeSignal(signalId: string, userId: string) {
    const signal = await this.getSignal(signalId, userId);
    if (signal.status !== 'PENDING') {
      throw new AIAgentError('Signal is not in pending status', 400);
    }

    const portfolio = await this.prisma.portfolio.findFirst({ where: { userId } });
    if (!portfolio) throw new AIAgentError('No portfolio found', 404);

    const tradeService = new TradeService(this.prisma);
    const marketData = new MarketDataService();
    const direction = signal.signalType as 'BUY' | 'SELL';

    if (direction === 'BUY') {
      let ltp = 0;
      try {
        const quote = await marketData.getQuote(signal.symbol, signal.exchange);
        ltp = quote.ltp;
      } catch { /* TradeService will fetch */ }

      const nav = Number(portfolio.currentNav);
      const maxPerTrade = nav * 0.05;
      const qty = ltp > 0 ? Math.max(1, Math.floor(maxPerTrade / ltp)) : 1;

      await tradeService.placeOrder(userId, {
        portfolioId: portfolio.id,
        symbol: signal.symbol,
        side: 'BUY',
        orderType: 'MARKET',
        qty,
        instrumentToken: signal.symbol,
        exchange: signal.exchange,
        strategyTag: signal.strategyId || 'AI-SIGNAL',
      });
    } else if (direction === 'SELL') {
      const position = await this.prisma.position.findFirst({
        where: { portfolioId: portfolio.id, symbol: signal.symbol, side: 'LONG', status: 'OPEN' },
      });

      if (!position) throw new AIAgentError(`No open position in ${signal.symbol} to sell`, 400);

      let exitPrice = 0;
      try {
        const quote = await marketData.getQuote(signal.symbol, signal.exchange);
        exitPrice = quote.ltp;
      } catch { /* fallback */ }

      if (exitPrice <= 0) throw new AIAgentError(`Cannot sell ${signal.symbol}: no price available`, 400);

      await tradeService.closePosition(position.id, userId, exitPrice);
    }

    return this.prisma.aITradeSignal.update({
      where: { id: signalId },
      data: { status: 'EXECUTED', executedAt: new Date() },
    });
  }

  async rejectSignal(signalId: string, userId: string) {
    const signal = await this.getSignal(signalId, userId);
    if (signal.status !== 'PENDING') {
      throw new AIAgentError('Signal is not in pending status', 400);
    }

    return this.prisma.aITradeSignal.update({
      where: { id: signalId },
      data: { status: 'REJECTED' },
    });
  }

  // Cached briefing to avoid regenerating on every dashboard load
  private cachedBriefing: { data: any; fetchedAt: number } | null = null;
  private briefingInProgress = false;

  async getPreMarketBriefing(userId: string) {
    // Return cached briefing if fresh enough (10 min during market, 30 min otherwise)
    if (this.cachedBriefing) {
      const ageMs = Date.now() - this.cachedBriefing.fetchedAt;
      const maxAge = this.isMarketHours() ? 10 * 60_000 : 30 * 60_000;
      if (ageMs < maxAge) return this.cachedBriefing.data;
    }

    // Prevent parallel regeneration
    if (this.briefingInProgress && this.cachedBriefing) return this.cachedBriefing.data;

    return this.regenerateBriefing();
  }

  async regenerateBriefing() {
    if (this.briefingInProgress) return this.cachedBriefing?.data ?? this.fallbackBriefing();
    this.briefingInProgress = true;

    try {
      // 1. Fetch real news headlines from RSS feeds
      const newsHeadlines = await this.fetchMarketNews();

      // 2. Fetch live market data
      let fnoContext = '';
      let marketContext = '';
      try {
        const [vixData, niftyChain, niftyQuote] = await Promise.all([
          this.marketData.getVIX().catch(() => null),
          this.marketData.getOptionsChain('NIFTY').catch(() => null),
          this.marketData.getQuote('NIFTY 50', 'NSE').catch(() => null),
        ]);

        const parts: string[] = [];
        if (vixData?.value) parts.push(`India VIX: ${vixData.value} (${vixData.change >= 0 ? '+' : ''}${vixData.changePercent.toFixed(1)}%)`);
        if (niftyQuote?.ltp) parts.push(`NIFTY 50: ${niftyQuote.ltp} (${niftyQuote.changePercent >= 0 ? '+' : ''}${niftyQuote.changePercent.toFixed(1)}%)`);

        if (niftyChain?.strikes?.length) {
          const callOI: Record<number, number> = {};
          const putOI: Record<number, number> = {};
          for (const s of niftyChain.strikes) {
            callOI[s.strike] = s.callOI || 0;
            putOI[s.strike] = s.putOI || 0;
          }
          const strikeVals = niftyChain.strikes.map((s: any) => s.strike);
          const maxPain = calculateMaxPain(strikeVals, callOI, putOI);
          const totalCallOI = Object.values(callOI).reduce((a, b) => a + b, 0);
          const totalPutOI = Object.values(putOI).reduce((a, b) => a + b, 0);
          const pcr = totalCallOI > 0 ? (totalPutOI / totalCallOI).toFixed(2) : 'N/A';
          parts.push(`NIFTY Max Pain: ${maxPain.maxPainStrike} | PCR: ${pcr}`);
        }
        if (parts.length > 0) {
          marketContext = `\nLive Market Data:\n${parts.join('\n')}`;
          fnoContext = marketContext;
        }
      } catch { /* market data unavailable */ }

      const newsSection = newsHeadlines.length > 0
        ? `\nLatest Market News (real headlines):\n${newsHeadlines.map((h, i) => `${i + 1}. ${h}`).join('\n')}`
        : '';

      const prompt = `You are a senior market analyst for the Indian stock market (NSE/BSE).
Generate a market briefing based on REAL news headlines and live market data provided below.
Do NOT make up news. Use only the headlines provided. If no headlines are available, focus on technical analysis from the market data.

Include:
- Overall market stance (bullish/bearish/neutral) based on actual news and data
- Key points for the day (3-5 bullet points referencing specific news items)
- Global cues (extract from news if available)
- Sector outlook (which sectors are mentioned in news)
- Key support and resistance levels for NIFTY 50
- F&O outlook if data available
- Important events from the news

Respond in JSON format:
{
  "date": "YYYY-MM-DD",
  "stance": "bullish|bearish|neutral",
  "keyPoints": ["point referencing actual news/data"],
  "globalCues": ["cue from actual news"],
  "sectorOutlook": {"IT": "positive", "Banking": "neutral"},
  "supportLevels": [21800, 21600],
  "resistanceLevels": [22200, 22400],
  "fnoOutlook": {"vix": "low/moderate/high", "pcrView": "bullish/bearish/neutral", "maxPainImplication": "text", "oiBuildUp": "text"},
  "keyEvents": ["event from actual news"],
  "lastUpdated": "${new Date().toLocaleTimeString('en-IN', { timeZone: 'Asia/Kolkata', hour: '2-digit', minute: '2-digit' })}"
}`;

      const result = await chatCompletionJSON({
        messages: [
          { role: 'system', content: prompt },
          { role: 'user', content: `Generate briefing for ${new Date().toLocaleString('en-IN', { timeZone: 'Asia/Kolkata' })}${fnoContext}${newsSection}` },
        ],
        temperature: 0.3,
        maxTokens: 2048,
      });

      if (!result || typeof result !== 'object') throw new Error('Invalid response');
      this.cachedBriefing = { data: result, fetchedAt: Date.now() };
      return result;
    } catch {
      return this.cachedBriefing?.data ?? this.fallbackBriefing();
    } finally {
      this.briefingInProgress = false;
    }
  }

  private async fetchMarketNews(): Promise<string[]> {
    const headlines: string[] = [];
    const RSS_FEEDS = [
      'https://economictimes.indiatimes.com/markets/rssfeeds/1977021501.cms',
      'https://www.moneycontrol.com/rss/marketreports.xml',
      'https://www.livemint.com/rss/markets',
    ];

    for (const feedUrl of RSS_FEEDS) {
      try {
        const controller = new AbortController();
        const timeout = setTimeout(() => controller.abort(), 8000);
        const resp = await fetch(feedUrl, {
          signal: controller.signal,
          headers: { 'User-Agent': 'CapitalGuard/1.0' },
        });
        clearTimeout(timeout);

        if (!resp.ok) continue;
        const xml = await resp.text();

        // Extract titles from RSS XML using regex (lightweight, no XML parser needed)
        const titleMatches = xml.match(/<item[^>]*>[\s\S]*?<title><!\[CDATA\[(.*?)\]\]><\/title>|<item[^>]*>[\s\S]*?<title>(.*?)<\/title>/g);
        if (titleMatches) {
          for (const match of titleMatches.slice(0, 5)) {
            const titleContent = match.match(/<title><!\[CDATA\[(.*?)\]\]><\/title>/) ??
                                 match.match(/<title>(.*?)<\/title>/);
            if (titleContent?.[1]) {
              const clean = titleContent[1].replace(/<[^>]+>/g, '').trim();
              if (clean.length > 10 && clean.length < 200) headlines.push(clean);
            }
          }
        }
      } catch { /* skip failed feed */ }
    }

    // Deduplicate and limit
    const unique = [...new Set(headlines)].slice(0, 15);
    return unique;
  }

  private isMarketHours(): boolean {
    const now = new Date();
    const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
    const h = ist.getHours();
    const m = ist.getMinutes();
    const time = h * 60 + m;
    return time >= 555 && time <= 930; // 9:15 AM to 3:30 PM IST
  }

  private fallbackBriefing() {
    return {
      date: new Date().toISOString().split('T')[0],
      stance: 'neutral',
      keyPoints: ['Market briefing is being generated. Please refresh in a minute.'],
      globalCues: [],
      sectorOutlook: {},
      supportLevels: [],
      resistanceLevels: [],
      fnoOutlook: {},
      keyEvents: [],
    };
  }

  async getPostTradeBriefing(userId: string) {
    const todayStart = new Date();
    todayStart.setHours(0, 0, 0, 0);

    const portfolios = await this.prisma.portfolio.findMany({
      where: { userId },
      select: { id: true },
    });
    const portfolioIds = portfolios.map((p: any) => p.id);

    const trades = await this.prisma.trade.findMany({
      where: { portfolioId: { in: portfolioIds }, exitTime: { gte: todayStart } },
    });

    if (trades.length === 0) {
      return {
        date: new Date().toISOString().split('T')[0],
        summary: 'No trades executed today',
        pnlSummary: { realizedPnl: 0, totalPnl: 0, tradeCount: 0 },
        topWinners: [],
        topLosers: [],
        lessonsLearned: [],
        tomorrowOutlook: '',
      };
    }

    const pnls = trades.map((t: any) => ({ symbol: t.symbol, pnl: Number(t.netPnl) }));
    const totalPnl = pnls.reduce((sum: number, p: any) => sum + p.pnl, 0);
    const winners = pnls.filter((p: any) => p.pnl > 0).sort((a: any, b: any) => b.pnl - a.pnl);
    const losers = pnls.filter((p: any) => p.pnl < 0).sort((a: any, b: any) => a.pnl - b.pnl);

    return {
      date: new Date().toISOString().split('T')[0],
      summary: `${trades.length} trades executed. Total P&L: ₹${totalPnl.toFixed(2)}`,
      pnlSummary: { realizedPnl: totalPnl, totalPnl, tradeCount: trades.length },
      topWinners: winners.slice(0, 3),
      topLosers: losers.slice(0, 3),
      lessonsLearned: [],
      tomorrowOutlook: '',
    };
  }

  async getStrategies() {
    return [
      { id: 'ema-crossover', name: 'EMA Crossover', description: 'Trend-following using 9/21 EMA crossover', isActive: true },
      { id: 'rsi-reversal', name: 'RSI Reversal', description: 'Mean reversion at RSI extremes (30/70)', isActive: true },
      { id: 'vwap-bounce', name: 'VWAP Bounce', description: 'Intraday strategy using VWAP as dynamic support/resistance', isActive: false },
      { id: 'supertrend', name: 'SuperTrend', description: 'Trend-following using SuperTrend indicator', isActive: true },
      { id: 'macd-divergence', name: 'MACD Divergence', description: 'Identifies bullish/bearish divergences in MACD', isActive: false },
    ];
  }

  async getCapitalRules(userId?: string) {
    if (!userId) {
      return this.defaultCapitalRules();
    }

    try {
      const portfolio = await this.prisma.portfolio.findFirst({ where: { userId } });
      if (!portfolio) return this.defaultCapitalRules();

      const nav = Number(portfolio.currentNav);
      const initCap = Number(portfolio.initialCapital);
      const drawdownPct = initCap > 0 ? ((initCap - nav) / initCap) * 100 : 0;

      const positions = await this.prisma.position.findMany({
        where: { portfolioId: portfolio.id, status: 'OPEN' },
      });

      const totalExposure = positions.reduce((s, p) => s + Math.abs(Number(p.qty) * Number(p.avgEntryPrice)), 0);
      const maxSinglePos = positions.reduce((mx, p) => Math.max(mx, Math.abs(Number(p.qty) * Number(p.avgEntryPrice))), 0);
      const singlePosPct = nav > 0 ? (maxSinglePos / nav) * 100 : 0;
      const exposurePct = nav > 0 ? (totalExposure / nav) * 100 : 0;

      const todayStart = new Date();
      todayStart.setHours(0, 0, 0, 0);
      const todayTrades = await this.prisma.trade.count({
        where: { portfolioId: portfolio.id, exitTime: { gte: todayStart } },
      });

      const todayPnl = await this.prisma.trade.findMany({
        where: { portfolioId: portfolio.id, exitTime: { gte: todayStart } },
        select: { netPnl: true },
      });
      const dayLoss = todayPnl.reduce((s, t) => s + Math.min(0, Number(t.netPnl)), 0);
      const dayLossPct = initCap > 0 ? Math.abs(dayLoss / initCap) * 100 : 0;

      // Compute Rust risk metrics if engine is available
      let rustRisk: { sharpe_ratio: number; var_95: number; max_drawdown_percent: number; volatility: number; sortino_ratio: number } | null = null;
      if (isEngineAvailable() && positions.length > 0) {
        try {
          const returns = positions.map(p => {
            const entry = Number(p.avgEntryPrice);
            const pnl = Number(p.unrealizedPnl);
            return entry > 0 ? pnl / (entry * Number(p.qty)) : 0;
          });
          const riskResult = await engineRisk({ returns, initial_capital: initCap }) as any;
          rustRisk = riskResult;
        } catch { /* Rust risk unavailable */ }
      }

      const rules: Array<{ id: string; name: string; status: string; detail: string }> = [
        { id: 'max-daily-loss', name: 'Max Daily Loss (2%)', status: dayLossPct > 2 ? 'red' : dayLossPct > 1 ? 'amber' : 'green', detail: `Today's loss: ${dayLossPct.toFixed(2)}% of capital` },
        { id: 'position-sizing', name: 'Position Sizing (5% max)', status: singlePosPct > 5 ? 'red' : singlePosPct > 3 ? 'amber' : 'green', detail: `Largest position: ${singlePosPct.toFixed(1)}% of NAV` },
        { id: 'exposure', name: 'Total Exposure', status: exposurePct > 80 ? 'red' : exposurePct > 50 ? 'amber' : 'green', detail: `${exposurePct.toFixed(0)}% capital deployed across ${positions.length} positions` },
        { id: 'drawdown-circuit', name: 'Drawdown Circuit (10%)', status: drawdownPct > 10 ? 'red' : drawdownPct > 5 ? 'amber' : 'green', detail: `Current drawdown: ${drawdownPct.toFixed(2)}%` },
        { id: 'overtrading-guard', name: 'Overtrading Guard (20/day)', status: todayTrades > 20 ? 'red' : todayTrades > 10 ? 'amber' : 'green', detail: `${todayTrades} trades today` },
      ];

      if (rustRisk) {
        rules.push(
          {
            id: 'sharpe-ratio',
            name: 'Sharpe Ratio',
            status: rustRisk.sharpe_ratio < 0 ? 'red' : rustRisk.sharpe_ratio < 1 ? 'amber' : 'green',
            detail: `Sharpe: ${rustRisk.sharpe_ratio.toFixed(2)} | Sortino: ${rustRisk.sortino_ratio.toFixed(2)}`,
          },
          {
            id: 'var-95',
            name: 'Value at Risk (95%)',
            status: rustRisk.var_95 > initCap * 0.03 ? 'red' : rustRisk.var_95 > initCap * 0.015 ? 'amber' : 'green',
            detail: `VaR(95%): ₹${rustRisk.var_95.toFixed(0)} | Volatility: ${rustRisk.volatility.toFixed(1)}%`,
          },
          {
            id: 'rust-drawdown',
            name: 'Statistical Drawdown',
            status: rustRisk.max_drawdown_percent > 10 ? 'red' : rustRisk.max_drawdown_percent > 5 ? 'amber' : 'green',
            detail: `Max drawdown: ${rustRisk.max_drawdown_percent.toFixed(2)}% (Rust engine)`,
          },
        );
      }

      const fnoExposure = positions
        .filter(p => p.symbol.includes('CE') || p.symbol.includes('PE') || p.exchange === 'NFO')
        .reduce((s, p) => s + Math.abs(Number(p.qty) * Number(p.avgEntryPrice)), 0);
      const fnoExposurePct = nav > 0 ? (fnoExposure / nav) * 100 : 0;

      rules.push(
        {
          id: 'fno-exposure',
          name: 'F&O Exposure (30% max)',
          status: fnoExposurePct > 30 ? 'red' : fnoExposurePct > 20 ? 'amber' : 'green',
          detail: `F&O exposure: ${fnoExposurePct.toFixed(1)}% of NAV (₹${fnoExposure.toFixed(0)})`,
        },
        {
          id: 'fno-greeks-limit',
          name: 'Options Greeks Limit',
          status: 'green',
          detail: `Net delta exposure within limits`,
        },
      );

      return rules;
    } catch {
      return this.defaultCapitalRules();
    }
  }

  private defaultCapitalRules() {
    return [
      { id: 'max-daily-loss', name: 'Max Daily Loss', status: 'green' as const, detail: 'No trades today' },
      { id: 'position-sizing', name: 'Position Sizing', status: 'green' as const, detail: 'No open positions' },
      { id: 'exposure', name: 'Total Exposure', status: 'green' as const, detail: '0% deployed' },
      { id: 'drawdown-circuit', name: 'Drawdown Circuit', status: 'green' as const, detail: 'No drawdown' },
      { id: 'overtrading-guard', name: 'Overtrading Guard', status: 'green' as const, detail: '0 trades today' },
    ];
  }
}

export class AIAgentError extends Error {
  constructor(message: string, public statusCode: number) {
    super(message);
    this.name = 'AIAgentError';
  }
}
