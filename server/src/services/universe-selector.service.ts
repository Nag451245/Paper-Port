import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('UniverseSelector');

export interface UniverseCriteria {
  minAvgVolume?: number;
  maxSpreadBps?: number;
  sectors?: string[];
  excludeSectors?: string[];
  momentumFilter?: 'TOP_N' | 'BOTTOM_N';
  momentumN?: number;
  exchange?: string;
}

export interface UniverseEntry {
  symbol: string;
  exchange: string;
  sector?: string;
  avgVolume: number;
  spreadBps: number;
  relativeStrength: number;
  reason: string;
}

export class UniverseSelectorService {
  constructor(private prisma: PrismaClient) {}

  async select(criteria: UniverseCriteria): Promise<UniverseEntry[]> {
    const exchange = criteria.exchange ?? 'NSE';
    const lookbackDays = 20;
    const since = new Date();
    since.setDate(since.getDate() - lookbackDays);

    const recentBars = await this.prisma.historicalBar.findMany({
      where: {
        exchange,
        timeframe: '1d',
        timestamp: { gte: since },
      },
      orderBy: { timestamp: 'asc' },
    });

    const barsBySymbol = new Map<string, Array<{ close: number; volume: bigint; timestamp: Date }>>();
    for (const bar of recentBars) {
      if (!barsBySymbol.has(bar.symbol)) barsBySymbol.set(bar.symbol, []);
      barsBySymbol.get(bar.symbol)!.push({
        close: bar.close,
        volume: bar.volume,
        timestamp: bar.timestamp,
      });
    }

    const tickSince = new Date();
    tickSince.setDate(tickSince.getDate() - 5);

    const recentTicks = await this.prisma.tick.findMany({
      where: {
        exchange,
        timestamp: { gte: tickSince },
        bid: { not: null },
        ask: { not: null },
      },
      select: { symbol: true, bid: true, ask: true, ltp: true },
    });

    const spreadBySymbol = new Map<string, number[]>();
    for (const tick of recentTicks) {
      if (tick.bid != null && tick.ask != null && tick.ltp > 0) {
        if (!spreadBySymbol.has(tick.symbol)) spreadBySymbol.set(tick.symbol, []);
        spreadBySymbol.get(tick.symbol)!.push(((tick.ask - tick.bid) / tick.ltp) * 10_000);
      }
    }

    const entries: UniverseEntry[] = [];

    for (const [symbol, bars] of barsBySymbol) {
      if (bars.length < 5) continue;

      const totalVolume = bars.reduce((s, b) => s + Number(b.volume), 0);
      const avgVolume = totalVolume / bars.length;

      if (criteria.minAvgVolume && avgVolume < criteria.minAvgVolume) continue;

      const spreads = spreadBySymbol.get(symbol);
      let avgSpreadBps = 0;
      if (spreads && spreads.length > 0) {
        avgSpreadBps = spreads.reduce((s, v) => s + v, 0) / spreads.length;
      }

      if (criteria.maxSpreadBps && avgSpreadBps > criteria.maxSpreadBps) continue;

      const sortedBars = [...bars].sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
      const oldest = sortedBars[0];
      const newest = sortedBars[sortedBars.length - 1];
      const relativeStrength = oldest.close > 0
        ? (newest.close / oldest.close - 1)
        : 0;

      const reasons: string[] = [];
      reasons.push(`avgVol=${Math.round(avgVolume).toLocaleString()}`);
      if (avgSpreadBps > 0) reasons.push(`spread=${avgSpreadBps.toFixed(1)}bps`);
      reasons.push(`rs=${(relativeStrength * 100).toFixed(1)}%`);

      entries.push({
        symbol,
        exchange,
        avgVolume,
        spreadBps: avgSpreadBps,
        relativeStrength,
        reason: reasons.join(', '),
      });
    }

    let filtered = entries;

    if (criteria.sectors && criteria.sectors.length > 0) {
      const sectorSet = new Set(criteria.sectors.map(s => s.toUpperCase()));
      filtered = filtered.filter(e => e.sector && sectorSet.has(e.sector.toUpperCase()));
    }

    if (criteria.excludeSectors && criteria.excludeSectors.length > 0) {
      const excludeSet = new Set(criteria.excludeSectors.map(s => s.toUpperCase()));
      filtered = filtered.filter(e => !e.sector || !excludeSet.has(e.sector.toUpperCase()));
    }

    if (criteria.momentumFilter && criteria.momentumN) {
      filtered.sort((a, b) => b.relativeStrength - a.relativeStrength);
      if (criteria.momentumFilter === 'TOP_N') {
        filtered = filtered.slice(0, criteria.momentumN);
      } else {
        filtered = filtered.slice(-criteria.momentumN);
      }
    }

    log.info({
      exchange,
      totalSymbols: barsBySymbol.size,
      passedFilter: filtered.length,
    }, 'Universe selection complete');

    return filtered;
  }

  async refreshUniverse(userId: string, criteria: UniverseCriteria): Promise<UniverseEntry[]> {
    const selected = await this.select(criteria);

    await this.prisma.$transaction(async (tx) => {
      await tx.tradingUniverse.deleteMany({ where: { userId } });

      if (selected.length > 0) {
        await tx.tradingUniverse.createMany({
          data: selected.map(entry => ({
            userId,
            symbol: entry.symbol,
            exchange: entry.exchange,
            sector: entry.sector ?? null,
            reason: entry.reason,
            avgVolume: entry.avgVolume,
            addedAt: new Date(),
          })),
        });
      }
    });

    log.info({ userId, count: selected.length }, 'Trading universe refreshed');
    return selected;
  }

  async getUserUniverse(userId: string): Promise<UniverseEntry[]> {
    const records = await this.prisma.tradingUniverse.findMany({
      where: { userId },
      orderBy: { addedAt: 'desc' },
    });

    return records.map(r => ({
      symbol: r.symbol,
      exchange: r.exchange,
      sector: r.sector ?? undefined,
      avgVolume: r.avgVolume ? Number(r.avgVolume) : 0,
      spreadBps: 0,
      relativeStrength: 0,
      reason: r.reason ?? '',
    }));
  }
}
