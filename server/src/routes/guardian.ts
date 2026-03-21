import type { FastifyInstance } from 'fastify';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { GuardianService } from '../services/guardian.service.js';
import { GuardianMemoryService } from '../services/guardian-memory.service.js';

let _guardianService: GuardianService | null = null;
let _guardianMemoryService: GuardianMemoryService | null = null;

function getGuardianService(): GuardianService {
  if (!_guardianService) {
    _guardianService = new GuardianService(getPrisma());
  }
  return _guardianService;
}

function getGuardianMemoryService(): GuardianMemoryService {
  if (!_guardianMemoryService) {
    _guardianMemoryService = new GuardianMemoryService(getPrisma());
  }
  return _guardianMemoryService;
}

export default async function guardianRoutes(app: FastifyInstance) {
  app.addHook('preHandler', authenticate);

  app.post('/chat', async (request, reply) => {
    const userId = getUserId(request);
    const body = request.body as { message?: string; pageContext?: string };
    const message = body?.message?.trim();
    if (!message) {
      return reply.code(400).send({ error: 'Message required' });
    }
    try {
      const result = await getGuardianService().chat(userId, message, body.pageContext);
      return result;
    } catch (err) {
      request.log.error({ err }, 'guardian.chat failed');
      return reply.code(500).send({ error: (err as Error).message || 'Chat failed' });
    }
  });

  app.get('/state', async (request, reply) => {
    const userId = getUserId(request);
    try {
      const state = await getGuardianService().getOrCreateState(userId);
      return {
        mood: state.mood,
        moodIntensity: state.moodIntensity,
        lastThought: state.lastThought,
        lastThoughtAt: state.lastThoughtAt?.toISOString() ?? null,
        marketStance: state.marketStance,
        currentFocus: state.currentFocus,
      };
    } catch (err) {
      request.log.error({ err }, 'guardian.state failed');
      return reply.code(500).send({ error: (err as Error).message || 'Failed to load state' });
    }
  });

  app.get('/memories', async (request, reply) => {
    const userId = getUserId(request);
    try {
      return await getGuardianMemoryService().getMemorySummary(userId);
    } catch (err) {
      request.log.error({ err }, 'guardian.memories failed');
      return reply.code(500).send({ error: (err as Error).message || 'Failed to load memories' });
    }
  });

  app.post('/acknowledge', async (request, reply) => {
    const body = request.body as { thoughtId?: string };
    if (!body?.thoughtId?.trim()) {
      return reply.code(400).send({ error: 'thoughtId required' });
    }
    return { acknowledged: true };
  });

  app.get('/awareness', async (request, reply) => {
    const userId = getUserId(request);
    try {
      const awareness = await getGuardianService().getAwareness(userId);
      return { awareness };
    } catch (err) {
      request.log.error({ err }, 'guardian.awareness failed');
      return reply.code(500).send({ error: (err as Error).message || 'Failed to load awareness' });
    }
  });
}
