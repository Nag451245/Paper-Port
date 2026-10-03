import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import Fastify, { type FastifyInstance } from 'fastify';

// Keep the route's TradeService construction offline; none of it is under test.
vi.mock('../../src/services/market-calendar.js', () => ({
  MarketCalendar: vi.fn().mockImplementation(function () { return {
    isMarketOpen: vi.fn().mockReturnValue(true),
  }; }),
}));

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(function () { return {
    getQuote: vi.fn().mockResolvedValue({ ltp: 100 }),
  }; }),
}));

vi.mock('../../src/middleware/auth.js', () => ({
  authenticate: vi.fn(async () => {}),
  getUserId: vi.fn(() => 'u1'),
}));

import { TradeService } from '../../src/services/trade.service.js';
import { tradeRoutes } from '../../src/routes/trades.js';

/**
 * Reporting contract for POST /execute-strategy.
 *
 * The route places each leg in its own try/catch, so a defined-risk structure
 * can come back half-open: the two shorts of an iron condor filled, the two
 * protective wings gone. That is a naked strangle — bounded risk turned
 * unbounded — and it used to be reported as 201 with a `failed` count the
 * caller had to notice on its own.
 *
 * Same verdict as BotEngine.executeMultiLegStrategy, which returns
 * success:false with an UNBALANCED message on the bot path.
 */
describe('POST /execute-strategy — partial-fill reporting', () => {
  let app: FastifyInstance;
  let placeOrder: ReturnType<typeof vi.spyOn>;

  const ironCondor = {
    portfolio_id: '11111111-1111-4111-8111-111111111111',
    symbol: 'NIFTY',
    expiry: '2026-08-28',
    strategy_name: 'iron-condor',
    legs: [
      { type: 'PE', strike: 23800, action: 'SELL', qty: 75 },
      { type: 'PE', strike: 23600, action: 'BUY', qty: 75 },
      { type: 'CE', strike: 24200, action: 'SELL', qty: 75 },
      { type: 'CE', strike: 24400, action: 'BUY', qty: 75 },
    ],
  };

  function execute(payload: unknown = ironCondor) {
    return app.inject({ method: 'POST', url: '/execute-strategy', payload: payload as any });
  }

  beforeEach(async () => {
    placeOrder = vi.spyOn(TradeService.prototype, 'placeOrder')
      .mockResolvedValue({ id: 'o1', status: 'FILLED' } as any);

    app = Fastify({ logger: false });
    await app.register(tradeRoutes);
    await app.ready();
  });

  afterEach(async () => {
    await app.close();
    vi.restoreAllMocks();
  });

  it('returns 201 when every leg is placed', async () => {
    const res = await execute();
    const body = res.json();

    expect(res.statusCode).toBe(201);
    expect(body.unbalanced).toBe(false);
    expect(body.filled).toBe(4);
    expect(body.failed).toBe(0);
    expect(body.error).toBeUndefined();
  });

  it('refuses to report a half-open condor as a clean entry', async () => {
    // Both shorts fill, one protective wing is rejected for margin: what is
    // left on the book is short risk with only half its protection.
    placeOrder
      .mockResolvedValueOnce({ id: 'o1', status: 'FILLED' } as any)
      .mockResolvedValueOnce({ id: 'o2', status: 'FILLED' } as any)
      .mockResolvedValueOnce({ id: 'o3', status: 'FILLED' } as any)
      .mockRejectedValueOnce(new Error('margin rejected'));

    const res = await execute();
    const body = res.json();

    expect(res.statusCode).not.toBe(201);
    expect(res.statusCode).toBe(409);
    expect(body.unbalanced).toBe(true);
    expect(body.error).toMatch(/UNBALANCED/);
    expect(body.error).toMatch(/3 of 4 legs open/);
    expect(body.error).toMatch(/margin rejected/);
    expect(body.error).toMatch(/manual review/i);
  });

  it('counts a leg that came back REJECTED, not just one that threw', async () => {
    // placeOrder resolving with a dead status is the same hole in the
    // structure as it throwing — the wing does not exist either way.
    placeOrder
      .mockResolvedValueOnce({ id: 'o1', status: 'FILLED' } as any)
      .mockResolvedValueOnce({ id: 'o2', status: 'REJECTED' } as any)
      .mockResolvedValueOnce({ id: 'o3', status: 'FILLED' } as any)
      .mockResolvedValueOnce({ id: 'o4', status: 'FILLED' } as any);

    const res = await execute();
    const body = res.json();

    expect(res.statusCode).toBe(409);
    expect(body.unbalanced).toBe(true);
    expect(body.filled).toBe(3);
    expect(body.rejected).toBe(1);
    expect(body.error).toMatch(/3 of 4 legs open/);
  });

  it('still returns the per-leg breakdown so the open legs can be reconciled', async () => {
    placeOrder
      .mockResolvedValueOnce({ id: 'o1', status: 'FILLED' } as any)
      .mockRejectedValueOnce(new Error('margin rejected'))
      .mockResolvedValueOnce({ id: 'o3', status: 'FILLED' } as any)
      .mockResolvedValueOnce({ id: 'o4', status: 'FILLED' } as any);

    const body = (await execute()).json();

    expect(body.results).toHaveLength(4);
    expect(body.totalLegs).toBe(4);
    expect(body.results[0].order.id).toBe('o1');
    expect(body.results[1]).toMatchObject({ leg: 2, order: null, error: 'margin rejected' });
    // The symbols identify which contracts are actually open.
    const symbols = placeOrder.mock.calls.map((c: any) => c[1].symbol);
    expect(symbols[0]).toBe('NIFTY2026082823800PE');
  });

  it('reports a total failure as not-created rather than 201 with zero legs', async () => {
    placeOrder.mockRejectedValue(new Error('kill switch active'));

    const res = await execute();
    const body = res.json();

    expect(res.statusCode).toBe(409);
    // Nothing opened, so there is no risk asymmetry to review — but it is
    // still not a strategy that exists.
    expect(body.unbalanced).toBe(false);
    expect(body.filled).toBe(0);
    expect(body.failed).toBe(4);
    expect(body.error).toMatch(/no legs were placed/i);
    expect(body.error).toMatch(/Nothing is open/i);
  });

  it('keeps rejecting a malformed request with 400, not 409', async () => {
    const res = await execute({ ...ironCondor, portfolio_id: 'not-a-uuid' });

    expect(res.statusCode).toBe(400);
    expect(placeOrder).not.toHaveBeenCalled();
  });
});
