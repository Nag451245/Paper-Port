import { describe, it, expect, vi, beforeEach } from 'vitest';
import { ReplayService, ReplayError } from '../../src/services/replay.service.js';
import { calculateCosts } from '../../src/lib/costs.js';

const prisma = { backtestResult: { create: vi.fn(({ data }: any) => Promise.resolve(data)) } } as any;
const market = { getHistory: vi.fn(), getLotSizes: vi.fn() } as any;

describe('ReplayService', () => {
  let svc: ReplayService;

  beforeEach(() => {
    vi.clearAllMocks();
    market.getHistory.mockResolvedValue([]);
    market.getLotSizes.mockResolvedValue({ lotSizes: {}, source: 'none' });
    svc = new ReplayService(prisma, market);
  });

  describe('candles', () => {
    it('fetches through the shared history path, contract symbols included', async () => {
      await svc.candles('u1', 'NIFTY2025022724000CE', '5minute', '2025-02-01', '2025-02-27');
      expect(market.getHistory).toHaveBeenCalledWith('NIFTY2025022724000CE', '5minute', '2025-02-01', '2025-02-27', 'u1');
    });

    it('caps how long a range can be per candle size', async () => {
      await expect(svc.candles('u1', 'TCS', '1minute', '2025-01-01', '2025-02-01')).rejects.toThrow(/10 days at a time/);
      await expect(svc.candles('u1', 'TCS', '5minute', '2025-01-01', '2025-01-31')).resolves.toEqual([]);
    });

    it('refuses a contract that cannot exist and a backwards range', async () => {
      await expect(svc.candles('u1', 'NIFTY20250230FUT', '5minute', '2025-02-01', '2025-02-05')).rejects.toBeInstanceOf(ReplayError);
      await expect(svc.candles('u1', 'TCS', '5minute', '2025-02-05', '2025-02-01')).rejects.toThrow(/after the end/);
    });
  });

  describe('charges', () => {
    it('uses the F&O cost model for contracts and the equity one for stocks', () => {
      const [opt, stock] = svc.charges([
        { symbol: 'NIFTY2025022724000CE', qty: 75, price: 120, side: 'SELL' },
        { symbol: 'RELIANCE', qty: 10, price: 1200, side: 'SELL' },
      ]);
      expect(opt).toBe(calculateCosts(75, 120, 'SELL', 'NFO', 'OPTIONS').totalCost);
      expect(stock).toBe(calculateCosts(10, 1200, 'SELL', 'NSE', 'EQUITY').totalCost);
    });
  });

  describe('lot size', () => {
    it('prefers the bridge, then a labelled default, else unknown', async () => {
      market.getLotSizes.mockResolvedValueOnce({ lotSizes: { NIFTY: 75 }, source: 'bridge' });
      expect(await svc.lotSize('nifty')).toEqual({ lotSize: 75, source: 'bridge' });
      expect((await svc.lotSize('BANKNIFTY')).lotSize).toBe(30);
      expect(await svc.lotSize('TCS')).toEqual({ lotSize: null, source: 'unknown' });
    });
  });

  describe('saving a session', () => {
    it('stores it as a backtest result with the same metrics as automated runs', async () => {
      const saved: any = await svc.saveSession('u1', {
        mode: 'stock', symbol: 'TCS', interval: '5minute', from: '2025-02-03', to: '2025-02-07',
        initialCapital: 100000,
        trades: [
          { symbol: 'TCS', side: 'LONG', qty: 10, entryTime: '2025-02-03 09:20:00', exitTime: '2025-02-03 10:00:00',
            entryPrice: 4000, exitPrice: 4040, charges: 12, netPnl: 388, reason: 'TARGET' },
          { symbol: 'TCS', side: 'SHORT', qty: 10, entryTime: '2025-02-04 09:30:00', exitTime: '2025-02-04 11:00:00',
            entryPrice: 4050, exitPrice: 4070, charges: 12, netPnl: -212, reason: 'STOP' },
        ],
        equityCurve: [
          { time: '2025-02-03 09:15:00', value: 100000 },
          { time: '2025-02-03 10:00:00', value: 100388 },
          { time: '2025-02-04 11:00:00', value: 100176 },
        ],
      });
      expect(saved.strategyId).toBe('manual_replay');
      expect(saved.totalTrades).toBe(2);
      expect(saved.winRate).toBe(50);
      expect(saved.maxDrawdown).toBeGreaterThan(0);
      const log = JSON.parse(saved.tradeLog);
      expect(log[1]).toMatchObject({ side: 'SHORT', pnl: -212, reason: 'STOP', pnlPercent: -0.49 });
    });
  });
});
