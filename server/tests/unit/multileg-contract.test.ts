import { describe, it, expect, vi, beforeEach } from 'vitest';
import { BotEngine } from '../../src/services/bot-engine.js';

vi.mock('../../src/lib/openai.js', () => ({
  chatCompletionJSON: vi.fn(),
  chatCompletion: vi.fn(),
  getOpenAIStatus: vi.fn().mockReturnValue({ circuitOpen: false, queueLength: 0, recentRequests: 0, cooldownRemainingMs: 0 }),
  _resetForTesting: vi.fn(),
}));

vi.mock('../../src/lib/rust-engine.js', () => ({
  isEngineAvailable: vi.fn().mockReturnValue(false),
  engineScan: vi.fn(),
  engineRisk: vi.fn(),
  engineScanActiveSymbols: vi.fn().mockResolvedValue({ count: 0, symbols: [] }),
}));

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(function () { return {
    getQuote: vi.fn().mockResolvedValue({ symbol: 'NIFTY', ltp: 24000 }),
  }; }),
}));

/**
 * Contract identity for multi-leg option orders.
 *
 * The behaviour pinned here is what made bot-placed option positions
 * unrecoverable: legs were named `NIFTY24000CE` with no expiry, which no quote
 * path can parse (so the position could never be priced) and which collapsed
 * two different expiries at the same strike into a single position row at a
 * blended entry price.
 */
describe('executeMultiLegStrategy — contract identity', () => {
  let engine: any;
  let placeOrder: ReturnType<typeof vi.fn>;

  const legs = [
    { type: 'CE', strike: 24000, action: 'SELL', qty: 1 },
    { type: 'CE', strike: 24200, action: 'BUY', qty: 1 },
  ];

  beforeEach(() => {
    const mockPrisma: any = {
      portfolio: { findFirst: vi.fn().mockResolvedValue({ id: 'pf1', userId: 'u1' }) },
      tradingBot: { update: vi.fn().mockResolvedValue({}), findUnique: vi.fn().mockResolvedValue(null) },
      strategyParam: { findFirst: vi.fn().mockResolvedValue(null) },
    };
    engine = new BotEngine(mockPrisma);

    placeOrder = vi.fn().mockResolvedValue({ id: 'o1', status: 'FILLED', avgFillPrice: 100 });
    engine.tradeService = { placeOrder };
    // Avoid a live bridge call for lot size.
    engine.getLotSizeForSymbol = vi.fn().mockResolvedValue(75);
    engine.updateBotTradeStats = vi.fn().mockResolvedValue(undefined);
  });

  it('refuses a multi-leg order with no expiry and places nothing', async () => {
    const result = await engine.executeMultiLegStrategy('u1', 'NIFTY', 'bear-call-spread', legs, undefined, undefined);

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/require an explicit expiry/i);
    expect(placeOrder).not.toHaveBeenCalled();
  });

  it('builds canonical symbols carrying the expiry', async () => {
    const result = await engine.executeMultiLegStrategy(
      'u1', 'NIFTY', 'bear-call-spread', legs, undefined, '2026-08-28',
    );

    expect(result.success).toBe(true);
    expect(placeOrder).toHaveBeenCalledTimes(2);

    const symbols = placeOrder.mock.calls.map(c => c[1].symbol);
    expect(symbols).toEqual(['NIFTY2026082824000CE', 'NIFTY2026082824200CE']);
  });

  it('passes contract identity through as fields, not just inside the symbol', async () => {
    await engine.executeMultiLegStrategy('u1', 'NIFTY', 'bear-call-spread', legs, undefined, '2026-08-28');

    const first = placeOrder.mock.calls[0][1];
    expect(first.expiry).toBe('2026-08-28');
    expect(first.strike).toBe(24000);
    expect(first.optionType).toBe('CE');
    expect(first.lotSize).toBe(75);
    expect(first.exchange).toBe('NFO');
    // qty is in UNITS: 1 lot x 75.
    expect(first.qty).toBe(75);
    // strategyTag is free for attribution now that identity lives in columns.
    expect(first.strategyTag).toBe('BOT:bear-call-spread');
  });

  it('gives two expiries at the same strike two distinct symbols', async () => {
    const oneLeg = [{ type: 'CE', strike: 24000, action: 'BUY', qty: 1 }];

    await engine.executeMultiLegStrategy('u1', 'NIFTY', 's', oneLeg, undefined, '2026-08-20');
    await engine.executeMultiLegStrategy('u1', 'NIFTY', 's', oneLeg, undefined, '2026-08-28');

    const [weekly, monthly] = placeOrder.mock.calls.map(c => c[1].symbol);
    expect(weekly).toBe('NIFTY2026082024000CE');
    expect(monthly).toBe('NIFTY2026082824000CE');
    // Netting keys on the symbol, so distinct symbols are what stop these two
    // contracts merging into one position row.
    expect(weekly).not.toBe(monthly);
  });

  it('reports a partially-filled defined-risk structure as UNBALANCED, not success', async () => {
    // The short fills, the protective long fails: what remains is a naked short.
    placeOrder
      .mockResolvedValueOnce({ id: 'o1', status: 'FILLED' })
      .mockRejectedValueOnce(new Error('margin rejected'));

    const result = await engine.executeMultiLegStrategy(
      'u1', 'NIFTY', 'bear-call-spread', legs, undefined, '2026-08-28',
    );

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/UNBALANCED/);
    expect(result.message).toMatch(/1 of 2 legs filled/);
    expect(result.message).toMatch(/manual review/i);
  });

  it('rejects a leg whose type is not CE or PE instead of guessing', async () => {
    const badLegs = [{ type: 'CALL', strike: 24000, action: 'BUY', qty: 1 }];
    const result = await engine.executeMultiLegStrategy('u1', 'NIFTY', 's', badLegs, undefined, '2026-08-28');

    expect(result.success).toBe(false);
    expect(result.message).toMatch(/bad leg type/i);
    expect(placeOrder).not.toHaveBeenCalled();
  });
});
