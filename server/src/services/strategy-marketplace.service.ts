import type { PrismaClient } from '@prisma/client';

export interface PublishedStrategy {
  id: string;
  name: string;
  description: string;
  authorId: string;
  authorName: string;
  parameters: Record<string, unknown>;
  indicators: string[];
  backtestResults?: {
    cagr: number;
    sharpeRatio: number;
    maxDrawdown: number;
    winRate: number;
    totalTrades: number;
  };
  rating: number;
  subscriberCount: number;
  version: string;
  isPublic: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const BUILT_IN_STRATEGIES: PublishedStrategy[] = [
  {
    id: 'strategy-ema-crossover',
    name: 'EMA Crossover',
    description: 'Buy when EMA9 crosses above EMA21, sell on reverse cross. Classic trend-following strategy.',
    authorId: 'system',
    authorName: 'Capital Guard',
    parameters: { fastPeriod: 9, slowPeriod: 21, stopLossPct: 2, targetPct: 4 },
    indicators: ['EMA9', 'EMA21'],
    backtestResults: { cagr: 18.5, sharpeRatio: 1.2, maxDrawdown: 12.3, winRate: 0.55, totalTrades: 245 },
    rating: 4.2,
    subscriberCount: 1250,
    version: '1.0.0',
    isPublic: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
  },
  {
    id: 'strategy-rsi-reversal',
    name: 'RSI Mean Reversion',
    description: 'Buy when RSI < 30 (oversold), sell when RSI > 70 (overbought). Works best in range-bound markets.',
    authorId: 'system',
    authorName: 'Capital Guard',
    parameters: { period: 14, oversold: 30, overbought: 70, stopLossPct: 1.5 },
    indicators: ['RSI14'],
    backtestResults: { cagr: 14.2, sharpeRatio: 0.95, maxDrawdown: 8.5, winRate: 0.62, totalTrades: 180 },
    rating: 3.8,
    subscriberCount: 890,
    version: '1.0.0',
    isPublic: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
  },
  {
    id: 'strategy-supertrend',
    name: 'Supertrend Breakout',
    description: 'Uses Supertrend indicator for trend direction with ATR-based stop loss. Strong momentum strategy.',
    authorId: 'system',
    authorName: 'Capital Guard',
    parameters: { period: 10, multiplier: 3, atrPeriod: 14 },
    indicators: ['Supertrend', 'ATR'],
    backtestResults: { cagr: 22.1, sharpeRatio: 1.4, maxDrawdown: 15.2, winRate: 0.48, totalTrades: 310 },
    rating: 4.5,
    subscriberCount: 2100,
    version: '1.0.0',
    isPublic: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
  },
  {
    id: 'strategy-bollinger-squeeze',
    name: 'Bollinger Band Squeeze',
    description: 'Detects volatility contractions and trades the subsequent breakout direction.',
    authorId: 'system',
    authorName: 'Capital Guard',
    parameters: { period: 20, stdDev: 2, squeezePeriod: 6 },
    indicators: ['Bollinger Bands', 'Volume'],
    backtestResults: { cagr: 16.8, sharpeRatio: 1.1, maxDrawdown: 10.1, winRate: 0.52, totalTrades: 155 },
    rating: 4.0,
    subscriberCount: 720,
    version: '1.0.0',
    isPublic: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
  },
  {
    id: 'strategy-vwap-reversion',
    name: 'VWAP Reversion',
    description: 'Intraday strategy: buy below VWAP with bullish candle, sell above VWAP with bearish candle.',
    authorId: 'system',
    authorName: 'Capital Guard',
    parameters: { distancePct: 0.5, volumeMultiplier: 1.5, maxHoldMinutes: 120 },
    indicators: ['VWAP', 'Volume'],
    backtestResults: { cagr: 25.3, sharpeRatio: 1.6, maxDrawdown: 7.8, winRate: 0.58, totalTrades: 450 },
    rating: 4.7,
    subscriberCount: 3200,
    version: '1.0.0',
    isPublic: true,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-06-01'),
  },
];

export class StrategyMarketplaceService {
  constructor(private prisma: PrismaClient) {}

  async getPublicStrategies(): Promise<PublishedStrategy[]> {
    return BUILT_IN_STRATEGIES;
  }

  async getStrategyById(id: string): Promise<PublishedStrategy | null> {
    return BUILT_IN_STRATEGIES.find(s => s.id === id) ?? null;
  }

  async getTopStrategies(limit = 5): Promise<PublishedStrategy[]> {
    return [...BUILT_IN_STRATEGIES]
      .sort((a, b) => b.rating - a.rating)
      .slice(0, limit);
  }

  async searchStrategies(query: string): Promise<PublishedStrategy[]> {
    const q = query.toLowerCase();
    return BUILT_IN_STRATEGIES.filter(
      s => s.name.toLowerCase().includes(q) ||
           s.description.toLowerCase().includes(q) ||
           s.indicators.some(i => i.toLowerCase().includes(q))
    );
  }
}
