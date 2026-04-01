export class BotError extends Error {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'BotError';
    }
}
export class BotService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async list(userId) {
        return this.prisma.tradingBot.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
    }
    async create(userId, data) {
        return this.prisma.tradingBot.create({
            data: {
                userId,
                name: data.name,
                role: data.role,
                avatarEmoji: data.avatarEmoji ?? '🤖',
                description: data.description ?? null,
                maxCapital: data.maxCapital ?? 100000,
                assignedSymbols: data.assignedSymbols ?? null,
                assignedStrategy: data.assignedStrategy ?? null,
            },
        });
    }
    async getById(botId, userId) {
        const bot = await this.prisma.tradingBot.findUnique({
            where: { id: botId },
        });
        if (!bot || bot.userId !== userId) {
            throw new BotError('Bot not found', 404);
        }
        return bot;
    }
    async update(botId, userId, data) {
        await this.getById(botId, userId);
        return this.prisma.tradingBot.update({
            where: { id: botId },
            data: {
                ...(data.name !== undefined && { name: data.name }),
                ...(data.role !== undefined && { role: data.role }),
                ...(data.avatarEmoji !== undefined && { avatarEmoji: data.avatarEmoji }),
                ...(data.description !== undefined && { description: data.description }),
                ...(data.maxCapital !== undefined && { maxCapital: data.maxCapital }),
                ...(data.assignedSymbols !== undefined && { assignedSymbols: data.assignedSymbols }),
                ...(data.assignedStrategy !== undefined && { assignedStrategy: data.assignedStrategy }),
            },
        });
    }
    async delete(botId, userId) {
        await this.getById(botId, userId);
        return this.prisma.tradingBot.delete({
            where: { id: botId },
        });
    }
    async start(botId, userId) {
        await this.getById(botId, userId);
        return this.prisma.tradingBot.update({
            where: { id: botId },
            data: { status: 'RUNNING' },
        });
    }
    async stop(botId, userId) {
        await this.getById(botId, userId);
        return this.prisma.tradingBot.update({
            where: { id: botId },
            data: { status: 'IDLE' },
        });
    }
    async assignTask(botId, userId, data) {
        await this.getById(botId, userId);
        return this.prisma.botTask.create({
            data: {
                botId,
                userId,
                taskType: data.taskType,
                description: data.description,
                parametersJson: data.parameters ? JSON.stringify(data.parameters) : undefined,
            },
        });
    }
    async listTasks(botId, userId) {
        await this.getById(botId, userId);
        return this.prisma.botTask.findMany({
            where: { botId },
            orderBy: { createdAt: 'desc' },
        });
    }
    async sendMessage(botId, userId, data) {
        await this.getById(botId, userId);
        return this.prisma.botMessage.create({
            data: {
                fromBotId: botId,
                toBotId: data.toBotId ?? null,
                userId,
                messageType: data.messageType ?? 'user',
                content: data.content,
            },
        });
    }
    async listMessages(botId, userId) {
        await this.getById(botId, userId);
        return this.prisma.botMessage.findMany({
            where: {
                OR: [{ fromBotId: botId }, { toBotId: botId }],
                userId,
            },
            orderBy: { createdAt: 'desc' },
        });
    }
    async allMessages(userId) {
        return this.prisma.botMessage.findMany({
            where: { userId },
            orderBy: { createdAt: 'desc' },
        });
    }
}
//# sourceMappingURL=bot.service.js.map