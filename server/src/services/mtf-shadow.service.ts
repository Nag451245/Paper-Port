/**
 * Runs the Rust engine's multi-timeframe scan (5-minute, 15-minute, 1-hour and
 * daily trends must agree) and sends its signals to the shadow book as
 * strategy "mtf". Shadow only: nothing here places or suggests a trade, so it
 * can be measured without changing how the bots trade.
 *
 * Candles: past sessions come from the candle lake (files, no broker call);
 * the market scan supplies today's 5-minute candles; anything the lake lacks
 * is fetched once per stock per day. 15-minute and 1-hour candles are built
 * from 5-minute ones, so every timeframe sees the same prices.
 */
import { createChildLogger } from '../lib/logger.js';
import { istDateStr, istDaysAgo } from '../lib/ist.js';
import { aggregate, readBars } from '../lib/candle-lake.js';
import { engineMultiTimeframeScan, type ScanSignal } from '../lib/rust-engine.js';
import type { HistoricalBar, MarketDataService } from './market-data.service.js';
import type { ShadowBook } from './shadow-book.service.js';

const log = createChildLogger('MtfShadow');

/** Run on 15-minute candle closes, not on every 3-minute market scan. */
const MIN_INTERVAL_MS = 15 * 60_000;
const MAX_SYMBOLS = 25;
/** The engine needs at least 15 candles per timeframe; give it a comfortable window. */
const KEEP = { m5: 150, m15: 120, h1: 120, d1: 250 };

interface Base { day: string; past5: HistoricalBar[]; daily: HistoricalBar[] }

const candle = (b: HistoricalBar) => ({ timestamp: b.timestamp, open: b.open, high: b.high, low: b.low, close: b.close, volume: b.volume });

export class MtfShadowScan {
  private lastRun = 0;
  private base = new Map<string, Base>();

  constructor(
    private readonly market: Pick<MarketDataService, 'getHistory'>,
    private readonly shadow: Pick<ShadowBook, 'record'>,
    private readonly scan: (data: unknown) => Promise<unknown> = (data) => engineMultiTimeframeScan(data),
    private readonly now: () => Date = () => new Date(),
  ) {}

  /** Past sessions for a stock, from the lake when it has them, fetched once a day otherwise. */
  private async history(symbol: string): Promise<Base> {
    const today = istDateStr(this.now());
    const hit = this.base.get(symbol);
    if (hit?.day === today) return hit;
    const yesterday = istDaysAgo(1);
    let past5 = readBars(symbol, '5m', istDaysAgo(21), yesterday);
    if (past5.length < 300) past5 = (await this.market.getHistory(symbol, '5minute', istDaysAgo(21), yesterday).catch(() => [])) ?? [];
    let daily = readBars(symbol, '1d', istDaysAgo(400), yesterday);
    if (daily.length < 60) daily = (await this.market.getHistory(symbol, '1day', istDaysAgo(400), yesterday).catch(() => [])) ?? [];
    const b = { day: today, past5: past5.filter((x) => x.timestamp.slice(0, 10) < today), daily: daily.filter((x) => x.timestamp.slice(0, 10) < today) };
    this.base.set(symbol, b);
    return b;
  }

  /** `stocks`: today's completed 5-minute candles per stock, from the market scan. */
  async run(stocks: { symbol: string; bars5m: HistoricalBar[] }[]): Promise<number> {
    const t = this.now().getTime();
    if (t - this.lastRun < MIN_INTERVAL_MS || !stocks.length) return 0;
    this.lastRun = t;
    if (this.base.size > 2_000) this.base.clear();

    const symbols: Record<string, unknown>[] = [];
    for (const s of stocks.slice(0, MAX_SYMBOLS)) {
      const { past5, daily } = await this.history(s.symbol);
      const byTime = new Map<string, HistoricalBar>();
      for (const b of [...past5, ...s.bars5m]) byTime.set(b.timestamp, b);
      const five = [...byTime.values()].sort((a, b) => (a.timestamp < b.timestamp ? -1 : 1));
      symbols.push({
        symbol: s.symbol,
        candles_5m: five.slice(-KEEP.m5).map(candle),
        candles_15m: aggregate(five, 15).slice(-KEEP.m15).map(candle),
        candles_1h: aggregate(five, 60).slice(-KEEP.h1).map(candle),
        candles_daily: daily.slice(-KEEP.d1).map(candle),
      });
    }

    let out: any;
    try {
      out = await this.scan({ symbols, aggressiveness: 'medium' });
    } catch (err) {
      log.warn({ err: (err as Error).message }, 'Multi-timeframe scan failed');
      return 0;
    }
    const signals: ScanSignal[] = ((out?.signals ?? []) as any[])
      .filter((s) => s.direction === 'LONG' || s.direction === 'SHORT')
      .map((s) => ({
        symbol: s.symbol,
        direction: s.direction === 'LONG' ? 'BUY' : 'SELL',
        confidence: Number(s.confidence) || 0,
        entry: Number(s.entry), stop_loss: Number(s.stop_loss), target: Number(s.target),
        indicators: {}, votes: {},
        strategy: 'mtf',
      }));
    const recorded = await this.shadow.record(signals);
    if (signals.length) log.info({ scanned: symbols.length, signals: signals.length, recorded }, 'Multi-timeframe shadow scan');
    return recorded;
  }
}
