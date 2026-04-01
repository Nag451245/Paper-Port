import type { PrismaClient } from '@prisma/client';
export declare class TelegramService {
    private prisma;
    private static pollingInstance;
    private static pollingStarted;
    private botToken;
    private lastUpdateId;
    private polling;
    private stopRequested;
    private processedUpdateIds;
    private userCooldowns;
    private chatCooldowns;
    private processingMessages;
    constructor(prisma: PrismaClient);
    get isConfigured(): boolean;
    stopPolling(): void;
    private startPolling;
    private pollLoop;
    private isOnScanCooldown;
    private isOnChatCooldown;
    private markProcessed;
    private pollUpdates;
    private routeMessage;
    private handleGreeting;
    private handleSmartStatus;
    private handleHelp;
    private handleScanCommand;
    private handleOptionsCommand;
    private handleQuoteCommand;
    private handleCommandCenterChat;
    private fetchCandles;
    sendMessage(chatId: string, text: string, parseMode?: 'HTML' | 'Markdown'): Promise<boolean>;
    notifyUser(userId: string, title: string, message: string): Promise<boolean>;
    notifyTradeExecution(userId: string, symbol: string, side: string, qty: number, price: number, pnl?: number): Promise<boolean>;
    notifySignal(userId: string, symbol: string, direction: string, confidence: number, entry: number, target: number, stopLoss: number, source?: string): Promise<boolean>;
    notifyPipelineSignal(symbol: string, direction: string, confidence: number, strategy: string, mlScore: number, source: string): Promise<void>;
    notifyRiskAlert(userId: string, alertType: string, message: string): Promise<boolean>;
    notifyDailyReport(userId: string, report: {
        trades: number;
        pnl: number;
        winRate: number;
        topWinner: string;
        topLoser: string;
        regime: string;
    }): Promise<boolean>;
    verifyConnection(chatId: string): Promise<{
        success: boolean;
        username?: string;
    }>;
    getBotInfo(): Promise<{
        username: string;
        name: string;
    } | null>;
}
//# sourceMappingURL=telegram.service.d.ts.map