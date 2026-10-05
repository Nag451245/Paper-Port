import { requireOwnBroker } from '../lib/broker-access.js';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { authenticate, getUserId } from '../middleware/auth.js';
import { getPrisma } from '../lib/prisma.js';
import { istDateStr } from '../lib/ist.js';
import { fnoRatesOn } from '../lib/fno-charges.js';
import { MarketDataService } from '../services/market-data.service.js';
import { OptionHistory, OPTION_UNDERLYINGS } from '../services/option-history.service.js';
import { OptionsLab, startJob, getJob, runningJob, MAX_CYCLES } from '../services/options-lab.service.js';

const day = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');
const hhmm = z.string().regex(/^(09|1[0-5]):[0-5]\d$/, 'HH:MM between 09:15 and 15:30');
const limit = z.object({ kind: z.enum(['pct', 'rupees']), value: z.number().positive() });

const backtestSchema = z.object({
  underlying: z.string().transform((s) => s.toUpperCase()).refine((s) => OPTION_UNDERLYINGS.includes(s), 'unsupported underlying'),
  from: day,
  to: day,
  expiryKind: z.enum(['weekly', 'monthly']).default('weekly'),
  entryDaysBefore: z.number().int().min(0).max(20),
  entryTime: hhmm,
  exitDaysBefore: z.number().int().min(0).max(20).default(0),
  exitTime: hhmm.default('15:15'),
  holdToExpiry: z.boolean().default(false),
  legs: z.array(z.object({
    type: z.enum(['CE', 'PE']),
    action: z.enum(['BUY', 'SELL']),
    lots: z.number().int().min(1).max(50),
    strikeMode: z.enum(['atm', 'premium']).default('atm'),
    offset: z.number().int().min(-30).max(30).default(0),
    premium: z.number().positive().optional(),
  })).min(1).max(6),
  lotSize: z.number().int().positive().max(5000),
  target: limit.optional(),
  stop: limit.optional(),
  slippagePct: z.number().min(0).max(5).default(0.5),
  brokeragePerOrder: z.number().min(0).max(100).default(20),
});

export async function optionsLabRoutes(app: FastifyInstance): Promise<void> {
  app.addHook('preHandler', authenticate);
  // Broker data is served only to an account whose own broker is connected.
  app.addHook('preHandler', requireOwnBroker);
  const history = new OptionHistory(new MarketDataService());
  const lab = new OptionsLab(history, getPrisma());

  // What is saved so far, and today's ICICI request allowance.
  app.get('/coverage', async (request) => {
    const q = z.object({ underlying: z.string().optional() }).parse(request.query);
    const u = (q.underlying ?? 'NIFTY').toUpperCase();
    return { underlyings: OPTION_UNDERLYINGS, underlying: u, ...history.coverage(u), budget: history.budget(), today: istDateStr(), maxCycles: MAX_CYCLES };
  });

  app.get('/rates', async (request) => {
    const q = z.object({ day: day.optional(), underlying: z.string().optional() }).parse(request.query);
    return fnoRatesOn(q.day ?? istDateStr(), { underlying: q.underlying });
  });

  app.post('/backtests', async (request, reply) => {
    const parsed = backtestSchema.safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Check the backtest settings', details: parsed.error.flatten().fieldErrors });
    const userId = getUserId(request);
    if (runningJob(userId, 'backtest')) return reply.code(409).send({ error: 'A backtest is already running; wait for it to finish.' });
    const job = startJob(userId, 'backtest', (report) => lab.backtest(userId, parsed.data, report));
    return reply.code(202).send({ jobId: job.id });
  });

  app.post('/replay', async (request, reply) => {
    const parsed = z.object({
      underlying: z.string(), day, expiry: day.optional(), each: z.number().int().min(3).max(12).optional(),
    }).safeParse(request.body);
    if (!parsed.success) return reply.code(400).send({ error: 'Choose an index and a past trading day' });
    const userId = getUserId(request);
    if (runningJob(userId, 'replay')) return reply.code(409).send({ error: 'A replay day is already loading.' });
    const { underlying, day: d, expiry, each } = parsed.data;
    const job = startJob(userId, 'replay', (report) => lab.replayDay(underlying, d, { expiry, each }, report));
    return reply.code(202).send({ jobId: job.id });
  });

  app.get('/jobs/:id', async (request, reply) => {
    const job = getJob((request.params as { id: string }).id, getUserId(request));
    if (!job) return reply.code(404).send({ error: 'No such job (finished jobs are kept for 2 hours)' });
    const { userId: _u, ...rest } = job;
    return rest;
  });

  app.get('/backtests', async (request) => {
    const runs = await getPrisma().optionBacktestRun.findMany({
      where: { userId: getUserId(request) }, orderBy: { createdAt: 'desc' }, take: 30,
      select: { id: true, underlying: true, dateFrom: true, dateTo: true, params: true, summary: true, createdAt: true },
    });
    return runs.map((r) => {
      const s = JSON.parse(r.summary);
      return {
        id: r.id, underlying: r.underlying, dateFrom: r.dateFrom, dateTo: r.dateTo, createdAt: r.createdAt,
        params: JSON.parse(r.params), trades: s.trades, net: s.net, winRate: s.win_rate, maxDrawdown: s.max_drawdown,
      };
    });
  });

  app.get('/backtests/:id', async (request, reply) => {
    const run = await getPrisma().optionBacktestRun.findFirst({ where: { id: (request.params as { id: string }).id, userId: getUserId(request) } });
    if (!run) return reply.code(404).send({ error: 'Backtest not found' });
    const summary = JSON.parse(run.summary);
    return {
      id: run.id, params: JSON.parse(run.params), summary, trades: JSON.parse(run.trades),
      skipped: summary.skipped ?? [], notes: summary.notes ?? [], createdAt: run.createdAt,
    };
  });

  app.delete('/backtests/:id', async (request, reply) => {
    const r = await getPrisma().optionBacktestRun.deleteMany({ where: { id: (request.params as { id: string }).id, userId: getUserId(request) } });
    if (!r.count) return reply.code(404).send({ error: 'Backtest not found' });
    return { ok: true };
  });
}
