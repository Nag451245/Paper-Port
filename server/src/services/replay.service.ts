/**
 * Replay Lab — manual backtesting, the way TradingView's bar replay and
 * Stockmock work: the trader steps through past candles and places trades by
 * hand. The replay clock and fills run in the browser (see
 * frontend/src/lib/replay-engine.ts); the server supplies candles, charges and
 * lot sizes, and keeps finished sessions.
 */
import type { PrismaClient, BacktestResult } from '@prisma/client';
import { MarketDataService, isDailyInterval, type HistoricalBar } from './market-data.service.js';
import { computeMetrics } from './backtest.service.js';
import { calculateCosts } from '../lib/costs.js';
import { isDerivativeSymbol, parseInstrumentSymbol } from '../lib/instrument.js';

export class ReplayError extends Error {
  constructor(message: string, public readonly statusCode = 400) {
    super(message);
    this.name = 'ReplayError';
  }
}

/** Longest range per candle size — enough to replay, small enough to fetch in one go. */
export const MAX_RANGE_DAYS: Record<string, number> = {
  '1minute': 10,
  '5minute': 60,
  '30minute': 180,
  '1day': 3650,
};

/** Current exchange lot sizes, used only when the Breeze bridge cannot say. Editable in the page. */
const FALLBACK_LOT_SIZES: Record<string, number> = { NIFTY: 65, BANKNIFTY: 30, FINNIFTY: 60, MIDCPNIFTY: 120 };

export interface ReplayFill {
  symbol: string;
  qty: number;
  price: number;
  side: 'BUY' | 'SELL';
}

export interface ReplayTrade {
  symbol: string;
  side: 'LONG' | 'SHORT';
  qty: number;
  entryTime: string;
  exitTime: string;
  entryPrice: number;
  exitPrice: number;
  charges: number;
  netPnl: number;
  reason: string;
}

export interface SaveSessionInput {
  mode: 'stock' | 'fno';
  symbol: string;
  interval: string;
  from: string;
  to: string;
  initialCapital: number;
  trades: ReplayTrade[];
  equityCurve: { time: string; value: number }[];
  notes?: string;
}

const dayDiff = (a: string, b: string) => (Date.parse(b) - Date.parse(a)) / 86_400_000;

export class ReplayService {
  constructor(
    private readonly prisma: PrismaClient,
    private readonly market = new MarketDataService(),
  ) {}

  async candles(userId: string, symbol: string, interval: string, from: string, to: string): Promise<HistoricalBar[]> {
    const span = dayDiff(from, to);
    if (span < 0) throw new ReplayError('The start date is after the end date.');
    const max = MAX_RANGE_DAYS[interval];
    if (span > max) {
      throw new ReplayError(`${interval} candles can be replayed ${max} days at a time. Shorten the period.`);
    }
    if (isDerivativeSymbol(symbol)) {
      try { parseInstrumentSymbol(symbol); } catch (err) { throw new ReplayError((err as Error).message); }
    }
    return this.market.getHistory(symbol, interval, from, to, userId);
  }

  /** Charges for each fill, from the same cost model paper trading uses. */
  charges(fills: ReplayFill[]): number[] {
    return fills.map((f) => {
      let exchange = 'NSE';
      let kind: 'EQUITY' | 'FUTURES' | 'OPTIONS' = 'EQUITY';
      if (isDerivativeSymbol(f.symbol)) {
        const spec = parseInstrumentSymbol(f.symbol);
        exchange = spec.exchange;
        kind = spec.instrumentType;
      }
      return calculateCosts(f.qty, f.price, f.side, exchange, kind).totalCost;
    });
  }

  async lotSize(underlying: string): Promise<{ lotSize: number | null; source: string }> {
    const u = underlying.trim().toUpperCase();
    try {
      const { lotSizes, source } = await this.market.getLotSizes();
      if (lotSizes[u] > 0) return { lotSize: lotSizes[u], source };
    } catch { /* fall through */ }
    if (FALLBACK_LOT_SIZES[u]) return { lotSize: FALLBACK_LOT_SIZES[u], source: 'default (today\'s size; past sizes may differ)' };
    return { lotSize: null, source: 'unknown' };
  }

  /** Keep a finished session alongside automated backtests, with the same metrics. */
  async saveSession(userId: string, input: SaveSessionInput): Promise<BacktestResult> {
    const day = (t: string) => t.slice(0, 10);
    const trades = input.trades.map((t) => ({
      entryDate: day(t.entryTime),
      exitDate: day(t.exitTime),
      entryPrice: t.entryPrice,
      exitPrice: t.exitPrice,
      qty: t.qty,
      side: t.side,
      pnl: Math.round(t.netPnl * 100) / 100,
      pnlPercent: t.entryPrice > 0
        ? Math.round(((t.side === 'LONG' ? t.exitPrice - t.entryPrice : t.entryPrice - t.exitPrice) / t.entryPrice) * 10000) / 100
        : 0,
      // Kept in the log for review; the metrics only read the fields above.
      symbol: t.symbol, entryTime: t.entryTime, exitTime: t.exitTime, charges: t.charges, reason: t.reason,
    }));
    const equityCurve = input.equityCurve.map((p) => ({ date: p.time, value: Math.round(p.value * 100) / 100 }));
    const metrics = computeMetrics(trades, input.initialCapital, equityCurve.map((p) => ({ ...p, date: day(p.date) })));

    return this.prisma.backtestResult.create({
      data: {
        userId,
        strategyId: 'manual_replay',
        strategyParams: JSON.stringify({
          mode: input.mode, symbol: input.symbol, interval: input.interval,
          initialCapital: input.initialCapital, engine: 'manual', notes: input.notes ?? '',
          daily: isDailyInterval(input.interval),
        }),
        dateFrom: new Date(input.from),
        dateTo: new Date(input.to),
        ...metrics,
        equityCurve: JSON.stringify(equityCurve),
        tradeLog: JSON.stringify(trades),
      },
    });
  }
}
