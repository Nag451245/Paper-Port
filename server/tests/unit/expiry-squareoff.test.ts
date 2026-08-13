import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { settlementType, isIndexUnderlying, parseInstrumentSymbol } from '../../src/lib/instrument.js';

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(() => ({ getQuote: vi.fn() })),
}));
vi.mock('../../src/lib/redis.js', () => ({ getRedis: vi.fn().mockReturnValue(null) }));
vi.mock('../../src/lib/event-bus.js', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/lib/websocket.js', () => ({
  wsHub: { broadcastPriceUpdate: vi.fn(), broadcastToUser: vi.fn(), broadcast: vi.fn() },
}));

const { IntradayManager } = await import('../../src/services/intraday-manager.service.js');

/**
 * Expiry lifecycle.
 *
 * The gap this closes: `squareOffAllIntraday` excludes product = 'DELIVERY', so a
 * stock option held for delivery survived the 15:15 sweep and went to physical
 * settlement. SEBI has mandated physical settlement of stock derivatives since
 * October 2019, so an ITM stock option left open through expiry is an obligation
 * to take or give delivery of the shares.
 */
describe('settlementType', () => {
  it('treats index derivatives as cash settled', () => {
    for (const u of ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX']) {
      expect(isIndexUnderlying(u)).toBe(true);
      expect(settlementType({ instrumentType: 'OPTIONS', underlying: u, segment: 'FO' })).toBe('CASH');
    }
  });

  it('treats stock derivatives as physically settled', () => {
    for (const u of ['RELIANCE', 'TCS', 'INFY']) {
      expect(isIndexUnderlying(u)).toBe(false);
      expect(settlementType({ instrumentType: 'OPTIONS', underlying: u, segment: 'FO' })).toBe('PHYSICAL');
    }
  });

  it('treats commodities as physically settled', () => {
    expect(settlementType({ instrumentType: 'FUTURES', underlying: 'CRUDEOIL', segment: 'COM' })).toBe('PHYSICAL');
  });

  it('defaults an unknown underlying to PHYSICAL, the safe direction', () => {
    // Assuming delivery risk that is not there costs a square-off. Assuming cash
    // settlement where there is delivery costs an unfunded delivery obligation.
    expect(settlementType({ instrumentType: 'FUTURES', underlying: 'SOMENEWCO', segment: 'FO' })).toBe('PHYSICAL');
  });

  it('classifies from a parsed canonical symbol', () => {
    expect(settlementType(parseInstrumentSymbol('RELIANCE202608241500CE'))).toBe('PHYSICAL');
    expect(settlementType(parseInstrumentSymbol('NIFTY2026082824000CE'))).toBe('CASH');
  });
});

describe('squareOffExpiringDerivatives', () => {
  const TODAY = '2026-08-27T10:00:00+05:30';
  // Contract expiries are stored at IST midnight.
  const istMidnightOf = (d: string) => new Date(`${d}T00:00:00+05:30`);

  let manager: any;
  let squareOffPosition: ReturnType<typeof vi.fn>;

  function makePosition(over: Record<string, unknown>) {
    return {
      id: 'p-' + Math.random().toString(36).slice(2, 8),
      symbol: 'X', exchange: 'NFO', status: 'OPEN', qty: 75,
      avgEntryPrice: 100, side: 'LONG', product: null,
      segment: 'FO', instrumentType: 'OPTIONS',
      portfolio: { userId: 'u1' },
      ...over,
    };
  }

  function build(positions: any[]) {
    squareOffPosition = vi.fn().mockImplementation(async (id: string, reason: string) => ({
      symbol: positions.find(p => p.id === id)?.symbol ?? '?',
      positionId: id, exitPrice: 100, pnl: 0, reason,
    }));
    const prisma: any = { position: { findMany: vi.fn().mockResolvedValue(positions), update: vi.fn() } };
    manager = new IntradayManager(prisma);
    manager.squareOffPosition = squareOffPosition;
    return manager;
  }

  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(TODAY));
  });
  afterEach(() => vi.useRealTimers());

  it('closes an expiring position even when it is held for DELIVERY', async () => {
    // This is the whole point: the intraday sweep skips product = 'DELIVERY'.
    build([makePosition({
      symbol: 'RELIANCE202608271500CE', underlying: 'RELIANCE',
      product: 'DELIVERY', expiry: istMidnightOf('2026-08-27'),
    })]);

    const results = await manager.squareOffExpiringDerivatives();

    expect(results).toHaveLength(1);
    expect(squareOffPosition).toHaveBeenCalledTimes(1);
    expect(squareOffPosition.mock.calls[0][1]).toMatch(/PHYSICALLY settled/);
  });

  it('squares off physically-settled contracts before cash-settled ones', async () => {
    const cash = makePosition({ symbol: 'NIFTY2026082724000CE', underlying: 'NIFTY', expiry: istMidnightOf('2026-08-27') });
    const physical = makePosition({ symbol: 'TCS202608274000CE', underlying: 'TCS', expiry: istMidnightOf('2026-08-27') });
    // Cash listed first, so ordering must come from the sort, not the input.
    build([cash, physical]);

    await manager.squareOffExpiringDerivatives();

    const order = squareOffPosition.mock.calls.map((c: any[]) => c[0]);
    expect(order).toEqual([physical.id, cash.id]);
  });

  it('leaves contracts expiring later alone', async () => {
    build([makePosition({
      symbol: 'NIFTY2026090324000CE', underlying: 'NIFTY', expiry: istMidnightOf('2026-09-03'),
    })]);

    expect(await manager.squareOffExpiringDerivatives()).toHaveLength(0);
    expect(squareOffPosition).not.toHaveBeenCalled();
  });

  it('never touches equity positions', async () => {
    build([makePosition({
      symbol: 'RELIANCE', underlying: 'RELIANCE', instrumentType: 'EQUITY',
      segment: 'EQ', exchange: 'NSE', expiry: null,
    })]);

    expect(await manager.squareOffExpiringDerivatives()).toHaveLength(0);
    expect(squareOffPosition).not.toHaveBeenCalled();
  });

  it('reports an already-expired open position instead of closing it at a fictional price', async () => {
    build([makePosition({
      symbol: 'NIFTY2026082024000CE', underlying: 'NIFTY', expiry: istMidnightOf('2026-08-20'),
    })]);

    const results = await manager.squareOffExpiringDerivatives();

    // The contract no longer trades, so there is no honest exit price for it.
    expect(results).toHaveLength(0);
    expect(squareOffPosition).not.toHaveBeenCalled();
  });

  it('recovers expiry from the symbol for rows predating the columns', async () => {
    build([makePosition({
      symbol: 'TCS202608274000CE',
      underlying: null, instrumentType: null, segment: null, expiry: null,
    })]);

    const results = await manager.squareOffExpiringDerivatives();
    expect(results).toHaveLength(1);
    expect(squareOffPosition.mock.calls[0][1]).toMatch(/PHYSICALLY settled/);
  });

  it('keeps sweeping after one contract fails to close', async () => {
    const a = makePosition({ symbol: 'TCS202608274000CE', underlying: 'TCS', expiry: istMidnightOf('2026-08-27') });
    const b = makePosition({ symbol: 'INFY202608271800CE', underlying: 'INFY', expiry: istMidnightOf('2026-08-27') });
    build([a, b]);
    squareOffPosition
      .mockRejectedValueOnce(new Error('broker rejected'))
      .mockResolvedValueOnce({ symbol: 'INFY', positionId: b.id, exitPrice: 1, pnl: 0, reason: 'r' });

    const results = await manager.squareOffExpiringDerivatives();

    // One failure must not strand the remaining physically-settled positions.
    expect(squareOffPosition).toHaveBeenCalledTimes(2);
    expect(results).toHaveLength(1);
  });
});
