/**
 * Replay Lab core: pure functions for manual backtesting. The page owns the
 * clock and the state; everything that decides a fill or a P&L lives here so it
 * can be tested without a browser.
 *
 * Fill rules (stated in the UI too):
 *  - A market order fills at the close of the candle on screen — the last
 *    price the trader has seen.
 *  - Stops and targets are checked on each later candle. A candle that opens
 *    beyond the level fills at its open (a gap), not at the level.
 *  - If one candle reaches both the stop and the target, the stop is assumed
 *    to have come first. Candles do not say which came first, and assuming
 *    the good outcome would flatter every result.
 */

export interface Bar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export type Side = 'LONG' | 'SHORT';
export type ExitReason = 'MANUAL' | 'STOP' | 'TARGET' | 'END';

export interface Position {
  id: string;
  symbol: string;
  label: string;
  side: Side;
  qty: number;
  entryPrice: number;
  entryTime: string;
  entryCharges: number;
  stopLoss?: number;
  target?: number;
}

export interface ClosedTrade extends Position {
  exitPrice: number;
  exitTime: string;
  reason: ExitReason;
  grossPnl: number;
  /** Undefined until the server has priced the exit. */
  exitCharges?: number;
}

export interface EquityPoint {
  time: string;
  value: number;
}

/**
 * A bar timestamp as epoch milliseconds. Times without a zone are Indian time,
 * matching the server's format: 'YYYY-MM-DD' (daily) or 'YYYY-MM-DD HH:MM:SS'.
 */
export function barTime(ts: string): number {
  if (/[zZ]$|[+-]\d\d:\d\d$/.test(ts)) return Date.parse(ts);
  if (ts.length <= 10) return Date.parse(`${ts}T00:00:00+05:30`);
  return Date.parse(`${ts.slice(0, 19).replace(' ', 'T')}+05:30`);
}

/** Index of the last bar at or before `t`, or -1. Bars must be in time order. */
export function indexAsOf(bars: Bar[], t: number): number {
  let lo = 0;
  let hi = bars.length - 1;
  let found = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (barTime(bars[mid].timestamp) <= t) {
      found = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }
  return found;
}

export function barAsOf(bars: Bar[], t: number): Bar | null {
  const i = indexAsOf(bars, t);
  return i >= 0 ? bars[i] : null;
}

/** Bars with after < time <= upto: the candles that printed during one clock step. */
export function barsBetween(bars: Bar[], after: number, upto: number): Bar[] {
  const end = indexAsOf(bars, upto);
  const start = indexAsOf(bars, after) + 1;
  return end >= start ? bars.slice(start, end + 1) : [];
}

export function grossPnl(side: Side, qty: number, entry: number, exit: number): number {
  return (side === 'LONG' ? exit - entry : entry - exit) * qty;
}

/** Why an order's levels make no sense, or null when they are fine. */
export function validateLevels(side: Side, price: number, stopLoss?: number, target?: number): string | null {
  if (!(price > 0)) return 'No price to trade at yet.';
  if (side === 'LONG') {
    if (stopLoss !== undefined && stopLoss >= price) return 'For a buy, the stop-loss must be below the current price.';
    if (target !== undefined && target <= price) return 'For a buy, the target must be above the current price.';
  } else {
    if (stopLoss !== undefined && stopLoss <= price) return 'For a sell, the stop-loss must be above the current price.';
    if (target !== undefined && target >= price) return 'For a sell, the target must be below the current price.';
  }
  return null;
}

/** Whether this candle closes the position, and at what price. See the fill rules above. */
export function checkExit(pos: Position, bar: Bar): { price: number; reason: 'STOP' | 'TARGET' } | null {
  const { stopLoss: sl, target: tp } = pos;
  if (pos.side === 'LONG') {
    if (sl !== undefined && bar.open <= sl) return { price: bar.open, reason: 'STOP' };
    if (tp !== undefined && bar.open >= tp) return { price: bar.open, reason: 'TARGET' };
    if (sl !== undefined && bar.low <= sl) return { price: sl, reason: 'STOP' };
    if (tp !== undefined && bar.high >= tp) return { price: tp, reason: 'TARGET' };
  } else {
    if (sl !== undefined && bar.open >= sl) return { price: bar.open, reason: 'STOP' };
    if (tp !== undefined && bar.open <= tp) return { price: bar.open, reason: 'TARGET' };
    if (sl !== undefined && bar.high >= sl) return { price: sl, reason: 'STOP' };
    if (tp !== undefined && bar.low <= tp) return { price: tp, reason: 'TARGET' };
  }
  return null;
}

export function closePosition(pos: Position, price: number, time: string, reason: ExitReason): ClosedTrade {
  return { ...pos, exitPrice: price, exitTime: time, reason, grossPnl: grossPnl(pos.side, pos.qty, pos.entryPrice, price) };
}

export function tradeCharges(t: ClosedTrade): number {
  return t.entryCharges + (t.exitCharges ?? 0);
}

export function netPnl(t: ClosedTrade): number {
  return t.grossPnl - tradeCharges(t);
}

/**
 * Account value now: capital, plus closed trades after all charges, plus open
 * positions marked at `priceOf` less the charges already paid to open them.
 */
export function equity(
  initialCapital: number,
  closed: ClosedTrade[],
  open: Position[],
  priceOf: (p: Position) => number | null,
): number {
  let value = initialCapital;
  for (const t of closed) value += netPnl(t);
  for (const p of open) {
    const px = priceOf(p);
    value -= p.entryCharges;
    if (px !== null) value += grossPnl(p.side, p.qty, p.entryPrice, px);
  }
  return value;
}

export interface Summary {
  trades: number;
  wins: number;
  losses: number;
  winRate: number;
  grossPnl: number;
  charges: number;
  netPnl: number;
  profitFactor: number | null;
  avgWin: number;
  avgLoss: number;
  maxDrawdownPct: number;
  maxDrawdown: number;
}

export function summarize(closed: ClosedTrade[], curve: EquityPoint[], initialCapital: number): Summary {
  const nets = closed.map(netPnl);
  const wins = nets.filter((n) => n > 0);
  const losses = nets.filter((n) => n < 0);
  const sum = (xs: number[]) => xs.reduce((a, b) => a + b, 0);
  const lossTotal = Math.abs(sum(losses));

  let peak = initialCapital;
  let maxDd = 0;
  let maxDdPct = 0;
  for (const p of curve) {
    if (p.value > peak) peak = p.value;
    const dd = peak - p.value;
    if (dd > maxDd) maxDd = dd;
    if (peak > 0 && dd / peak > maxDdPct) maxDdPct = dd / peak;
  }

  return {
    trades: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length ? (wins.length / closed.length) * 100 : 0,
    grossPnl: sum(closed.map((t) => t.grossPnl)),
    charges: sum(closed.map(tradeCharges)),
    netPnl: sum(nets),
    profitFactor: lossTotal > 0 ? sum(wins) / lossTotal : wins.length ? null : 0,
    avgWin: wins.length ? sum(wins) / wins.length : 0,
    avgLoss: losses.length ? sum(losses) / losses.length : 0,
    maxDrawdownPct: maxDdPct * 100,
    maxDrawdown: maxDd,
  };
}

/** Canonical contract symbol, the same grammar the server parses: NIFTY20261029FUT, NIFTY2026102924000CE. */
export type ContractKind = 'FUT' | 'CE' | 'PE';

export function buildContractSymbol(underlying: string, kind: ContractKind, expiry: string, strike: string | number): string | null {
  const u = underlying.trim().toUpperCase();
  if (!/^[A-Z&]+$/.test(u) || !/^\d{4}-\d{2}-\d{2}$/.test(expiry)) return null;
  const date = expiry.replace(/-/g, '');
  if (kind === 'FUT') return `${u}${date}FUT`;
  const k = Number(strike);
  if (!Number.isInteger(k) || k <= 0) return null;
  return `${u}${date}${k}${kind}`;
}

/** Strike spacing for the at-the-money hint; null when there is no standard step. */
export function strikeStep(underlying: string): number | null {
  const u = underlying.toUpperCase();
  if (u === 'NIFTY' || u === 'FINNIFTY') return 50;
  if (u === 'BANKNIFTY' || u === 'SENSEX' || u === 'BANKEX') return 100;
  if (u === 'MIDCPNIFTY') return 25;
  return null;
}
