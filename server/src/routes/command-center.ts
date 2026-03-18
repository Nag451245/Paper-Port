import type { FastifyInstance } from 'fastify';
import { TargetTracker } from '../services/target-tracker.service.js';
import { EODReviewService } from '../services/eod-review.service.js';
import { RiskService } from '../services/risk.service.js';
import { AIAgentService } from '../services/ai-agent.service.js';
import { chatCompletion, chatCompletionJSON } from '../lib/openai.js';
import { getPrisma } from '../lib/prisma.js';
import { authenticate, getUserId } from '../middleware/auth.js';
import { istDateStr } from '../lib/ist.js';
import { engineScan, engineScanActiveSymbols, engineScanStatus, engineOptionsSignals, engineOptionsData, isEngineAvailable, enginePerformanceSummary, engineExecutionPlan, engineActiveStrategies, engineDiscoveryResults, engineDiscoveryRun } from '../lib/rust-engine.js';

const GEMINI_MODEL = 'gemini-2.5-pro';
const BRIDGE_URL = process.env.BREEZE_BRIDGE_URL || 'http://127.0.0.1:8001';

interface ChatIntent {
  intent: string;
  params: Record<string, unknown>;
  response: string;
}

interface ChatResult {
  role: 'assistant';
  content: string;
  intent: string;
}

let _botEngineRef: any = null;

export function setBotEngineRef(engine: any) {
  _botEngineRef = engine;
}

/**
 * Core command center chat logic — reusable by both HTTP route and Telegram bot.
 */
export async function processCommandCenterChat(userId: string, message: string): Promise<ChatResult> {
  const prisma = getPrisma();
  const targetTracker = new TargetTracker(prisma);
  const eodReview = new EODReviewService(prisma);
  const riskService = new RiskService(prisma);
  const aiAgentService = new AIAgentService(prisma);

  try {
    await prisma.commandMessage.create({ data: { userId, role: 'user', content: message } });
  } catch { /* best-effort */ }

  let intent: ChatIntent;
  try {
    intent = await chatCompletionJSON<ChatIntent>({
      messages: [
        {
          role: 'system',
          content: `You are a trading operations AI for "Capital Guard". Parse user intent and return JSON.
Be concise. Return ONLY valid JSON, no explanation.

{
  "intent": "set_target"|"check_progress"|"stop_trading"|"resume_trading"|"show_report"|"change_instruments"|"status"|"bot_status"|"bot_instruct"|"explain_decision"|"list_signals"|"execute_signal"|"reject_signal"|"start_scanner"|"stop_scanner"|"start_agent"|"stop_agent"|"scan_symbol"|"options_analysis"|"rust_status"|"discovery_status"|"run_discovery"|"general_chat",
  "params": { ... },
  "response": "short natural response"
}

Key intents:
- "Scan RELIANCE" / "Analyze TCS" -> scan_symbol with {symbol}
- "Options for NIFTY" / "NIFTY options" -> options_analysis with {symbol}
- "Rust engine status" / "What is engine doing?" -> rust_status
- "Discovery status" / "What strategies were discovered?" -> discovery_status
- "Run strategy discovery" / "Discover new strategies" -> run_discovery
- "Make 2% on 10L" -> set_target
- "How are bots doing?" -> bot_status
- "Show pending signals" -> list_signals
- "Start scanning" -> start_scanner
- General questions about trading/performance -> general_chat`,
        },
        { role: 'user', content: message },
      ],
      model: GEMINI_MODEL,
      maxTokens: 512,
      temperature: 0.1,
    });
  } catch {
    intent = { intent: 'general_chat', params: {}, response: 'Let me look into that.' };
  }

  let responseContent = intent.response || 'Processing your request...';

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
        responseContent = `Target set!\n• Capital: ₹${(capitalBase / 100000).toFixed(1)}L\n• Profit target: ₹${profitAbs.toFixed(0)} (${profitTargetPct}%)\n• Max loss: ₹${lossAbs.toFixed(0)} (${maxLossPct}%)\n• Instruments: ${instruments}`;
        break;
      }

      case 'check_progress': {
        const progress = await targetTracker.updateProgress(userId);
        if (progress) {
          const sign = progress.currentPnl >= 0 ? '+' : '';
          responseContent = `• P&L: ${sign}₹${progress.currentPnl.toFixed(0)} of ₹${progress.profitTargetAbs.toFixed(0)} target (${progress.progressPct.toFixed(0)}%)\n• Aggression: ${progress.aggression.toUpperCase()}\n• Status: ${progress.status}`;
          if (progress.consecutiveLossDays > 0) responseContent += `\n• Warning: ${progress.consecutiveLossDays} consecutive loss day(s)`;
        } else {
          responseContent = 'No active target. Say "Make 2% daily on 10L" to set one.';
        }
        break;
      }

      case 'stop_trading': {
        await targetTracker.pauseTarget(userId);
        responseContent = 'Trading paused. Bots will stop new positions. Say "resume trading" when ready.';
        break;
      }

      case 'resume_trading': {
        const resumed = await targetTracker.resumeTarget(userId);
        responseContent = resumed ? 'Trading resumed. Bots are active.' : 'No paused target found. Set a new target first.';
        break;
      }

      case 'show_report': {
        const reportDate = (intent.params as any).date ? new Date((intent.params as any).date) : new Date();
        const report = await eodReview.getReport(userId, reportDate);
        if (report) {
          let review: any = {};
          try { review = JSON.parse(report.decisionsReview as string); } catch { /* */ }
          responseContent = `EOD Report (${reportDate.toISOString().split('T')[0]}):\n• P&L: ₹${report.totalPnl.toFixed(0)} | Target: ₹${report.targetPnl.toFixed(0)} | ${report.targetAchieved ? 'HIT' : 'MISSED'}\n• Good: ${review.whatWentWell?.join(', ') || 'N/A'}\n• Bad: ${review.whatWentWrong?.join(', ') || 'N/A'}\n• Improve: ${review.improvements?.join(', ') || 'N/A'}`;
        } else {
          responseContent = 'No report for that date. Reports generate after market close.';
        }
        break;
      }

      case 'change_instruments': {
        const instruments = (intent.params as any).instruments || 'ALL';
        const target = await targetTracker.getActiveTarget(userId);
        if (target) {
          await prisma.tradingTarget.update({ where: { id: target.id }, data: { instruments } });
          responseContent = `Instruments → ${instruments}. Bots will focus on ${instruments === 'ALL' ? 'equity + F&O' : instruments.toLowerCase()}.`;
        } else {
          responseContent = 'No active target. Set one first.';
        }
        break;
      }

      case 'status': {
        const progress = await targetTracker.updateProgress(userId);
        const risk = await riskService.getDailyRiskSummary(userId);
        const bots = await prisma.tradingBot.findMany({ where: { userId, status: 'RUNNING' }, select: { name: true, lastAction: true, totalPnl: true } });
        const lines = ['System Status:'];
        if (progress) lines.push(`• Target: ₹${progress.profitTargetAbs.toFixed(0)}/day | P&L: ₹${progress.currentPnl.toFixed(0)} | ${progress.aggression}`);
        lines.push(`• Risk: ${risk.riskScore}/100 | Positions: ${risk.openPositions} | Day P&L: ₹${risk.dayPnl.toFixed(0)}`);
        lines.push(`• Bots: ${bots.length} active`);
        bots.forEach(b => lines.push(`  - ${b.name}: ₹${Number(b.totalPnl).toFixed(0)} | ${b.lastAction || 'idle'}`));

        let engineInfo = '';
        try {
          const scanStatus = await engineScanStatus() as any;
          const active = await engineScanActiveSymbols();
          engineInfo = `• Rust Engine: ${active.count} active symbols`;
          if (scanStatus?.last_scan_time) engineInfo += ` | Last scan: ${scanStatus.last_scan_time}`;
        } catch { /* */ }
        if (engineInfo) lines.push(engineInfo);

        responseContent = lines.join('\n');
        break;
      }

      case 'bot_status': {
        const bots = await prisma.tradingBot.findMany({
          where: { userId },
          select: { name: true, role: true, status: true, lastAction: true, totalPnl: true, winRate: true, totalTrades: true },
        });
        if (bots.length === 0) {
          responseContent = 'No bots configured. Create them from the Bot Team page.';
        } else {
          const lines = [`Bot Fleet (${bots.length}):`];
          for (const b of bots) {
            const pnl = Number(b.totalPnl);
            lines.push(`\n${b.name} [${b.role}] — ${b.status}`);
            lines.push(`  P&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)} | WR: ${(Number(b.winRate) * 100).toFixed(0)}% | Trades: ${b.totalTrades}`);
            lines.push(`  Last: ${b.lastAction || 'idle'}`);
          }
          responseContent = lines.join('\n');
        }
        break;
      }

      case 'bot_instruct': {
        const p = intent.params as any;
        const botName = p.botName || '';
        const instruction = p.instruction || message;
        const bot = await prisma.tradingBot.findFirst({ where: { userId, name: { contains: botName, mode: 'insensitive' } } });
        if (bot) {
          const update: Record<string, unknown> = { lastAction: `Instructed: ${instruction}`, lastActionAt: new Date() };
          if (/focus|sector|symbol|only trade/i.test(instruction)) update.assignedSymbols = instruction;
          await prisma.tradingBot.update({ where: { id: bot.id }, data: update });
          responseContent = `Instruction sent to ${bot.name}: "${instruction}". Bot will adapt next cycle.`;
        } else {
          const names = (await prisma.tradingBot.findMany({ where: { userId }, select: { name: true } })).map(b => b.name).join(', ');
          responseContent = `No bot matching "${botName}". Available: ${names || 'none'}`;
        }
        break;
      }

      case 'explain_decision': {
        const symbol = ((intent.params as any).symbol || '').toUpperCase();
        const recentTrade = await prisma.trade.findFirst({
          where: { portfolio: { userId }, symbol: { contains: symbol } },
          orderBy: { entryTime: 'desc' },
          select: { symbol: true, side: true, qty: true, entryPrice: true, exitPrice: true, netPnl: true, strategyTag: true },
        });
        const recentSignal = await prisma.aITradeSignal.findFirst({
          where: { userId, symbol: { contains: symbol } },
          orderBy: { createdAt: 'desc' },
          select: { symbol: true, signalType: true, rationale: true, compositeScore: true, status: true },
        });
        const parts: string[] = [];
        if (recentTrade) {
          const pnl = Number(recentTrade.netPnl);
          parts.push(`Last trade: ${recentTrade.side} ${recentTrade.qty}x ${recentTrade.symbol} @ ₹${Number(recentTrade.entryPrice).toFixed(2)}${recentTrade.exitPrice ? ` → ₹${Number(recentTrade.exitPrice).toFixed(2)}` : ''}\nP&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(0)} | Strategy: ${recentTrade.strategyTag || 'manual'}`);
        }
        if (recentSignal) {
          parts.push(`Last signal: ${recentSignal.signalType} ${recentSignal.symbol} (${(Number(recentSignal.compositeScore) * 100).toFixed(0)}%)\n${recentSignal.rationale}\nStatus: ${recentSignal.status}`);
        }
        responseContent = parts.length > 0 ? parts.join('\n\n') : `No recent trades or signals for "${symbol}".`;
        break;
      }

      case 'list_signals': {
        const signals = await prisma.aITradeSignal.findMany({
          where: { userId, status: 'PENDING' },
          orderBy: { createdAt: 'desc' },
          take: 10,
          select: { id: true, symbol: true, signalType: true, compositeScore: true, rationale: true },
        });
        if (signals.length === 0) {
          responseContent = 'No pending signals. Signals are generated during market hours.';
        } else {
          const lines = [`Pending Signals (${signals.length}):`];
          signals.forEach((s, i) => {
            lines.push(`${i + 1}. ${s.signalType} ${s.symbol} — ${(Number(s.compositeScore) * 100).toFixed(0)}%`);
            lines.push(`   ${s.rationale}`);
          });
          responseContent = lines.join('\n');
        }
        break;
      }

      case 'execute_signal': {
        const p = intent.params as any;
        let signal;
        if (p.signalId) signal = await prisma.aITradeSignal.findFirst({ where: { id: { startsWith: p.signalId }, userId, status: 'PENDING' } });
        else if (p.symbol) signal = await prisma.aITradeSignal.findFirst({ where: { userId, status: 'PENDING', symbol: { contains: p.symbol.toUpperCase() } }, orderBy: { createdAt: 'desc' } });
        if (signal) {
          try {
            await aiAgentService.executeSignal(signal.id, userId);
            responseContent = `Executed: ${signal.signalType} ${signal.symbol} (${(Number(signal.compositeScore) * 100).toFixed(0)}%)`;
          } catch (err) { responseContent = `Failed: ${(err as Error).message}`; }
        } else { responseContent = 'No matching pending signal.'; }
        break;
      }

      case 'reject_signal': {
        const p = intent.params as any;
        if (p.all) {
          const result = await prisma.aITradeSignal.updateMany({ where: { userId, status: 'PENDING' }, data: { status: 'REJECTED' } });
          responseContent = `Rejected ${result.count} signal(s).`;
        } else if (p.signalId) {
          await prisma.aITradeSignal.updateMany({ where: { id: { startsWith: p.signalId }, userId, status: 'PENDING' }, data: { status: 'REJECTED' } });
          responseContent = 'Signal rejected.';
        } else { responseContent = 'Specify a signal ID or say "reject all".'; }
        break;
      }

      case 'start_scanner': {
        if (_botEngineRef) { await _botEngineRef.startMarketScan(userId); responseContent = 'Scanner started. Scanning markets every 5 min.'; }
        else { responseContent = 'Bot engine not available.'; }
        break;
      }
      case 'stop_scanner': {
        if (_botEngineRef) { _botEngineRef.stopMarketScan(); responseContent = 'Scanner stopped.'; }
        else { responseContent = 'Bot engine not available.'; }
        break;
      }
      case 'start_agent': {
        await aiAgentService.startAgent(userId);
        if (_botEngineRef) { _botEngineRef.startAgent(userId); _botEngineRef.startMarketScan(userId); }
        responseContent = 'AI Agent started. It will scan, generate signals, and trade.';
        break;
      }
      case 'stop_agent': {
        await aiAgentService.stopAgent(userId);
        if (_botEngineRef) { _botEngineRef.stopAgent(userId); _botEngineRef.stopMarketScan(); }
        responseContent = 'AI Agent stopped.';
        break;
      }

      case 'scan_symbol': {
        const symbol = ((intent.params as any).symbol || '').toUpperCase();
        if (!symbol) { responseContent = 'Please specify a symbol. E.g. "Scan RELIANCE"'; break; }
        try {
          const candles = await fetchBridgeCandles(symbol);
          if (!candles || candles.length < 15) { responseContent = `Not enough data for ${symbol}. Check if the symbol is valid.`; break; }
          if (!isEngineAvailable()) { responseContent = 'Rust engine is offline.'; break; }
          const result = await engineScan({ symbols: [{ symbol, candles }], aggressiveness: 'high', current_date: new Date().toISOString().split('T')[0] });
          if (!result.signals || result.signals.length === 0) {
            responseContent = `${symbol}: NEUTRAL — No strong signals. Range-bound or low momentum.`;
          } else {
            const sig = result.signals[0];
            const tPct = sig.entry > 0 && sig.target > 0 ? ((sig.target - sig.entry) / sig.entry * 100).toFixed(1) : '—';
            const slPct = sig.entry > 0 && sig.stop_loss > 0 ? ((sig.stop_loss - sig.entry) / sig.entry * 100).toFixed(1) : '—';
            const ind = sig.indicators ?? {};
            const indParts: string[] = [];
            if (ind.ema_9 && ind.ema_21) indParts.push(`EMA9: ${ind.ema_9.toFixed(1)} | EMA21: ${ind.ema_21.toFixed(1)}`);
            if (ind.rsi_14) indParts.push(`RSI: ${ind.rsi_14.toFixed(1)}`);
            responseContent = `Rust Engine — ${symbol}:\n• ${sig.direction} | Confidence: ${(sig.confidence * 100).toFixed(0)}%\n• Entry: ₹${sig.entry.toFixed(2)} | Target: ₹${sig.target.toFixed(2)} (${tPct}%) | SL: ₹${sig.stop_loss.toFixed(2)} (${slPct}%)${indParts.length > 0 ? '\n• ' + indParts.join(' | ') : ''}${sig.strategy ? '\n• Strategy: ' + sig.strategy : ''}`;
          }
        } catch (err) { responseContent = `Scan failed for ${symbol}: ${(err as Error).message}`; }
        break;
      }

      case 'options_analysis': {
        const symbol = ((intent.params as any).symbol || '').toUpperCase();
        if (!symbol) { responseContent = 'Please specify a symbol. E.g. "Options NIFTY"'; break; }
        try {
          const [optData, allSignals] = await Promise.all([engineOptionsData(symbol), engineOptionsSignals()]);
          const symSignals = allSignals.filter(s => s.symbol === symbol && s.confidence >= 0.5);
          if (!optData && symSignals.length === 0) { responseContent = `No options data for ${symbol}. Feed may not be running for this symbol.`; break; }
          const lines = [`Options — ${symbol}:`];
          if (optData) {
            const pcr = optData.pcr as number | undefined;
            const maxPain = optData.max_pain as number | undefined;
            const atmIv = optData.atm_iv as number | undefined;
            const spot = optData.spot_price as number | undefined;
            if (spot) lines.push(`• Spot: ₹${Number(spot).toFixed(2)}`);
            if (pcr !== undefined) lines.push(`• PCR: ${pcr.toFixed(2)} (${pcr > 1.3 ? 'Bullish' : pcr < 0.7 ? 'Bearish' : 'Neutral'})`);
            if (maxPain) lines.push(`• Max Pain: ₹${Number(maxPain).toLocaleString()}`);
            if (atmIv !== undefined) lines.push(`• ATM IV: ${(atmIv * 100).toFixed(1)}%`);
          }
          if (symSignals.length > 0) {
            lines.push('Signals:');
            for (const sig of symSignals) lines.push(`• ${sig.strategy}: ${sig.side.toUpperCase()} (${(sig.confidence * 100).toFixed(0)}%) — ${sig.reason}`);
            const bull = symSignals.filter(s => s.side.toLowerCase() === 'buy').length;
            const bear = symSignals.filter(s => s.side.toLowerCase() === 'sell').length;
            lines.push(`Bias: ${bull > bear ? 'BULLISH' : bear > bull ? 'BEARISH' : 'NEUTRAL'}`);
          }
          responseContent = lines.join('\n');
        } catch (err) { responseContent = `Options analysis failed: ${(err as Error).message}`; }
        break;
      }

      case 'rust_status': {
        try {
          const [scanStatus, active, optSignals, perfSummary, strategies] = await Promise.all([
            engineScanStatus().catch(() => null) as Promise<any>,
            engineScanActiveSymbols().catch(() => ({ count: 0, symbols: [] })),
            engineOptionsSignals().catch(() => []),
            enginePerformanceSummary().catch(() => null),
            engineActiveStrategies().catch(() => null),
          ]);
          const lines = ['Rust Engine Status:'];
          lines.push(`• Engine: ${isEngineAvailable() ? 'ONLINE' : 'OFFLINE'}`);
          lines.push(`• Active symbols: ${active.count}`);
          if (active.symbols.length > 0) lines.push(`• Top movers: ${active.symbols.slice(0, 10).join(', ')}`);
          if (optSignals.length > 0) lines.push(`• Options signals: ${optSignals.length} (${optSignals.filter(s => s.confidence >= 0.5).length} high-confidence)`);
          if (scanStatus?.sectors_scanned) lines.push(`• Sectors scanned: ${scanStatus.sectors_scanned}`);
          if (perfSummary) {
            lines.push(`\nPerformance Engine:`);
            lines.push(`• Outcomes tracked: ${(perfSummary as any).total_outcomes ?? 0}`);
            lines.push(`• Avg health: ${(perfSummary as any).avg_health_score ?? 'N/A'}`);
            lines.push(`• Calibration error: ${(perfSummary as any).avg_calibration_error ?? 'N/A'}`);
          }
          if (strategies) {
            lines.push(`• Active strategies: ${(strategies as any).active?.length ?? 0}`);
            lines.push(`• Retired strategies: ${(strategies as any).retired?.length ?? 0}`);
          }
          responseContent = lines.join('\n');
        } catch { responseContent = `Rust engine: ${isEngineAvailable() ? 'ONLINE' : 'OFFLINE'}. Unable to fetch detailed status.`; }
        break;
      }

      case 'discovery_status': {
        try {
          const results = await engineDiscoveryResults();
          if (!results || (results as any).error) {
            responseContent = 'No strategy discovery results available yet. Discovery runs automatically on Saturdays at 11:00 IST.';
          } else {
            const r = results as any;
            const lines = ['Strategy Discovery Results:'];
            lines.push(`• Timestamp: ${r.timestamp ?? 'N/A'}`);
            lines.push(`• Total strategies evaluated: ${r.results?.length ?? 0}`);
            lines.push(`• Promoted: ${r.promoted?.length ? r.promoted.join(', ') : 'None'}`);
            lines.push(`• Retired: ${r.retired?.length ? r.retired.join(', ') : 'None'}`);
            if (r.results?.length) {
              lines.push('\nDetails:');
              for (const s of r.results) {
                lines.push(`  ${s.strategy}: ${s.action} (OOS Sharpe: ${s.out_sample_sharpe}, Consistency: ${s.consistency})`);
              }
            }
            responseContent = lines.join('\n');
          }
        } catch { responseContent = 'Unable to fetch discovery results.'; }
        break;
      }

      case 'run_discovery': {
        try {
          responseContent = 'Starting strategy discovery pipeline... This may take a few minutes.';
          engineDiscoveryRun().then(result => {
            if (result) {
              const r = result as any;
              console.log(`Discovery complete: ${r.promoted?.length ?? 0} promoted, ${r.retired?.length ?? 0} retired`);
            }
          }).catch(() => {});
        } catch { responseContent = 'Failed to trigger strategy discovery.'; }
        break;
      }

      default: {
        const weekAgo = new Date();
        weekAgo.setDate(weekAgo.getDate() - 7);

        const [recentTrades, bots, signals, pnlRecords, chatHistory] = await Promise.all([
          prisma.trade.findMany({
            where: { portfolio: { userId }, exitTime: { gte: weekAgo } },
            orderBy: { exitTime: 'desc' }, take: 20,
            select: { symbol: true, side: true, netPnl: true, strategyTag: true },
          }),
          prisma.tradingBot.findMany({
            where: { userId },
            select: { name: true, role: true, status: true, lastAction: true, totalPnl: true, winRate: true, totalTrades: true },
          }),
          prisma.aITradeSignal.findMany({
            where: { userId, createdAt: { gte: weekAgo } },
            orderBy: { createdAt: 'desc' }, take: 10,
            select: { symbol: true, signalType: true, compositeScore: true, status: true, outcomeTag: true },
          }),
          prisma.dailyPnlRecord.findMany({
            where: { userId, date: { gte: weekAgo } },
            orderBy: { date: 'desc' },
            select: { date: true, netPnl: true, tradeCount: true, winCount: true, lossCount: true },
          }),
          prisma.commandMessage.findMany({
            where: { userId }, orderBy: { createdAt: 'desc' }, take: 6,
            select: { role: true, content: true },
          }),
        ]);

        const ctx: string[] = [];
        if (pnlRecords.length > 0) {
          ctx.push(`DAILY P&L:\n${pnlRecords.map(d => `${new Date(d.date).toISOString().split('T')[0]}: ₹${Number(d.netPnl).toFixed(0)} (${d.winCount}W/${d.lossCount}L)`).join('\n')}`);
        }
        if (recentTrades.length > 0) {
          const total = recentTrades.reduce((s, t) => s + Number(t.netPnl), 0);
          const wins = recentTrades.filter(t => Number(t.netPnl) > 0).length;
          ctx.push(`TRADES (${recentTrades.length} in 7d): P&L ₹${total.toFixed(0)} | WR ${((wins / recentTrades.length) * 100).toFixed(0)}%`);
        }
        if (bots.length > 0) {
          ctx.push(`BOTS:\n${bots.map(b => `${b.name} (${b.role}): ${b.status} | ₹${Number(b.totalPnl).toFixed(0)} | WR ${(Number(b.winRate) * 100).toFixed(0)}% | ${b.lastAction || 'idle'}`).join('\n')}`);
        }
        if (signals.length > 0) {
          ctx.push(`SIGNALS:\n${signals.slice(0, 6).map(s => `${s.signalType} ${s.symbol} ${(Number(s.compositeScore) * 100).toFixed(0)}% → ${s.status}`).join('\n')}`);
        }

        let rustCtx = '';
        try {
          const [active, optSigs] = await Promise.all([
            engineScanActiveSymbols().catch(() => ({ count: 0, symbols: [] })),
            engineOptionsSignals().catch(() => []),
          ]);
          if (active.count > 0) rustCtx += `\nRUST ENGINE: ${active.count} active symbols. Top: ${active.symbols.slice(0, 8).join(', ')}`;
          const highConf = optSigs.filter(s => s.confidence >= 0.5);
          if (highConf.length > 0) rustCtx += `\nOPTIONS SIGNALS: ${highConf.map(s => `${s.side.toUpperCase()} ${s.symbol} (${s.strategy}, ${(s.confidence * 100).toFixed(0)}%)`).join('; ')}`;
        } catch { /* */ }

        const history = chatHistory.reverse().map(m => ({ role: m.role as 'user' | 'assistant', content: m.content }));

        try {
          responseContent = await chatCompletion({
            messages: [
              {
                role: 'system',
                content: `You are Capital Guard's AI trading assistant for Indian markets (NSE/BSE/MCX).

RULES:
- Be CONCISE. Use bullet points. Max 3-4 short paragraphs.
- Reference actual data, numbers, symbols. No generic advice.
- If asked about bots/engine, use the provided data.
- You can tell users to "Scan RELIANCE" or "Options NIFTY" for live analysis.

Date: ${istDateStr()}

DATA:
${ctx.length > 0 ? ctx.join('\n\n') : 'No trading data yet — new user.'}${rustCtx}`,
              },
              ...history,
              { role: 'user', content: message },
            ],
            model: GEMINI_MODEL,
            maxTokens: 768,
            temperature: 0.5,
          });
        } catch {
          responseContent = intent.response || 'Unable to process right now. Try "status", "bot status", or "scan SYMBOL".';
        }
        break;
      }
    }
  } catch (err) {
    responseContent = `Error: ${(err as Error).message}`;
  }

  try {
    await prisma.commandMessage.create({
      data: { userId, role: 'assistant', content: responseContent, metadata: JSON.stringify({ intent: intent.intent }) },
    });
  } catch { /* best-effort — metadata serialization can fail */ }

  return { role: 'assistant', content: responseContent, intent: intent.intent };
}

async function fetchBridgeCandles(symbol: string): Promise<Array<{ open: number; high: number; low: number; close: number; volume: number; timestamp: string }>> {
  try {
    const from = new Date(Date.now() - 5 * 86400000).toISOString().split('T')[0];
    const to = new Date().toISOString().split('T')[0];
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 20_000);
    const res = await fetch(`${BRIDGE_URL}/historical/${encodeURIComponent(symbol)}?interval=5minute&from=${from}&to=${to}`, { signal: ac.signal });
    clearTimeout(timer);
    const data = await res.json() as { bars?: Array<Record<string, unknown>> };
    if (!data.bars) return [];
    return data.bars.map(b => ({
      open: Number(b.open ?? 0), high: Number(b.high ?? 0), low: Number(b.low ?? 0),
      close: Number(b.close ?? 0), volume: Number(b.volume ?? 0),
      timestamp: String(b.timestamp ?? b.datetime ?? new Date().toISOString()),
    }));
  } catch { return []; }
}

export default async function commandCenterRoutes(app: FastifyInstance) {
  const prisma = getPrisma();
  const targetTracker = new TargetTracker(prisma);
  const eodReview = new EODReviewService(prisma);
  const riskService = new RiskService(prisma);

  if ((app as any).botEngine) setBotEngineRef((app as any).botEngine);

  app.addHook('preHandler', authenticate);

  app.post('/chat', async (request, reply) => {
    const userId = getUserId(request);
    const { message } = request.body as { message: string };
    if (!message?.trim()) return reply.code(400).send({ error: 'Message required' });

    if ((app as any).botEngine && !_botEngineRef) setBotEngineRef((app as any).botEngine);

    return processCommandCenterChat(userId, message);
  });

  app.get('/target', async (request) => {
    const userId = getUserId(request);
    return { target: await targetTracker.updateProgress(userId) };
  });

  app.get('/dashboard', async (request) => {
    const userId = getUserId(request);
    const [progress, risk, bots, recentPnl] = await Promise.all([
      targetTracker.updateProgress(userId),
      riskService.getDailyRiskSummary(userId),
      prisma.tradingBot.findMany({ where: { userId, status: 'RUNNING' }, select: { id: true, name: true, role: true, lastAction: true, lastActionAt: true, totalPnl: true, winRate: true } }),
      targetTracker.getRecentPnlRecords(userId, 7),
    ]);
    const todayStart = new Date(); todayStart.setUTCHours(0, 0, 0, 0);
    const todaySignals = await prisma.aITradeSignal.findMany({
      where: { userId, createdAt: { gte: todayStart } },
      orderBy: { createdAt: 'desc' }, take: 20,
      select: { id: true, symbol: true, signalType: true, compositeScore: true, status: true, rationale: true, createdAt: true },
    });
    return { target: progress, risk, bots, recentPnl, todaySignals };
  });

  app.get('/reports', async (request) => {
    const userId = getUserId(request);
    return eodReview.getReports(userId, Number((request.query as any).limit) || 30);
  });

  app.get('/reports/:date', async (request) => {
    const userId = getUserId(request);
    const report = await eodReview.getReport(userId, new Date((request.params as any).date));
    return report || { error: 'Report not found' };
  });

  app.get('/messages', async (request) => {
    const userId = getUserId(request);
    return prisma.commandMessage.findMany({ where: { userId }, orderBy: { createdAt: 'desc' }, take: Number((request.query as any).limit) || 50 });
  });

  app.get('/activity', async (request) => {
    const userId = getUserId(request);
    const messages = await prisma.botMessage.findMany({
      where: { userId }, orderBy: { createdAt: 'desc' }, take: Number((request.query as any).limit) || 50,
      include: { fromBot: { select: { id: true, name: true, role: true } } },
    });
    return messages.map(m => ({
      id: m.id, botId: m.fromBotId, botName: m.fromBot?.name ?? 'System', botRole: m.fromBot?.role ?? 'SYSTEM',
      activityType: m.messageType, summary: m.content,
      details: m.metadataJson ? JSON.parse(m.metadataJson) : null, createdAt: m.createdAt.toISOString(),
    }));
  });
}
