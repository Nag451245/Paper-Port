import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';
const log = createChildLogger('MarketMemory');
function computeNiftyBand(niftyLevel) {
    const base = Math.floor(niftyLevel / 500) * 500;
    return `${base}-${base + 500}`;
}
function getAdjacentBands(niftyLevel) {
    const base = Math.floor(niftyLevel / 500) * 500;
    return [
        `${base - 500}-${base}`,
        `${base}-${base + 500}`,
        `${base + 500}-${base + 1000}`,
    ];
}
function parseFingerprint(fp) {
    try {
        const parsed = JSON.parse(fp);
        if (Array.isArray(parsed))
            return parsed.map(Number);
    }
    catch {
        /* invalid fingerprint */
    }
    return [];
}
function cosineSimilarity(a, b) {
    if (a.length === 0 || b.length === 0 || a.length !== b.length)
        return 0;
    let dot = 0;
    let magA = 0;
    let magB = 0;
    for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
    }
    const denom = Math.sqrt(magA) * Math.sqrt(magB);
    if (denom === 0)
        return 0;
    return dot / denom;
}
export class MarketMemoryService {
    prisma = getPrisma();
    async recordMemory(input) {
        const { conditions } = input;
        const niftyBand = computeNiftyBand(conditions.niftyLevel);
        const record = await this.prisma.marketMemory.create({
            data: {
                userId: input.userId,
                symbol: input.symbol,
                timestamp: new Date(),
                niftyLevel: conditions.niftyLevel,
                niftyBand,
                vixLevel: conditions.vixLevel,
                regime: conditions.regime,
                dayOfWeek: conditions.dayOfWeek,
                hourOfDay: conditions.hourOfDay,
                gapPct: conditions.gapPct,
                signalStrategy: input.strategy,
                signalDirection: input.direction,
                signalConfidence: input.confidence,
                fingerprint: input.fingerprint,
                marketSnapshot: input.marketSnapshot ? input.marketSnapshot : undefined,
            },
        });
        log.info({ memoryId: record.id, symbol: input.symbol, regime: conditions.regime }, 'Memory recorded');
        return record.id;
    }
    async resolveMemory(memoryId, outcome, pnlPct, holdingMinutes, lessons) {
        await this.prisma.marketMemory.update({
            where: { id: memoryId },
            data: {
                outcome,
                pnlPct,
                holdingMinutes,
                lessonsLearned: lessons ?? null,
                resolvedAt: new Date(),
            },
        });
        log.info({ memoryId, outcome, pnlPct }, 'Memory resolved');
    }
    async recall(userId, conditions, fingerprint, topK = 20) {
        const bands = getAdjacentBands(conditions.niftyLevel);
        const candidates = await this.prisma.marketMemory.findMany({
            where: {
                userId,
                regime: conditions.regime,
                niftyBand: { in: bands },
                outcome: { not: null },
            },
            orderBy: { timestamp: 'desc' },
            take: 200,
        });
        if (candidates.length === 0) {
            return {
                similarCases: 0,
                historicalWinRate: 0,
                avgPnlPct: 0,
                bestStrategy: '',
                worstStrategy: '',
                cautionNotes: ['No historical data for these conditions'],
                memories: [],
            };
        }
        const queryVec = parseFingerprint(fingerprint);
        const scored = candidates
            .map((c) => ({
            record: c,
            similarity: cosineSimilarity(queryVec, parseFingerprint(c.fingerprint)),
        }))
            .sort((a, b) => b.similarity - a.similarity)
            .slice(0, topK);
        const resolved = scored.filter((s) => s.record.outcome !== null);
        const wins = resolved.filter((s) => s.record.outcome === 'WIN');
        const losses = resolved.filter((s) => s.record.outcome === 'LOSS');
        const winRate = resolved.length > 0 ? wins.length / resolved.length : 0;
        const pnls = resolved.map((s) => s.record.pnlPct ?? 0);
        const avgPnl = pnls.length > 0 ? pnls.reduce((a, b) => a + b, 0) / pnls.length : 0;
        const strategyPnl = new Map();
        for (const s of resolved) {
            const key = s.record.signalStrategy;
            const entry = strategyPnl.get(key) ?? { total: 0, count: 0 };
            entry.total += s.record.pnlPct ?? 0;
            entry.count++;
            strategyPnl.set(key, entry);
        }
        let bestStrategy = '';
        let worstStrategy = '';
        let bestAvg = -Infinity;
        let worstAvg = Infinity;
        for (const [strat, data] of strategyPnl) {
            const avg = data.total / data.count;
            if (avg > bestAvg) {
                bestAvg = avg;
                bestStrategy = strat;
            }
            if (avg < worstAvg) {
                worstAvg = avg;
                worstStrategy = strat;
            }
        }
        const cautionNotes = this.generateCautionNotes(resolved, conditions);
        return {
            similarCases: resolved.length,
            historicalWinRate: Math.round(winRate * 10000) / 10000,
            avgPnlPct: Math.round(avgPnl * 100) / 100,
            bestStrategy,
            worstStrategy,
            cautionNotes,
            memories: scored.map((s) => ({
                id: s.record.id,
                symbol: s.record.symbol,
                strategy: s.record.signalStrategy,
                direction: s.record.signalDirection,
                outcome: s.record.outcome ?? 'PENDING',
                pnlPct: s.record.pnlPct ?? 0,
                regime: s.record.regime,
                lessonsLearned: s.record.lessonsLearned,
            })),
        };
    }
    async getWinRateForConditions(userId, regime, niftyBand, strategy) {
        const where = {
            userId,
            regime,
            niftyBand,
            outcome: { not: null },
        };
        if (strategy)
            where.signalStrategy = strategy;
        const records = await this.prisma.marketMemory.findMany({
            where,
            select: { outcome: true },
        });
        const total = records.length;
        if (total === 0)
            return { winRate: 0, totalCases: 0 };
        const wins = records.filter((r) => r.outcome === 'WIN').length;
        return {
            winRate: Math.round((wins / total) * 10000) / 10000,
            totalCases: total,
        };
    }
    async getSupportResistanceLevels(symbol, limit = 10) {
        const memories = await this.prisma.marketMemory.findMany({
            where: {
                symbol,
                outcome: { not: null },
                niftyLevel: { gt: 0 },
            },
            select: {
                niftyLevel: true,
                outcome: true,
                signalDirection: true,
                timestamp: true,
            },
            orderBy: { timestamp: 'desc' },
            take: 500,
        });
        if (memories.length === 0)
            return [];
        const bandSize = this.computePriceBandSize(memories.map((m) => m.niftyLevel));
        const levelMap = new Map();
        for (const m of memories) {
            const rounded = Math.round(m.niftyLevel / bandSize) * bandSize;
            const entry = levelMap.get(rounded) ?? {
                wins: 0,
                losses: 0,
                lastTested: m.timestamp,
                directions: [],
            };
            if (m.outcome === 'WIN')
                entry.wins++;
            else if (m.outcome === 'LOSS')
                entry.losses++;
            if (m.timestamp > entry.lastTested)
                entry.lastTested = m.timestamp;
            entry.directions.push(m.signalDirection);
            levelMap.set(rounded, entry);
        }
        const levels = [];
        for (const [price, data] of levelMap) {
            const total = data.wins + data.losses;
            if (total < 2)
                continue;
            const bullishSignals = data.directions.filter((d) => d === 'LONG' || d === 'BUY').length;
            const isSupportZone = bullishSignals > total / 2;
            levels.push({
                price,
                type: isSupportZone ? 'SUPPORT' : 'RESISTANCE',
                strength: total,
                lastTestedAt: data.lastTested,
                held: data.wins > data.losses,
            });
        }
        return levels
            .sort((a, b) => b.strength - a.strength)
            .slice(0, limit);
    }
    async getLessonsForSymbol(userId, symbol, limit = 10) {
        const records = await this.prisma.marketMemory.findMany({
            where: {
                userId,
                symbol,
                lessonsLearned: { not: null },
            },
            select: { lessonsLearned: true },
            orderBy: { resolvedAt: 'desc' },
            take: limit,
        });
        return records
            .map((r) => r.lessonsLearned)
            .filter((l) => l !== null);
    }
    generateCautionNotes(resolved, conditions) {
        const notes = [];
        const strategyGroups = new Map();
        for (const s of resolved) {
            const key = s.record.signalStrategy;
            const entry = strategyGroups.get(key) ?? { wins: 0, total: 0 };
            entry.total++;
            if (s.record.outcome === 'WIN')
                entry.wins++;
            strategyGroups.set(key, entry);
        }
        for (const [strat, data] of strategyGroups) {
            if (data.total >= 4) {
                const losses = data.total - data.wins;
                if (losses / data.total >= 0.7) {
                    notes.push(`${losses}/${data.total} ${strat} signals failed in this regime`);
                }
            }
        }
        const highVixLosses = resolved.filter((s) => s.record.vixLevel >= 18 && s.record.outcome === 'LOSS');
        const totalLosses = resolved.filter((s) => s.record.outcome === 'LOSS');
        if (totalLosses.length >= 3 && highVixLosses.length >= 3) {
            notes.push(`VIX was 18+ in ${highVixLosses.length}/${totalLosses.length} losing cases`);
        }
        if (conditions.vixLevel >= 20) {
            notes.push('Current VIX is elevated (≥20) — volatility regime may suppress signals');
        }
        if (conditions.gapPct > 1 || conditions.gapPct < -1) {
            const gapDir = conditions.gapPct > 0 ? 'up' : 'down';
            notes.push(`Large gap ${gapDir} (${conditions.gapPct.toFixed(2)}%) — gap fills are common`);
        }
        return notes;
    }
    computePriceBandSize(prices) {
        if (prices.length === 0)
            return 50;
        const avg = prices.reduce((a, b) => a + b, 0) / prices.length;
        return Math.max(Math.round(avg * 0.005 / 5) * 5, 5);
    }
}
//# sourceMappingURL=market-memory.service.js.map