import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { BotService, BotError } from '../services/bot.service.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
const VALID_BOT_ROLES = ['SCANNER', 'ANALYST', 'EXECUTOR', 'RISK_MANAGER', 'STRATEGIST', 'MONITOR'] as const;

const createBotSchema = z.object({
  name: z.string().min(1),
  role: z.enum(VALID_BOT_ROLES),
  avatarEmoji: z.string().optional(),
  description: z.string().optional(),
  maxCapital: z.number().positive().optional(),
  assignedSymbols: z.string().optional(),
  assignedStrategy: z.string().optional(),
});

const updateBotSchema = z.object({
  name: z.string().min(1).optional(),
  role: z.enum(VALID_BOT_ROLES).optional(),
  avatarEmoji: z.string().optional(),
  description: z.string().optional(),
  maxCapital: z.number().positive().optional(),
  assignedSymbols: z.string().optional(),
  assignedStrategy: z.string().optional(),
});

const assignTaskSchema = z.object({
  taskType: z.string().min(1),
  description: z.string().min(1),
  parameters: z.record(z.unknown()).optional(),
});

const sendMessageSchema = z.object({
  content: z.string().min(1),
  toBotId: z.string().uuid().optional(),
  messageType: z.string().optional(),
});

export async function botRoutes(app: FastifyInstance): Promise<void> {
  const service = new BotService(getPrisma());

  app.addHook('preHandler', authenticate);

  app.get('/', async (request, reply) => {
    const userId = getUserId(request);
    const bots = await service.list(userId);
    return reply.send(bots);
  });

  app.post('/', async (request, reply) => {
    const parsed = createBotSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    const userId = getUserId(request);
    const bot = await service.create(userId, parsed.data);
    return reply.code(201).send(bot);
  });

  app.get('/messages/all', async (request, reply) => {
    const userId = getUserId(request);
    const messages = await service.allMessages(userId);
    return reply.send(messages);
  });

  app.get('/:botId', async (request, reply) => {
    try {
      const { botId } = request.params as { botId: string };
      const userId = getUserId(request);
      const bot = await service.getById(botId, userId);
      return reply.send(bot);
    } catch (err) {
      if (err instanceof BotError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.put('/:botId', async (request, reply) => {
    const parsed = updateBotSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { botId } = request.params as { botId: string };
      const userId = getUserId(request);
      const bot = await service.update(botId, userId, parsed.data);
      return reply.send(bot);
    } catch (err) {
      if (err instanceof BotError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.delete('/:botId', async (request, reply) => {
    try {
      const { botId } = request.params as { botId: string };
      const userId = getUserId(request);
      await service.delete(botId, userId);
      return reply.code(204).send();
    } catch (err) {
      if (err instanceof BotError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/:botId/start', async (request, reply) => {
    try {
      const { botId } = request.params as { botId: string };
      const userId = getUserId(request);
      const bot = await service.start(botId, userId);
      const engine = (app as any).botEngine;
      if (engine) engine.startBot(botId, userId);
      return reply.send(bot);
    } catch (err) {
      if (err instanceof BotError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/:botId/stop', async (request, reply) => {
    try {
      const { botId } = request.params as { botId: string };
      const userId = getUserId(request);
      const bot = await service.stop(botId, userId);
      const engine = (app as any).botEngine;
      if (engine) engine.stopBot(botId);
      return reply.send(bot);
    } catch (err) {
      if (err instanceof BotError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/:botId/tasks', async (request, reply) => {
    const parsed = assignTaskSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { botId } = request.params as { botId: string };
      const userId = getUserId(request);
      const task = await service.assignTask(botId, userId, parsed.data);
      return reply.code(201).send(task);
    } catch (err) {
      if (err instanceof BotError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/:botId/tasks', async (request, reply) => {
    try {
      const { botId } = request.params as { botId: string };
      const userId = getUserId(request);
      const tasks = await service.listTasks(botId, userId);
      return reply.send(tasks);
    } catch (err) {
      if (err instanceof BotError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.post('/:botId/messages', async (request, reply) => {
    const parsed = sendMessageSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }

    try {
      const { botId } = request.params as { botId: string };
      const userId = getUserId(request);
      const message = await service.sendMessage(botId, userId, parsed.data);
      return reply.code(201).send(message);
    } catch (err) {
      if (err instanceof BotError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });

  app.get('/:botId/messages', async (request, reply) => {
    try {
      const { botId } = request.params as { botId: string };
      const userId = getUserId(request);
      const messages = await service.listMessages(botId, userId);
      return reply.send(messages);
    } catch (err) {
      if (err instanceof BotError) return reply.code(err.statusCode).send({ error: err.message });
      throw err;
    }
  });
}
