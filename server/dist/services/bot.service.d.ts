import type { PrismaClient } from '@prisma/client';
type BotRole = string;
export declare class BotError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number);
}
export interface CreateBotData {
    name: string;
    role: BotRole;
    avatarEmoji?: string;
    description?: string;
    maxCapital?: number;
    assignedSymbols?: string;
    assignedStrategy?: string;
}
export interface UpdateBotData {
    name?: string;
    role?: BotRole;
    avatarEmoji?: string;
    description?: string;
    maxCapital?: number;
    assignedSymbols?: string;
    assignedStrategy?: string;
}
export interface AssignTaskData {
    taskType: string;
    description: string;
    parameters?: Record<string, unknown>;
}
export interface SendMessageData {
    content: string;
    toBotId?: string;
    messageType?: string;
}
export declare class BotService {
    private prisma;
    constructor(prisma: PrismaClient);
    list(userId: string): Promise<{
        status: string;
        name: string;
        id: string;
        role: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        winRate: import("@prisma/client/runtime/library").Decimal;
        totalTrades: number;
        avatarEmoji: string;
        description: string | null;
        assignedSymbols: string | null;
        assignedStrategy: string | null;
        portfolioId: string | null;
        apiKeyRef: string | null;
        maxCapital: import("@prisma/client/runtime/library").Decimal;
        usedCapital: import("@prisma/client/runtime/library").Decimal;
        totalPnl: import("@prisma/client/runtime/library").Decimal;
        lastAction: string | null;
        lastActionAt: Date | null;
    }[]>;
    create(userId: string, data: CreateBotData): Promise<{
        status: string;
        name: string;
        id: string;
        role: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        winRate: import("@prisma/client/runtime/library").Decimal;
        totalTrades: number;
        avatarEmoji: string;
        description: string | null;
        assignedSymbols: string | null;
        assignedStrategy: string | null;
        portfolioId: string | null;
        apiKeyRef: string | null;
        maxCapital: import("@prisma/client/runtime/library").Decimal;
        usedCapital: import("@prisma/client/runtime/library").Decimal;
        totalPnl: import("@prisma/client/runtime/library").Decimal;
        lastAction: string | null;
        lastActionAt: Date | null;
    }>;
    getById(botId: string, userId: string): Promise<{
        status: string;
        name: string;
        id: string;
        role: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        winRate: import("@prisma/client/runtime/library").Decimal;
        totalTrades: number;
        avatarEmoji: string;
        description: string | null;
        assignedSymbols: string | null;
        assignedStrategy: string | null;
        portfolioId: string | null;
        apiKeyRef: string | null;
        maxCapital: import("@prisma/client/runtime/library").Decimal;
        usedCapital: import("@prisma/client/runtime/library").Decimal;
        totalPnl: import("@prisma/client/runtime/library").Decimal;
        lastAction: string | null;
        lastActionAt: Date | null;
    }>;
    update(botId: string, userId: string, data: UpdateBotData): Promise<{
        status: string;
        name: string;
        id: string;
        role: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        winRate: import("@prisma/client/runtime/library").Decimal;
        totalTrades: number;
        avatarEmoji: string;
        description: string | null;
        assignedSymbols: string | null;
        assignedStrategy: string | null;
        portfolioId: string | null;
        apiKeyRef: string | null;
        maxCapital: import("@prisma/client/runtime/library").Decimal;
        usedCapital: import("@prisma/client/runtime/library").Decimal;
        totalPnl: import("@prisma/client/runtime/library").Decimal;
        lastAction: string | null;
        lastActionAt: Date | null;
    }>;
    delete(botId: string, userId: string): Promise<{
        status: string;
        name: string;
        id: string;
        role: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        winRate: import("@prisma/client/runtime/library").Decimal;
        totalTrades: number;
        avatarEmoji: string;
        description: string | null;
        assignedSymbols: string | null;
        assignedStrategy: string | null;
        portfolioId: string | null;
        apiKeyRef: string | null;
        maxCapital: import("@prisma/client/runtime/library").Decimal;
        usedCapital: import("@prisma/client/runtime/library").Decimal;
        totalPnl: import("@prisma/client/runtime/library").Decimal;
        lastAction: string | null;
        lastActionAt: Date | null;
    }>;
    start(botId: string, userId: string): Promise<{
        status: string;
        name: string;
        id: string;
        role: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        winRate: import("@prisma/client/runtime/library").Decimal;
        totalTrades: number;
        avatarEmoji: string;
        description: string | null;
        assignedSymbols: string | null;
        assignedStrategy: string | null;
        portfolioId: string | null;
        apiKeyRef: string | null;
        maxCapital: import("@prisma/client/runtime/library").Decimal;
        usedCapital: import("@prisma/client/runtime/library").Decimal;
        totalPnl: import("@prisma/client/runtime/library").Decimal;
        lastAction: string | null;
        lastActionAt: Date | null;
    }>;
    stop(botId: string, userId: string): Promise<{
        status: string;
        name: string;
        id: string;
        role: string;
        isActive: boolean;
        createdAt: Date;
        updatedAt: Date;
        userId: string;
        winRate: import("@prisma/client/runtime/library").Decimal;
        totalTrades: number;
        avatarEmoji: string;
        description: string | null;
        assignedSymbols: string | null;
        assignedStrategy: string | null;
        portfolioId: string | null;
        apiKeyRef: string | null;
        maxCapital: import("@prisma/client/runtime/library").Decimal;
        usedCapital: import("@prisma/client/runtime/library").Decimal;
        totalPnl: import("@prisma/client/runtime/library").Decimal;
        lastAction: string | null;
        lastActionAt: Date | null;
    }>;
    assignTask(botId: string, userId: string, data: AssignTaskData): Promise<{
        status: string;
        id: string;
        createdAt: Date;
        userId: string;
        description: string;
        botId: string;
        taskType: string;
        parametersJson: string | null;
        resultJson: string | null;
        completedAt: Date | null;
    }>;
    listTasks(botId: string, userId: string): Promise<{
        status: string;
        id: string;
        createdAt: Date;
        userId: string;
        description: string;
        botId: string;
        taskType: string;
        parametersJson: string | null;
        resultJson: string | null;
        completedAt: Date | null;
    }[]>;
    sendMessage(botId: string, userId: string, data: SendMessageData): Promise<{
        id: string;
        createdAt: Date;
        userId: string;
        fromBotId: string;
        toBotId: string | null;
        messageType: string;
        content: string;
        metadataJson: string | null;
        isRead: boolean;
    }>;
    listMessages(botId: string, userId: string): Promise<{
        id: string;
        createdAt: Date;
        userId: string;
        fromBotId: string;
        toBotId: string | null;
        messageType: string;
        content: string;
        metadataJson: string | null;
        isRead: boolean;
    }[]>;
    allMessages(userId: string): Promise<{
        id: string;
        createdAt: Date;
        userId: string;
        fromBotId: string;
        toBotId: string | null;
        messageType: string;
        content: string;
        metadataJson: string | null;
        isRead: boolean;
    }[]>;
}
export {};
//# sourceMappingURL=bot.service.d.ts.map