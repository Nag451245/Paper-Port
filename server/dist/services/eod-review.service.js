import { chatCompletionJSON } from '../lib/openai.js';
import { TargetTracker } from './target-tracker.service.js';
import { LearningStoreService } from './learning-store.service.js';
import { MarketDataService } from './market-data.service.js';
import { TelegramService } from './telegram.service.js';
import { istDateStr } from '../lib/ist.js';
export class EODReviewService {
    prisma;
    targetTracker;
    learningStore;
    marketData = new MarketDataService();
    telegram;
    running = false;
    constructor(prisma) {
        this.prisma = prisma;
        this.targetTracker = new TargetTracker(prisma);
        this.learningStore = new LearningStoreService();
        this.telegram = new TelegramService(prisma);
    }
    async runReview(userId) {
        if (this.running)
            return;
        this.running = true;
        try {
            const users = userId
                ? [{ id: userId }]
                : await this.prisma.user.findMany({ where: { isActive: true }, select: { id: true } });
            for (const user of users) {
                try {
                    await this.reviewUserDay(user.id);
                }
                catch (err) {
                    console.error(`[EODReview] Error reviewing user ${user.id}:`, err.message);
                }
            }
        }
        finally {
            this.running = false;
        }
    }
    async reviewUserDay(userId) {
        const todayStart = new Date();
        todayStart.setUTCHours(0, 0, 0, 0);
        const todayEnd = new Date(todayStart);
        todayEnd.setUTCHours(23, 59, 59, 999);
        // Collect day's data
        const portfolios = await this.prisma.portfolio.findMany({
            where: { userId },
            select: { id: true, initialCapital: true, currentNav: true },
        });
        const portfolioIds = portfolios.map(p => p.id);
        const trades = await this.prisma.trade.findMany({
            where: {
                portfolioId: { in: portfolioIds },
                exitTime: { gte: todayStart, lte: todayEnd },
            },
        });
        const signals = await this.prisma.aITradeSignal.findMany({
            where: {
                userId,
                createdAt: { gte: todayStart, lte: todayEnd },
            },
        });
        const botMessages = await this.prisma.botMessage.findMany({
            where: {
                userId,
                createdAt: { gte: todayStart, lte: todayEnd },
            },
            orderBy: { createdAt: 'asc' },
            take: 50,
        });
        if (trades.length === 0 && signals.length === 0) {
            console.log(`[EODReview] User ${userId}: no trades or signals today, skipping`);
            return;
        }
        // Get target info
        const target = await this.targetTracker.getActiveTarget(userId);
        const targetPnl = target ? target.capitalBase * (target.profitTargetPct / 100) : 0;
        // Calculate day P&L
        const totalPnl = trades.reduce((sum, t) => sum + Number(t.netPnl), 0);
        const wins = trades.filter(t => Number(t.netPnl) > 0);
        const losses = trades.filter(t => Number(t.netPnl) < 0);
        // Trade reviews
        const tradeReviews = trades.map(t => ({
            tradeId: t.id,
            symbol: t.symbol,
            side: t.side,
            entryPrice: Number(t.entryPrice),
            exitPrice: Number(t.exitPrice),
            pnl: Number(t.netPnl),
            outcome: Number(t.netPnl) > 0 ? 'WIN' : Number(t.netPnl) < -10 ? 'LOSS' : 'BREAKEVEN',
            entryTiming: '',
            exitTiming: '',
            riskRewardPlanned: '',
            riskRewardActual: '',
        }));
        // False positive detection
        const falsePositives = signals
            .filter(s => {
            if (s.status === 'EXECUTED') {
                const matchingTrade = trades.find(t => t.symbol === s.symbol);
                return matchingTrade && Number(matchingTrade.netPnl) < 0;
            }
            return s.status === 'EXPIRED' || s.status === 'REJECTED';
        })
            .map(s => ({
            signalId: s.id,
            symbol: s.symbol,
            direction: s.signalType,
            confidence: s.compositeScore,
            reason: s.rationale || '',
            actualOutcome: s.outcomeTag || 'UNKNOWN',
        }));
        // Market context
        let marketContext = { vix: 15, niftyChange: 0 };
        try {
            const [vixData, indices] = await Promise.all([
                this.marketData.getVIX().catch(() => ({ value: 15 })),
                this.marketData.getIndices().catch(() => []),
            ]);
            const nifty = indices.find((i) => i.name?.includes('NIFTY'));
            marketContext = { vix: vixData.value, niftyChange: nifty?.changePercent ?? 0 };
        }
        catch { /* use defaults */ }
        // Generate AI review
        let aiReview;
        try {
            aiReview = await chatCompletionJSON({
                messages: [
                    {
                        role: 'system',
                        content: `You are an expert trading performance reviewer. Analyze today's trading session and provide a structured review. Be specific about what went right and wrong, with actionable improvements. Return JSON with keys: whatWentWell (string[]), whatWentWrong (string[]), decisionAnalysis (string), improvements (string[]), falsePositiveAnalysis (string).`,
                    },
                    {
                        role: 'user',
                        content: `Day Summary:
- Total P&L: ₹${totalPnl.toFixed(2)} | Target: ₹${targetPnl.toFixed(0)} | ${totalPnl >= targetPnl ? 'TARGET HIT' : 'TARGET MISSED'}
- Trades: ${trades.length} total | ${wins.length} wins | ${losses.length} losses | Win Rate: ${trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(0) : 0}%
- Market: NIFTY ${marketContext.niftyChange > 0 ? '+' : ''}${marketContext.niftyChange.toFixed(2)}% | VIX: ${marketContext.vix}

Trade Details:
${tradeReviews.map(t => `  ${t.side} ${t.symbol}: Entry ₹${t.entryPrice} → Exit ₹${t.exitPrice} | P&L: ₹${t.pnl.toFixed(2)} [${t.outcome}]`).join('\n')}

Signals Generated: ${signals.length} | Executed: ${signals.filter(s => s.status === 'EXECUTED').length}
False Positives: ${falsePositives.length}
${falsePositives.map(fp => `  ${fp.direction} ${fp.symbol} (${(fp.confidence * 100).toFixed(0)}% conf) → ${fp.actualOutcome}`).join('\n')}`,
                    },
                ],
                maxTokens: 2000,
                temperature: 0.3,
            });
        }
        catch {
            aiReview = {
                whatWentWell: totalPnl > 0 ? [`Overall profit of ₹${totalPnl.toFixed(0)}`] : [],
                whatWentWrong: totalPnl < 0 ? [`Net loss of ₹${Math.abs(totalPnl).toFixed(0)}`] : [],
                decisionAnalysis: `${trades.length} trades executed. Win rate: ${trades.length > 0 ? ((wins.length / trades.length) * 100).toFixed(0) : 0}%`,
                improvements: ['Review signal confidence thresholds'],
                falsePositiveAnalysis: `${falsePositives.length} false positive signals detected`,
            };
        }
        // Risk events today
        const riskEvents = await this.prisma.riskEvent.findMany({
            where: { userId, createdAt: { gte: todayStart, lte: todayEnd } },
            select: { ruleType: true, severity: true, symbol: true, details: true },
        });
        // Store EOD Report
        const reportDate = new Date(todayStart);
        await this.prisma.eODReport.upsert({
            where: { userId_date: { userId, date: reportDate } },
            create: {
                userId,
                date: reportDate,
                totalPnl,
                targetPnl,
                targetAchieved: totalPnl >= targetPnl && targetPnl > 0,
                tradesSummary: JSON.stringify(tradeReviews),
                falsePositives: JSON.stringify(falsePositives),
                decisionsReview: JSON.stringify(aiReview),
                improvements: JSON.stringify(aiReview.improvements),
                marketContext: JSON.stringify(marketContext),
                riskEvents: JSON.stringify(riskEvents.map(r => ({ type: r.ruleType, severity: r.severity, symbol: r.symbol }))),
            },
            update: {
                totalPnl,
                targetPnl,
                targetAchieved: totalPnl >= targetPnl && targetPnl > 0,
                tradesSummary: JSON.stringify(tradeReviews),
                falsePositives: JSON.stringify(falsePositives),
                decisionsReview: JSON.stringify(aiReview),
                improvements: JSON.stringify(aiReview.improvements),
                marketContext: JSON.stringify(marketContext),
                riskEvents: JSON.stringify(riskEvents.map(r => ({ type: r.ruleType, severity: r.severity, symbol: r.symbol }))),
            },
        });
        // Record daily P&L
        await this.targetTracker.recordDailyPnl(userId);
        // Store detailed report in learning folder
        try {
            await this.learningStore.writeDailyReport(reportDate, {
                userId,
                totalPnl,
                targetPnl,
                targetAchieved: totalPnl >= targetPnl,
                trades: tradeReviews,
                falsePositives,
                review: aiReview,
                marketContext,
                riskEvents: riskEvents.length,
            });
            for (const trade of tradeReviews) {
                await this.learningStore.writeTradeReview(reportDate, trade.tradeId, trade);
            }
            if (falsePositives.length > 0) {
                await this.learningStore.writeFalsePositives(reportDate, falsePositives);
            }
        }
        catch (err) {
            console.error(`[EODReview] Learning store write failed:`, err.message);
        }
        // Check consecutive loss days — trigger deep review
        const updatedTarget = await this.targetTracker.getActiveTarget(userId);
        if (updatedTarget && updatedTarget.consecutiveLossDays >= 2) {
            await this.triggerDeepReview(userId, updatedTarget.consecutiveLossDays);
        }
        console.log(`[EODReview] User ${userId}: report generated | P&L: ₹${totalPnl.toFixed(0)} | ${trades.length} trades | ${falsePositives.length} false positives`);
        // Send Telegram daily report
        const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
        const topWinner = wins.length > 0
            ? wins.reduce((a, b) => Number(a.netPnl) > Number(b.netPnl) ? a : b).symbol
            : 'None';
        const topLoser = losses.length > 0
            ? losses.reduce((a, b) => Number(a.netPnl) < Number(b.netPnl) ? a : b).symbol
            : 'None';
        this.telegram.notifyDailyReport(userId, {
            trades: trades.length,
            pnl: totalPnl,
            winRate,
            topWinner,
            topLoser,
            regime: marketContext.niftyChange > 0.5 ? 'Bullish' : marketContext.niftyChange < -0.5 ? 'Bearish' : 'Sideways',
        }).catch(err => console.error('[EODReview] Telegram daily report failed:', err.message));
    }
    async triggerDeepReview(userId, lossDays) {
        console.log(`[EODReview] DEEP REVIEW triggered for user ${userId}: ${lossDays} consecutive loss days`);
        const recentRecords = await this.targetTracker.getRecentPnlRecords(userId, lossDays + 1);
        try {
            const deepReview = await chatCompletionJSON({
                messages: [
                    {
                        role: 'system',
                        content: `You are a senior trading risk manager. ${lossDays} consecutive loss days have triggered a mandatory review. Analyze the pattern and recommend action. Return JSON with: diagnosis (string), regimeChange (boolean), suggestedAction (string: "pause"|"reduce_size"|"switch_strategy"|"continue"), strategySwitch (string: if switch, what to switch to).`,
                    },
                    {
                        role: 'user',
                        content: `Recent daily P&L:\n${recentRecords.map(r => `  ${istDateStr(r.date)}: ₹${Number(r.netPnl).toFixed(0)} | ${r.winCount}W/${r.lossCount}L | ${r.status}`).join('\n')}`,
                    },
                ],
                maxTokens: 500,
                temperature: 0.3,
            });
            // Store as a command message for the user to see
            await this.prisma.commandMessage.create({
                data: {
                    userId,
                    role: 'assistant',
                    content: `DEEP REVIEW: ${lossDays} consecutive loss days detected.\n\nDiagnosis: ${deepReview.diagnosis}\n\nRecommendation: ${deepReview.suggestedAction}${deepReview.regimeChange ? '\n\nMarket regime change detected.' : ''}${deepReview.strategySwitch ? `\n\nSuggested strategy: ${deepReview.strategySwitch}` : ''}`,
                    metadata: JSON.stringify({ type: 'deep_review', lossDays, review: deepReview }),
                },
            });
        }
        catch (err) {
            console.error(`[EODReview] Deep review AI failed:`, err.message);
        }
    }
    async getReport(userId, date) {
        const reportDate = date ?? new Date();
        reportDate.setUTCHours(0, 0, 0, 0);
        return this.prisma.eODReport.findUnique({
            where: { userId_date: { userId, date: reportDate } },
        });
    }
    async getReports(userId, limit = 30) {
        return this.prisma.eODReport.findMany({
            where: { userId },
            orderBy: { date: 'desc' },
            take: limit,
        });
    }
}
//# sourceMappingURL=eod-review.service.js.map