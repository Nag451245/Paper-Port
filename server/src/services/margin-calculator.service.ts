import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';

const log = createChildLogger('MarginCalculator');

export interface MarginParams {
  symbol: string;
  qty: number;
  price: number;
  side: 'BUY' | 'SELL';
  segment: 'EQ' | 'FO' | 'CD';
  exchange?: string;
  delta?: number;
  underlyingPrice?: number;
}

export interface MarginBreakdown {
  varMargin: number;
  elmMargin: number;
  spanMargin: number;
  totalRequired: number;
  utilizationPct: number;
}

export interface PeakMarginInfo {
  peakUtilizationPct: number;
  currentMarginUsed: number;
  availableMargin: number;
  snapshotAt: Date;
}

export interface MarginSufficiency {
  sufficient: boolean;
  shortfall: number;
  utilizationPct: number;
}

type SymbolGroup = 'I' | 'II' | 'III';

const GROUP_VAR_RATES: Record<SymbolGroup, number> = {
  I: 0.105,
  II: 0.165,
  III: 0.265,
};

const DEFAULT_SPAN_PCT = 0.15;
const ELM_RATE_EQ = 0.035;
const ELM_RATE_FO = 0.02;

export class MarginCalculatorService {
  private prisma: PrismaClient;
  private symbolGroupOverrides: Map<string, SymbolGroup> = new Map();
  private varRateOverrides: Map<string, number> = new Map();
  private spanPct: number = DEFAULT_SPAN_PCT;

  constructor(prisma?: PrismaClient) {
    this.prisma = prisma ?? getPrisma();
    this.seedDefaultGroups();
  }

  private seedDefaultGroups(): void {
    const groupI = [
      'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
      'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK',
      'LT', 'AXISBANK', 'BAJFINANCE', 'MARUTI', 'TATAMOTORS',
      'SUNPHARMA', 'TITAN', 'ASIANPAINT', 'NTPC', 'POWERGRID',
    ];
    const groupIII = [
      'YESBANK', 'SUZLON', 'RPOWER', 'IRFC', 'IDEA',
      'PNB', 'JPASSOCIAT', 'SAIL', 'NHPC', 'IDFCFIRSTB',
    ];

    for (const sym of groupI) this.symbolGroupOverrides.set(sym, 'I');
    for (const sym of groupIII) this.symbolGroupOverrides.set(sym, 'III');
  }

  setSymbolGroup(symbol: string, group: SymbolGroup): void {
    this.symbolGroupOverrides.set(symbol, group);
  }

  setVarRateOverride(symbol: string, rate: number): void {
    this.varRateOverrides.set(symbol, rate);
  }

  setSpanPct(pct: number): void {
    this.spanPct = pct;
  }

  private getVarRate(symbol: string): number {
    const override = this.varRateOverrides.get(symbol);
    if (override !== undefined) return override;

    const group = this.symbolGroupOverrides.get(symbol) ?? 'II';
    return GROUP_VAR_RATES[group];
  }

  private getElmRate(segment: 'EQ' | 'FO' | 'CD'): number {
    return segment === 'FO' ? ELM_RATE_FO : ELM_RATE_EQ;
  }

  calculateMarginRequired(params: MarginParams): MarginBreakdown {
    const { symbol, qty, price, segment } = params;
    const notional = qty * price;

    const varRate = this.getVarRate(symbol);
    const varMargin = notional * varRate;

    const elmRate = this.getElmRate(segment);
    const elmMargin = notional * elmRate;

    let spanMargin = 0;
    if (segment === 'FO') {
      const delta = params.delta ?? 1;
      const underlying = params.underlyingPrice ?? price;
      spanMargin = Math.abs(delta) * underlying * qty * this.spanPct;
    }

    const totalRequired = varMargin + elmMargin + spanMargin;
    const utilizationPct = 0;

    log.debug({ symbol, segment, varMargin, elmMargin, spanMargin, totalRequired }, 'margin calculated');

    return {
      varMargin: round(varMargin),
      elmMargin: round(elmMargin),
      spanMargin: round(spanMargin),
      totalRequired: round(totalRequired),
      utilizationPct,
    };
  }

  async getPeakMarginUtilization(userId: string): Promise<PeakMarginInfo> {
    const todayStart = startOfDay(new Date());

    const peak = await this.prisma.marginRecord.findFirst({
      where: {
        userId,
        snapshotAt: { gte: todayStart },
      },
      orderBy: { peakUtilPct: 'desc' },
    });

    if (!peak) {
      return {
        peakUtilizationPct: 0,
        currentMarginUsed: 0,
        availableMargin: 0,
        snapshotAt: new Date(),
      };
    }

    const allSnapshots = await this.prisma.marginRecord.findMany({
      where: {
        userId,
        snapshotAt: { gte: todayStart },
      },
      orderBy: { snapshotAt: 'desc' },
      take: 1,
    });

    const latest = allSnapshots[0];
    const currentUsed = latest?.totalRequired ?? 0;

    return {
      peakUtilizationPct: peak.peakUtilPct,
      currentMarginUsed: currentUsed,
      availableMargin: 0,
      snapshotAt: peak.snapshotAt,
    };
  }

  async recordMarginSnapshot(
    userId: string,
    symbol: string,
    margin: MarginBreakdown,
    exchange: string = 'NSE',
    segment: 'EQ' | 'FO' | 'CD' = 'EQ',
  ): Promise<void> {
    await this.prisma.marginRecord.create({
      data: {
        userId,
        symbol,
        exchange,
        segment,
        varMargin: margin.varMargin,
        elmMargin: margin.elmMargin,
        spanMargin: margin.spanMargin,
        totalRequired: margin.totalRequired,
        peakUtilPct: margin.utilizationPct,
        snapshotAt: new Date(),
      },
    });

    log.info({ userId, symbol, totalRequired: margin.totalRequired }, 'margin snapshot recorded');
  }

  checkMarginSufficiency(
    userId: string,
    requiredMargin: number,
    availableCapital: number,
  ): MarginSufficiency {
    const utilizationPct = availableCapital > 0
      ? (requiredMargin / availableCapital) * 100
      : 100;

    const shortfall = Math.max(0, requiredMargin - availableCapital);
    const sufficient = requiredMargin <= availableCapital;

    if (!sufficient) {
      log.warn(
        { userId, requiredMargin, availableCapital, shortfall },
        'margin insufficient',
      );
    }

    return {
      sufficient,
      shortfall: round(shortfall),
      utilizationPct: round(utilizationPct),
    };
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function startOfDay(d: Date): Date {
  const s = new Date(d);
  s.setHours(0, 0, 0, 0);
  return s;
}
