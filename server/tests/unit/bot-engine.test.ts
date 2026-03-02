import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotEngine } from '../../src/services/bot-engine.js';

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletionJSON: vi.fn().mockResolvedValue({
    message: 'NIFTY bearish trend, buy PE 23400.',
    messageType: 'signal',
    action: 'Recommended Bear Put Spread',
    signals: [
      {
        symbol: 'NIFTY',
        direction: 'BUY_PE',
        confidence: 0.82,
        reason: 'PCR dropping below 0.8, VIX rising',
        strategy: 'Bear Put Spread',
        legs: [
          { type: 'PE', strike: 23400, action: 'BUY', qty: 1 },
          { type: 'PE', strike: 23200, action: 'SELL', qty: 1 },
        ],
      },
    ],
  }),
  chatCompletion: vi.fn().mockResolvedValue('Mock response'),
  getOpenAIStatus: vi.fn().mockReturnValue({ circuitOpen: false, queueLength: 0, recentRequests: 0, cooldownRemainingMs: 0 }),
  _resetForTesting: vi.fn(),
}));

vi.mock('../../src/lib/rust-engine.js', () => ({
  isEngineAvailable: vi.fn().mockReturnValue(false),
  engineScan: vi.fn(),
  engineRisk: vi.fn(),
}));

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({
    getQuote: vi.fn().mockResolvedValue({ symbol: 'RELIANCE', ltp: 2500, open: 2480, high: 2520, low: 2470, close: 2500, volume: 1000000, exchange: 'NSE' }),
    getHistory: vi.fn().mockResolvedValue([]),
    getVIX: vi.fn().mockResolvedValue({ value: 14.5, change: -0.2, changePercent: -1.36 }),
    getOptionsChain: vi.fn().mockResolvedValue({
      symbol: 'NIFTY',
      underlyingValue: 23500,
      strikes: [
        { strike: 23000, callOI: 5000000, callLTP: 520, callIV: 18, putOI: 3000000, putLTP: 30, putIV: 16 },
        { strike: 23200, callOI: 4000000, callLTP: 340, callIV: 17, putOI: 4000000, putLTP: 55, putIV: 17 },
        { strike: 23400, callOI: 3000000, callLTP: 190, callIV: 16, putOI: 6000000, putLTP: 100, putIV: 18 },
        { strike: 23500, callOI: 8000000, callLTP: 130, callIV: 15, putOI: 7000000, putLTP: 140, putIV: 15 },
        { strike: 23600, callOI: 6000000, callLTP: 80, callIV: 16, putOI: 4500000, putLTP: 200, putIV: 17 },
        { strike: 23800, callOI: 7000000, callLTP: 30, callIV: 18, putOI: 2000000, putLTP: 340, putIV: 19 },
        { strike: 24000, callOI: 9000000, callLTP: 10, callIV: 20, putOI: 1000000, putLTP: 520, putIV: 22 },
      ],
    }),
    getTopMovers: vi.fn().mockResolvedValue({ gainers: [], losers: [] }),
    search: vi.fn().mockResolvedValue([]),
  })),
}));

function createMockPrisma() {
  return {
    tradingBot: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      create: vi.fn(),
      update: vi.fn(),
      delete: vi.fn(),
    },
    botMessage: { create: vi.fn(), findMany: vi.fn() },
    botTask: { create: vi.fn(), findMany: vi.fn() },
    aIAgentConfig: { findUnique: vi.fn(), create: vi.fn(), upsert: vi.fn() },
    aITradeSignal: { findUnique: vi.fn(), findMany: vi.fn(), count: vi.fn(), update: vi.fn(), create: vi.fn() },
    portfolio: { findFirst: vi.fn(), findUnique: vi.fn(), findMany: vi.fn(), update: vi.fn() },
    position: { findFirst: vi.fn(), findMany: vi.fn(), create: vi.fn(), update: vi.fn() },
    order: { create: vi.fn(), update: vi.fn() },
    trade: { create: vi.fn(), findMany: vi.fn() },
    $disconnect: vi.fn(),
  } as any;
}

describe('BotEngine', () => {
  let engine: BotEngine;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    vi.clearAllMocks();
    mockPrisma = createMockPrisma();
    engine = new BotEngine(mockPrisma);
  });

  describe('bot lifecycle', () => {
    it('should start and track a bot', async () => {
      expect(engine.getRunningBotCount()).toBe(0);
      mockPrisma.tradingBot.findUnique.mockResolvedValue({
        id: 'b1', userId: 'u1', status: 'RUNNING', role: 'SCANNER',
        assignedSymbols: 'RELIANCE', name: 'Test Bot',
      });

      await engine.startBot('b1', 'u1');
      expect(engine.getRunningBotCount()).toBe(1);
    });

    it('should stop a running bot', async () => {
      mockPrisma.tradingBot.findUnique.mockResolvedValue({
        id: 'b1', userId: 'u1', status: 'RUNNING', role: 'SCANNER',
        assignedSymbols: 'RELIANCE', name: 'Test Bot',
      });

      await engine.startBot('b1', 'u1');
      engine.stopBot('b1');
      expect(engine.getRunningBotCount()).toBe(0);
    });

    it('should enforce MAX_CONCURRENT_BOTS limit', async () => {
      for (let i = 0; i < 6; i++) {
        mockPrisma.tradingBot.findUnique.mockResolvedValue({
          id: `b${i}`, userId: 'u1', status: 'RUNNING', role: 'SCANNER',
          assignedSymbols: 'RELIANCE', name: `Bot ${i}`,
        });
        await engine.startBot(`b${i}`, 'u1');
      }
      expect(engine.getRunningBotCount()).toBeLessThanOrEqual(5);
    });

    it('should stop all bots', async () => {
      for (let i = 0; i < 3; i++) {
        await engine.startBot(`b${i}`, 'u1');
      }
      engine.stopAll();
      expect(engine.getRunningBotCount()).toBe(0);
    });
  });

  describe('FNO_STRATEGIST bot role', () => {
    it('should export BotEngine class with proper structure', async () => {
      const botModule = await import('../../src/services/bot-engine.js');
      expect(botModule.BotEngine).toBeDefined();
      const instance = new botModule.BotEngine(mockPrisma);
      expect(instance).toBeDefined();
      expect(typeof instance.startBot).toBe('function');
      expect(typeof instance.stopBot).toBe('function');
      expect(typeof instance.startMarketScan).toBe('function');
      expect(typeof instance.stopMarketScan).toBe('function');
      expect(typeof instance.getLastScanResult).toBe('function');
    });
  });

  describe('market scanner', () => {
    it('should return null when no scan has run', () => {
      expect(engine.getLastScanResult()).toBeNull();
    });

    it('should report scanner not running initially', () => {
      expect(engine.isScannerRunning()).toBe(false);
    });
  });

  describe('agent lifecycle', () => {
    it('should start and stop an agent', async () => {
      await engine.startAgent('u1');
      engine.stopAgent('u1');
    });
  });
});
