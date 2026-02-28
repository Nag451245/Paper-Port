import type { PrismaClient } from '@prisma/client';
type BotRole = string;

export class BotError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'BotError';
  }
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

export class BotService {
  constructor(private prisma: PrismaClient) {}

  async list(userId: string) {
    return this.prisma.tradingBot.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, data: CreateBotData) {
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

  async getById(botId: string, userId: string) {
    const bot = await this.prisma.tradingBot.findUnique({
      where: { id: botId },
    });

    if (!bot || bot.userId !== userId) {
      throw new BotError('Bot not found', 404);
    }

    return bot;
  }

  async update(botId: string, userId: string, data: UpdateBotData) {
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

  async delete(botId: string, userId: string) {
    await this.getById(botId, userId);

    return this.prisma.tradingBot.delete({
      where: { id: botId },
    });
  }

  async start(botId: string, userId: string) {
    await this.getById(botId, userId);

    return this.prisma.tradingBot.update({
      where: { id: botId },
      data: { status: 'RUNNING' },
    });
  }

  async stop(botId: string, userId: string) {
    await this.getById(botId, userId);

    return this.prisma.tradingBot.update({
      where: { id: botId },
      data: { status: 'IDLE' },
    });
  }

  async assignTask(botId: string, userId: string, data: AssignTaskData) {
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

  async listTasks(botId: string, userId: string) {
    await this.getById(botId, userId);

    return this.prisma.botTask.findMany({
      where: { botId },
      orderBy: { createdAt: 'desc' },
    });
  }

  async sendMessage(botId: string, userId: string, data: SendMessageData) {
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

  async listMessages(botId: string, userId: string) {
    await this.getById(botId, userId);

    return this.prisma.botMessage.findMany({
      where: {
        OR: [{ fromBotId: botId }, { toBotId: botId }],
        userId,
      },
      orderBy: { createdAt: 'desc' },
    });
  }

  async allMessages(userId: string) {
    return this.prisma.botMessage.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
    });
  }
}
