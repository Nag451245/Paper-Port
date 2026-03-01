import Fastify, { type FastifyInstance } from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import cron from 'node-cron';
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
import { disconnectPrisma, getPrisma } from './lib/prisma.js';
import { AuthService } from './services/auth.service.js';
import { BotEngine } from './services/bot-engine.js';
import { registerWebSocket, wsHub } from './lib/websocket.js';

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
  app.decorate('botEngine', botEngine);

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

    // Database check
    try {
      await getPrisma().$queryRawUnsafe('SELECT 1');
      checks.database = 'ok';
    } catch {
      checks.database = 'error';
    }

    // Redis check
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

    // Rust engine check
    try {
      const { isEngineAvailable } = await import('./lib/rust-engine.js');
      checks.rustEngine = isEngineAvailable() ? 'ok' : 'not_found';
    } catch {
      checks.rustEngine = 'error';
    }

    // WebSocket connections
    checks.wsConnections = String(wsHub.getConnectedCount());

    const overall = Object.values(checks).every(v =>
      v === 'ok' || v === 'not_configured' || v === 'not_found' || !isNaN(Number(v))
    ) ? 'ok' : 'degraded';

    return {
      status: overall,
      timestamp: new Date().toISOString(),
      uptime: Math.round(process.uptime()),
      memory: {
        heapMB: Math.round(process.memoryUsage().heapUsed / 1024 / 1024),
        rssMB: Math.round(process.memoryUsage().rss / 1024 / 1024),
      },
      checks,
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

  await registerWebSocket(app);
  app.decorate('wsHub', wsHub);

  // Auto-renew Breeze sessions at 8:00 AM and 8:30 AM IST on weekdays (retry)
  const sessionRefreshTask = cron.schedule('0 8 * * 1-6', async () => {
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

  // Retry at 8:30 in case the first attempt failed
  const sessionRetryTask = cron.schedule('30 8 * * 1-6', async () => {
    try {
      const result = await authService.renewExpiringSessions();
      if (result.attempted > 0) {
        console.log(`[Breeze Cron Retry] ${result.refreshed}/${result.attempted} refreshed`);
      }
    } catch {
      // silent retry
    }
  });

  app.addHook('onClose', async () => {
    botEngine.stopAll();
    sessionRefreshTask.stop();
    sessionRetryTask.stop();
    await disconnectPrisma();
  });

  // Auto-renew Breeze sessions on startup (15s delay to let server stabilize)
  app.addHook('onReady', async () => {
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

  // Auto-resume bots/agents on startup — limited to MAX_CONCURRENT_BOTS (3)
  app.addHook('onReady', async () => {
    const prisma = getPrisma();
    try {
      const runningBots = await prisma.tradingBot.findMany({
        where: { status: 'RUNNING' },
        select: { id: true, userId: true, name: true, role: true },
        take: 5, // resume up to 5 bots (matches MAX_CONCURRENT_BOTS)
      });

      // Mark excess bots as IDLE so they don't auto-resume next time
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

      // Stagger bot resumes with 10s gaps
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
        take: 1, // only one agent at a time
      });
      for (const agent of activeAgents) {
        // Delay agent start by 40s to let server stabilize
        setTimeout(() => {
          botEngine.startAgent(agent.userId).catch(() => {});
          botEngine.startMarketScan(agent.userId).catch(() => {});
          app.log.info(`Auto-resumed AI agent + market scanner for user ${agent.userId}`);
        }, 40_000);
      }

      if (runningBots.length > 0 || activeAgents.length > 0) {
        app.log.info(`Will resume ${runningBots.length} bots, ${activeAgents.length} agents (staggered)`);
      }
    } catch (err) {
      app.log.error({ err }, 'Failed to auto-resume bots/agents');
    }
  });

  return app;
}
