import type { FastifyInstance } from 'fastify';
import { TargetTracker } from '../services/target-tracker.service.js';
import { EODReviewService } from '../services/eod-review.service.js';
import { RiskService } from '../services/risk.service.js';
import { chatCompletionJSON } from '../lib/openai.js';
import { getPrisma } from '../lib/prisma.js';
import { authenticate, getUserId } from '../middleware/auth.js';

interface ChatIntent {
  intent: string;
  params: Record<string, unknown>;
  response: string;
}

export default async function commandCenterRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const targetTracker = new TargetTracker(prisma);
  const eodReview = new EODReviewService(prisma);
  const riskService = new RiskService(prisma);

  app.addHook('preHandler', authenticate);

  // ── Chat endpoint ──
  app.post('/chat', async (request, reply) => {
    const userId = getUserId(request);
    const { message } = request.body as { message: string };
    if (!message?.trim()) return reply.code(400).send({ error: 'Message required' });

    // Store user message
    await prisma.commandMessage.create({
      data: { userId, role: 'user', content: message },
    });

    // Parse intent via Gemini
    let intent: ChatIntent;
    try {
      intent = await chatCompletionJSON<ChatIntent>({
        messages: [
          {
            role: 'system',
            content: `You are a trading command center assistant. Parse the user's message and determine intent.
Return JSON:
{
  "intent": "set_target" | "check_progress" | "stop_trading" | "resume_trading" | "show_report" | "change_instruments" | "status" | "general_chat",
  "params": {
    For set_target: { "capitalBase": number, "profitTargetPct": number, "maxLossPct": number, "instruments": "ALL"|"EQUITY"|"FNO", "type": "DAILY"|"WEEKLY" }
    For change_instruments: { "instruments": "ALL"|"EQUITY"|"FNO" }
    For show_report: { "date": "YYYY-MM-DD" } (optional)
    For general_chat: {}
  },
  "response": "Natural language response to show the user"
}

Examples:
- "Make 2% daily on 10 lakh" -> set_target with capitalBase=1000000, profitTargetPct=2
- "How are we doing today?" -> check_progress
- "Stop all trading" -> stop_trading
- "Show today's report" -> show_report
- "Only trade F&O" -> change_instruments with instruments="FNO"
- "Resume trading" -> resume_trading`,
          },
          { role: 'user', content: message },
        ],
        maxTokens: 500,
        temperature: 0.2,
      });
    } catch {
      intent = { intent: 'general_chat', params: {}, response: 'I understand. Let me help you with that.' };
    }

    let responseContent = intent.response;

    // Execute intent
    try {
      switch (intent.intent) {
        case 'set_target': {
          const p = intent.params as any;
          const capitalBase = Number(p.capitalBase) || 1000000;
          const profitTargetPct = Number(p.profitTargetPct) || 2;
          const maxLossPct = Number(p.maxLossPct) || 0.3;
          const instruments = p.instruments || 'ALL';
          const type = p.type || 'DAILY';

          await targetTracker.createTarget(userId, {
            type,
            capitalBase,
            profitTargetPct,
            maxLossPct,
            instruments,
          });

          const profitAbs = capitalBase * (profitTargetPct / 100);
          const lossAbs = capitalBase * (maxLossPct / 100);
          responseContent = `Target set! Capital: ₹${(capitalBase / 100000).toFixed(1)}L | Daily profit target: ₹${profitAbs.toFixed(0)} (${profitTargetPct}%) | Max loss: ₹${lossAbs.toFixed(0)} (${maxLossPct}%) | Instruments: ${instruments}. Bots will now trade to hit this target.`;
          break;
        }

        case 'check_progress': {
          const progress = await targetTracker.updateProgress(userId);
          if (progress) {
            const pnlSign = progress.currentPnl >= 0 ? '+' : '';
            responseContent = `Current P&L: ${pnlSign}₹${progress.currentPnl.toFixed(0)} of ₹${progress.profitTargetAbs.toFixed(0)} target (${progress.progressPct.toFixed(0)}%). Aggression: ${progress.aggression.toUpperCase()}. Status: ${progress.status}.${progress.consecutiveLossDays > 0 ? ` Warning: ${progress.consecutiveLossDays} consecutive loss day(s).` : ''}`;
          } else {
            responseContent = 'No active target set. Tell me your capital and profit target to get started.';
          }
          break;
        }

        case 'stop_trading': {
          await targetTracker.pauseTarget(userId);
          responseContent = 'All trading paused. Bots will stop opening new positions. Say "resume trading" when ready.';
          break;
        }

        case 'resume_trading': {
          const resumed = await targetTracker.resumeTarget(userId);
          responseContent = resumed
            ? 'Trading resumed. Bots are back in action.'
            : 'No paused target found. Set a new target to start trading.';
          break;
        }

        case 'show_report': {
          const reportDate = (intent.params as any).date
            ? new Date((intent.params as any).date)
            : new Date();
          const report = await eodReview.getReport(userId, reportDate);
          if (report) {
            const review = JSON.parse(report.decisionsReview as string);
            responseContent = `EOD Report for ${reportDate.toISOString().split('T')[0]}:\nP&L: ₹${report.totalPnl.toFixed(0)} | Target: ₹${report.targetPnl.toFixed(0)} | ${report.targetAchieved ? 'TARGET HIT' : 'TARGET MISSED'}\n\nWhat went well: ${review.whatWentWell?.join(', ') || 'N/A'}\nWhat went wrong: ${review.whatWentWrong?.join(', ') || 'N/A'}\nImprovements: ${review.improvements?.join(', ') || 'N/A'}`;
          } else {
            responseContent = 'No report available for that date. Reports are generated after market close.';
          }
          break;
        }

        case 'change_instruments': {
          const instruments = (intent.params as any).instruments || 'ALL';
          const target = await targetTracker.getActiveTarget(userId);
          if (target) {
            await prisma.tradingTarget.update({
              where: { id: target.id },
              data: { instruments },
            });
            responseContent = `Instruments updated to: ${instruments}. Bots will now focus on ${instruments === 'ALL' ? 'equity, F&O, and strategies' : instruments.toLowerCase()} trading.`;
          } else {
            responseContent = 'No active target. Set a target first.';
          }
          break;
        }

        case 'status': {
          const progress = await targetTracker.updateProgress(userId);
          const risk = await riskService.getDailyRiskSummary(userId);
          const bots = await prisma.tradingBot.findMany({
            where: { userId, status: 'RUNNING' },
            select: { name: true, lastAction: true, totalPnl: true },
          });

          responseContent = `System Status:\n`;
          if (progress) {
            responseContent += `Target: ₹${progress.profitTargetAbs.toFixed(0)}/day | P&L: ₹${progress.currentPnl.toFixed(0)} | Aggression: ${progress.aggression}\n`;
          }
          responseContent += `Risk Score: ${risk.riskScore}/100 | Positions: ${risk.openPositions} | Day P&L: ₹${risk.dayPnl.toFixed(0)}\n`;
          responseContent += `Active Bots: ${bots.length}\n`;
          bots.forEach((b: any) => {
            responseContent += `  - ${b.name}: ₹${Number(b.totalPnl).toFixed(0)} P&L | ${b.lastAction || 'idle'}\n`;
          });
          break;
        }
      }
    } catch (err) {
      responseContent = `Error: ${(err as Error).message}`;
    }

    // Store assistant response
    await prisma.commandMessage.create({
      data: {
        userId,
        role: 'assistant',
        content: responseContent,
        metadata: JSON.stringify({ intent: intent.intent, params: intent.params }),
      },
    });

    return { role: 'assistant', content: responseContent, intent: intent.intent };
  });

  // ── Get current target + progress ──
  app.get('/target', async (request) => {
    const userId = getUserId(request);
    const progress = await targetTracker.updateProgress(userId);
    return { target: progress };
  });

  // ── Dashboard aggregate ──
  app.get('/dashboard', async (request) => {
    const userId = getUserId(request);
    const [progress, risk, bots, recentPnl] = await Promise.all([
      targetTracker.updateProgress(userId),
      riskService.getDailyRiskSummary(userId),
      prisma.tradingBot.findMany({
        where: { userId, status: 'RUNNING' },
        select: { id: true, name: true, role: true, lastAction: true, lastActionAt: true, totalPnl: true, winRate: true },
      }),
      targetTracker.getRecentPnlRecords(userId, 7),
    ]);

    const todayStart = new Date();
    todayStart.setUTCHours(0, 0, 0, 0);
    const todaySignals = await prisma.aITradeSignal.findMany({
      where: { userId, createdAt: { gte: todayStart } },
      orderBy: { createdAt: 'desc' },
      take: 20,
      select: { id: true, symbol: true, signalType: true, compositeScore: true, status: true, rationale: true, createdAt: true },
    });

    return { target: progress, risk, bots, recentPnl, todaySignals };
  });

  // ── EOD Reports ──
  app.get('/reports', async (request) => {
    const userId = getUserId(request);
    const limit = Number((request.query as any).limit) || 30;
    return eodReview.getReports(userId, limit);
  });

  app.get('/reports/:date', async (request) => {
    const userId = getUserId(request);
    const dateStr = (request.params as any).date;
    const date = new Date(dateStr);
    const report = await eodReview.getReport(userId, date);
    if (!report) return { error: 'Report not found' };
    return report;
  });

  // ── Chat history ──
  app.get('/messages', async (request) => {
    const userId = getUserId(request);
    const limit = Number((request.query as any).limit) || 50;
    return prisma.commandMessage.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
    });
  });
}
