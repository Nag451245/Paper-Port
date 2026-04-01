import type { FastifyInstance } from 'fastify';
interface ChatResult {
    role: 'assistant';
    content: string;
    intent: string;
}
export declare function setBotEngineRef(engine: any): void;
/**
 * Core command center chat logic — reusable by both HTTP route and Telegram bot.
 */
export declare function processCommandCenterChat(userId: string, message: string): Promise<ChatResult>;
export default function commandCenterRoutes(app: FastifyInstance): Promise<void>;
export {};
//# sourceMappingURL=command-center.d.ts.map