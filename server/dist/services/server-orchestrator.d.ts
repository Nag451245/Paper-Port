import cron from 'node-cron';
import type { PrismaClient } from '@prisma/client';
import { MarketCalendar, type MarketPhase } from './market-calendar.js';
import type { BotEngine } from './bot-engine.js';
import type { LearningEngine } from './learning-engine.js';
interface OrchestratorStats {
    pingsSentToday: number;
    lastPingAt: string | null;
    phaseChangesToday: number;
    botsAutoStarted: number;
    botsAutoStopped: number;
    startedAt: string;
}
export declare class ServerOrchestrator {
    private prisma;
    private botEngine;
    private port;
    readonly calendar: MarketCalendar;
    private currentPhase;
    private heartbeatTask;
    private lastPingAt;
    private serverUrl;
    private stats;
    private scheduledTasks;
    private learningEngine?;
    constructor(prisma: PrismaClient, botEngine: BotEngine, port: number);
    start(): void;
    setLearningEngine(engine: LearningEngine): void;
    stop(): void;
    private heartbeat;
    private maybePing;
    private onPhaseChange;
    private autoStartBots;
    private autoStopBots;
    /**
     * Schedule a cron job that only fires on market days (skips holidays).
     * Returns the task so it can be stopped on shutdown.
     */
    scheduleMarketDay(cronExpression: string, handler: () => Promise<void> | void): cron.ScheduledTask;
    /**
     * Schedule a cron job that runs regardless of market status.
     */
    scheduleAlways(cronExpression: string, handler: () => Promise<void> | void): cron.ScheduledTask;
    private resetDailyStats;
    getStatus(): {
        market: ReturnType<MarketCalendar['getStatus']>;
        orchestrator: OrchestratorStats & {
            currentPhase: MarketPhase;
        };
        botEngine: {
            activeBots: number;
            activeAgents: number;
        };
    };
}
export {};
//# sourceMappingURL=server-orchestrator.d.ts.map