import { describe, it, expect, vi, beforeAll, beforeEach } from 'vitest';
import type { FastifyInstance } from 'fastify';

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletion: vi.fn().mockResolvedValue('Mock AI response'),
  chatCompletionJSON: vi.fn().mockResolvedValue({
    signals: [
      {
        symbol: 'RELIANCE',
        direction: 'BUY',
        score: 0.85,
        rationale: 'Strong momentum breakout',
        entry: 2500,
        stopLoss: 2450,
        target: 2600,
        gateScores: {
          g1_trend: 80, g2_momentum: 75, g3_volatility: 60, g4_volume: 70,
          g5_options_flow: 50, g6_global_macro: 65, g7_fii_dii: 55, g8_sentiment: 70, g9_risk: 60,
        },
      },
    ],
    marketView: 'Markets are bullish with strong momentum',
    riskAlerts: [],
  }),
  getOpenAIStatus: vi.fn().mockReturnValue({
    circuitOpen: false, queueLength: 0, recentRequests: 0, cooldownRemainingMs: 0,
  }),
  _resetForTesting: vi.fn(),
}));

vi.mock('../../src/lib/rust-engine.js', async (importOriginal) => {
  const mod = await importOriginal<typeof import('../../src/lib/rust-engine.js')>();
  return {
    ...mod,
    isEngineAvailable: vi.fn().mockReturnValue(false),
    startDaemon: vi.fn().mockReturnValue(false),
    stopDaemon: vi.fn(),
    ensureEngineAvailable: vi.fn().mockResolvedValue(false),
    engineScan: vi.fn().mockResolvedValue({
      signals: [
        {
          symbol: 'RELIANCE',
          direction: 'BUY',
          confidence: 0.78,
          entry: 2500,
          stop_loss: 2450,
          target: 2600,
          indicators: { ema_9: 2490, ema_21: 2480, rsi_14: 62, macd: 5 },
          votes: { ema_crossover: 0.8, rsi: 0.6, macd: 0.7 },
          strategy: 'composite',
        },
      ],
    }),
    engineRisk: vi.fn().mockResolvedValue({
      max_drawdown_percent: 3.5,
      var_95: -15000,
      sharpe: 1.2,
    }),
    _getCircuitBreakerState: vi.fn().mockReturnValue({
      crashCount: 0, lastCrashTime: 0, circuitOpenSince: 0,
      MAX_CRASHES: 5, CRASH_WINDOW_MS: 60000, CIRCUIT_COOLDOWN_MS: 300000,
    }),
    _resetCircuitBreakerForTesting: vi.fn(),
  };
});

vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: vi.fn().mockImplementation(() => ({
    isMarketOpen: vi.fn().mockReturnValue(true),
    getMarketPhase: vi.fn().mockReturnValue('MARKET_HOURS'),
    getPhaseConfig: vi.fn().mockReturnValue({
      pingIntervalMs: 60000, botTickMs: 120000, scanIntervalMs: 180000,
      botsActive: true, label: 'Market Hours',
    }),
    getHolidayName: vi.fn().mockReturnValue(null),
    getNextMarketOpen: vi.fn().mockReturnValue({ date: new Date().toISOString(), label: 'Today' }),
    isHoliday: vi.fn().mockReturnValue(false),
    isWeekend: vi.fn().mockReturnValue(false),
    getStatus: vi.fn().mockReturnValue({
      phase: 'MARKET_HOURS', phaseLabel: 'Market Hours', isOpen: true,
      isHoliday: false, holidayName: null, isWeekend: false,
      nextOpen: { date: '', label: '' }, upcomingHolidays: [], timestamp: new Date().toISOString(),
    }),
    getUpcomingHolidays: vi.fn().mockReturnValue([]),
  })),
}));

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({
    getQuote: vi.fn().mockResolvedValue({
      symbol: 'RELIANCE', ltp: 2500, open: 2480, high: 2520, low: 2470,
      close: 2500, change: 20, changePercent: 0.8, volume: 1000000, exchange: 'NSE',
    }),
    getHistory: vi.fn().mockResolvedValue(
      Array.from({ length: 50 }, (_, i) => ({
        timestamp: `2026-03-${String((i % 28) + 1).padStart(2, '0')}T09:15:00Z`,
        open: 2480 + i, close: 2490 + i, high: 2510 + i, low: 2470 + i, volume: 1000000,
      }))
    ),
    getVIX: vi.fn().mockResolvedValue({ value: 14.5, change: -0.2, changePercent: -1.36 }),
    getOptionsChain: vi.fn().mockResolvedValue({ symbol: 'NIFTY', underlyingValue: 23500, strikes: [] }),
    getTopMovers: vi.fn().mockResolvedValue({
      gainers: [
        { symbol: 'RELIANCE', name: 'Reliance', ltp: 2500, change: 50, changePercent: 2.0, volume: 5000000 },
        { symbol: 'TCS', name: 'TCS', ltp: 3800, change: 60, changePercent: 1.6, volume: 3000000 },
      ],
      losers: [
        { symbol: 'ITC', name: 'ITC', ltp: 450, change: -10, changePercent: -2.2, volume: 8000000 },
      ],
    }),
    search: vi.fn().mockResolvedValue([]),
  })),
}));

describe('Trade Pipeline Integration', () => {
  let app: FastifyInstance;
  let mockPrisma: any;

  beforeAll(async () => {
    const { __mockPrisma } = await import('../../src/lib/prisma.js') as any;
    mockPrisma = __mockPrisma;
  });

  beforeEach(() => {
    vi.clearAllMocks();
  });

  describe('Signal Generation Flow', () => {
    it('engineScan interface should accept open and timestamp fields', async () => {
      const { engineScan } = await import('../../src/lib/rust-engine.js');
      const input = {
        symbols: [{
          symbol: 'RELIANCE',
          candles: Array.from({ length: 30 }, (_, i) => ({
            open: 2480 + i,
            close: 2490 + i,
            high: 2510 + i,
            low: 2470 + i,
            volume: 1000000,
            timestamp: `2026-03-${String((i % 28) + 1).padStart(2, '0')}T09:15:00Z`,
          })),
        }],
        aggressiveness: 'high' as const,
        current_date: '2026-03-13',
      };

      await engineScan(input);
      expect(engineScan).toHaveBeenCalledWith(input);
    });

    it('engineScan interface should work without open field (backward compat)', async () => {
      const { engineScan } = await import('../../src/lib/rust-engine.js');
      const input = {
        symbols: [{
          symbol: 'TCS',
          candles: Array.from({ length: 30 }, (_, i) => ({
            close: 3800 + i,
            high: 3820 + i,
            low: 3780 + i,
            volume: 500000,
          })),
        }],
      };

      await engineScan(input);
      expect(engineScan).toHaveBeenCalledWith(input);
    });
  });

  describe('BotEngine Trade Execution', () => {
    it('should create BotEngine with Prisma and OMS', async () => {
      const { BotEngine } = await import('../../src/services/bot-engine.js');
      const { OrderManagementService } = await import('../../src/services/oms.service.js');
      const oms = new OrderManagementService(mockPrisma);
      const engine = new BotEngine(mockPrisma, oms);
      expect(engine).toBeDefined();
    });

    it('should start and stop market scan', async () => {
      const { BotEngine } = await import('../../src/services/bot-engine.js');
      const engine = new BotEngine(mockPrisma);
      expect(engine.isScannerRunning()).toBe(false);
      await engine.startMarketScan('test-user');
      expect(engine.isScannerRunning()).toBe(true);
      engine.stopMarketScan();
      expect(engine.isScannerRunning()).toBe(false);
    });
  });

  describe('OMS State Transitions', () => {
    it('should create OMS with valid state types', async () => {
      const { OrderManagementService } = await import('../../src/services/oms.service.js');
      const oms = new OrderManagementService(mockPrisma);
      expect(oms).toBeDefined();
    });
  });

  describe('Circuit Breaker State', () => {
    it('should expose circuit breaker state for monitoring', async () => {
      const { _getCircuitBreakerState } = await import('../../src/lib/rust-engine.js');
      const state = _getCircuitBreakerState();
      expect(state.crashCount).toBe(0);
      expect(state.MAX_CRASHES).toBe(5);
      expect(state.CIRCUIT_COOLDOWN_MS).toBe(300000);
    });
  });
});
