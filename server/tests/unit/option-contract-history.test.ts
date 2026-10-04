import { describe, it, expect, vi, afterEach } from 'vitest';
import { MarketDataService } from '../../src/services/market-data.service.js';
import { getUpstox } from '../../src/services/upstox.service.js';

const bar = { timestamp: '2026-09-29 09:15:00', open: 100, high: 101, low: 99, close: 100, volume: 10 };
afterEach(() => vi.restoreAllMocks());

describe('option contract history across brokers', () => {
  const args = ['NIFTY', '2026-09-29', 22400, 'CE', '2026-09-24', '2026-09-29'] as const;

  it('uses ICICI Breeze when it answers, without asking Upstox', async () => {
    const svc = new MarketDataService();
    vi.spyOn(svc, 'breezeOptionHistory').mockResolvedValue({ bars: [bar] });
    const upstox = vi.spyOn(getUpstox(), 'history');
    expect(await svc.optionContractHistory(...args)).toEqual({ bars: [bar] });
    expect(upstox).not.toHaveBeenCalled();
  });

  it('falls back to the Upstox login when ICICI is not connected', async () => {
    const svc = new MarketDataService();
    vi.spyOn(svc, 'breezeOptionHistory').mockResolvedValue({ bars: [], error: 'ICICI Breeze is not connected' });
    vi.spyOn(svc as any, 'upstoxToken').mockResolvedValue('upstox-token');
    const upstox = vi.spyOn(getUpstox(), 'history').mockResolvedValue([bar]);
    expect(await svc.optionContractHistory(...args)).toEqual({ bars: [bar] });
    expect(upstox).toHaveBeenCalledWith('upstox-token', 'NIFTY2026092922400CE', '5minute', '2026-09-24', '2026-09-29', 'NFO');
  });

  it('an empty Upstox answer is an error, never "no trades" (it would be cached)', async () => {
    const svc = new MarketDataService();
    vi.spyOn(svc, 'breezeOptionHistory').mockResolvedValue({ bars: [], error: 'ICICI Breeze is not connected' });
    vi.spyOn(svc as any, 'upstoxToken').mockResolvedValue('upstox-token');
    vi.spyOn(getUpstox(), 'history').mockResolvedValue([]);
    expect((await svc.optionContractHistory(...args)).error).toMatch(/Upstox Plus/);
  });

  it('says how to connect when neither broker is', async () => {
    const svc = new MarketDataService();
    vi.spyOn(svc, 'breezeOptionHistory').mockResolvedValue({ bars: [], error: 'ICICI Breeze is not connected' });
    vi.spyOn(svc as any, 'upstoxToken').mockResolvedValue(null);
    expect((await svc.optionContractHistory(...args)).error).toMatch(/log in with Upstox/);
  });
});
