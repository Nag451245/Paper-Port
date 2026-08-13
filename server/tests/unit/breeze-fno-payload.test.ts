import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { getBrokerAdapter } from '../../src/lib/broker-adapter.js';
import {
  toBreezeProduct, toBreezeRight, toBreezeExpiry, toBreezeStockCode,
} from '../../src/lib/breeze-symbols.js';

/**
 * The F&O order payload sent to ICICI Breeze.
 *
 * This is the whole substance of the LIVE F&O fix, so it is asserted field by
 * field. Before it, `BreezeAdapter.placeOrder` sent the option tradingsymbol as
 * `stock_code`, `product: 'cash'`, and no expiry_date / right / strike_price —
 * so no derivative order could ever be accepted. Everything filled fine in PAPER
 * against the internal simulator, which is why the gap was invisible.
 *
 * Formats are pinned against the two places in the repo that already talk to
 * Breeze successfully: server/breeze-bridge/app.py and engine/src/broker_icici.rs.
 *
 * NOTE: passing these proves the payload is well-formed, NOT that Breeze accepts
 * it. Acceptance still requires one real 1-lot order against a live account.
 */
describe('Breeze field mapping', () => {
  it('maps product from the segment', () => {
    expect(toBreezeProduct('OPTIONS', 'INTRADAY')).toBe('options');
    expect(toBreezeProduct('FUTURES', 'DELIVERY')).toBe('futures');
    // Equity behaviour is deliberately unchanged.
    expect(toBreezeProduct('EQUITY', 'INTRADAY')).toBe('intraday');
    expect(toBreezeProduct('EQUITY', 'DELIVERY')).toBe('cash');
    expect(toBreezeProduct(null, undefined)).toBe('cash');
  });

  it('maps right to call/put, never ce/pe', () => {
    // The Rust adapter sends option_type.to_lowercase() -> "ce", which Breeze
    // does not accept; the bridge passes `right` through unmodified.
    expect(toBreezeRight('CE')).toBe('call');
    expect(toBreezeRight('PE')).toBe('put');
    expect(toBreezeRight('call')).toBe('call');
    expect(() => toBreezeRight('CALLS')).toThrow(/Breeze right/i);
  });

  it('formats expiry in the exact shape Breeze expects', () => {
    expect(toBreezeExpiry('2026-08-28')).toBe('2026-08-28T06:00:00.000Z');
    expect(() => toBreezeExpiry('28-08-2026')).toThrow();
  });

  it('uses Breeze short codes for the underlying', () => {
    // "BANKNIFTY" is not a code Breeze knows.
    expect(toBreezeStockCode('BANKNIFTY')).toBe('CNXBAN');
    expect(toBreezeStockCode('RELIANCE')).toBe('RELIND');
    expect(toBreezeStockCode('NIFTY')).toBe('NIFTY');
    // Unmapped names pass through unchanged.
    expect(toBreezeStockCode('SOMEMIDCAP')).toBe('SOMEMIDCAP');
  });
});

describe('BreezeAdapter.placeOrder — F&O payload', () => {
  let fetchMock: ReturnType<typeof vi.fn>;

  function bodyOf(call: number = 0): any {
    return JSON.parse(fetchMock.mock.calls[call][1].body);
  }

  beforeEach(() => {
    fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ order_id: 'BRZ123' }),
    });
    vi.stubGlobal('fetch', fetchMock);
  });

  afterEach(() => vi.unstubAllGlobals());

  it('sends underlying, expiry, right and strike for an option', async () => {
    const adapter = getBrokerAdapter('breeze')!;
    const result = await adapter.placeOrder({
      symbol: 'BANKNIFTY2026082654000PE',
      exchange: 'NFO',
      side: 'SELL',
      orderType: 'MARKET',
      qty: 35,
      underlying: 'BANKNIFTY',
      instrumentType: 'OPTIONS',
      expiry: '2026-08-26',
      strike: 54000,
      optionType: 'PE',
    });

    expect(result.status).toBe('PLACED');
    const body = bodyOf();

    expect(body.stock_code).toBe('CNXBAN');       // NOT the tradingsymbol
    expect(body.exchange_code).toBe('NFO');
    expect(body.product).toBe('options');          // NOT 'cash'
    expect(body.expiry_date).toBe('2026-08-26T06:00:00.000Z');
    expect(body.right).toBe('put');
    expect(body.strike_price).toBe('54000');
    expect(body.action).toBe('sell');
    expect(body.quantity).toBe(35);
  });

  it('sends expiry but no right/strike for a future', async () => {
    const adapter = getBrokerAdapter('breeze')!;
    await adapter.placeOrder({
      symbol: 'CRUDEOIL20260819FUT',
      exchange: 'MCX',
      side: 'BUY',
      orderType: 'LIMIT',
      qty: 100,
      price: 5600,
      underlying: 'CRUDEOIL',
      instrumentType: 'FUTURES',
      expiry: '2026-08-19',
    });

    const body = bodyOf();
    expect(body.stock_code).toBe('CRUDEOIL');
    expect(body.exchange_code).toBe('MCX');
    expect(body.product).toBe('futures');
    expect(body.expiry_date).toBe('2026-08-19T06:00:00.000Z');
    expect(body.right).toBeUndefined();
    expect(body.strike_price).toBeUndefined();
    expect(body.order_type).toBe('limit');
  });

  it('recovers contract identity from the symbol when the caller omits it', async () => {
    const adapter = getBrokerAdapter('breeze')!;
    await adapter.placeOrder({
      symbol: 'NIFTY2026082824000CE',
      exchange: 'NFO',
      side: 'BUY',
      orderType: 'MARKET',
      qty: 75,
    });

    const body = bodyOf();
    expect(body.stock_code).toBe('NIFTY');
    expect(body.product).toBe('options');
    expect(body.expiry_date).toBe('2026-08-28T06:00:00.000Z');
    expect(body.right).toBe('call');
    expect(body.strike_price).toBe('24000');
  });

  it('leaves the equity payload exactly as it was', async () => {
    const adapter = getBrokerAdapter('breeze')!;
    await adapter.placeOrder({
      symbol: 'RELIANCE',
      exchange: 'NSE',
      side: 'BUY',
      orderType: 'MARKET',
      qty: 10,
      product: 'DELIVERY',
    });

    const body = bodyOf();
    expect(body.product).toBe('cash');
    expect(body.expiry_date).toBeUndefined();
    expect(body.right).toBeUndefined();
    expect(body.strike_price).toBeUndefined();
  });

  it('fails without placing anything when a derivative has no expiry', async () => {
    const adapter = getBrokerAdapter('breeze')!;
    const result = await adapter.placeOrder({
      symbol: 'NIFTYWEEKLY',
      exchange: 'NFO',
      side: 'BUY',
      orderType: 'MARKET',
      qty: 75,
      instrumentType: 'OPTIONS',
      underlying: 'NIFTY',
    });

    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/no expiry/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails without placing anything when an option has no strike', async () => {
    const adapter = getBrokerAdapter('breeze')!;
    const result = await adapter.placeOrder({
      symbol: 'NIFTYWEEKLY',
      exchange: 'NFO',
      side: 'BUY',
      orderType: 'MARKET',
      qty: 75,
      instrumentType: 'OPTIONS',
      underlying: 'NIFTY',
      expiry: '2026-08-28',
      optionType: 'CE',
    });

    expect(result.status).toBe('FAILED');
    expect(result.message).toMatch(/strike/i);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
