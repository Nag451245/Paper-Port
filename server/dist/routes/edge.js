import { getPrisma } from '../lib/prisma.js';
import { StrategyComposer } from '../services/strategy-composer.js';
import { SentimentEngine } from '../services/sentiment-engine.js';
import { engineAdvancedSignals, engineIVSurface, engineWalkForward } from '../lib/rust-engine.js';
import { istDateStr } from '../lib/ist.js';
export async function edgeRoutes(app) {
    const prisma = getPrisma();
    const composer = new StrategyComposer(prisma);
    const sentiment = new SentimentEngine(prisma);
    app.addHook('onRequest', async (request, reply) => {
        // Market status is public — skip auth
        if (request.url.endsWith('/market-status'))
            return;
        try {
            await request.jwtVerify();
        }
        catch {
            throw app.httpErrors.unauthorized('Invalid or missing token');
        }
    });
    app.get('/market-status', async () => {
        const orchestrator = app.orchestrator;
        if (!orchestrator) {
            return { error: 'Orchestrator not available' };
        }
        return orchestrator.getStatus();
    });
    // ── Strategy Composition ──
    app.get('/composition', async (req) => {
        const userId = req.user?.sub;
        return composer.composePortfolio(userId);
    });
    app.get('/composition/kelly/:strategy', async (req) => {
        const userId = req.user?.sub;
        const { strategy } = req.params;
        const ledgers = await prisma.strategyLedger.findMany({
            where: { userId, strategyId: strategy },
            orderBy: { date: 'desc' },
            take: 30,
        });
        if (ledgers.length === 0) {
            return { kellyFraction: 0, halfKelly: 0, suggestedAllocation: 0.05, winRate: 0, avgWinLossRatio: 0, message: 'Insufficient data' };
        }
        const wins = ledgers.filter((l) => l.winRate > 50);
        const winRate = wins.length / ledgers.length;
        const avgWin = ledgers.filter((l) => Number(l.netPnl) > 0).reduce((s, l) => s + Number(l.netPnl), 0) / (wins.length || 1);
        const avgLoss = Math.abs(ledgers.filter((l) => Number(l.netPnl) < 0).reduce((s, l) => s + Number(l.netPnl), 0)) / (ledgers.filter((l) => Number(l.netPnl) < 0).length || 1);
        return composer.computeKelly(winRate, avgWin, avgLoss);
    });
    // ── Walk-Forward Validation ──
    app.post('/walk-forward', async (req) => {
        const body = req.body;
        return engineWalkForward({
            strategy: body.strategy,
            symbol: body.symbol,
            initial_capital: 100000,
            candles: body.candles,
            param_grid: body.param_grid ?? { ema_short: [5, 7, 9, 12, 15], ema_long: [15, 18, 21, 26, 30] },
            in_sample_ratio: 0.7,
            num_folds: body.num_folds ?? 5,
        });
    });
    // ── Sentiment Intelligence ──
    app.get('/sentiment', async () => {
        return sentiment.getSentimentSnapshot();
    });
    app.post('/sentiment/analyze', async (req) => {
        const { symbols } = req.body;
        return sentiment.getAISentimentAnalysis(symbols ?? []);
    });
    // ── Advanced Signals (VWAP, Volume Profile, Order Flow, Market Profile) ──
    app.post('/advanced-signals', async (req) => {
        const body = req.body;
        return engineAdvancedSignals({
            candles: body.candles,
            compute: body.compute ?? ['vwap', 'volume_profile', 'order_flow', 'market_profile'],
        });
    });
    // ── IV Surface ──
    app.post('/iv-surface', async (req) => {
        const body = req.body;
        return engineIVSurface({
            spot: body.spot,
            strikes: body.strikes,
        });
    });
    // ── Track Record / Performance ──
    app.get('/track-record', async (req) => {
        const userId = req.user?.sub;
        const trades = await prisma.trade.findMany({
            where: { portfolio: { userId } },
            orderBy: { exitTime: 'asc' },
        });
        let cumPnl = 0;
        const timeline = [];
        const dailyMap = new Map();
        for (const t of trades) {
            const date = t.exitTime ? istDateStr(new Date(t.exitTime)) : 'unknown';
            const existing = dailyMap.get(date) ?? { pnl: 0, count: 0 };
            existing.pnl += Number(t.netPnl);
            existing.count += 1;
            dailyMap.set(date, existing);
        }
        for (const [date, data] of [...dailyMap.entries()].sort()) {
            cumPnl += data.pnl;
            timeline.push({ date, cumPnl: Number(cumPnl.toFixed(2)), tradeCount: data.count });
        }
        const portfolio = await prisma.portfolio.findFirst({ where: { userId } });
        const initialCapital = portfolio ? Number(portfolio.initialCapital) : 1000000;
        const cashNav = portfolio ? Number(portfolio.currentNav) : initialCapital;
        let investedValue = 0;
        let unrealizedPnl = 0;
        if (portfolio) {
            const openPositions = await prisma.position.findMany({
                where: { portfolioId: portfolio.id, status: 'OPEN' },
                select: { side: true, qty: true, avgEntryPrice: true, unrealizedPnl: true },
            });
            for (const pos of openPositions) {
                const entry = Number(pos.avgEntryPrice);
                investedValue += pos.side === 'LONG' ? entry * pos.qty : entry * pos.qty * 0.25;
                unrealizedPnl += Number(pos.unrealizedPnl ?? 0);
            }
        }
        const totalNav = cashNav + investedValue + unrealizedPnl;
        const totalRealizedPnl = trades.reduce((s, t) => s + Number(t.netPnl), 0);
        const totalReturn = initialCapital > 0 ? (totalRealizedPnl / initialCapital) * 100 : 0;
        const wins = trades.filter((t) => Number(t.netPnl) > 0);
        const losses = trades.filter((t) => Number(t.netPnl) < 0);
        const winRate = trades.length > 0 ? (wins.length / trades.length) * 100 : 0;
        const avgWin = wins.length > 0 ? wins.reduce((s, t) => s + Number(t.netPnl), 0) / wins.length : 0;
        const avgLoss = losses.length > 0 ? Math.abs(losses.reduce((s, t) => s + Number(t.netPnl), 0) / losses.length) : 0;
        const profitFactor = avgLoss > 0 ? avgWin * wins.length / (avgLoss * losses.length) : 0;
        let maxDD = 0;
        let peak = 0;
        for (const entry of timeline) {
            if (entry.cumPnl > peak)
                peak = entry.cumPnl;
            const dd = peak > 0 ? ((peak - entry.cumPnl) / peak) * 100 : 0;
            if (dd > maxDD)
                maxDD = dd;
        }
        const byStrategy = new Map();
        for (const t of trades) {
            const key = t.strategyTag || 'manual';
            const existing = byStrategy.get(key) ?? { trades: 0, pnl: 0, wins: 0 };
            existing.trades += 1;
            existing.pnl += Number(t.netPnl);
            if (Number(t.netPnl) > 0)
                existing.wins += 1;
            byStrategy.set(key, existing);
        }
        return {
            timeline,
            summary: {
                totalTrades: trades.length,
                totalReturn: Number(totalReturn.toFixed(2)),
                realizedPnl: Number(totalRealizedPnl.toFixed(2)),
                unrealizedPnl: Number(unrealizedPnl.toFixed(2)),
                winRate: Number(winRate.toFixed(1)),
                profitFactor: Number(profitFactor.toFixed(2)),
                maxDrawdown: Number(maxDD.toFixed(2)),
                avgWin: Number(avgWin.toFixed(2)),
                avgLoss: Number(avgLoss.toFixed(2)),
                initialCapital,
                currentNav: Number(totalNav.toFixed(2)),
            },
            byStrategy: Object.fromEntries([...byStrategy.entries()].map(([k, v]) => [k, { ...v, pnl: Number(v.pnl.toFixed(2)), winRate: v.trades > 0 ? Number(((v.wins / v.trades) * 100).toFixed(1)) : 0 }])),
        };
    });
}
//# sourceMappingURL=edge.js.map