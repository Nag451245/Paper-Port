import { getPrisma } from '../lib/prisma.js';
import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('HistoricalData');

const FETCH_TIMEOUT_MS = 10_000;
const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';

const INTERVAL_MAP: Record<string, string> = {
  '1m': '1m', '1min': '1m', 'minute': '1m',
  '5m': '5m', '5min': '5m',
  '15m': '15m', '15min': '15m',
  '30m': '30m', '30min': '30m',
  '1h': '1h', '60m': '1h',
  '1d': '1d', 'daily': '1d', 'day': '1d',
  '1wk': '1wk', 'weekly': '1wk',
  '1mo': '1mo', 'monthly': '1mo',
};

export interface HistoricalBarRecord {
  id: string;
  symbol: string;
  exchange: string;
  timeframe: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: bigint;
  adjClose: number | null;
  timestamp: Date;
}

export interface AdjustedPoint {
  timestamp: Date;
  close: number;
  adjClose: number;
}

export class HistoricalDataService {
  async fetchAndStore(
    symbol: string,
    exchange: string,
    timeframe: string,
    startDate: Date,
    endDate: Date,
  ): Promise<number> {
    const yahooSymbol = toYahooSymbol(symbol, exchange);
    const interval = INTERVAL_MAP[timeframe.toLowerCase()] ?? '1d';
    const period1 = Math.floor(startDate.getTime() / 1000);
    const period2 = Math.floor(endDate.getTime() / 1000);

    const url = `https://query1.finance.yahoo.com/v8/finance/chart/${yahooSymbol}?period1=${period1}&period2=${period2}&interval=${interval}`;

    log.info({ symbol, exchange, timeframe, startDate, endDate }, 'Fetching from Yahoo Finance');

    const res = await fetch(url, {
      headers: { 'User-Agent': USER_AGENT },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });

    if (!res.ok) {
      log.warn({ status: res.status, symbol }, 'Yahoo Finance returned non-OK status');
      return 0;
    }

    const json = await res.json() as any;
    const result = json?.chart?.result?.[0];
    if (!result) {
      log.warn({ symbol }, 'No chart data in Yahoo response');
      return 0;
    }

    const timestamps: number[] = result.timestamp ?? [];
    const quote = result.indicators?.quote?.[0] ?? {};
    const adjClose: number[] = result.indicators?.adjclose?.[0]?.adjclose ?? [];

    const prisma = getPrisma();
    let upsertCount = 0;

    for (let i = 0; i < timestamps.length; i++) {
      const o = quote.open?.[i];
      const h = quote.high?.[i];
      const l = quote.low?.[i];
      const c = quote.close?.[i];
      const v = quote.volume?.[i] ?? 0;

      if (o == null || c == null) continue;

      const barTimestamp = new Date(timestamps[i] * 1000);

      try {
        await prisma.historicalBar.upsert({
          where: {
            symbol_exchange_timeframe_timestamp: {
              symbol,
              exchange,
              timeframe,
              timestamp: barTimestamp,
            },
          },
          create: {
            symbol,
            exchange,
            timeframe,
            open: o,
            high: h ?? o,
            low: l ?? o,
            close: c,
            volume: BigInt(v),
            adjClose: adjClose[i] ?? null,
            timestamp: barTimestamp,
          },
          update: {
            open: o,
            high: h ?? o,
            low: l ?? o,
            close: c,
            volume: BigInt(v),
            adjClose: adjClose[i] ?? null,
          },
        });
        upsertCount++;
      } catch (err) {
        log.warn({ err, symbol, timestamp: barTimestamp }, 'Failed to upsert bar');
      }
    }

    log.info({ symbol, exchange, timeframe, upsertCount }, 'Stored historical bars');
    return upsertCount;
  }

  async getHistory(
    symbol: string,
    exchange: string,
    timeframe: string,
    startDate: Date,
    endDate: Date,
  ): Promise<HistoricalBarRecord[]> {
    const prisma = getPrisma();

    const bars = await prisma.historicalBar.findMany({
      where: {
        symbol,
        exchange,
        timeframe,
        timestamp: { gte: startDate, lte: endDate },
      },
      orderBy: { timestamp: 'asc' },
    });

    if (bars.length > 0) {
      return bars as HistoricalBarRecord[];
    }

    log.info({ symbol, exchange, timeframe }, 'Cache miss — fetching from Yahoo');
    await this.fetchAndStore(symbol, exchange, timeframe, startDate, endDate);

    return (await prisma.historicalBar.findMany({
      where: {
        symbol,
        exchange,
        timeframe,
        timestamp: { gte: startDate, lte: endDate },
      },
      orderBy: { timestamp: 'asc' },
    })) as HistoricalBarRecord[];
  }

  adjustForCorporateActions(
    symbol: string,
    bars: HistoricalBarRecord[],
    actions: { ratio: number | null; exDate: Date }[],
  ): HistoricalBarRecord[] {
    if (actions.length === 0) return bars;

    const sorted = [...actions]
      .filter(a => a.ratio != null && a.ratio > 0)
      .sort((a, b) => b.exDate.getTime() - a.exDate.getTime());

    return bars.map(bar => {
      let adjustmentFactor = 1;
      for (const action of sorted) {
        if (bar.timestamp < action.exDate) {
          adjustmentFactor *= action.ratio!;
        }
      }

      if (adjustmentFactor === 1) return bar;

      return {
        ...bar,
        open: Number((bar.open * adjustmentFactor).toFixed(2)),
        high: Number((bar.high * adjustmentFactor).toFixed(2)),
        low: Number((bar.low * adjustmentFactor).toFixed(2)),
        close: Number((bar.close * adjustmentFactor).toFixed(2)),
        adjClose: bar.adjClose != null
          ? Number((bar.adjClose * adjustmentFactor).toFixed(2))
          : Number((bar.close * adjustmentFactor).toFixed(2)),
      };
    });
  }

  async getAdjustedSeries(
    symbol: string,
    exchange: string,
    startDate: Date,
    endDate: Date,
  ): Promise<AdjustedPoint[]> {
    const bars = await this.getHistory(symbol, exchange, '1d', startDate, endDate);
    if (bars.length === 0) return [];

    const prisma = getPrisma();
    const actions = await prisma.corporateAction.findMany({
      where: {
        symbol,
        exDate: { lte: endDate },
      },
      orderBy: { exDate: 'asc' },
    });

    const adjusted = this.adjustForCorporateActions(symbol, bars, actions);

    return adjusted.map(bar => ({
      timestamp: bar.timestamp,
      close: bar.close,
      adjClose: bar.adjClose ?? bar.close,
    }));
  }

  async recordCorporateAction(
    symbol: string,
    actionType: string,
    ratio: number | null,
    exDate: Date,
    details?: Record<string, unknown>,
  ): Promise<void> {
    const prisma = getPrisma();
    await prisma.corporateAction.create({
      data: {
        symbol,
        actionType,
        ratio,
        exDate,
        details: details ? (details as any) : undefined,
      },
    });
    log.info({ symbol, actionType, ratio, exDate }, 'Recorded corporate action');
  }
}

function toYahooSymbol(symbol: string, exchange: string): string {
  const upper = symbol.toUpperCase();
  if (upper.endsWith('.NS') || upper.endsWith('.BO') || upper.startsWith('^')) return upper;
  const encoded = upper.replace('&', '%26');
  return exchange.toUpperCase() === 'BSE' ? `${encoded}.BO` : `${encoded}.NS`;
}
