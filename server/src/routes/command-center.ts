import type { FastifyInstance } from 'fastify';
import { TargetTracker } from '../services/target-tracker.service.js';
import { EODReviewService } from '../services/eod-review.service.js';
import { RiskService } from '../services/risk.service.js';
import { AIAgentService } from '../services/ai-agent.service.js';
import { chatCompletion, chatCompletionJSON } from '../lib/openai.js';
import { getPrisma } from '../lib/prisma.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { istDateStr } from '../lib/ist.js';

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
  const aiAgentService = new AIAgentService(prisma);

  app.addHook('preHandler', authenticate);

  // ── Chat endpoint ──
  app.post('/chat', async (request, reply) => {
    const userId = getUserId(request);
    const { message } = request.body as { message: string };
    if (!message?.trim()) return reply.code(400).send({ error: 'Message required' });

    await prisma.commandMessage.create({
      data: { userId, role: 'user', content: message },
    });

    let intent: ChatIntent;
    try {
      intent = await chatCompletionJSON<ChatIntent>({
        messages: [
          {
            role: 'system',
            content: `You are an AI trading operations assistant for "Mission Control". Parse the user's message and determine intent.
Return JSON:
{
  "intent": "set_target" | "check_progress" | "stop_trading" | "resume_trading" | "show_report" | "change_instruments" | "status" | "bot_status" | "bot_instruct" | "explain_decision" | "list_signals" | "execute_signal" | "reject_signal" | "start_scanner" | "stop_scanner" | "start_agent" | "stop_agent" | "general_chat",
  "params": {
    For set_target: { "capitalBase": number, "profitTargetPct": number, "maxLossPct": number, "instruments": "ALL"|"EQUITY"|"FNO", "type": "DAILY"|"WEEKLY" }
    For change_instruments: { "instruments": "ALL"|"EQUITY"|"FNO" }
    For show_report: { "date": "YYYY-MM-DD" } (optional)
    For bot_instruct: { "botName": string, "instruction": string }
    For explain_decision: { "symbol": string }
    For execute_signal: { "signalId": string, "symbol": string }
    For reject_signal: { "signalId": string, "all": boolean }
    For general_chat: {}
  },
  "response": "Natural language response to show the user"
}

Examples:
- "Make 2% daily on 10 lakh" -> set_target
- "How are we doing today?" -> check_progress
- "Stop all trading" -> stop_trading
- "Show today's report" -> show_report
- "Only trade F&O" -> change_instruments
- "Resume trading" -> resume_trading
- "How are the bots doing?" -> bot_status
- "Tell Scanner Bot to focus on IT sector" -> bot_instruct
- "Why did you buy RELIANCE?" -> explain_decision with symbol="RELIANCE"
- "Show pending signals" -> list_signals
- "Execute the RELIANCE signal" -> execute_signal with symbol="RELIANCE"
- "Reject all pending signals" -> reject_signal with all=true
- "Start scanning" -> start_scanner
- "Stop the scanner" -> stop_scanner
- "Start the AI agent" -> start_agent
- "Stop the agent" -> stop_agent
- "What's the status?" -> status`,
          },
          { role: 'user', content: message },
        ],
        maxTokens: 2048,
        temperature: 0.2,
      });
    } catch {
      intent = { intent: 'general_chat', params: {}, response: 'I understand. Let me help you with that.' };
    }

    let responseContent = intent.response || 'I understand your request. Let me help you with that.';

    try {
      switch (intent.intent) {
        case 'set_target': {
          const p = intent.params as any;
          const capitalBase = Number(p.capitalBase) || 1000000;
          const profitTargetPct = Number(p.profitTargetPct) || 2;
          const maxLossPct = Number(p.maxLossPct) || 0.3;
          const instruments = p.instruments || 'ALL';
          const type = p.type || 'DAILY';

          await targetTracker.createTarget(userId, { type, capitalBase, profitTargetPct, maxLossPct, instruments });

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
          const reportDate = (intent.params as any).date ? new Date((intent.params as any).date) : new Date();
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
            await prisma.tradingTarget.update({ where: { id: target.id }, data: { instruments } });
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
          responseContent = 'System Status:\n';
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

        case 'bot_status': {
          const bots = await prisma.tradingBot.findMany({
            where: { userId },
            select: { id: true, name: true, role: true, status: true, lastAction: true, lastActionAt: true, totalPnl: true, winRate: true, totalTrades: true },
          });
          if (bots.length === 0) {
            responseContent = 'No bots configured. Create bots from the Bot Team page.';
          } else {
            responseContent = `Bot Fleet (${bots.length} bots):\n`;
            for (const b of bots) {
              const pnl = Number(b.totalPnl);
              const wr = Number(b.winRate);
              responseContent += `\n${b.name} [${b.role}] — ${b.status}\n`;
              responseContent += `  P&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)} | Win Rate: ${(wr * 100).toFixed(0)}% | Trades: ${b.totalTrades}\n`;
              responseContent += `  Last: ${b.lastAction || 'No activity'}\n`;
            }
          }
          break;
        }

        case 'bot_instruct': {
          const p = intent.params as any;
          const botName = p.botName || '';
          const instruction = p.instruction || message;
          const bot = await prisma.tradingBot.findFirst({
            where: { userId, name: { contains: botName, mode: 'insensitive' } },
          });
          if (bot) {
            const assignUpdate: Record<string, unknown> = { lastAction: `Instructed: ${instruction}`, lastActionAt: new Date() };
            if (/focus|sector|symbol|only trade/i.test(instruction)) {
              assignUpdate.assignedSymbols = instruction;
            }
            await prisma.tradingBot.update({ where: { id: bot.id }, data: assignUpdate });
            responseContent = `Instruction sent to ${bot.name}: "${instruction}". The bot will adapt on its next cycle.`;
          } else {
            responseContent = `No bot found matching "${botName}". Available bots: ${(await prisma.tradingBot.findMany({ where: { userId }, select: { name: true } })).map(b => b.name).join(', ') || 'none'}`;
          }
          break;
        }

        case 'explain_decision': {
          const symbol = ((intent.params as any).symbol || '').toUpperCase();
          const recentTrade = await prisma.trade.findFirst({
            where: { portfolio: { userId }, symbol: { contains: symbol } },
            orderBy: { entryTime: 'desc' },
            select: { symbol: true, side: true, qty: true, entryPrice: true, exitPrice: true, netPnl: true, strategyTag: true, entryTime: true, exitTime: true },
          });
          const recentSignal = await prisma.aITradeSignal.findFirst({
            where: { userId, symbol: { contains: symbol } },
            orderBy: { createdAt: 'desc' },
            select: { symbol: true, signalType: true, rationale: true, compositeScore: true, status: true, createdAt: true },
          });
          if (recentTrade) {
            const pnl = Number(recentTrade.netPnl);
            responseContent = `Last trade for ${recentTrade.symbol}:\n${recentTrade.side} ${recentTrade.qty} @ ₹${Number(recentTrade.entryPrice).toFixed(2)}`;
            if (recentTrade.exitPrice) responseContent += ` → ₹${Number(recentTrade.exitPrice).toFixed(2)}`;
            responseContent += `\nP&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)} | Strategy: ${recentTrade.strategyTag || 'manual'}`;
          }
          if (recentSignal) {
            responseContent += `\n\nLast signal: ${recentSignal.signalType} ${recentSignal.symbol} (${(Number(recentSignal.compositeScore) * 100).toFixed(0)}% confidence)\nRationale: ${recentSignal.rationale}\nStatus: ${recentSignal.status}`;
          }
          if (!recentTrade && !recentSignal) {
            responseContent = `No recent trades or signals found for "${symbol}".`;
          }
          break;
        }

        case 'list_signals': {
          const signals = await prisma.aITradeSignal.findMany({
            where: { userId, status: 'PENDING' },
            orderBy: { createdAt: 'desc' },
            take: 10,
            select: { id: true, symbol: true, signalType: true, compositeScore: true, rationale: true, createdAt: true },
          });
          if (signals.length === 0) {
            responseContent = 'No pending signals. The AI agent will generate signals during market hours.';
          } else {
            responseContent = `Pending Signals (${signals.length}):\n`;
            signals.forEach((s, i) => {
              responseContent += `\n${i + 1}. ${s.signalType} ${s.symbol} — ${(Number(s.compositeScore) * 100).toFixed(0)}% confidence\n   ${s.rationale}\n   ID: ${s.id.slice(0, 8)}`;
            });
          }
          break;
        }

        case 'execute_signal': {
          const p = intent.params as any;
          let signal;
          if (p.signalId) {
            signal = await prisma.aITradeSignal.findFirst({ where: { id: { startsWith: p.signalId }, userId, status: 'PENDING' } });
          } else if (p.symbol) {
            signal = await prisma.aITradeSignal.findFirst({ where: { userId, status: 'PENDING', symbol: { contains: p.symbol.toUpperCase() } }, orderBy: { createdAt: 'desc' } });
          }
          if (signal) {
            try {
              await aiAgentService.executeSignal(signal.id, userId);
              responseContent = `Signal executed: ${signal.signalType} ${signal.symbol} (${(Number(signal.compositeScore) * 100).toFixed(0)}% confidence)`;
            } catch (err) {
              responseContent = `Failed to execute signal: ${(err as Error).message}`;
            }
          } else {
            responseContent = 'No matching pending signal found.';
          }
          break;
        }

        case 'reject_signal': {
          const p = intent.params as any;
          if (p.all) {
            const result = await prisma.aITradeSignal.updateMany({ where: { userId, status: 'PENDING' }, data: { status: 'REJECTED' } });
            responseContent = `Rejected ${result.count} pending signal(s).`;
          } else if (p.signalId) {
            await prisma.aITradeSignal.updateMany({ where: { id: { startsWith: p.signalId }, userId, status: 'PENDING' }, data: { status: 'REJECTED' } });
            responseContent = 'Signal rejected.';
          } else {
            responseContent = 'Specify a signal ID or say "reject all pending signals".';
          }
          break;
        }

        case 'start_scanner': {
          const engine = (app as any).botEngine;
          if (engine) {
            await engine.startMarketScan(userId);
            responseContent = 'Market scanner started. Scanning NSE, MCX & CDS markets every 5 minutes.';
          } else {
            responseContent = 'Bot engine not available.';
          }
          break;
        }

        case 'stop_scanner': {
          const engine = (app as any).botEngine;
          if (engine) {
            engine.stopMarketScan();
            responseContent = 'Market scanner stopped.';
          } else {
            responseContent = 'Bot engine not available.';
          }
          break;
        }

        case 'start_agent': {
          await aiAgentService.startAgent(userId);
          const engine = (app as any).botEngine;
          if (engine) {
            engine.startAgent(userId);
            engine.startMarketScan(userId);
          }
          responseContent = 'AI Agent started. It will scan markets, generate signals, and trade based on your configured mode.';
          break;
        }

        case 'stop_agent': {
          await aiAgentService.stopAgent(userId);
          const engine = (app as any).botEngine;
          if (engine) {
            engine.stopAgent(userId);
            engine.stopMarketScan();
          }
          responseContent = 'AI Agent stopped. No new signals will be generated.';
          break;
        }

        default: {
          const weekAgo = new Date();
          weekAgo.setDate(weekAgo.getDate() - 7);

          const [recentTrades, bots, signals, pnlRecords, chatHistory] = await Promise.all([
            prisma.trade.findMany({
              where: { portfolio: { userId }, exitTime: { gte: weekAgo } },
              orderBy: { exitTime: 'desc' },
              take: 30,
              select: { symbol: true, side: true, netPnl: true, exitTime: true, strategyTag: true, qty: true, entryPrice: true, exitPrice: true },
            }),
            prisma.tradingBot.findMany({
              where: { userId },
              select: { name: true, role: true, status: true, lastAction: true, totalPnl: true, winRate: true, totalTrades: true },
            }),
            prisma.aITradeSignal.findMany({
              where: { userId, createdAt: { gte: weekAgo } },
              orderBy: { createdAt: 'desc' },
              take: 15,
              select: { symbol: true, signalType: true, compositeScore: true, status: true, rationale: true, outcomeTag: true },
            }),
            prisma.dailyPnlRecord.findMany({
              where: { userId, date: { gte: weekAgo } },
              orderBy: { date: 'desc' },
              select: { date: true, netPnl: true, tradeCount: true, winCount: true, lossCount: true },
            }),
            prisma.commandMessage.findMany({
              where: { userId },
              orderBy: { createdAt: 'desc' },
              take: 6,
              select: { role: true, content: true },
            }),
          ]);

          const contextParts: string[] = [];

          if (pnlRecords.length > 0) {
            const dailySummary = pnlRecords.map(d => `${new Date(d.date).toISOString().split('T')[0]}: P&L ₹${Number(d.netPnl).toFixed(0)}, ${d.tradeCount} trades (${d.winCount}W/${d.lossCount}L)`).join('\n');
            contextParts.push(`DAILY P&L (last ${pnlRecords.length} days):\n${dailySummary}`);
          }

          if (recentTrades.length > 0) {
            const totalPnl = recentTrades.reduce((s, t) => s + Number(t.netPnl), 0);
            const wins = recentTrades.filter(t => Number(t.netPnl) > 0).length;
            const topWinners = [...recentTrades].sort((a, b) => Number(b.netPnl) - Number(a.netPnl)).slice(0, 3);
            const topLosers = [...recentTrades].sort((a, b) => Number(a.netPnl) - Number(b.netPnl)).slice(0, 3);
            contextParts.push(`RECENT TRADES (${recentTrades.length} in last 7 days):\nTotal P&L: ₹${totalPnl.toFixed(0)} | Win rate: ${((wins / recentTrades.length) * 100).toFixed(0)}%\nBest trades: ${topWinners.map(t => `${t.symbol} ${t.side} ₹${Number(t.netPnl).toFixed(0)}`).join(', ')}\nWorst trades: ${topLosers.map(t => `${t.symbol} ${t.side} ₹${Number(t.netPnl).toFixed(0)}`).join(', ')}`);
          }

          if (bots.length > 0) {
            const botSummary = bots.map(b => `${b.name} (${b.role}): ${b.status} | P&L: ₹${Number(b.totalPnl).toFixed(0)} | WR: ${(Number(b.winRate) * 100).toFixed(0)}% | Trades: ${b.totalTrades} | Last: ${b.lastAction || 'idle'}`).join('\n');
            contextParts.push(`BOT FLEET:\n${botSummary}`);
          }

          if (signals.length > 0) {
            const signalSummary = signals.slice(0, 8).map(s => `${s.signalType} ${s.symbol} (${(Number(s.compositeScore) * 100).toFixed(0)}%) → ${s.status}${s.outcomeTag ? ' [' + s.outcomeTag + ']' : ''}`).join('\n');
            contextParts.push(`RECENT SIGNALS:\n${signalSummary}`);
          }

          const conversationHistory = chatHistory.reverse().map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

          try {
            responseContent = await chatCompletion({
              messages: [
                {
                  role: 'system',
                  content: `You are an expert AI trading operations assistant for "Capital Guard", a personal algorithmic trading platform for Indian markets (NSE/BSE). You help the user understand their trading performance, bot behavior, and provide actionable insights.

Respond naturally and conversationally. Be specific — reference actual data, numbers, symbols, and patterns. Give concrete, actionable recommendations when asked for improvements. Keep responses concise but insightful (2-4 paragraphs max).

If asked about performance, analyze the data and highlight patterns, winning/losing strategies, and areas for improvement.
If asked about bots, explain what they've been doing and suggest configuration changes.
If asked what you can do, explain you can set targets, control bots, review signals, analyze performance, and more.

Current date: ${istDateStr()}

USER'S TRADING DATA:
${contextParts.length > 0 ? contextParts.join('\n\n') : 'No trading data available yet — the user is new or has not placed any trades.'}`,
                },
                ...conversationHistory,
                { role: 'user', content: message },
              ],
              maxTokens: 1024,
              temperature: 0.7,
            });
          } catch {
            responseContent = intent.response || 'I wasn\'t able to process that right now. Try asking about your targets, bot status, or recent trades.';
          }
          break;
        }
      }
    } catch (err) {
      responseContent = `Error: ${(err as Error).message}`;
    }

    try {
      await prisma.commandMessage.create({
        data: {
          userId,
          role: 'assistant',
          content: responseContent,
          metadata: JSON.stringify({ intent: intent.intent, params: intent.params }),
        },
      });
    } catch (err) {
      console.error('[CommandCenter] Failed to save response:', (err as Error).message);
    }

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

  // ── Bot activity history ──
  app.get('/activity', async (request) => {
    const userId = getUserId(request);
    const limit = Number((request.query as any).limit) || 50;
    const messages = await prisma.botMessage.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      include: {
        fromBot: { select: { id: true, name: true, role: true } },
      },
    });
    return messages.map(m => ({
      id: m.id,
      botId: m.fromBotId,
      botName: m.fromBot?.name ?? 'System',
      botRole: m.fromBot?.role ?? 'SYSTEM',
      activityType: m.messageType,
      summary: m.content,
      details: m.metadataJson ? JSON.parse(m.metadataJson) : null,
      createdAt: m.createdAt.toISOString(),
    }));
  });
}
