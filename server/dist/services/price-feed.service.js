import { PrismaClient } from '@prisma/client';
import { MarketDataService } from './market-data.service.js';
import { wsHub } from '../lib/websocket.js';
import { MarketCalendar } from './market-calendar.js';
import { emit } from '../lib/event-bus.js';
import { createChildLogger } from '../lib/logger.js';
import { TickStoreService } from './tick-store.service.js';
import { OrderBookService } from './order-book.service.js';
const pfLog = createChildLogger('PriceFeed');
const FEED_INTERVAL_MS = 2_000;
const PNL_PERSIST_INTERVAL_MS = 30_000;
const CANDLE_INTERVAL_MS = 5 * 60_000;
const MAX_SYMBOLS_PER_BATCH = 25;
export class PriceFeedService {
    intervalHandle = null;
    pnlPersistHandle = null;
    marketData;
    calendar;
    prisma;
    dataPipeline = null;
    lastPrices = new Map();
    candleBuilders = new Map();
    running = false;
    tickStore;
    orderBook;
    constructor(prisma, dataPipeline) {
        this.marketData = new MarketDataService();
        this.calendar = new MarketCalendar();
        this.prisma = prisma ?? new PrismaClient();
        this.dataPipeline = dataPipeline ?? null;
        this.tickStore = new TickStoreService();
        this.orderBook = new OrderBookService();
    }
    start() {
        if (this.intervalHandle)
            return;
        this.running = true;
        this.tickStore.startAutoFlush();
        console.log(`[PriceFeed] Starting — broadcasting every ${FEED_INTERVAL_MS}ms`);
        this.intervalHandle = setInterval(() => {
            this.tick().catch(err => console.error('[PriceFeed] Tick error:', err.message));
        }, FEED_INTERVAL_MS);
        this.pnlPersistHandle = setInterval(() => {
            this.persistUnrealizedPnl().catch(err => console.error('[PriceFeed] P&L persist error:', err.message));
        }, PNL_PERSIST_INTERVAL_MS);
    }
    stop() {
        this.running = false;
        if (this.intervalHandle) {
            clearInterval(this.intervalHandle);
            this.intervalHandle = null;
        }
        if (this.pnlPersistHandle) {
            clearInterval(this.pnlPersistHandle);
            this.pnlPersistHandle = null;
        }
        this.tickStore.stopAutoFlush();
        console.log('[PriceFeed] Stopped');
    }
    isRunning() { return this.running; }
    getActiveSymbolCount() {
        return wsHub.getSubscribedSymbols().length;
    }
    getLastPrice(symbol) {
        return this.lastPrices.get(symbol)?.ltp;
    }
    getAllLastPrices() {
        const out = {};
        for (const [sym, data] of this.lastPrices) {
            out[sym] = data.ltp;
        }
        return out;
    }
    getTickStore() { return this.tickStore; }
    getOrderBook() { return this.orderBook; }
    async tick() {
        const subscribedSymbols = wsHub.getSubscribedSymbols();
        if (subscribedSymbols.length === 0)
            return;
        // During non-market hours, reduce polling frequency
        if (!this.calendar.isMarketOpen()) {
            const now = Date.now();
            const lastTick = this.lastPrices.values().next().value?.timestamp ?? 0;
            if (now - lastTick < 60_000)
                return;
        }
        const batches = [];
        for (let i = 0; i < subscribedSymbols.length; i += MAX_SYMBOLS_PER_BATCH) {
            batches.push(subscribedSymbols.slice(i, i + MAX_SYMBOLS_PER_BATCH));
        }
        await Promise.allSettled(batches.map(batch => Promise.allSettled(batch.map(async (symbol) => {
            try {
                const quote = await this.marketData.getQuote(symbol);
                if (quote.ltp <= 0)
                    return;
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
                    this.tickStore.append(symbol, 'NSE', quote.ltp, undefined, undefined, undefined, undefined, quote.volume, new Date(now));
                    this.orderBook.updateFromTick(symbol, quote.ltp, undefined, undefined, undefined, undefined, quote.volume);
                    emit('market-data', {
                        type: 'TICK_RECEIVED', symbol, ltp: quote.ltp,
                        change: quote.change, volume: quote.volume,
                        timestamp: priceData.timestamp,
                    }).catch(err => pfLog.warn({ err, symbol }, 'Failed to emit TICK_RECEIVED event'));
                }
            }
            catch { }
        }))));
    }
    async persistUnrealizedPnl() {
        if (!this.calendar.isMarketOpen())
            return;
        try {
            const openPositions = await this.prisma.position.findMany({
                where: { status: 'OPEN' },
                select: { id: true, symbol: true, exchange: true, side: true, qty: true, avgEntryPrice: true },
            });
            if (openPositions.length === 0)
                return;
            let updatedCount = 0;
            for (const pos of openPositions) {
                try {
                    const cached = this.lastPrices.get(pos.symbol);
                    let ltp = cached?.ltp ?? 0;
                    if (ltp <= 0) {
                        const quote = await this.marketData.getQuote(pos.symbol, pos.exchange);
                        ltp = quote.ltp;
                    }
                    if (ltp <= 0)
                        continue;
                    const entryPrice = Number(pos.avgEntryPrice);
                    const unrealizedPnl = pos.side === 'LONG'
                        ? (ltp - entryPrice) * pos.qty
                        : (entryPrice - ltp) * pos.qty;
                    await this.prisma.position.update({
                        where: { id: pos.id },
                        data: { unrealizedPnl },
                    });
                    updatedCount++;
                }
                catch { }
            }
            // NOTE: Do NOT touch portfolio.currentNav here.
            // currentNav represents available CASH and is only modified by handleFill (buy/sell).
            // The frontend computes display NAV as: currentNav + sum(position market values).
        }
        catch (err) {
            console.error('[PriceFeed] persistUnrealizedPnl failed:', err.message);
        }
    }
    updateCandleBuilder(symbol, ltp, volume, now) {
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
        }
        else {
            existing.high = Math.max(existing.high, ltp);
            existing.low = Math.min(existing.low, ltp);
            existing.close = ltp;
            existing.volume += volume;
        }
    }
    async persistBuiltCandle(symbol, candle) {
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
        }
        catch {
            // Non-critical — don't block real-time feed
        }
    }
}
//# sourceMappingURL=price-feed.service.js.map