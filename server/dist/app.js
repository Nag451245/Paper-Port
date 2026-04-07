import Fastify from 'fastify';
import cors from '@fastify/cors';
import jwt from '@fastify/jwt';
import sensible from '@fastify/sensible';
import rateLimit from '@fastify/rate-limit';
import helmet from '@fastify/helmet';
import multipart from '@fastify/multipart';
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
import { engineRoutes } from './routes/engine.js';
import { disconnectPrisma, getPrisma } from './lib/prisma.js';
import { getRedis } from './lib/redis.js';
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
import { on as onEvent, shutdownEventBus } from './lib/event-bus.js';
import { UptimeMonitorService } from './services/uptime-monitor.service.js';
import { DataPipelineService } from './services/data-pipeline.service.js';
import { OrderManagementService } from './services/oms.service.js';
import { registerAllWorkers } from './services/event-workers.js';
import { apiRequestDuration } from './lib/metrics.js';
import { MetricsService } from './services/metrics.service.js';
import { AuditTrailService } from './services/audit-trail.service.js';
import { OMSRecoveryService } from './services/oms-recovery.service.js';
import reportRoutes from './routes/reports.js';
import guardianRoutes from './routes/guardian.js';
import { isEngineAvailable, ensureEngineAvailable, startDaemon, stopDaemon } from './lib/rust-engine.js';
import { initTracing } from './lib/tracing.js';
export async function buildApp(options = {}) {
    await initTracing();
    const app = Fastify({
        logger: options.logger ?? true,
        bodyLimit: 1_048_576, // 1 MB max body
        pluginTimeout: 120_000,
    });
    const authService = new AuthService(getPrisma(), env.JWT_SECRET);
    const oms = new OrderManagementService(getPrisma());
    const botEngine = new BotEngine(getPrisma(), oms);
    const learningEngine = new LearningEngine(getPrisma());
    const morningBoot = new MorningBoot(getPrisma());
    const orchestrator = new ServerOrchestrator(getPrisma(), botEngine, env.PORT);
    orchestrator.setLearningEngine(learningEngine);
    const uptimeMonitor = new UptimeMonitorService(async () => {
        try {
            await getPrisma().$queryRaw `SELECT 1`;
            return true;
        }
        catch {
            return false;
        }
    });
    const dataPipeline = new DataPipelineService();
    const metricsService = MetricsService.getInstance();
    metricsService.startCollecting();
    metricsService.setGaugeProvider(async () => {
        const prisma = getPrisma();
        const [posCount, portfolio] = await Promise.all([
            prisma.position.count({ where: { status: 'OPEN' } }),
            prisma.portfolio.aggregate({ _sum: { currentNav: true } }),
        ]);
        return {
            openPositions: posCount,
            nav: Number(portfolio._sum.currentNav ?? 0),
            wsConnections: wsHub.getConnectedCount(),
        };
    });
    const auditTrail = new AuditTrailService();
    const omsRecovery = new OMSRecoveryService(auditTrail);
    app.decorate('botEngine', botEngine);
    app.decorate('learningEngine', learningEngine);
    app.decorate('morningBoot', morningBoot);
    app.decorate('orchestrator', orchestrator);
    app.decorate('oms', oms);
    await app.register(sensible);
    await app.register(helmet, {
        contentSecurityPolicy: env.NODE_ENV === 'production' ? {
            directives: {
                defaultSrc: ["'self'"],
                scriptSrc: ["'self'"],
                styleSrc: ["'self'", "'unsafe-inline'"],
                imgSrc: ["'self'", 'data:', 'https:'],
                connectSrc: ["'self'", ...env.CORS_ORIGINS.split(',').map(o => o.trim()), 'wss:'],
                fontSrc: ["'self'", 'https:', 'data:'],
                objectSrc: ["'none'"],
                frameSrc: ["'none'"],
                baseUri: ["'self'"],
                formAction: ["'self'"],
            },
        } : false,
    });
    await app.register(rateLimit, {
        max: 5000,
        timeWindow: '1 minute',
        keyGenerator: (req) => {
            const user = req.user;
            return user?.sub || req.ip;
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
    await app.register(multipart, {
        limits: { fileSize: 50 * 1024 * 1024 },
    });
    app.addContentTypeParser('application/x-www-form-urlencoded', { parseAs: 'string' }, (_req, body, done) => {
        try {
            if (!body || typeof body !== 'string' || body.length === 0) {
                done(null, {});
                return;
            }
            const parsed = Object.fromEntries(new URLSearchParams(body));
            done(null, parsed);
        }
        catch (err) {
            done(err, undefined);
        }
    });
    app.setErrorHandler((error, _request, reply) => {
        const statusCode = error.statusCode ?? 500;
        if (statusCode >= 500) {
            app.log.error(error);
        }
        reply.status(statusCode).send({
            error: statusCode >= 500 ? 'Internal server error' : error.message,
        });
    });
    // Start uptime monitoring, event bus workers, and data pipeline
    uptimeMonitor.start();
    registerAllWorkers(getPrisma(), learningEngine, botEngine);
    dataPipeline.initialize().then(ok => {
        if (ok)
            dataPipeline.startConsumer();
    }).catch(err => app.log.error({ err }, 'Data pipeline initialization failed'));
    // Track request latency and errors for uptime monitoring
    app.addHook('onResponse', async (request, reply) => {
        const latencyMs = reply.elapsedTime;
        if (latencyMs > 0)
            uptimeMonitor.recordLatency(latencyMs);
        if (reply.statusCode >= 500)
            uptimeMonitor.recordError();
        const route = request.routeOptions?.url ?? request.url;
        if (route !== '/metrics' && route !== '/health') {
            metricsService.recordApiDuration(request.method, route, latencyMs);
        }
    });
    // Prometheus metrics endpoint — protected by JWT auth
    app.get('/metrics', { preHandler: [async (request, reply) => {
                try {
                    await request.jwtVerify();
                }
                catch {
                    reply.code(401).send({ error: 'Authentication required for metrics' });
                }
            }] }, async (_req, reply) => {
        reply.header('Content-Type', metricsService.getContentType());
        return metricsService.getMetrics();
    });
    // Request duration instrumentation
    app.addHook('onResponse', (request, reply, done) => {
        const route = request.routeOptions?.url ?? request.url;
        if (route !== '/metrics' && route !== '/health') {
            const durationSec = reply.elapsedTime / 1000;
            apiRequestDuration
                .labels(request.method, route, String(reply.statusCode))
                .observe(durationSec);
        }
        done();
    });
    let breezeBridgeHealthy = null;
    app.get('/health', async () => {
        const checks = {};
        try {
            await getPrisma().$queryRaw `SELECT 1`;
            checks.database = 'ok';
        }
        catch {
            checks.database = 'error';
        }
        try {
            checks.engine = isEngineAvailable() ? 'ok' : 'not_installed';
        }
        catch {
            checks.engine = 'error';
        }
        try {
            const resp = await fetch(`${env.BREEZE_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(3000) });
            checks.breeze_bridge = resp.ok ? 'ok' : 'unhealthy';
            breezeBridgeHealthy = resp.ok;
        }
        catch {
            checks.breeze_bridge = 'unreachable';
            breezeBridgeHealthy = false;
        }
        try {
            const redis = getRedis();
            if (redis) {
                const pong = await redis.ping();
                checks.redis = pong === 'PONG' ? 'ok' : 'unhealthy';
            }
            else {
                checks.redis = 'not_configured';
            }
        }
        catch {
            checks.redis = 'error';
        }
        try {
            const mlResp = await fetch(`${env.ML_SERVICE_URL}/health`, { signal: AbortSignal.timeout(3000) });
            checks.ml_service = mlResp.ok ? 'ok' : 'unhealthy';
        }
        catch {
            checks.ml_service = 'unreachable';
        }
        const engineOk = checks.engine === 'ok' || checks.engine === 'not_installed';
        const overall = checks.database === 'ok' && engineOk && checks.redis !== 'error' ? 'ok'
            : checks.database === 'ok' && checks.redis !== 'error' ? 'degraded' : 'error';
        const uptimeStatus = uptimeMonitor.getStatus();
        return {
            status: overall,
            timestamp: new Date().toISOString(),
            uptime: Math.round(process.uptime()),
            checks,
            monitoring: {
                uptimePct: uptimeStatus.uptimePct,
                marketHoursUptimePct: uptimeStatus.marketHoursUptimePct,
                servicesUp: uptimeStatus.servicesUp,
                servicesTotal: uptimeStatus.servicesTotal,
                target: uptimeStatus.target,
                onTrack: uptimeStatus.onTrack,
                recentErrors: uptimeStatus.recentErrors,
                avgLatencyMs: uptimeStatus.avgLatencyMs,
            },
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
    await app.register(engineRoutes, { prefix: '/api/engine' });
    await app.register(reportRoutes, { prefix: '/api/reports' });
    await app.register(guardianRoutes, { prefix: '/api/guardian' });
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
        }
        catch (err) {
            console.error('[Breeze Cron] Auto-renew failed:', err.message);
        }
    });
    orchestrator.scheduleAlways('30 8 * * 1-6', async () => {
        try {
            const result = await authService.renewExpiringSessions();
            if (result.attempted > 0) {
                console.log(`[Breeze Cron Retry] ${result.refreshed}/${result.attempted} refreshed`);
            }
        }
        catch (err) {
            app.log.warn(`[Breeze Cron Retry] Auto-renew retry failed: ${err.message}`);
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
                try {
                    await targetTracker.updateProgress(user.id);
                }
                catch (e) {
                    app.log.warn(`[TargetTracker] Failed for user ${user.id}: ${e.message}`);
                }
            }
        }
        catch (err) {
            console.error('[TargetTracker Cron] Error:', err.message);
        }
    });
    // EOD Review — 15:35 IST = 10:05 UTC
    orchestrator.scheduleMarketDay('5 10 * * 1-5', async () => {
        console.log('[EODReview Cron] Starting end-of-day review...');
        await eodReviewService.runReview();
        console.log('[EODReview Cron] Review complete');
    });
    // EOD OMS Reconciliation — 15:40 IST = 10:10 UTC
    orchestrator.scheduleMarketDay('10 10 * * 1-5', async () => {
        try {
            const { engineOMSReconcile } = await import('./lib/rust-engine.js');
            const report = await engineOMSReconcile();
            const matched = report?.matched ?? 0;
            const mismatches = report?.mismatches ?? [];
            // Notify Chitti about reconciliation outcome
            const prisma = getPrisma();
            const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
            if (Array.isArray(mismatches) && mismatches.length > 0) {
                app.log.error({ mismatches }, `[EOD Reconciliation] ${mismatches.length} position mismatches detected!`);
                const { emit } = await import('./lib/event-bus.js');
                await emit('risk', {
                    type: 'RECONCILIATION_MISMATCH',
                    mismatches,
                    timestamp: new Date().toISOString(),
                });
                for (const u of users) {
                    guardianService.onEvent(u.id, {
                        type: 'reconciliation_result',
                        data: { matched, mismatchCount: mismatches.length, mismatches },
                    }).catch(() => { });
                }
            }
            else {
                console.log(`[EOD Reconciliation] All ${matched} positions reconciled — no mismatches`);
            }
        }
        catch (err) {
            app.log.error(`[EOD Reconciliation] Failed: ${err.message}`);
        }
    });
    // Record daily P&L — 15:45 IST = 10:15 UTC
    orchestrator.scheduleMarketDay('15 10 * * 1-5', async () => {
        try {
            const db = getPrisma();
            const users = await db.user.findMany({ where: { isActive: true }, select: { id: true } });
            for (const user of users) {
                try {
                    await targetTracker.recordDailyPnl(user.id);
                }
                catch (e) {
                    app.log.warn(`[DailyPnl] Failed for user ${user.id}: ${e.message}`);
                }
            }
            console.log(`[DailyPnl Cron] Recorded P&L for ${users.length} users`);
        }
        catch (err) {
            console.error('[DailyPnl Cron] Error:', err.message);
        }
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
                try {
                    await targetTracker.resetDailyTarget(user.id);
                }
                catch (e) {
                    app.log.warn(`[MorningReset] Failed for user ${user.id}: ${e.message}`);
                }
            }
            console.log(`[Morning Reset] Reset daily targets for ${users.length} users`);
        }
        catch (err) {
            console.error('[Morning Reset] Error:', err.message);
        }
    });
    // Global market intelligence scan — 08:45 IST = 03:15 UTC (before market open)
    orchestrator.scheduleMarketDay('15 3 * * 1-5', async () => {
        try {
            const intel = await globalMarketService.runDailyIntelligenceScan();
            console.log(`[GlobalMarket Cron] Pre-market scan done — Sentiment: ${intel.sentiment}, ${intel.globalIndices.length} global indices, ${intel.sectorPerformance.length} sectors`);
        }
        catch (err) {
            console.error('[GlobalMarket Cron] Error:', err.message);
        }
    });
    // Intra-day intelligence refresh — every 30 min during market hours (9:15-15:30 IST = 3:45-10:00 UTC)
    orchestrator.scheduleMarketDay('*/30 3-10 * * 1-5', async () => {
        try {
            await globalMarketService.runDailyIntelligenceScan();
        }
        catch (err) {
            app.log.warn(`[GlobalMarket] Intraday refresh failed: ${err.message}`);
        }
    });
    // Morning boot — only on market days
    orchestrator.scheduleMarketDay('20 3 * * 1-5', async () => {
        const result = await morningBoot.runMorningBoot();
        console.log(`[Morning Boot] Processed ${result.usersProcessed} users, activated ${result.strategiesActivated} strategies`);
        // Close the loop: load nightly-trained ML weights into the live bot engine
        await botEngine.loadMLWeightsFromDB();
        console.log('[Morning Boot] ML weights loaded into execution engine');
    });
    // ── Stop-Loss Monitor, Price Feed, Intraday Manager & Fill Reconciliation ──
    const stopLossMonitor = new StopLossMonitor(getPrisma(), oms);
    const priceFeedService = new PriceFeedService(getPrisma(), dataPipeline);
    const intradayManager = new IntradayManager(getPrisma(), oms);
    const optionsPositionService = new OptionsPositionService(getPrisma());
    const { FillReconciliationService } = await import('./services/fill-reconciliation.service.js');
    const fillReconciliation = new FillReconciliationService(getPrisma(), oms);
    app.decorate('stopLossMonitor', stopLossMonitor);
    app.decorate('priceFeedService', priceFeedService);
    app.decorate('intradayManager', intradayManager);
    app.decorate('optionsPositionService', optionsPositionService);
    app.decorate('fillReconciliation', fillReconciliation);
    // Startup reconciliation: detect orphaned broker positions from crashes
    app.addHook('onReady', async () => {
        try {
            const result = await fillReconciliation.startupReconciliation();
            if (result.orphanedBrokerPositions > 0) {
                console.error(`[CRITICAL] ${result.orphanedBrokerPositions} orphaned broker position(s) detected! Manual review required.`);
            }
            if (result.qtyMismatches > 0) {
                console.warn(`[WARNING] ${result.qtyMismatches} position quantity mismatch(es) between broker and DB.`);
            }
            console.log(`[Startup Reconciliation] Complete: broker orphans=${result.orphanedBrokerPositions}, DB-only=${result.missingBrokerPositions}, qty mismatches=${result.qtyMismatches}`);
        }
        catch (err) {
            console.error('[Startup Reconciliation] Failed:', err.message);
        }
    });
    app.addHook('onReady', async () => {
        try {
            const report = await omsRecovery.recover();
            if (report.orphanedExpired > 0 || report.stuckRejected > 0) {
                app.log.warn({ report }, `[OMS Recovery] Recovered: ${report.totalRecovered} orders, expired ${report.orphanedExpired} orphans, rejected ${report.stuckRejected} stuck`);
            }
            else {
                app.log.info(`[OMS Recovery] Clean startup — ${report.totalRecovered} active orders recovered`);
            }
        }
        catch (err) {
            app.log.error({ err }, '[OMS Recovery] Failed');
        }
    });
    // Start SL monitor, price feed, intraday manager, and fill reconciliation at market open
    orchestrator.scheduleMarketDay('45 3 * * 1-5', async () => {
        console.log('[MarketOpen] Starting stop-loss monitor, price feed, intraday manager, and fill reconciliation');
        await stopLossMonitor.start();
        priceFeedService.start();
        intradayManager.startAutoSquareOff();
        fillReconciliation.start();
    });
    // Stop all at market close
    orchestrator.scheduleMarketDay('0 10 * * 1-5', async () => {
        console.log('[MarketClose] Stopping stop-loss monitor, price feed, intraday manager, and fill reconciliation');
        stopLossMonitor.stop();
        priceFeedService.stop();
        intradayManager.stopAutoSquareOff();
        fillReconciliation.stop();
    });
    app.addHook('onClose', async () => {
        try {
            await omsRecovery.gracefulShutdown();
            app.log.info('[shutdown] OMS graceful shutdown complete');
        }
        catch { /* best effort */ }
        metricsService.stopCollecting();
        auditTrail.destroy();
        botEngine.stopAll();
        stopLossMonitor.stop();
        priceFeedService.stop();
        fillReconciliation.stop();
        dataPipeline.stopConsumer();
        orchestrator.stop();
        uptimeMonitor.stop();
        try {
            stopDaemon();
            console.log('[shutdown] Rust engine daemon stopped');
        }
        catch { /* engine not loaded */ }
        await shutdownEventBus();
        await disconnectPrisma();
    });
    app.addHook('onReady', async () => {
        try {
            const ok = await ensureEngineAvailable();
            if (ok) {
                const daemonOk = startDaemon();
                console.log(`[startup] Rust engine: ACTIVE (daemon: ${daemonOk ? 'persistent' : 'single-shot'})`);
                botEngine.refreshRustAvailability();
            }
            else {
                console.log(`[startup] Rust engine: NOT AVAILABLE — bots will use Gemini AI analysis only`);
            }
        }
        catch (err) {
            console.error('[startup] Rust engine check failed:', err.message, '— bots will use Gemini AI only');
        }
    });
    app.addHook('onReady', () => {
        fetch(`${env.BREEZE_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(5000) })
            .then(resp => {
            breezeBridgeHealthy = resp.ok;
            if (resp.ok)
                console.log(`[Breeze Bridge] Connected at ${env.BREEZE_BRIDGE_URL}`);
            else
                console.warn(`[Breeze Bridge] Unhealthy — HTTP ${resp.status}. Market data and order placement may be limited.`);
        })
            .catch(() => {
            breezeBridgeHealthy = false;
            console.warn(`[Breeze Bridge] UNREACHABLE at ${env.BREEZE_BRIDGE_URL} — market data will be limited. Ensure the Python bridge is running.`);
        });
    });
    // Bridge key events to WebSocket for real-time UI updates
    onEvent('RISK_VIOLATION', (e) => {
        if ('userId' in e && 'violations' in e) {
            wsHub.broadcastToUser(e.userId, { type: 'risk_violation', data: e });
        }
    });
    onEvent('CIRCUIT_BREAKER_TRIGGERED', (e) => {
        if ('userId' in e) {
            wsHub.broadcastToUser(e.userId, { type: 'circuit_breaker', data: e });
        }
    });
    onEvent('PHASE_CHANGE', (e) => {
        if ('from' in e && 'to' in e) {
            wsHub.broadcastRegime({ regime: e.to, confidence: 1.0, timestamp: e.timestamp });
        }
    });
    // ── Guardian AI Personality — Event Wiring ─────────────────────────
    const { GuardianService } = await import('./services/guardian.service.js');
    const guardianService = new GuardianService(getPrisma());
    onEvent('POSITION_CLOSED', (e) => {
        if ('userId' in e && 'symbol' in e) {
            guardianService.onEvent(e.userId, {
                type: 'trade_executed',
                data: { symbol: e.symbol, side: 'CLOSE', pnl: e.pnl },
            }).catch(() => { });
        }
    });
    onEvent('SIGNAL_GENERATED', (e) => {
        if ('userId' in e && 'confidence' in e) {
            guardianService.onEvent(e.userId, {
                type: 'signal_generated',
                data: { symbol: e.symbol, confidence: e.confidence },
            }).catch(() => { });
        }
    });
    onEvent('RISK_VIOLATION', (e) => {
        if ('userId' in e) {
            guardianService.onEvent(e.userId, {
                type: 'risk_violation',
                data: { violations: e.violations, severity: e.severity },
            }).catch(() => { });
        }
    });
    onEvent('PHASE_CHANGE', (e) => {
        if ('to' in e) {
            const prisma = getPrisma();
            prisma.user.findMany({ where: { isActive: true }, select: { id: true } })
                .then(users => {
                for (const u of users) {
                    guardianService.onEvent(u.id, {
                        type: 'regime_change',
                        data: { regime: e.to, details: `Phase changed from ${e.from} to ${e.to}` },
                    }).catch(() => { });
                }
            }).catch(() => { });
        }
    });
    // Guardian proactive thought generation — every 60 min during market hours (reduced from 3 min to cut Gemini costs)
    orchestrator.scheduleMarketDay('0 4-10 * * 1-5', async () => {
        try {
            const prisma = getPrisma();
            const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
            for (const u of users) {
                const state = await guardianService.getOrCreateState(u.id);
                const lastThoughtAge = state.lastThoughtAt
                    ? Date.now() - new Date(state.lastThoughtAt).getTime()
                    : Infinity;
                if (lastThoughtAge > 55 * 60 * 1000) {
                    await guardianService.getAwareness(u.id);
                    await guardianService.generateThought(u.id);
                }
            }
        }
        catch (err) {
            app.log.warn({ err }, '[Guardian] Proactive thought generation failed');
        }
    });
    // Guardian morning boot greeting — 9:00 IST = 3:30 UTC
    orchestrator.scheduleMarketDay('30 3 * * 1-5', async () => {
        try {
            const prisma = getPrisma();
            const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
            for (const u of users) {
                await guardianService.onEvent(u.id, { type: 'morning_boot', data: {} });
            }
        }
        catch (err) {
            app.log.warn({ err }, '[Guardian] Morning boot greeting failed');
        }
    });
    // Guardian mood update based on VIX — every 10 min during market hours
    orchestrator.scheduleMarketDay('*/10 3-10 * * 1-5', async () => {
        try {
            const prisma = getPrisma();
            const users = await prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
            for (const u of users) {
                const awareness = await guardianService.getAwareness(u.id);
                const vixMatch = awareness.match(/VIX[:\s]+([\d.]+)/i);
                const vix = vixMatch ? parseFloat(vixMatch[1]) : undefined;
                await guardianService.updateMood(u.id, { vix, isMarketOpen: true });
            }
        }
        catch (err) {
            app.log.warn({ err }, '[Guardian] Mood update failed');
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
                    if (result.errors.length > 0)
                        console.warn('[Breeze Startup] Errors:', result.errors);
                }
            }
            catch (err) {
                console.error('[Breeze Startup] Auto-renew failed:', err.message);
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
                                status: 'IDLE',
                                isActive: true,
                            },
                        });
                    }
                    app.log.info(`[Bootstrap] Created 4 default bots for user ${user.id}`);
                }
                else {
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
                                status: 'IDLE',
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
                }
                else if (!existingAgent.isActive) {
                    await prisma.aIAgentConfig.update({
                        where: { userId: user.id },
                        data: { isActive: true },
                    });
                    app.log.info(`[Bootstrap] Activated AI agent for user ${user.id}`);
                }
            }
            // Reset error-state bots to IDLE (user must manually start them)
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
                app.log.info(`[Bootstrap] Reset ${staleCount.count} error-state bots to IDLE`);
            }
        }
        catch (err) {
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
        }
        else {
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
                        app.log.error(`Failed to start bot ${bot.name}: ${err.message}`);
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
                        app.log.error(`Failed to start agent: ${err.message}`);
                    });
                    botEngine.startMarketScan(agent.userId).catch(err => {
                        app.log.error(`Failed to start market scan: ${err.message}`);
                    });
                    app.log.info(`Auto-resumed AI agent + market scanner for user ${agent.userId}`);
                }, 40_000);
            }
            if (runningBots.length > 0 || activeAgents.length > 0) {
                app.log.info(`Will resume ${runningBots.length} bots, ${activeAgents.length} agents (staggered, phase: ${phase})`);
            }
            else {
                app.log.info(`[Bot Resume] No RUNNING bots or active agents found in DB`);
            }
        }
        catch (err) {
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
                }
                catch (e) {
                    app.log.warn(`[Reconcile] Failed for portfolio ${p.id}: ${e.message}`);
                }
            }
        }
        catch (err) {
            app.log.error({ err }, 'Failed to reconcile portfolios');
        }
    });
    // Scheduled market briefing refresh
    app.addHook('onReady', async () => {
        const prisma = getPrisma();
        const { AIAgentService } = await import('./services/ai-agent.service.js');
        const agentService = new AIAgentService(prisma, oms);
        // During market hours (9:15 AM - 3:30 PM IST = UTC 3:45 - 10:00)
        // Cron runs every 20 min from UTC 4-10 (covers 9:30 IST to 15:30 IST)
        orchestrator.scheduleMarketDay('*/20 4-10 * * 1-5', async () => {
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
            agentService.regenerateBriefing().catch(err => app.log.warn({ err }, 'Initial briefing generation failed'));
            app.log.info('[Briefing] Initial briefing generation triggered');
        }, 30_000);
    });
    // Match pending orders every minute during market hours
    // IST 9:00-16:00 = UTC 3:30-10:30 → cron 3-10 UTC (covers pre-open + buffer)
    // matchPendingOrders() has its own isMarketOpen() guard for precise timing
    app.addHook('onReady', async () => {
        const prisma = getPrisma();
        const { TradeService } = await import('./services/trade.service.js');
        const tradeService = new TradeService(prisma, oms);
        orchestrator.scheduleMarketDay('* 3-10 * * 1-5', async () => {
            try {
                const result = await tradeService.matchPendingOrders();
                if (result.matched > 0 || result.failed > 0) {
                    app.log.info(`[OrderMatcher] Matched: ${result.matched}, Failed: ${result.failed}`);
                }
            }
            catch (err) {
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
                    const added = new Set();
                    for (const s of symbolsToAdd) {
                        if (added.has(s.symbol))
                            continue;
                        added.add(s.symbol);
                        try {
                            await prisma.watchlistItem.create({
                                data: {
                                    watchlistId: defaultWatchlist.id,
                                    symbol: s.symbol,
                                    exchange: s.exchange,
                                },
                            });
                        }
                        catch { /* skip duplicate watchlist items */ }
                        if (added.size >= 10)
                            break;
                    }
                    if (added.size > 0) {
                        app.log.info(`[Watchlist] Populated ${added.size} symbols for user ${user.id}`);
                    }
                }
            }
        }
        catch (err) {
            app.log.error({ err }, 'Failed to auto-populate watchlists');
        }
    });
    return app;
}
//# sourceMappingURL=app.js.map