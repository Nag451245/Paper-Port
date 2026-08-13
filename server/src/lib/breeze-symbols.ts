/**
 * ICICI Breeze payload mapping.
 *
 * Breeze does not take a tradingsymbol. It takes the UNDERLYING as `stock_code`
 * plus `expiry_date`, `right` and `strike_price` as separate fields, with
 * `product` naming the segment. Sending `stock_code: "NIFTY2026082824000CE"` —
 * which is what the adapter did before this module existed — cannot work: there
 * is no such stock code, and without expiry/right/strike Breeze has no contract
 * to act on.
 *
 * Field formats are taken from the two places in this repo that already talk to
 * Breeze successfully: `server/breeze-bridge/app.py` (option chain, quotes) and
 * `engine/src/broker_icici.rs`.
 *
 * One deliberate deviation from the Rust reference: it sends
 * `right: option_type.to_lowercase()`, which yields "ce"/"pe". Every working
 * Breeze call in the bridge uses "call"/"put", and the bridge passes `right`
 * through to Breeze unmodified, so "ce" would be rejected. Nothing in the Rust
 * engine ever populates `option_type`, so that path was never exercised.
 */

/**
 * Breeze uses its own short codes rather than NSE tradingsymbols.
 *
 * Moved here from market-data.service.ts, where it was unexported and used in
 * exactly one place — so the order path sent raw NSE symbols. A BANKNIFTY order
 * needs `CNXBAN`; "BANKNIFTY" is not a code Breeze knows.
 *
 * The map is incomplete. Unmapped symbols fall through unchanged, which is
 * correct for names where Breeze uses the NSE symbol (NIFTY, SENSEX, and most
 * mid-caps) and wrong for any short-coded name not listed. Callers placing F&O
 * orders should treat an unmapped non-index underlying as suspect.
 */
export const BREEZE_STOCK_CODES: Record<string, string> = {
  NIFTY: 'NIFTY', BANKNIFTY: 'CNXBAN', FINNIFTY: 'NIFFIN',
  MIDCPNIFTY: 'NIFSEL', NIFTYNXT50: 'NIFNEX', SENSEX: 'SENSEX',
  RELIANCE: 'RELIND', HDFCBANK: 'HDFBAN', ICICIBANK: 'ICIBAN',
  INFY: 'INFTEC', SBIN: 'STABAN', HINDUNILVR: 'HINLEV',
  BHARTIARTL: 'BHAAIR', KOTAKBANK: 'KOTMAH', LT: 'LARTOU',
  AXISBANK: 'AXIBAN', BAJFINANCE: 'BAJFI', HCLTECH: 'HCLTEC',
  TATAMOTORS: 'TATMOT', SUNPHARMA: 'SUNPHA', TITAN: 'TITIND',
  ASIANPAINT: 'ASIPAI', ADANIENT: 'ADAENT', TATASTEEL: 'TATSTE',
  POWERGRID: 'POWGRI', JSWSTEEL: 'JSWSTE', 'M&M': 'MAHMAH',
  BAJAJFINSV: 'BAFINS', ULTRACEMCO: 'ULTCEM', NESTLEIND: 'NESIND',
  DRREDDY: 'DRREDD', DIVISLAB: 'DIVLAB', HEROMOTOCO: 'HERHON',
};

export function toBreezeStockCode(symbolOrUnderlying: string): string {
  const key = symbolOrUnderlying.trim().toUpperCase();
  return BREEZE_STOCK_CODES[key] ?? key;
}

/** True when the underlying has no explicit Breeze code and is not an index. */
export function isUnmappedBreezeCode(underlying: string): boolean {
  return !(underlying.trim().toUpperCase() in BREEZE_STOCK_CODES);
}

/**
 * Breeze `product`. Derivative segments name themselves; equity keeps the
 * existing cash/intraday mapping unchanged.
 */
export function toBreezeProduct(
  instrumentType: string | null | undefined,
  product: string | null | undefined,
): string {
  switch (String(instrumentType ?? '').toUpperCase()) {
    case 'OPTIONS': return 'options';
    case 'FUTURES': return 'futures';
    default:
      return String(product ?? '').toUpperCase() === 'INTRADAY' ? 'intraday' : 'cash';
  }
}

/** Breeze `right`: "call" or "put", never "ce"/"pe". */
export function toBreezeRight(optionType: string): 'call' | 'put' {
  const t = optionType.trim().toUpperCase();
  if (t === 'CE' || t === 'CALL') return 'call';
  if (t === 'PE' || t === 'PUT') return 'put';
  throw new Error(`Cannot map option type "${optionType}" to a Breeze right`);
}

/**
 * Breeze `expiry_date`: "YYYY-MM-DDT06:00:00.000Z".
 *
 * The 06:00:00Z is not a real time — it is the literal shape Breeze expects, and
 * both the bridge and the Rust adapter send exactly this.
 */
export function toBreezeExpiry(expiry: Date | string): string {
  const dateStr = expiry instanceof Date
    ? expiry.toLocaleDateString('en-CA', { timeZone: 'Asia/Kolkata' })
    : expiry.trim();

  if (!/^\d{4}-\d{2}-\d{2}$/.test(dateStr)) {
    throw new Error(`Expiry must be YYYY-MM-DD for Breeze, got "${expiry}"`);
  }
  return `${dateStr}T06:00:00.000Z`;
}
