import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import { env } from './config.js';
import { authRoutes } from './routes/auth.js';
import { portfolioRoutes } from './routes/portfolio.js';
import { tradeRoutes } from './routes/trades.js';
import { marketRoutes } from './routes/market.js';
import { watchlistRoutes } from './routes/watchlist.js';
import { aiRoutes } from './routes/ai.js';
import { intelligenceRoutes } from './routes/intelligence.js';
import { backtestRoutes } from './routes/backtest.js';
import { botRoutes } from './routes/bots.js';
import { notificationRoutes } from './routes/notifications.js';
import { alertRoutes } from './routes/alerts.js';
import { analyticsRoutes } from './routes/analytics.js';
import { optionsRoutes } from './routes/options.js';
import { learningRoutes } from './routes/learning.js';
import { edgeRoutes } from './routes/edge.js';
import { riskRoutes } from './routes/risk.js';
import commandCenterRoutes from './routes/command-center.js';
import { disconnectPrisma, getPrisma } from './lib/prisma.js';
import { AuthService } from './services/auth.service.js';
import { BotEngine } from './services/bot-engine.js';
import { LearningEngine } from './services/learning-engine.js';
import { MorningBoot } from './services/morning-boot.js';
import { ServerOrchestrator } from './services/server-orchestrator.js';
import { TargetTracker } from './services/target-tracker.service.js';
import { EODReviewService } from './services/eod-review.service.js';
import { GlobalMarketService } from './services/global-market.service.js';
import { StopLossMonitor } from './services/stop-loss-monitor.service.js';
import { PriceFeedService } from './services/price-feed.service.js';
import { IntradayManager } from './services/intraday-manager.service.js';
import { OptionsPositionService } from './services/options-position.service.js';
import { registerWebSocket, wsHub } from './lib/websocket.js';
import { getOpenAIStatus } from './lib/openai.js';

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 1_048_576, // 1 MB max body
    pluginTimeout: 120_000,
  });

  const authService = new AuthService(getPrisma(), env.JWT_SECRET);
  const botEngine = new BotEngine(getPrisma());
  const learningEngine = new LearningEngine(getPrisma());
  const morningBoot = new MorningBoot(getPrisma());
  const orchestrator = new ServerOrchestrator(getPrisma(), botEngine, env.PORT);
  app.decorate('botEngine', botEngine);
  app.decorate('learningEngine', learningEngine);
  app.decorate('morningBoot', morningBoot);
  app.decorate('orchestrator', orchestrator);

  await app.register(sensible);

  await app.register(helmet, {
    contentSecurityPolicy: false, // disabled for dev; enable in production
  });

  await app.register(rateLimit, {
    max: 200,
    timeWindow: '1 minute',
    keyGenerator: (req) => {
      const user = (req as any).user;
      return user?.id || req.ip;
    },
  });

  await app.register(cors, {
    origin: env.CORS_ORIGINS.split(',').map((o) => o.trim()),
    credentials: true,
    methods: ['GET', 'HEAD', 'POST', 'PUT', 'DELETE', 'PATCH', 'OPTIONS'],
  });

  await app.register(jwt, {
    secret: env.JWT_SECRET,
    sign: { expiresIn: env.JWT_EXPIRES_IN },
  });

  app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body ? {} : {});
  });

  app.setErrorHandler((error: Error & { statusCode?: number }, _request, reply) => {
    const statusCode = error.statusCode ?? 500;
    if (statusCode >= 500) {
      app.log.error(error);
    }
    reply.status(statusCode).send({
      error: statusCode >= 500 ? 'Internal server error' : error.message,
    });
  });

  app.get('/health', async () => {
    const checks: Record<string, string> = {};

    try {
      await getPrisma().$queryRawUnsafe('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    try {
      const { getRedis } = await import('./lib/redis.js');
      const redis = getRedis();
      if (redis) {
        await redis.ping();
        checks.redis = 'ok';
      } else {
        checks.redis = 'not_configured';
      }
    } catch {
      checks.redis = 'error';
    }

    try {
      const { isEngineAvailable } = await import('./lib/rust-engine.js');
      checks.rustEngine = isEngineAvailable() ? 'ok' : 'not_found';
    } catch {
      checks.rustEngine = 'error';
    }

    checks.wsConnections = String(wsHub.getConnectedCount());

    const overall = Object.values(checks).every(v =>
      v === 'ok' || v === 'not_configured' || v === 'not_found' || !isNaN(Number(v))
    ) ? 'ok' : 'degraded';

    const orchStatus = orchestrator.getStatus();

    return {
      status: overall,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: {
        heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      checks,
      market: {
        phase: orchStatus.market.phase,
        phaseLabel: orchStatus.market.phaseLabel,
        isOpen: orchStatus.market.isOpen,
        isHoliday: orchStatus.market.isHoliday,
        holidayName: orchStatus.market.holidayName,
        nextOpen: orchStatus.market.nextOpen,
      },
      bots: {
        activeBots: orchStatus.botEngine.activeBots,
        activeAgents: orchStatus.botEngine.activeAgents,
      },
      orchestrator: {
        pingsSentToday: orchStatus.orchestrator.pingsSentToday,
        lastPingAt: orchStatus.orchestrator.lastPingAt,
      },
      ai: getOpenAIStatus(),
    };
  });

  await app.register(authRoutes, { prefix: '/api/auth' });
  await app.register(portfolioRoutes, { prefix: '/api/portfolio' });
  await app.register(tradeRoutes, { prefix: '/api/trades' });
  await app.register(marketRoutes, { prefix: '/api/market' });
  await app.register(watchlistRoutes, { prefix: '/api/watchlist' });
  await app.register(aiRoutes, { prefix: '/api/ai' });
  await app.register(intelligenceRoutes, { prefix: '/api/intelligence' });
  await app.register(backtestRoutes, { prefix: '/api/backtest' });
  await app.register(botRoutes, { prefix: '/api/bots' });
  await app.register(notificationRoutes, { prefix: '/api/notifications' });
  await app.register(alertRoutes, { prefix: '/api/alerts' });
  await app.register(analyticsRoutes, { prefix: '/api/analytics' });
  await app.register(optionsRoutes, { prefix: '/api/options' });
  await app.register(learningRoutes, { prefix: '/api/learning' });
  await app.register(edgeRoutes, { prefix: '/api/edge' });
  await app.register(riskRoutes, { prefix: '/api/risk' });
  await app.register(commandCenterRoutes, { prefix: '/api/command' });

  await registerWebSocket(app);
  app.decorate('wsHub', wsHub);

  // Session renewal — runs on all trading days including Saturdays (some exchanges)
  orchestrator.scheduleAlways('0 8 * * 1-6', async () => {
    try {
      const result = await authService.renewExpiringSessions();
      console.log(`[Breeze Cron] Auto-renew: ${result.refreshed}/${result.attempted} refreshed`);
      if (result.errors.length > 0) {
        console.warn('[Breeze Cron] Errors:', result.errors);
      }
    } catch (err) {
      console.error('[Breeze Cron] Auto-renew failed:', (err as Error).message);
    }
  });

  orchestrator.scheduleAlways('30 8 * * 1-6', async () => {
    try {
      const result = await authService.renewExpiringSessions();
      if (result.attempted > 0) {
        console.log(`[Breeze Cron Retry] ${result.refreshed}/${result.attempted} refreshed`);
      }
    } catch {
      // silent retry
    }
  });

  const targetTracker = new TargetTracker(getPrisma());
  const eodReviewService = new EODReviewService(getPrisma());
  const globalMarketService = new GlobalMarketService();

  // Target progress update — every 5 min during market hours (3:45-10:00 UTC = 9:15-15:30 IST)
  orchestrator.scheduleMarketDay('*/5 3-10 * * 1-5', async () => {
    try {
      const db = getPrisma();
      const users = await db.user.findMany({ where: { isActive: true }, select: { id: true } });
      for (const user of users) {
        try { await targetTracker.updateProgress(user.id); } catch { /* skip */ }
      }
    } catch (err) { console.error('[TargetTracker Cron] Error:', (err as Error).message); }
  });

  // EOD Review — 15:35 IST = 10:05 UTC
  orchestrator.scheduleMarketDay('5 10 * * 1-5', async () => {
    console.log('[EODReview Cron] Starting end-of-day review...');
    await eodReviewService.runReview();
    console.log('[EODReview Cron] Review complete');
  });

  // Record daily P&L — 15:45 IST = 10:15 UTC
  orchestrator.scheduleMarketDay('15 10 * * 1-5', async () => {
    try {
      const db = getPrisma();
      const users = await db.user.findMany({ where: { isActive: true }, select: { id: true } });
      for (const user of users) {
        try { await targetTracker.recordDailyPnl(user.id); } catch { /* skip */ }
      }
      console.log(`[DailyPnl Cron] Recorded P&L for ${users.length} users`);
    } catch (err) { console.error('[DailyPnl Cron] Error:', (err as Error).message); }
  });

  // Nightly learning — only on market days (skips holidays & weekends) — 16:00 IST = 10:30 UTC
  orchestrator.scheduleMarketDay('30 10 * * 1-5', async () => {
    const result = await learningEngine.runNightlyLearning();
    console.log(`[Learning Cron] Processed ${result.usersProcessed} users, ${result.insights} insights generated`);
  });

  // Morning target reset — 08:30 IST = 03:00 UTC
  orchestrator.scheduleMarketDay('0 3 * * 1-5', async () => {
    try {
      const db = getPrisma();
      const users = await db.user.findMany({ where: { isActive: true }, select: { id: true } });
      for (const user of users) {
        try { await targetTracker.resetDailyTarget(user.id); } catch { /* skip */ }
      }
      console.log(`[Morning Reset] Reset daily targets for ${users.length} users`);
    } catch (err) { console.error('[Morning Reset] Error:', (err as Error).message); }
  });

  // Global market intelligence scan — 08:45 IST = 03:15 UTC (before market open)
  orchestrator.scheduleMarketDay('15 3 * * 1-5', async () => {
    try {
      const intel = await globalMarketService.runDailyIntelligenceScan();
      console.log(`[GlobalMarket Cron] Pre-market scan done — Sentiment: ${intel.sentiment}, ${intel.globalIndices.length} global indices, ${intel.sectorPerformance.length} sectors`);
    } catch (err) { console.error('[GlobalMarket Cron] Error:', (err as Error).message); }
  });

  // Intra-day intelligence refresh — every 30 min during market hours (9:15-15:30 IST = 3:45-10:00 UTC)
  orchestrator.scheduleMarketDay('*/30 3-10 * * 1-5', async () => {
    try {
      await globalMarketService.runDailyIntelligenceScan();
    } catch { /* silent refresh */ }
  });

  // Morning boot — only on market days
  orchestrator.scheduleMarketDay('20 3 * * 1-5', async () => {
    const result = await morningBoot.runMorningBoot();
    console.log(`[Morning Boot] Processed ${result.usersProcessed} users, activated ${result.strategiesActivated} strategies`);
  });

  // ── Stop-Loss Monitor, Price Feed & Intraday Manager ──
  const stopLossMonitor = new StopLossMonitor(getPrisma());
  const priceFeedService = new PriceFeedService(getPrisma());
  const intradayManager = new IntradayManager(getPrisma());
  const optionsPositionService = new OptionsPositionService(getPrisma());
  app.decorate('stopLossMonitor', stopLossMonitor);
  app.decorate('priceFeedService', priceFeedService);
  app.decorate('intradayManager', intradayManager);
  app.decorate('optionsPositionService', optionsPositionService);

  // Start SL monitor, price feed, and intraday manager at market open
  orchestrator.scheduleMarketDay('45 3 * * 1-5', async () => {
    console.log('[MarketOpen] Starting stop-loss monitor, price feed, and intraday manager');
    await stopLossMonitor.start();
    priceFeedService.start();
    intradayManager.startAutoSquareOff();
  });

  // Stop all at market close
  orchestrator.scheduleMarketDay('0 10 * * 1-5', async () => {
    console.log('[MarketClose] Stopping stop-loss monitor, price feed, and intraday manager');
    stopLossMonitor.stop();
    priceFeedService.stop();
    intradayManager.stopAutoSquareOff();
  });

  app.addHook('onClose', async () => {
    botEngine.stopAll();
    stopLossMonitor.stop();
    priceFeedService.stop();
    orchestrator.stop();
    await disconnectPrisma();
  });

  // Download Rust engine binary at startup if not already present
  app.addHook('onReady', async () => {
    try {
      const { ensureEngineAvailable, startDaemon } = await import('./lib/rust-engine.js');
      const ok = await ensureEngineAvailable();
      if (ok) {
        const daemonOk = startDaemon();
        console.log(`[startup] Rust engine: ACTIVE (daemon: ${daemonOk ? 'persistent' : 'single-shot'})`);
        botEngine.refreshRustAvailability();
      } else {
        console.log(`[startup] Rust engine: NOT AVAILABLE — bots will use Gemini AI analysis only`);
      }
    } catch (err: any) {
      console.error('[startup] Rust engine check failed:', err.message, '— bots will use Gemini AI only');
    }
  });

  // Start orchestrator and renew sessions on startup
  app.addHook('onReady', async () => {
    orchestrator.start();

    setTimeout(async () => {
      try {
        const result = await authService.renewExpiringSessions();
        if (result.attempted > 0) {
          console.log(`[Breeze Startup] Auto-renew: ${result.refreshed}/${result.attempted} refreshed`);
          if (result.errors.length > 0) console.warn('[Breeze Startup] Errors:', result.errors);
        }
      } catch (err) {
        console.error('[Breeze Startup] Auto-renew failed:', (err as Error).message);
      }
    }, 15_000);
  });

  // Bootstrap default bots & AI agent for users who have none
  app.addHook('onReady', async () => {
    const prisma = getPrisma();
    try {
      const users = await prisma.user.findMany({
        where: { isActive: true },
        select: { id: true },
      });

      for (const user of users) {
        const existingBots = await prisma.tradingBot.count({ where: { userId: user.id } });
        if (existingBots === 0) {
          const defaultBots = [
            { name: 'Alpha Scanner', role: 'SCANNER', avatarEmoji: '🔍', assignedSymbols: 'RELIANCE,TCS,INFY,HDFCBANK,ITC,SBIN,BHARTIARTL,KOTAKBANK', description: 'Scans equities for breakouts and momentum patterns' },
            { name: 'Auto Executor', role: 'EXECUTOR', avatarEmoji: '⚡', assignedSymbols: 'RELIANCE,TCS,INFY,HDFCBANK,ITC,SBIN,BHARTIARTL,KOTAKBANK', description: 'Executes trades automatically on high-confidence signals' },
            { name: 'Risk Sentinel', role: 'RISK_MANAGER', avatarEmoji: '🛡️', assignedSymbols: 'NIFTY 50,BANKNIFTY', description: 'Monitors portfolio risk, drawdowns, and position sizing' },
            { name: 'Strategy Analyst', role: 'ANALYST', avatarEmoji: '📊', assignedSymbols: 'RELIANCE,TCS,INFY,HDFCBANK', description: 'Provides in-depth technical analysis and recommendations' },
          ];
          for (const bot of defaultBots) {
            await prisma.tradingBot.create({
              data: {
                userId: user.id,
                name: bot.name,
                role: bot.role,
                avatarEmoji: bot.avatarEmoji,
                assignedSymbols: bot.assignedSymbols,
                description: bot.description,
                status: 'RUNNING',
                isActive: true,
              },
            });
          }
          app.log.info(`[Bootstrap] Created 4 default bots for user ${user.id}`);
        } else {
          // Ensure an EXECUTOR bot exists for users who already have bots
          const hasExecutor = await prisma.tradingBot.findFirst({
            where: { userId: user.id, role: 'EXECUTOR' },
          });
          if (!hasExecutor) {
            await prisma.tradingBot.create({
              data: {
                userId: user.id,
                name: 'Auto Executor',
                role: 'EXECUTOR',
                avatarEmoji: '⚡',
                assignedSymbols: 'RELIANCE,TCS,INFY,HDFCBANK,ITC,SBIN,BHARTIARTL,KOTAKBANK',
                description: 'Executes trades automatically on high-confidence signals',
                status: 'RUNNING',
                isActive: true,
              },
            });
            app.log.info(`[Bootstrap] Added missing EXECUTOR bot for user ${user.id}`);
          }
        }

        const existingAgent = await prisma.aIAgentConfig.findUnique({ where: { userId: user.id } });
        if (!existingAgent) {
          await prisma.aIAgentConfig.create({
            data: {
              userId: user.id,
              mode: 'ADVISORY',
              isActive: true,
              minSignalScore: 0.7,
              maxDailyTrades: 5,
              strategies: JSON.stringify(['ema-crossover', 'supertrend', 'momentum']),
            },
          });
          app.log.info(`[Bootstrap] Created default AI agent config for user ${user.id}`);
        } else if (!existingAgent.isActive) {
          await prisma.aIAgentConfig.update({
            where: { userId: user.id },
            data: { isActive: true },
          });
          app.log.info(`[Bootstrap] Activated AI agent for user ${user.id}`);
        }
      }
      // Clear error-state bots but keep them RUNNING so they resume
      const staleCount = await prisma.tradingBot.updateMany({
        where: {
          OR: [
            { lastAction: { startsWith: 'Error:' } },
            { status: 'ERROR' },
          ],
        },
        data: {
          lastAction: 'Ready — awaiting next cycle',
          status: 'RUNNING',
        },
      });
      if (staleCount.count > 0) {
        app.log.info(`[Bootstrap] Reset ${staleCount.count} error-state bots to RUNNING`);
      }
    } catch (err) {
      app.log.error({ err }, 'Failed to bootstrap default bots/agents');
    }
  });

  // Auto-resume bots/agents — always start regardless of phase
  // Bots run at reduced frequency outside market hours but stay alive
  app.addHook('onReady', async () => {
    const phase = orchestrator.calendar.getMarketPhase();
    const phaseConfig = orchestrator.calendar.getPhaseConfig(phase);
    const isMarketActive = phaseConfig.botsActive;

    app.log.info(`[Bot Resume] Phase: ${phase} (${phaseConfig.label}), botsActive: ${isMarketActive}`);

    // Set appropriate tick intervals based on phase
    if (isMarketActive) {
      botEngine.setTickInterval(phaseConfig.botTickMs || 60_000);
    } else {
      // Outside market hours: run every 10 minutes to keep bots alive and visible
      botEngine.setTickInterval(10 * 60_000);
    }

    const prisma = getPrisma();
    try {
      const runningBots = await prisma.tradingBot.findMany({
        where: { status: 'RUNNING' },
        select: { id: true, userId: true, name: true, role: true },
        take: 5,
      });

      if (runningBots.length > 0) {
        const excessBots = await prisma.tradingBot.findMany({
          where: { status: 'RUNNING', id: { notIn: runningBots.map(b => b.id) } },
          select: { id: true },
        });
        if (excessBots.length > 0) {
          await prisma.tradingBot.updateMany({
            where: { id: { in: excessBots.map(b => b.id) } },
            data: { status: 'IDLE' },
          });
          app.log.info(`Set ${excessBots.length} excess bots to IDLE to prevent OOM`);
        }
      }

      for (let i = 0; i < runningBots.length; i++) {
        const bot = runningBots[i];
        setTimeout(() => {
          botEngine.startBot(bot.id, bot.userId).catch(err => {
            app.log.error(`Failed to start bot ${bot.name}: ${(err as Error).message}`);
          });
          app.log.info(`Auto-resumed bot: ${bot.name} (${bot.role})`);
        }, i * 10_000);
      }

      const activeAgents = await prisma.aIAgentConfig.findMany({
        where: { isActive: true },
        select: { userId: true },
        take: 1,
      });
      for (const agent of activeAgents) {
        setTimeout(() => {
          botEngine.startAgent(agent.userId).catch(err => {
            app.log.error(`Failed to start agent: ${(err as Error).message}`);
          });
          botEngine.startMarketScan(agent.userId).catch(err => {
            app.log.error(`Failed to start market scan: ${(err as Error).message}`);
          });
          app.log.info(`Auto-resumed AI agent + market scanner for user ${agent.userId}`);
        }, 40_000);
      }

      if (runningBots.length > 0 || activeAgents.length > 0) {
        app.log.info(`Will resume ${runningBots.length} bots, ${activeAgents.length} agents (staggered, phase: ${phase})`);
      } else {
        app.log.info(`[Bot Resume] No RUNNING bots or active agents found in DB`);
      }
    } catch (err) {
      app.log.error({ err }, 'Failed to auto-resume bots/agents');
    }
  });

  // Reconcile portfolio NAV on startup to fix any drift from partial failures
  app.addHook('onReady', async () => {
    const prisma = getPrisma();
    try {
      const portfolios = await prisma.portfolio.findMany({
        select: { id: true, userId: true },
      });
      const portfolioService = new (await import('./services/portfolio.service.js')).PortfolioService(prisma);
      for (const p of portfolios) {
        try {
          const result = await portfolioService.reconcileNav(p.id, p.userId);
          if (Math.abs(result.drift) > 1) {
            app.log.info(`[Reconcile] Portfolio ${p.id}: corrected ₹${result.drift.toFixed(2)} drift (${result.before} → ${result.after})`);
          }
        } catch { /* skip individual portfolio errors */ }
      }
    } catch (err) {
      app.log.error({ err }, 'Failed to reconcile portfolios');
    }
  });

  // Scheduled market briefing refresh
  app.addHook('onReady', async () => {
    const prisma = getPrisma();
    const { AIAgentService } = await import('./services/ai-agent.service.js');
    const agentService = new AIAgentService(prisma);

    // During market hours (9:15 AM - 3:30 PM IST): every 20 min
    // IST = UTC+5:30, so 9:15 IST = 3:45 UTC, 3:30 PM IST = 10:00 UTC
    orchestrator.scheduleMarketDay('*/20 9-15 * * 1-5', async () => {
      app.log.info('[Briefing] Refreshing market briefing (market hours)');
      await agentService.regenerateBriefing();
    });

    // Before market (7 AM - 9 AM IST): every hour → UTC 1:30-3:30
    orchestrator.scheduleMarketDay('30 1,2,3 * * 1-5', async () => {
      app.log.info('[Briefing] Refreshing pre-market briefing');
      await agentService.regenerateBriefing();
    });

    // After market (4 PM - 8 PM IST): every hour → UTC 10:30-14:30
    orchestrator.scheduleMarketDay('30 10,11,12,13,14 * * 1-5', async () => {
      app.log.info('[Briefing] Refreshing post-market briefing');
      await agentService.regenerateBriefing();
    });

    // Generate initial briefing 30s after startup
    setTimeout(() => {
      agentService.regenerateBriefing().catch(() => {});
      app.log.info('[Briefing] Initial briefing generation triggered');
    }, 30_000);
  });

  // Match pending orders every minute during market hours
  // IST 9:00-16:00 = UTC 3:30-10:30 → cron 3-10 UTC (covers pre-open + buffer)
  // matchPendingOrders() has its own isMarketOpen() guard for precise timing
  app.addHook('onReady', async () => {
    const prisma = getPrisma();
    const { TradeService } = await import('./services/trade.service.js');
    const tradeService = new TradeService(prisma);

    orchestrator.scheduleMarketDay('* 3-10 * * 1-5', async () => {
      try {
        const result = await tradeService.matchPendingOrders();
        if (result.matched > 0 || result.failed > 0) {
          app.log.info(`[OrderMatcher] Matched: ${result.matched}, Failed: ${result.failed}`);
        }
      } catch (err) {
        app.log.error({ err }, '[OrderMatcher] Failed to match pending orders');
      }
    });
  });

  // Auto-populate watchlist from open positions for users with empty watchlists
  app.addHook('onReady', async () => {
    const prisma = getPrisma();
    try {
      const users = await prisma.user.findMany({
        where: { isActive: true },
        select: { id: true },
      });

      for (const user of users) {
        const watchlists = await prisma.watchlist.findMany({
          where: { userId: user.id },
          include: { items: true },
        });

        // Create a default watchlist if none exists
        let defaultWatchlist = watchlists[0];
        if (!defaultWatchlist) {
          defaultWatchlist = await prisma.watchlist.create({
            data: { userId: user.id, name: 'My Watchlist' },
            include: { items: true },
          });
        }

        // If watchlist is empty, populate with open positions + key indices
        if (defaultWatchlist.items.length === 0) {
          const openPositions = await prisma.position.findMany({
            where: { portfolioId: { in: (await prisma.portfolio.findMany({ where: { userId: user.id }, select: { id: true } })).map(p => p.id) }, status: 'OPEN' },
            select: { symbol: true, exchange: true },
          });

          const defaultSymbols = [
            { symbol: 'RELIANCE', exchange: 'NSE' },
            { symbol: 'TCS', exchange: 'NSE' },
            { symbol: 'HDFCBANK', exchange: 'NSE' },
            { symbol: 'INFY', exchange: 'NSE' },
            { symbol: 'ITC', exchange: 'NSE' },
          ];

          const symbolsToAdd = [
            ...openPositions.map(p => ({ symbol: p.symbol, exchange: p.exchange })),
            ...defaultSymbols,
          ];

          const added = new Set<string>();
          for (const s of symbolsToAdd) {
            if (added.has(s.symbol)) continue;
            added.add(s.symbol);
            try {
              await prisma.watchlistItem.create({
                data: {
                  watchlistId: defaultWatchlist.id,
                  symbol: s.symbol,
                  exchange: s.exchange as any,
                },
              });
            } catch { /* skip duplicates */ }
            if (added.size >= 10) break;
          }

          if (added.size > 0) {
            app.log.info(`[Watchlist] Populated ${added.size} symbols for user ${user.id}`);
          }
        }
      }
    } catch (err) {
      app.log.error({ err }, 'Failed to auto-populate watchlists');
    }
  });

  return app;
}
