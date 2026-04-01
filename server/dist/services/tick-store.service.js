import { getPrisma } from '../lib/prisma.js';
import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('TickStore');
const FLUSH_INTERVAL_MS = 1_000;
const FLUSH_THRESHOLD = 500;
export class TickStoreService {
    buffer = [];
    flushHandle = null;
    flushing = false;
    append(symbol, exchange, ltp, bid, ask, bidQty, askQty, volume, timestamp) {
        this.buffer.push({
            symbol,
            exchange,
            ltp,
            bid: bid ?? null,
            ask: ask ?? null,
            bidQty: bidQty ?? null,
            askQty: askQty ?? null,
            volume: BigInt(volume),
            timestamp,
        });
        if (this.buffer.length >= FLUSH_THRESHOLD) {
            this.flush().catch(err => log.warn({ err }, 'Threshold flush failed'));
        }
    }
    async flush() {
        if (this.flushing || this.buffer.length === 0)
            return 0;
        this.flushing = true;
        const batch = this.buffer.splice(0);
        try {
            const prisma = getPrisma();
            const result = await prisma.tick.createMany({
                data: batch.map(t => ({
                    symbol: t.symbol,
                    exchange: t.exchange,
                    ltp: t.ltp,
                    bid: t.bid,
                    ask: t.ask,
                    bidQty: t.bidQty,
                    askQty: t.askQty,
                    volume: t.volume,
                    timestamp: t.timestamp,
                })),
                skipDuplicates: true,
            });
            log.debug({ count: result.count }, 'Flushed ticks to DB');
            return result.count;
        }
        catch (err) {
            this.buffer.unshift(...batch);
            log.error({ err, batchSize: batch.length }, 'Tick flush failed — re-queued');
            return 0;
        }
        finally {
            this.flushing = false;
        }
    }
    async query(symbol, from, to, limit = 1000) {
        const prisma = getPrisma();
        return prisma.tick.findMany({
            where: {
                symbol,
                timestamp: { gte: from, lte: to },
            },
            orderBy: { timestamp: 'asc' },
            take: limit,
        });
    }
    async getLatestTick(symbol) {
        const prisma = getPrisma();
        return prisma.tick.findFirst({
            where: { symbol },
            orderBy: { timestamp: 'desc' },
        });
    }
    startAutoFlush() {
        if (this.flushHandle)
            return;
        this.flushHandle = setInterval(() => {
            this.flush().catch(err => log.warn({ err }, 'Auto-flush failed'));
        }, FLUSH_INTERVAL_MS);
        log.info('Auto-flush started');
    }
    stopAutoFlush() {
        if (this.flushHandle) {
            clearInterval(this.flushHandle);
            this.flushHandle = null;
        }
        this.flush().catch(err => log.warn({ err }, 'Final flush on stop failed'));
        log.info('Auto-flush stopped');
    }
    getBufferSize() {
        return this.buffer.length;
    }
}
//# sourceMappingURL=tick-store.service.js.map