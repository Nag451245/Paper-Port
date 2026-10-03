/**
 * The EOD square-off selector must be NULL-safe.
 *
 * SQL three-valued logic makes `NOT (col = 'DELIVERY')` evaluate to NULL — not
 * TRUE — when col IS NULL, which filters the row OUT. Verified against the real
 * SQLite database, that produces two distinct money bugs:
 *
 *   - Filtering on strategyTag alone skips every position with a NULL tag, so
 *     manually-placed positions are never squared off and carry overnight.
 *   - Adding `product` without null handling skips every row with a NULL
 *     product — the entire existing book right after the migration that added
 *     the column.
 *
 * A Prisma mock cannot reproduce SQL null semantics, so this test pins the SHAPE
 * of the where clause instead. It exists to fail loudly if someone "simplifies"
 * the explicit null branches away.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/services/market-data.service.js', () => ({
  MarketDataService: vi.fn().mockImplementation(function () { return { getQuote: vi.fn() }; }),
}));
vi.mock('../../src/lib/redis.js', () => ({ getRedis: vi.fn().mockReturnValue(null) }));
vi.mock('../../src/lib/event-bus.js', () => ({ emit: vi.fn().mockResolvedValue(undefined) }));
vi.mock('../../src/lib/websocket.js', () => ({
  wsHub: { broadcastPriceUpdate: vi.fn(), broadcastToUser: vi.fn(), broadcast: vi.fn() },
}));

const { IntradayManager } = await import('../../src/services/intraday-manager.service.js');

describe('squareOffAllIntraday — NULL-safe delivery exclusion', () => {
  let findMany: ReturnType<typeof vi.fn>;
  let manager: any;

  beforeEach(() => {
    findMany = vi.fn().mockResolvedValue([]);
    const prisma: any = { position: { findMany, update: vi.fn(), findUnique: vi.fn() } };
    manager = new IntradayManager(prisma);
  });

  function capturedWhere() {
    expect(findMany).toHaveBeenCalled();
    return findMany.mock.calls[0][0].where;
  }

  it('handles a NULL product explicitly rather than relying on `not`', async () => {
    await manager.squareOffAllIntraday('u1');
    const where = capturedWhere();

    const productClause = where.AND.find((c: any) =>
      Array.isArray(c.OR) && c.OR.some((o: any) => 'product' in o));

    expect(productClause, 'no product clause found in the selector').toBeDefined();
    // A bare `{ product: { not: 'DELIVERY' } }` would drop every NULL-product row.
    expect(productClause.OR).toEqual(
      expect.arrayContaining([{ product: null }]),
    );
  });

  it('handles a NULL strategyTag explicitly', async () => {
    await manager.squareOffAllIntraday('u1');
    const where = capturedWhere();

    const tagClause = where.AND.find((c: any) =>
      Array.isArray(c.OR) && c.OR.some((o: any) => 'strategyTag' in o));

    expect(tagClause, 'no strategyTag clause found in the selector').toBeDefined();
    expect(tagClause.OR).toEqual(
      expect.arrayContaining([{ strategyTag: null }]),
    );
  });

  it('does not use a top-level NOT, which is what caused the null bug', async () => {
    await manager.squareOffAllIntraday('u1');
    const where = capturedWhere();

    expect(where.NOT).toBeUndefined();
    expect(Array.isArray(where.AND)).toBe(true);
  });

  it('still filters to OPEN positions and scopes to the user', async () => {
    await manager.squareOffAllIntraday('u1');
    const where = capturedWhere();

    expect(where.status).toBe('OPEN');
    expect(where.portfolio).toEqual({ userId: 'u1' });
  });
});

describe('convertToDelivery — writes the product column, not the tag', () => {
  it('sets product to DELIVERY and leaves strategyTag alone', async () => {
    const update = vi.fn().mockResolvedValue({});
    const prisma: any = {
      position: {
        findUnique: vi.fn().mockResolvedValue({
          id: 'p1', status: 'OPEN', strategyTag: 'BOT:momentum',
          portfolio: { userId: 'u1' },
        }),
        update,
        findMany: vi.fn().mockResolvedValue([]),
      },
    };
    const manager: any = new IntradayManager(prisma);

    await manager.convertToDelivery('p1', 'u1');

    expect(update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: { product: 'DELIVERY' },
    });
    // The old implementation did strategyTag.replace('INTRADAY','DELIVERY'),
    // a no-op for 'BOT:momentum' — it reported success while leaving the
    // position eligible for square-off.
    expect(update.mock.calls[0][0].data.strategyTag).toBeUndefined();
  });
});
