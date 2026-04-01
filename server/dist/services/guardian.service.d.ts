import type { PrismaClient, GuardianState } from '@prisma/client';
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
    type: 'trade_executed' | 'signal_generated' | 'risk_violation' | 'target_hit' | 'regime_change' | 'eod_review' | 'morning_boot' | 'reconciliation_result' | 'exposure_breach' | 'drift_detected';
    data: Record<string, unknown>;
}
export declare class GuardianService {
    private readonly prisma;
    private readonly memory;
    constructor(prisma: PrismaClient);
    getOrCreateState(userId: string): Promise<GuardianState>;
    buildSystemPrompt(userId: string): Promise<string>;
    getAwareness(userId: string): Promise<string>;
    chat(userId: string, message: string, _pageContext?: string): Promise<{
        content: string;
        mood: string;
        moodIntensity: number;
    }>;
    updateMood(userId: string, signals: MoodSignals): Promise<GuardianState>;
    generateThought(userId: string): Promise<GuardianThought>;
    onEvent(userId: string, event: SystemEvent): Promise<void>;
}
export {};
//# sourceMappingURL=guardian.service.d.ts.map