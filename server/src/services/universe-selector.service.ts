import type { PrismaClient } from '@prisma/client';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('UniverseSelector');

const SECTOR_MAP: Record<string, string> = {
  RELIANCE: 'Energy', ONGC: 'Energy', BPCL: 'Energy', IOC: 'Energy', GAIL: 'Energy',
  TCS: 'IT', INFY: 'IT', WIPRO: 'IT', HCLTECH: 'IT', TECHM: 'IT', LTIM: 'IT',
  HDFCBANK: 'Banking', ICICIBANK: 'Banking', SBIN: 'Banking', KOTAKBANK: 'Banking', AXISBANK: 'Banking',
  BANKBARODA: 'Banking', PNB: 'Banking', INDUSINDBK: 'Banking',
  HINDUNILVR: 'FMCG', ITC: 'FMCG', NESTLEIND: 'FMCG', BRITANNIA: 'FMCG', DABUR: 'FMCG',
  MARICO: 'FMCG', TATACONSUM: 'FMCG',
  SUNPHARMA: 'Pharma', DRREDDY: 'Pharma', CIPLA: 'Pharma', DIVISLAB: 'Pharma', APOLLOHOSP: 'Pharma',
  TATAMOTORS: 'Auto', MARUTI: 'Auto', M_M: 'Auto', BAJAJ_AUTO: 'Auto', HEROMOTOCO: 'Auto', EICHERMOT: 'Auto',
  TATASTEEL: 'Metals', JSWSTEEL: 'Metals', HINDALCO: 'Metals', VEDL: 'Metals', COALINDIA: 'Metals',
  LT: 'Infra', ADANIENT: 'Infra', ADANIPORTS: 'Infra', ULTRACEMCO: 'Infra', GRASIM: 'Infra',
  NTPC: 'Power', POWERGRID: 'Power', TATAPOWER: 'Power', NHPC: 'Power',
  BAJFINANCE: 'Finance', BAJAJFINSV: 'Finance', SBILIFE: 'Finance', HDFCLIFE: 'Finance',
  TITAN: 'Consumer', ASIANPAINT: 'Consumer', PIDILITIND: 'Consumer',
  BHARTIARTL: 'Telecom', INDIGO: 'Aviation', DLF: 'Realty',
};

const NIFTY_50 = [
  'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'HINDUNILVR', 'SBIN', 'BHARTIARTL',
  'KOTAKBANK', 'ITC', 'LT', 'AXISBANK', 'BAJFINANCE', 'TATAMOTORS', 'MARUTI', 'SUNPHARMA',
  'TITAN', 'NTPC', 'WIPRO', 'ASIANPAINT', 'HCLTECH', 'ULTRACEMCO', 'POWERGRID', 'NESTLEIND',
  'TATASTEEL', 'JSWSTEEL', 'ADANIENT', 'ADANIPORTS', 'BAJAJFINSV', 'GRASIM', 'TECHM',
  'DRREDDY', 'CIPLA', 'BRITANNIA', 'HINDALCO', 'M_M', 'EICHERMOT', 'DIVISLAB', 'COALINDIA',
  'TATACONSUM', 'HEROMOTOCO', 'SBILIFE', 'HDFCLIFE', 'INDUSINDBK', 'APOLLOHOSP',
  'BAJAJ_AUTO', 'ONGC', 'BPCL', 'TATAPOWER', 'PIDILITIND',
];

interface UniverseConfig {
  maxPerSector: number;
  minAvgDailyVolume: number;
  maxSymbols: number;
}

const DEFAULT_CONFIG: UniverseConfig = {
  maxPerSector: 5,
  minAvgDailyVolume: 100_000,
  maxSymbols: 30,
};

export class UniverseSelectorService {
  constructor(private prisma: PrismaClient) {}

  async refreshUniverse(userId: string, config?: Partial<UniverseConfig>): Promise<{
    added: string[];
    removed: string[];
    total: number;
  }> {
    const cfg = { ...DEFAULT_CONFIG, ...config };

    // Start from NIFTY 50 as the base liquid universe
    const candidates = NIFTY_50.map(symbol => ({
      symbol,
      sector: SECTOR_MAP[symbol] ?? 'Other',
      avgVolume: 500_000,
    }));

    // Diversify by sector
    const sectorCounts: Record<string, number> = {};
    const selected: typeof candidates = [];

    for (const c of candidates) {
      const count = sectorCounts[c.sector] ?? 0;
      if (count >= cfg.maxPerSector) continue;
      if (c.avgVolume < cfg.minAvgDailyVolume) continue;
      sectorCounts[c.sector] = count + 1;
      selected.push(c);
      if (selected.length >= cfg.maxSymbols) break;
    }

    // Get current universe
    const existing = await this.prisma.tradingUniverse.findMany({
      where: { userId },
      select: { symbol: true },
    });
    const existingSymbols = new Set(existing.map((e: { symbol: string }) => e.symbol));
    const newSymbols = new Set(selected.map(s => s.symbol));

    const removed: string[] = [];
    for (const sym of existingSymbols) {
      if (!newSymbols.has(sym)) {
        await this.prisma.tradingUniverse.deleteMany({ where: { userId, symbol: sym } });
        removed.push(sym);
      }
    }

    const added: string[] = [];
    for (const c of selected) {
      if (!existingSymbols.has(c.symbol)) {
        await this.prisma.tradingUniverse.create({
          data: {
            userId,
            symbol: c.symbol,
            exchange: 'NSE',
            sector: c.sector,
            reason: 'NIFTY50_liquid',
            avgVolume: c.avgVolume,
          },
        }).catch(err => log.warn({ err, symbol: c.symbol }, 'Failed to insert trading universe symbol'));
        added.push(c.symbol);
      }
    }

    log.info({ userId, added: added.length, removed: removed.length, total: selected.length }, 'Universe refreshed');

    return { added, removed, total: selected.length };
  }

  async getUniverse(userId: string): Promise<string[]> {
    const records = await this.prisma.tradingUniverse.findMany({
      where: { userId },
      select: { symbol: true },
      orderBy: { addedAt: 'asc' },
    });

    if (records.length === 0) {
      return NIFTY_50.slice(0, 20);
    }

    return records.map((r: { symbol: string }) => r.symbol);
  }
}
