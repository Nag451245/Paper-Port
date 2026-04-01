/**
 * Event Workers — BullMQ consumers for all 5 event bus categories.
 *
 * Bridges the gap between event producers (TradeService, OMS, RiskService, etc.)
 * and consumers (WebSocket push, decision audit, learning triggers).
 */
import type { PrismaClient } from '@prisma/client';
import type { LearningEngine } from './learning-engine.js';
import type { BotEngine } from './bot-engine.js';
export declare function registerAllWorkers(prisma: PrismaClient, learningEngine?: LearningEngine, botEngine?: BotEngine): void;
//# sourceMappingURL=event-workers.d.ts.map