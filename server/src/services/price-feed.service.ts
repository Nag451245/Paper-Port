import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { wsHub } from '../lib/websocket.js';
import { MarketCalendar } from './market-calendar.js';
import { emit } from '../lib/event-bus.js';
import type { DataPipelineService } from './data-pipeline.service.js';
import { createChildLogger } from '../lib/logger.js';

const pfLog = createChildLogger('PriceFeed');
const FEED_INTERVAL_MS = 2_000;
const PNL_PERSIST_INTERVAL_MS = 30_000;
const CANDLE_INTERVAL_MS = 5 * 60_000;
const MAX_SYMBOLS_PER_BATCH = 25;

interface CandleBuilder {
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bucketStart: number;
}

export class PriceFeedService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private pnlPersistHandle: ReturnType<typeof setInterval> | null = null;
  private marketData: MarketDataService;
  private calendar: MarketCalendar;
  private prisma: PrismaClient;
  private dataPipeline: DataPipelineService | null = null;
  private lastPrices = new Map<string, { ltp: number; volume: number; timestamp: number }>();
  private candleBuilders = new Map<string, CandleBuilder>();
  private running = false;

  constructor(prisma?: PrismaClient, dataPipeline?: DataPipelineService) {
    this.marketData = new MarketDataService();
    this.calendar = new MarketCalendar();
    this.prisma = prisma ?? new PrismaClient();
    this.dataPipeline = dataPipeline ?? null;
  }

  start(): void {
    if (this.intervalHandle) return;
    this.running = true;

    console.log(`[PriceFeed] Starting — broadcasting every ${FEED_INTERVAL_MS}ms`);

    this.intervalHandle = setInterval(() => {
      this.tick().catch(err =>
        console.error('[PriceFeed] Tick error:', err.message)
      );
    }, FEED_INTERVAL_MS);

    this.pnlPersistHandle = setInterval(() => {
      this.persistUnrealizedPnl().catch(err =>
        console.error('[PriceFeed] P&L persist error:', err.message)
      );
    }, PNL_PERSIST_INTERVAL_MS);
  }

  stop(): void {
    this.running = false;
    if (this.intervalHandle) {
      clearInterval(this.intervalHandle);
      this.intervalHandle = null;
    }
    if (this.pnlPersistHandle) {
      clearInterval(this.pnlPersistHandle);
      this.pnlPersistHandle = null;
    }
    console.log('[PriceFeed] Stopped');
  }

  isRunning(): boolean { return this.running; }

  getActiveSymbolCount(): number {
    return wsHub.getSubscribedSymbols().length;
  }

  getLastPrice(symbol: string): number | undefined {
    return this.lastPrices.get(symbol)?.ltp;
  }

  getAllLastPrices(): Record<string, number> {
    const out: Record<string, number> = {};
    for (const [sym, data] of this.lastPrices) {
      out[sym] = data.ltp;
    }
    return out;
  }

  private async tick(): Promise<void> {
    const subscribedSymbols = wsHub.getSubscribedSymbols();
    if (subscribedSymbols.length === 0) return;

    // During non-market hours, reduce polling frequency
    if (!this.calendar.isMarketOpen()) {
      const now = Date.now();
      const lastTick = this.lastPrices.values().next().value?.timestamp ?? 0;
      if (now - lastTick < 60_000) return;
    }

    const batches: string[][] = [];
    for (let i = 0; i < subscribedSymbols.length; i += MAX_SYMBOLS_PER_BATCH) {
      batches.push(subscribedSymbols.slice(i, i + MAX_SYMBOLS_PER_BATCH));
    }

    await Promise.allSettled(
      batches.map(batch =>
        Promise.allSettled(
          batch.map(async symbol => {
            try {
              const quote = await this.marketData.getQuote(symbol);
              if (quote.ltp <= 0) return;

              const prev = this.lastPrices.get(symbol);
              const changed = !prev || prev.ltp !== quote.ltp || prev.volume !== quote.volume;

              if (changed) {
                const now = Date.now();
                const priceData = {
                  ltp: quote.ltp,
                  change: quote.change,
                  changePercent: quote.changePercent,
                  volume: quote.volume,
                  timestamp: new Date().toISOString(),
                };

                wsHub.broadcastPriceUpdate(symbol, priceData);
                this.lastPrices.set(symbol, { ltp: quote.ltp, volume: quote.volume, timestamp: now });

                this.dataPipeline?.publishTick(symbol, quote.ltp, quote.volume, now).catch(err => pfLog.warn({ err, symbol }, 'Failed to publish tick to pipeline'));

                this.updateCandleBuilder(symbol, quote.ltp, quote.volume, now);

                emit('market-data', {
                  type: 'TICK_RECEIVED', symbol, ltp: quote.ltp,
                  change: quote.change, volume: quote.volume,
                  timestamp: priceData.timestamp,
                }).catch(err => pfLog.warn({ err, symbol }, 'Failed to emit TICK_RECEIVED event'));
              }
            } catch {}
          })
        )
      )
    );
  }

  private async persistUnrealizedPnl(): Promise<void> {
    if (!this.calendar.isMarketOpen()) return;

    try {
      const openPositions = await this.prisma.position.findMany({
        where: { status: 'OPEN' },
        select: { id: true, symbol: true, exchange: true, side: true, qty: true, avgEntryPrice: true },
      });

      if (openPositions.length === 0) return;

      let updatedCount = 0;
      for (const pos of openPositions) {
        try {
          const cached = this.lastPrices.get(pos.symbol);
          let ltp = cached?.ltp ?? 0;

          if (ltp <= 0) {
            const quote = await this.marketData.getQuote(pos.symbol, pos.exchange);
            ltp = quote.ltp;
          }

          if (ltp <= 0) continue;

          const entryPrice = Number(pos.avgEntryPrice);
          const unrealizedPnl = pos.side === 'LONG'
            ? (ltp - entryPrice) * pos.qty
            : (entryPrice - ltp) * pos.qty;

          await this.prisma.position.update({
            where: { id: pos.id },
            data: { unrealizedPnl },
          });
          updatedCount++;
        } catch {}
      }

      // NOTE: Do NOT touch portfolio.currentNav here.
      // currentNav represents available CASH and is only modified by handleFill (buy/sell).
      // The frontend computes display NAV as: currentNav + sum(position market values).
    } catch (err) {
      console.error('[PriceFeed] persistUnrealizedPnl failed:', (err as Error).message);
    }
  }

  private updateCandleBuilder(symbol: string, ltp: number, volume: number, now: number): void {
    const bucketStart = Math.floor(now / CANDLE_INTERVAL_MS) * CANDLE_INTERVAL_MS;
    const existing = this.candleBuilders.get(symbol);

    if (!existing || existing.bucketStart !== bucketStart) {
      // New 5-minute bucket — persist the old candle if it exists
      if (existing && existing.close > 0) {
        this.persistBuiltCandle(symbol, existing).catch(err => pfLog.warn({ err, symbol }, 'Failed to persist candle'));
      }
      this.candleBuilders.set(symbol, {
        open: ltp, high: ltp, low: ltp, close: ltp,
        volume, bucketStart,
      });
    } else {
      existing.high = Math.max(existing.high, ltp);
      existing.low = Math.min(existing.low, ltp);
      existing.close = ltp;
      existing.volume += volume;
    }
  }

  private async persistBuiltCandle(symbol: string, candle: CandleBuilder): Promise<void> {
    try {
      await this.prisma.candleStore.upsert({
        where: {
          symbol_exchange_interval_timestamp: {
            symbol, exchange: 'NSE', interval: '5m',
            timestamp: new Date(candle.bucketStart),
          },
        },
        create: {
          symbol, exchange: 'NSE', interval: '5m',
          timestamp: new Date(candle.bucketStart),
          open: candle.open, high: candle.high,
          low: candle.low, close: candle.close,
          volume: candle.volume,
        },
        update: {
          open: candle.open, high: candle.high,
          low: candle.low, close: candle.close,
          volume: candle.volume,
        },
      });
    } catch {
      // Non-critical — don't block real-time feed
    }
  }
}
