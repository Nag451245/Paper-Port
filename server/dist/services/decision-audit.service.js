export class DecisionAuditService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma;
    }
    async recordDecision(record) {
        const audit = await this.prisma.decisionAudit.create({
            data: {
                userId: record.userId,
                botId: record.botId,
                symbol: record.symbol,
                decisionType: record.decisionType,
                direction: record.direction,
                confidence: record.confidence,
                signalSource: record.signalSource,
                marketDataSnapshot: JSON.stringify(record.marketDataSnapshot),
                riskChecks: JSON.stringify(record.riskChecks ?? {}),
                reasoning: record.reasoning,
                entryPrice: record.entryPrice,
            },
        });
        return audit.id;
    }
    async resolveDecision(auditId, outcome) {
        let outcomeLabel;
        if (Math.abs(outcome.pnl) < 10)
            outcomeLabel = 'BREAKEVEN';
        else if (outcome.pnl > 0)
            outcomeLabel = 'WIN';
        else
            outcomeLabel = 'LOSS';
        await this.prisma.decisionAudit.update({
            where: { id: auditId },
            data: {
                exitPrice: outcome.exitPrice,
                pnl: outcome.pnl,
                predictionAccuracy: outcome.predictionAccuracy,
                outcome: outcomeLabel,
                reasoning: outcome.outcomeNotes
                    ? `${outcomeLabel}: ${outcome.outcomeNotes}`
                    : undefined,
                resolvedAt: new Date(),
            },
        });
    }
    async getDecisionHistory(userId, filters = {}) {
        const { page = 1, limit = 50, symbol, botId, decisionType, fromDate, toDate } = filters;
        const where = { userId };
        if (symbol)
            where.symbol = symbol;
        if (botId)
            where.botId = botId;
        if (decisionType)
            where.decisionType = decisionType;
        if (fromDate || toDate) {
            where.createdAt = {};
            if (fromDate)
                where.createdAt.gte = new Date(fromDate);
            if (toDate)
                where.createdAt.lte = new Date(toDate);
        }
        const [decisions, total] = await Promise.all([
            this.prisma.decisionAudit.findMany({
                where,
                orderBy: { createdAt: 'desc' },
                skip: (page - 1) * limit,
                take: limit,
            }),
            this.prisma.decisionAudit.count({ where }),
        ]);
        return {
            decisions: decisions.map((d) => ({
                ...d,
                marketDataSnapshot: JSON.parse(d.marketDataSnapshot),
                riskChecks: JSON.parse(d.riskChecks),
            })),
            total,
        };
    }
    async getDecisionAnalytics(userId, days = 30) {
        const since = new Date();
        since.setDate(since.getDate() - days);
        const decisions = await this.prisma.decisionAudit.findMany({
            where: { userId, createdAt: { gte: since } },
        });
        const entrySignals = decisions.filter((d) => d.decisionType === 'ENTRY_SIGNAL');
        const exitSignals = decisions.filter((d) => d.decisionType === 'EXIT_SIGNAL');
        const riskBlocks = decisions.filter((d) => d.decisionType === 'RISK_BLOCK');
        const resolved = decisions.filter((d) => d.resolvedAt && d.pnl !== null);
        const wins = resolved.filter((d) => (d.pnl ?? 0) > 0);
        const symbolMap = new Map();
        for (const d of decisions) {
            const entry = symbolMap.get(d.symbol) ?? { count: 0, totalPnl: 0 };
            entry.count++;
            entry.totalPnl += d.pnl ?? 0;
            symbolMap.set(d.symbol, entry);
        }
        const sourceMap = new Map();
        for (const d of decisions) {
            const entry = sourceMap.get(d.signalSource) ?? { count: 0, correct: 0 };
            entry.count++;
            if (d.predictionAccuracy && d.predictionAccuracy > 0.5)
                entry.correct++;
            sourceMap.set(d.signalSource, entry);
        }
        return {
            totalDecisions: decisions.length,
            entrySignals: entrySignals.length,
            exitSignals: exitSignals.length,
            riskBlocks: riskBlocks.length,
            avgConfidence: decisions.length > 0
                ? Number((decisions.reduce((s, d) => s + d.confidence, 0) / decisions.length).toFixed(2))
                : 0,
            accuracyRate: resolved.length > 0
                ? Number((resolved.filter(d => (d.predictionAccuracy ?? 0) > 0.5).length / resolved.length * 100).toFixed(1))
                : 0,
            winRate: resolved.length > 0
                ? Number((wins.length / resolved.length * 100).toFixed(1))
                : 0,
            topSymbols: [...symbolMap.entries()]
                .map(([symbol, data]) => ({ symbol, count: data.count, avgPnl: Number((data.totalPnl / data.count).toFixed(2)) }))
                .sort((a, b) => b.count - a.count)
                .slice(0, 10),
            signalSourceBreakdown: [...sourceMap.entries()]
                .map(([source, data]) => ({
                source,
                count: data.count,
                accuracy: data.count > 0 ? Number((data.correct / data.count * 100).toFixed(1)) : 0,
            })),
        };
    }
}
//# sourceMappingURL=decision-audit.service.js.map