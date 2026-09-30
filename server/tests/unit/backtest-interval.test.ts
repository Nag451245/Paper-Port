import { describe, it, expect, vi, beforeEach } from 'vitest';

const engineBacktest = vi.fn();
vi.mock('../../src/lib/rust-engine.js', () => ({
  isEngineAvailable: () => true,
  engineBacktest: (data: unknown) => engineBacktest(data),
}));

import { BacktestService, BacktestError } from '../../src/services/backtest.service.js';
import { MarketDataService } from '../../src/services/market-data.service.js';

const prisma = { backtestResult: { create: vi.fn(({ data }: any) => Promise.resolve(data)) } } as any;
const bars = (n: number) => Array.from({ length: n }, (_, i) => ({
  timestamp: `2025-02-03 ${String(9 + Math.floor((15 + i * 5) / 60)).padStart(2, '0')}:${String((15 + i * 5) % 60).padStart(2, '0')}:00`,
  open: 100, high: 101, low: 99, close: 100 + i * 0.1, volume: 1000,
}));

const input = {
  strategyId: 'momentum', symbol: 'RELIANCE', startDate: '2025-02-01', endDate: '2025-02-05',
  initialCapital: 100000, parameters: {},
};

describe('BacktestService interval and contracts', () => {
  let getHistory: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    engineBacktest.mockReset().mockResolvedValue({ trade_log: [], equity_curve: [] });
    getHistory = vi.spyOn(MarketDataService.prototype, 'getHistory').mockResolvedValue(bars(40));
  });

  it('defaults to daily candles', async () => {
    await new BacktestService(prisma).run('u1', input);
    expect(getHistory.mock.calls[0][1]).toBe('1day');
    expect(engineBacktest.mock.calls[0][0].bars_per_day).toBe(1);
  });

  it('runs on 5-minute candles and tells the engine there are 75 a day', async () => {
    const result: any = await new BacktestService(prisma).run('u1', { ...input, interval: '5minute' });
    expect(getHistory.mock.calls[0][1]).toBe('5minute');
    expect(engineBacktest.mock.calls[0][0].bars_per_day).toBe(75);
    expect(JSON.parse(result.strategyParams).interval).toBe('5minute');
  });

  it('explains that contract history needs Breeze when none comes back', async () => {
    getHistory.mockResolvedValue([]);
    const run = new BacktestService(prisma).run('u1', { ...input, symbol: 'NIFTY2025022724000CE' });
    await expect(run).rejects.toBeInstanceOf(BacktestError);
    await expect(run).rejects.toThrow(/only from ICICI Breeze/);
  });

  it('explains the intraday limit when no 5-minute history comes back', async () => {
    getHistory.mockResolvedValue([]);
    await expect(new BacktestService(prisma).run('u1', { ...input, interval: '5minute' }))
      .rejects.toThrow(/Intraday history comes from ICICI Breeze/);
  });
});
