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
import { disconnectPrisma, getPrisma } from './lib/prisma.js';
import { AuthService } from './services/auth.service.js';
import { BotEngine } from './services/bot-engine.js';
import { LearningEngine } from './services/learning-engine.js';
import { MorningBoot } from './services/morning-boot.js';
import { ServerOrchestrator } from './services/server-orchestrator.js';
import { registerWebSocket, wsHub } from './lib/websocket.js';
import { getOpenAIStatus } from './lib/openai.js';

export interface BuildAppOptions {
  logger?: boolean;
}

export async function buildApp(options: BuildAppOptions = {}): Promise<FastifyInstance> {
  const app = Fastify({
    logger: options.logger ?? true,
    bodyLimit: 1_048_576, // 1 MB max body
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

  // Nightly learning — only on market days (skips holidays & weekends)
  orchestrator.scheduleMarketDay('30 10 * * 1-5', async () => {
    const result = await learningEngine.runNightlyLearning();
    console.log(`[Learning Cron] Processed ${result.usersProcessed} users, ${result.insights} insights generated`);
  });

  // Morning boot — only on market days
  orchestrator.scheduleMarketDay('15 3 * * 1-5', async () => {
    const result = await morningBoot.runMorningBoot();
    console.log(`[Morning Boot] Processed ${result.usersProcessed} users, activated ${result.strategiesActivated} strategies`);
  });

  app.addHook('onClose', async () => {
    botEngine.stopAll();
    orchestrator.stop();
    await disconnectPrisma();
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
          app.log.info(`[Bootstrap] Created 3 default bots for user ${user.id}`);
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
      // Clear ALL error-state bots (stale OpenAI errors, failed cycles, etc.)
      const staleCount = await prisma.tradingBot.updateMany({
        where: {
          OR: [
            { lastAction: { startsWith: 'Error:' } },
            { status: 'ERROR' },
          ],
        },
        data: {
          lastAction: 'Ready — awaiting next cycle',
          status: 'IDLE',
        },
      });
      if (staleCount.count > 0) {
        app.log.info(`[Bootstrap] Cleared ${staleCount.count} stale error messages from bots`);
      }
    } catch (err) {
      app.log.error({ err }, 'Failed to bootstrap default bots/agents');
    }
  });

  // Auto-resume bots/agents — only during market phases where bots should be active
  app.addHook('onReady', async () => {
    const phase = orchestrator.calendar.getMarketPhase();
    const phaseConfig = orchestrator.calendar.getPhaseConfig(phase);

    if (!phaseConfig.botsActive) {
      app.log.info(`[Bot Resume] Skipping — current phase: ${phase} (${phaseConfig.label})`);
      return;
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
          botEngine.startBot(bot.id, bot.userId).catch(() => {});
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
          botEngine.startAgent(agent.userId).catch(() => {});
          botEngine.startMarketScan(agent.userId).catch(() => {});
          app.log.info(`Auto-resumed AI agent + market scanner for user ${agent.userId}`);
        }, 40_000);
      }

      if (runningBots.length > 0 || activeAgents.length > 0) {
        app.log.info(`Will resume ${runningBots.length} bots, ${activeAgents.length} agents (staggered, phase: ${phase})`);
      }
    } catch (err) {
      app.log.error({ err }, 'Failed to auto-resume bots/agents');
    }
  });

  return app;
}
