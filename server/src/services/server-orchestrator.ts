import cron from 'node-cron';
import type { PrismaClient } from '@prisma/client';
import { MarketCalendar, type MarketPhase } from './market-calendar.js';
import type { BotEngine } from './bot-engine.js';

interface OrchestratorStats {
  pingsSentToday: number;
  lastPingAt: string | null;
  phaseChangesToday: number;
  botsAutoStarted: number;
  botsAutoStopped: number;
  startedAt: string;
}

export class ServerOrchestrator {
  readonly calendar = new MarketCalendar();
  private currentPhase: MarketPhase;
  private heartbeatTask: cron.ScheduledTask | null = null;
  private lastPingAt = 0;
  private serverUrl: string;
  private stats: OrchestratorStats;
  private scheduledTasks: cron.ScheduledTask[] = [];

  constructor(
    private prisma: PrismaClient,
    private botEngine: BotEngine,
    private port: number,
  ) {
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

  start(): void {
    console.log(`[Orchestrator] Starting — phase: ${this.currentPhase} | ${this.calendar.getPhaseConfig(this.currentPhase).label}`);

    const holiday = this.calendar.getHolidayName();
    if (holiday) {
      console.log(`[Orchestrator] Today is a holiday: ${holiday}`);
    }

    this.heartbeatTask = cron.schedule('* * * * *', () => {
      this.heartbeat().catch(err => {
        console.error('[Orchestrator] Heartbeat error:', (err as Error).message);
      });
    });

    this.resetDailyStats();
  }

  stop(): void {
    this.heartbeatTask?.stop();
    this.heartbeatTask = null;
    for (const task of this.scheduledTasks) task.stop();
    this.scheduledTasks = [];
    console.log('[Orchestrator] Stopped');
  }

  private async heartbeat(): Promise<void> {
    const phase = this.calendar.getMarketPhase();

    if (phase !== this.currentPhase) {
      await this.onPhaseChange(this.currentPhase, phase);
      this.currentPhase = phase;
      this.stats.phaseChangesToday++;
    }

    await this.maybePing(phase);
  }

  private async maybePing(phase: MarketPhase): Promise<void> {
    const config = this.calendar.getPhaseConfig(phase);
    const now = Date.now();
    const elapsed = now - this.lastPingAt;

    if (elapsed < config.pingIntervalMs) return;

    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 10_000);
      await fetch(`${this.serverUrl}/health`, { signal: controller.signal });
      clearTimeout(timeout);
      this.lastPingAt = now;
      this.stats.pingsSentToday++;
      this.stats.lastPingAt = new Date().toISOString();
    } catch {
      // Server might be starting up; non-critical
    }
  }

  private async onPhaseChange(from: MarketPhase, to: MarketPhase): Promise<void> {
    console.log(`[Orchestrator] Phase changed: ${from} -> ${to}`);

    const config = this.calendar.getPhaseConfig(to);

    if (to === 'MARKET_HOURS' && !config.botsActive === false) {
      await this.autoStartBots();
    }

    if (from === 'MARKET_HOURS' && to !== 'MARKET_HOURS') {
      await this.autoStopBots();
    }

    if (to === 'MARKET_HOURS') {
      this.botEngine.setTickInterval(config.botTickMs);
      this.botEngine.setMarketScanInterval(config.scanIntervalMs);
    }

    if (to === 'AFTER_HOURS' && from === 'AFTER_HOURS') return;
    const nextOpen = this.calendar.getNextMarketOpen();
    if (to === 'WEEKEND' || to === 'HOLIDAY' || to === 'AFTER_HOURS') {
      console.log(`[Orchestrator] Next market open: ${nextOpen.date} (${nextOpen.label})`);
    }
  }

  private async autoStartBots(): Promise<void> {
    try {
      const bots = await this.prisma.tradingBot.findMany({
        where: { status: 'RUNNING', isActive: true },
        select: { id: true, userId: true, name: true },
        take: 5,
      });

      for (let i = 0; i < bots.length; i++) {
        const bot = bots[i];
        setTimeout(() => {
          this.botEngine.startBot(bot.id, bot.userId).catch(() => {});
        }, i * 5_000);
      }

      const agents = await this.prisma.aIAgentConfig.findMany({
        where: { isActive: true },
        select: { userId: true },
        take: 1,
      });
      for (const agent of agents) {
        setTimeout(() => {
          this.botEngine.startAgent(agent.userId).catch(() => {});
          this.botEngine.startMarketScan(agent.userId).catch(() => {});
        }, bots.length * 5_000 + 10_000);
      }

      this.stats.botsAutoStarted += bots.length;
      if (bots.length > 0) {
        console.log(`[Orchestrator] Auto-started ${bots.length} bots + ${agents.length} agents for market open`);
      }
    } catch (err) {
      console.error('[Orchestrator] Auto-start failed:', (err as Error).message);
    }
  }

  private async autoStopBots(): Promise<void> {
    try {
      const activeCount = this.botEngine.getActiveBotCount();
      this.botEngine.stopAll();
      this.stats.botsAutoStopped += activeCount;
      if (activeCount > 0) {
        console.log(`[Orchestrator] Auto-stopped ${activeCount} bots/agents for market close`);
      }
    } catch (err) {
      console.error('[Orchestrator] Auto-stop failed:', (err as Error).message);
    }
  }

  /**
   * Schedule a cron job that only fires on market days (skips holidays).
   * Returns the task so it can be stopped on shutdown.
   */
  scheduleMarketDay(cronExpression: string, handler: () => Promise<void> | void): cron.ScheduledTask {
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
      } catch (err) {
        console.error('[Orchestrator] Scheduled task failed:', (err as Error).message);
      }
    });
    this.scheduledTasks.push(task);
    return task;
  }

  /**
   * Schedule a cron job that runs regardless of market status.
   */
  scheduleAlways(cronExpression: string, handler: () => Promise<void> | void): cron.ScheduledTask {
    const task = cron.schedule(cronExpression, async () => {
      try {
        await handler();
      } catch (err) {
        console.error('[Orchestrator] Scheduled task failed:', (err as Error).message);
      }
    });
    this.scheduledTasks.push(task);
    return task;
  }

  private resetDailyStats(): void {
    cron.schedule('30 2 * * *', () => { // midnight IST (UTC+5:30 -> 2:30 UTC)
      this.stats.pingsSentToday = 0;
      this.stats.phaseChangesToday = 0;
      this.stats.botsAutoStarted = 0;
      this.stats.botsAutoStopped = 0;
    });
  }

  getStatus(): {
    market: ReturnType<MarketCalendar['getStatus']>;
    orchestrator: OrchestratorStats & { currentPhase: MarketPhase };
    botEngine: { activeBots: number; activeAgents: number };
  } {
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
