import cron from 'node-cron';
import { MarketCalendar } from './market-calendar.js';
import { createChildLogger } from '../lib/logger.js';
import { emit } from '../lib/event-bus.js';
const log = createChildLogger('Orchestrator');
export class ServerOrchestrator {
    prisma;
    botEngine;
    port;
    calendar = new MarketCalendar();
    currentPhase;
    heartbeatTask = null;
    lastPingAt = 0;
    serverUrl;
    stats;
    scheduledTasks = [];
    learningEngine;
    constructor(prisma, botEngine, port) {
        this.prisma = prisma;
        this.botEngine = botEngine;
        this.port = port;
        this.currentPhase = this.calendar.getMarketPhase();
        this.serverUrl = `http://127.0.0.1:${port}`;
        this.stats = {
            pingsSentToday: 0,
            lastPingAt: null,
            phaseChangesToday: 0,
            botsAutoStarted: 0,
            botsAutoStopped: 0,
            startedAt: new Date().toISOString(),
        };
    }
    start() {
        console.log(`[Orchestrator] Starting — phase: ${this.currentPhase} | ${this.calendar.getPhaseConfig(this.currentPhase).label}`);
        const holiday = this.calendar.getHolidayName();
        if (holiday) {
            console.log(`[Orchestrator] Today is a holiday: ${holiday}`);
        }
        if (this.currentPhase === 'MARKET_HOURS' || this.currentPhase === 'PRE_MARKET') {
            const config = this.calendar.getPhaseConfig(this.currentPhase);
            this.botEngine.setTickInterval(config.botTickMs || 60_000);
            this.botEngine.setMarketScanInterval(config.scanIntervalMs || 5 * 60_000);
            setTimeout(() => {
                this.autoStartBots().catch(err => {
                    console.error('[Orchestrator] Auto-start on boot failed:', err.message);
                });
            }, 15_000);
        }
        this.heartbeatTask = cron.schedule('* * * * *', () => {
            this.heartbeat().catch(err => {
                console.error('[Orchestrator] Heartbeat error:', err.message);
            });
        });
        this.resetDailyStats();
    }
    setLearningEngine(engine) {
        this.learningEngine = engine;
    }
    stop() {
        this.heartbeatTask?.stop();
        this.heartbeatTask = null;
        for (const task of this.scheduledTasks)
            task.stop();
        this.scheduledTasks = [];
        console.log('[Orchestrator] Stopped');
    }
    async heartbeat() {
        const phase = this.calendar.getMarketPhase();
        if (phase !== this.currentPhase) {
            await this.onPhaseChange(this.currentPhase, phase);
            this.currentPhase = phase;
            this.stats.phaseChangesToday++;
        }
        await this.maybePing(phase);
    }
    async maybePing(phase) {
        const config = this.calendar.getPhaseConfig(phase);
        const now = Date.now();
        const elapsed = now - this.lastPingAt;
        if (elapsed < config.pingIntervalMs)
            return;
        try {
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 10_000);
            await fetch(`${this.serverUrl}/health`, { signal: controller.signal });
            clearTimeout(timeout);
            this.lastPingAt = now;
            this.stats.pingsSentToday++;
            this.stats.lastPingAt = new Date().toISOString();
        }
        catch {
            // Server might be starting up; non-critical
        }
    }
    async onPhaseChange(from, to) {
        log.info({ from, to }, 'Market phase changed');
        emit('system', { type: 'PHASE_CHANGE', from, to, timestamp: new Date().toISOString() }).catch(err => log.error({ err }, 'Failed to emit PHASE_CHANGE event'));
        const config = this.calendar.getPhaseConfig(to);
        if (to === 'MARKET_HOURS') {
            if (this.learningEngine) {
                this.learningEngine.resetIntradayState();
            }
            await this.autoStartBots();
            this.botEngine.setTickInterval(config.botTickMs || 60_000);
            this.botEngine.setMarketScanInterval(config.scanIntervalMs || 5 * 60_000);
        }
        else {
            if (from === 'MARKET_HOURS') {
                await this.autoStopBots();
            }
            this.botEngine.setTickInterval(10 * 60_000);
            this.botEngine.setMarketScanInterval(30 * 60_000);
        }
        const nextOpen = this.calendar.getNextMarketOpen();
        if (to === 'WEEKEND' || to === 'HOLIDAY' || to === 'AFTER_HOURS') {
            console.log(`[Orchestrator] Next market open: ${nextOpen.date} (${nextOpen.label})`);
        }
    }
    async autoStartBots() {
        try {
            const bots = await this.prisma.tradingBot.findMany({
                where: { isActive: true, status: { in: ['RUNNING', 'IDLE'] } },
                select: { id: true, userId: true, name: true, status: true },
                take: 5,
            });
            for (const bot of bots) {
                if (bot.status !== 'RUNNING') {
                    await this.prisma.tradingBot.update({
                        where: { id: bot.id },
                        data: { status: 'RUNNING', lastAction: 'Auto-started at market open', lastActionAt: new Date() },
                    });
                }
            }
            for (let i = 0; i < bots.length; i++) {
                const bot = bots[i];
                setTimeout(() => {
                    this.botEngine.startBot(bot.id, bot.userId).catch(err => log.error({ err, botId: bot.id }, 'Failed to auto-start bot'));
                }, i * 5_000);
            }
            const agents = await this.prisma.aIAgentConfig.findMany({
                where: { isActive: true },
                select: { userId: true },
                take: 1,
            });
            for (const agent of agents) {
                setTimeout(() => {
                    this.botEngine.startAgent(agent.userId).catch(err => log.error({ err, userId: agent.userId }, 'Failed to auto-start agent'));
                    this.botEngine.startMarketScan(agent.userId).catch(err => log.error({ err, userId: agent.userId }, 'Failed to auto-start market scan'));
                }, bots.length * 5_000 + 10_000);
            }
            this.stats.botsAutoStarted += bots.length;
            if (bots.length > 0) {
                console.log(`[Orchestrator] Auto-started ${bots.length} bots + ${agents.length} agents for market open`);
            }
        }
        catch (err) {
            console.error('[Orchestrator] Auto-start failed:', err.message);
        }
    }
    async autoStopBots() {
        try {
            const activeCount = this.botEngine.getActiveBotCount();
            this.botEngine.stopAll();
            this.stats.botsAutoStopped += activeCount;
            if (activeCount > 0) {
                console.log(`[Orchestrator] Auto-stopped ${activeCount} bots/agents for market close`);
            }
        }
        catch (err) {
            console.error('[Orchestrator] Auto-stop failed:', err.message);
        }
    }
    /**
     * Schedule a cron job that only fires on market days (skips holidays).
     * Returns the task so it can be stopped on shutdown.
     */
    scheduleMarketDay(cronExpression, handler) {
        const task = cron.schedule(cronExpression, async () => {
            if (this.calendar.isHoliday() || this.calendar.isWeekend()) {
                const reason = this.calendar.isHoliday()
                    ? `Holiday: ${this.calendar.getHolidayName()}`
                    : 'Weekend';
                console.log(`[Orchestrator] Skipping scheduled task — ${reason}`);
                return;
            }
            try {
                await handler();
            }
            catch (err) {
                console.error('[Orchestrator] Scheduled task failed:', err.message);
            }
        });
        this.scheduledTasks.push(task);
        return task;
    }
    /**
     * Schedule a cron job that runs regardless of market status.
     */
    scheduleAlways(cronExpression, handler) {
        const task = cron.schedule(cronExpression, async () => {
            try {
                await handler();
            }
            catch (err) {
                console.error('[Orchestrator] Scheduled task failed:', err.message);
            }
        });
        this.scheduledTasks.push(task);
        return task;
    }
    resetDailyStats() {
        cron.schedule('30 2 * * *', () => {
            this.stats.pingsSentToday = 0;
            this.stats.phaseChangesToday = 0;
            this.stats.botsAutoStarted = 0;
            this.stats.botsAutoStopped = 0;
        });
    }
    getStatus() {
        return {
            market: this.calendar.getStatus(),
            orchestrator: {
                ...this.stats,
                currentPhase: this.currentPhase,
            },
            botEngine: {
                activeBots: this.botEngine.getActiveBotCount(),
                activeAgents: this.botEngine.getActiveAgentCount(),
            },
        };
    }
}
//# sourceMappingURL=server-orchestrator.js.map