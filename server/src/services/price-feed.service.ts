import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { wsHub } from '../lib/websocket.js';
import { MarketCalendar } from './market-calendar.js';

const FEED_INTERVAL_MS = 2_000;
const PNL_PERSIST_INTERVAL_MS = 30_000;
const MAX_SYMBOLS_PER_BATCH = 25;

export class PriceFeedService {
  private intervalHandle: ReturnType<typeof setInterval> | null = null;
  private pnlPersistHandle: ReturnType<typeof setInterval> | null = null;
  private marketData: MarketDataService;
  private calendar: MarketCalendar;
  private prisma: PrismaClient;
  private lastPrices = new Map<string, { ltp: number; volume: number; timestamp: number }>();
  private running = false;

  constructor(prisma?: PrismaClient) {
    this.marketData = new MarketDataService();
    this.calendar = new MarketCalendar();
    this.prisma = prisma ?? new PrismaClient();
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

    for (const batch of batches) {
      await Promise.allSettled(
        batch.map(async symbol => {
          try {
            const quote = await this.marketData.getQuote(symbol);
            if (quote.ltp <= 0) return;

            const prev = this.lastPrices.get(symbol);
            const changed = !prev || prev.ltp !== quote.ltp || prev.volume !== quote.volume;

            if (changed) {
              const priceData = {
                ltp: quote.ltp,
                change: quote.change,
                changePercent: quote.changePercent,
                volume: quote.volume,
                timestamp: new Date().toISOString(),
              };

              wsHub.broadcastPriceUpdate(symbol, priceData);
              this.lastPrices.set(symbol, { ltp: quote.ltp, volume: quote.volume, timestamp: Date.now() });
            }
          } catch {}
        })
      );
    }
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

      if (updatedCount > 0) {
        // Also update portfolio NAV with current position values
        const portfolios = await this.prisma.portfolio.findMany({
          select: { id: true, initialCapital: true },
        });

        for (const pf of portfolios) {
          const positions = await this.prisma.position.findMany({
            where: { portfolioId: pf.id, status: 'OPEN' },
            select: { unrealizedPnl: true, avgEntryPrice: true, qty: true, side: true },
          });

          const realizedTrades = await this.prisma.trade.findMany({
            where: { portfolioId: pf.id },
            select: { netPnl: true },
          });

          const totalRealized = realizedTrades.reduce((s, t) => s + Number(t.netPnl), 0);
          const totalUnrealized = positions.reduce((s, p) => s + Number(p.unrealizedPnl ?? 0), 0);
          const totalInvested = positions.reduce((s, p) => s + Number(p.avgEntryPrice) * p.qty, 0);
          const nav = Number(pf.initialCapital) + totalRealized + totalUnrealized - totalInvested
            + positions.reduce((s, p) => s + Number(p.avgEntryPrice) * p.qty, 0);

          await this.prisma.portfolio.update({
            where: { id: pf.id },
            data: { currentNav: Number(pf.initialCapital) + totalRealized + totalUnrealized },
          }).catch(() => {});
        }
      }
    } catch (err) {
      console.error('[PriceFeed] persistUnrealizedPnl failed:', (err as Error).message);
    }
  }
}
