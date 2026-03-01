import { describe, it, expect, vi, beforeEach } from 'vitest';
import { AIAgentService, AIAgentError } from '../../src/services/ai-agent.service.js';

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletion: vi.fn().mockResolvedValue('Mock response'),
  chatCompletionJSON: vi.fn().mockResolvedValue({
    date: '2025-06-01', stance: 'bullish', keyPoints: ['Mock point'],
    globalCues: [], sectorOutlook: {}, supportLevels: [], resistanceLevels: [], keyEvents: [],
  }),
}));

function createMockPrisma() {
  return {
    aIAgentConfig: {
      findUnique: vi.fn(),
      create: vi.fn(),
      upsert: vi.fn(),
    },
    aITradeSignal: {
      findUnique: vi.fn(),
      findMany: vi.fn(),
      count: vi.fn(),
      update: vi.fn(),
    },
    portfolio: { findMany: vi.fn(), findFirst: vi.fn() },
    trade: { findMany: vi.fn() },
  } as any;
}

describe('AIAgentService', () => {
  let service: AIAgentService;
  let mockPrisma: ReturnType<typeof createMockPrisma>;

  beforeEach(() => {
    mockPrisma = createMockPrisma();
    service = new AIAgentService(mockPrisma);
  });

  describe('getConfig', () => {
    it('should return existing config', async () => {
      const config = { id: 'cfg1', userId: 'u1', mode: 'ADVISORY', isActive: false };
      mockPrisma.aIAgentConfig.findUnique.mockResolvedValue(config);

      const result = await service.getConfig('u1');
      expect(result).toEqual(config);
    });

    it('should create default config if none exists', async () => {
      mockPrisma.aIAgentConfig.findUnique.mockResolvedValue(null);
      mockPrisma.aIAgentConfig.create.mockResolvedValue({
        id: 'cfg-new', userId: 'u1', mode: 'ADVISORY', isActive: false,
      });

      const result = await service.getConfig('u1');
      expect(result.mode).toBe('ADVISORY');
      expect(result.isActive).toBe(false);
    });
  });

  describe('updateConfig', () => {
    it('should update config fields', async () => {
      mockPrisma.aIAgentConfig.upsert.mockResolvedValue({
        userId: 'u1', mode: 'SIGNAL', isActive: true,
      });

      const result = await service.updateConfig('u1', { mode: 'SIGNAL', isActive: true });
      expect(result.mode).toBe('SIGNAL');
    });
  });

  describe('startAgent / stopAgent', () => {
    it('should start agent', async () => {
      mockPrisma.aIAgentConfig.upsert.mockResolvedValue({});
      const result = await service.startAgent('u1');
      expect(result.status).toBe('running');
    });

    it('should stop agent', async () => {
      mockPrisma.aIAgentConfig.upsert.mockResolvedValue({});
      const result = await service.stopAgent('u1');
      expect(result.status).toBe('stopped');
    });
  });

  describe('getStatus', () => {
    it('should return agent status with signal counts', async () => {
      mockPrisma.aIAgentConfig.findUnique.mockResolvedValue({
        id: 'cfg1', userId: 'u1', mode: 'ADVISORY', isActive: true, updatedAt: new Date(),
      });
      mockPrisma.aIAgentConfig.create.mockResolvedValue(null);
      mockPrisma.aITradeSignal.count
        .mockResolvedValueOnce(5)
        .mockResolvedValueOnce(2);

      const result = await service.getStatus('u1');
      expect(result.isActive).toBe(true);
      expect(result.todaySignals).toBe(5);
      expect(result.todayTrades).toBe(2);
    });
  });

  describe('listSignals', () => {
    it('should return paginated signals', async () => {
      mockPrisma.aITradeSignal.findMany.mockResolvedValue([
        { id: 's1', symbol: 'RELIANCE', status: 'PENDING' },
      ]);
      mockPrisma.aITradeSignal.count.mockResolvedValue(1);

      const result = await service.listSignals('u1');
      expect(result.signals).toHaveLength(1);
      expect(result.total).toBe(1);
    });
  });

  describe('getSignal', () => {
    it('should return signal if owned by user', async () => {
      mockPrisma.aITradeSignal.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', symbol: 'RELIANCE',
      });

      const result = await service.getSignal('s1', 'u1');
      expect(result.symbol).toBe('RELIANCE');
    });

    it('should throw 404 for non-existent signal', async () => {
      mockPrisma.aITradeSignal.findUnique.mockResolvedValue(null);
      await expect(service.getSignal('nonexistent', 'u1')).rejects.toThrow(AIAgentError);
    });

    it('should throw 404 for signal owned by another user', async () => {
      mockPrisma.aITradeSignal.findUnique.mockResolvedValue({
        id: 's1', userId: 'other-user',
      });
      await expect(service.getSignal('s1', 'u1')).rejects.toMatchObject({ statusCode: 404 });
    });
  });

  describe('executeSignal', () => {
    it('should execute pending signal', async () => {
      mockPrisma.aITradeSignal.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', status: 'PENDING',
      });
      mockPrisma.portfolio.findFirst.mockResolvedValue({
        id: 'p1', userId: 'u1', currentNav: 1000000,
      });
      mockPrisma.aITradeSignal.update.mockResolvedValue({
        id: 's1', status: 'EXECUTED', executedAt: new Date(),
      });

      const result = await service.executeSignal('s1', 'u1');
      expect(result.status).toBe('EXECUTED');
    });

    it('should throw 400 for non-pending signal', async () => {
      mockPrisma.aITradeSignal.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', status: 'EXECUTED',
      });

      await expect(service.executeSignal('s1', 'u1')).rejects.toMatchObject({ statusCode: 400 });
    });
  });

  describe('rejectSignal', () => {
    it('should reject pending signal', async () => {
      mockPrisma.aITradeSignal.findUnique.mockResolvedValue({
        id: 's1', userId: 'u1', status: 'PENDING',
      });
      mockPrisma.aITradeSignal.update.mockResolvedValue({ id: 's1', status: 'REJECTED' });

      const result = await service.rejectSignal('s1', 'u1');
      expect(result.status).toBe('REJECTED');
    });
  });

  describe('getPreMarketBriefing', () => {
    it('should return briefing from OpenAI', async () => {
      const result = await service.getPreMarketBriefing('u1');
      expect(result.stance).toBe('bullish');
      expect(result.keyPoints).toBeDefined();
    });
  });

  describe('getPostTradeBriefing', () => {
    it('should return empty briefing when no trades', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.trade.findMany.mockResolvedValue([]);

      const result = await service.getPostTradeBriefing('u1');
      expect(result.summary).toBe('No trades executed today');
    });

    it('should summarize trades when available', async () => {
      mockPrisma.portfolio.findMany.mockResolvedValue([{ id: 'p1' }]);
      mockPrisma.trade.findMany.mockResolvedValue([
        { symbol: 'RELIANCE', netPnl: 5000 },
        { symbol: 'TCS', netPnl: -2000 },
      ]);

      const result = await service.getPostTradeBriefing('u1');
      expect(result.pnlSummary.tradeCount).toBe(2);
      expect(result.topWinners).toHaveLength(1);
      expect(result.topLosers).toHaveLength(1);
    });
  });

  describe('getStrategies', () => {
    it('should return list of strategies', async () => {
      const strategies = await service.getStrategies();
      expect(strategies.length).toBeGreaterThan(0);
      expect(strategies[0]).toHaveProperty('id');
      expect(strategies[0]).toHaveProperty('name');
    });
  });

  describe('getCapitalRules', () => {
    it('should return capital preservation rules', async () => {
      const rules = await service.getCapitalRules();
      expect(rules.length).toBeGreaterThan(0);
      expect(rules[0]).toHaveProperty('status');
    });
  });
});
