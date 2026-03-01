import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { OptionsService, type OptionLeg } from '../services/options.service.js';

const legSchema = z.object({
  type: z.enum(['CE', 'PE']),
  strike: z.number(),
  action: z.enum(['BUY', 'SELL']),
  qty: z.number().int().positive(),
  premium: z.number().min(0),
  expiry: z.string().optional(),
});

const payoffSchema = z.object({
  legs: z.array(legSchema).min(1).max(8),
  spotPrice: z.number().positive(),
});

const scenarioSchema = z.object({
  legs: z.array(legSchema).min(1).max(8),
  spotPrice: z.number().positive(),
  scenarios: z.array(z.object({
    spotChange: z.number(),
    ivChange: z.number(),
    daysElapsed: z.number().min(0),
  })).min(1).max(20),
});

const maxPainSchema = z.object({
  strikes: z.array(z.number()),
  callOI: z.record(z.string(), z.number()),
  putOI: z.record(z.string(), z.number()),
});

export async function optionsRoutes(app: FastifyInstance): Promise<void> {
  const optionsService = new OptionsService(getPrisma());

  app.get('/templates', async () => {
    return optionsService.getTemplates();
  });

  app.get('/templates/:id', async (request, reply) => {
    const { id } = request.params as { id: string };
    const template = optionsService.getTemplateById(id);
    if (!template) return reply.code(404).send({ error: 'Template not found' });
    return template;
  });

  app.get('/templates/category/:category', async (request) => {
    const { category } = request.params as { category: string };
    return optionsService.getTemplatesByCategory(category);
  });

  app.post('/payoff', async (request, reply) => {
    const parsed = payoffSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const result = optionsService.computePayoff(parsed.data.legs as OptionLeg[], parsed.data.spotPrice);
    return result;
  });

  app.post('/scenario', { preHandler: [authenticate] }, async (request, reply) => {
    const parsed = scenarioSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    return optionsService.scenarioSimulation(
      parsed.data.legs as OptionLeg[],
      parsed.data.spotPrice,
      parsed.data.scenarios,
    );
  });

  app.post('/max-pain', async (request, reply) => {
    const parsed = maxPainSchema.safeParse(request.body);
    if (!parsed.success) {
      return reply.code(400).send({ error: 'Validation failed', details: parsed.error.flatten().fieldErrors });
    }
    const callOI: Record<number, number> = {};
    const putOI: Record<number, number> = {};
    for (const [k, v] of Object.entries(parsed.data.callOI)) callOI[Number(k)] = v;
    for (const [k, v] of Object.entries(parsed.data.putOI)) putOI[Number(k)] = v;
    return optionsService.computeMaxPain({ strikes: parsed.data.strikes, callOI, putOI });
  });

  app.post('/explain', { preHandler: [authenticate] }, async (request, reply) => {
    const body = request.body as {
      strategyName: string;
      legs: OptionLeg[];
      spotPrice: number;
      greeks?: any;
    };
    if (!body.strategyName || !body.legs || !body.spotPrice) {
      return reply.code(400).send({ error: 'strategyName, legs, and spotPrice are required' });
    }
    const { payoffCurve: _, greeks } = optionsService.computePayoff(body.legs, body.spotPrice);
    const explanation = optionsService.generateAIExplanation({
      strategyName: body.strategyName,
      legs: body.legs,
      greeks,
      spotPrice: body.spotPrice,
    });
    return { explanation, greeks };
  });
}
