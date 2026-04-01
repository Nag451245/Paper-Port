import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
declare class WebSocketHub {
    private clients;
    private symbolSubscriptions;
    private heartbeatTimer;
    register(socket: WebSocket, userId: string): void;
    private ensureHeartbeat;
    private handleMessage;
    private unregister;
    private safeSend;
    private drainPending;
    broadcastPriceUpdate(symbol: string, data: {
        ltp: number;
        change: number;
        changePercent: number;
        volume: number;
        timestamp: string;
    }): void;
    broadcastToUser(userId: string, event: {
        type: string;
        [key: string]: unknown;
    }): void;
    broadcastSignal(userId: string, signal: {
        symbol: string;
        direction: string;
        confidence: number;
        source: string;
    }): void;
    broadcastBotMessage(userId: string, message: {
        botId: string;
        content: string;
        messageType: string;
    }): void;
    broadcastBotActivity(userId: string, activity: {
        botId: string;
        botName: string;
        activityType: 'scan_complete' | 'signal_generated' | 'trade_executed' | 'risk_blocked' | 'decision_made' | 'status_change';
        summary: string;
        details?: Record<string, unknown>;
    }): void;
    broadcastNotification(userId: string, notification: {
        title: string;
        message: string;
        notificationType: string;
    }): void;
    broadcastTradeExecution(userId: string, trade: {
        symbol: string;
        side: string;
        qty: number;
        price: number;
    }): void;
    broadcastEngineSignal(symbol: string, data: {
        indicators: Record<string, number>;
        signal: string;
        confidence: number;
        timestamp: string;
    }): void;
    broadcastRegime(data: {
        regime: string;
        confidence: number;
        timestamp: string;
    }): void;
    broadcastAnomaly(data: {
        symbol: string;
        anomaly_type: string;
        score: number;
        details: string;
        timestamp: string;
    }): void;
    getConnectedCount(): number;
    getSubscribedSymbols(): string[];
    shutdown(): void;
}
export declare const wsHub: WebSocketHub;
export declare function registerWebSocket(app: FastifyInstance): Promise<void>;
export {};
//# sourceMappingURL=websocket.d.ts.map