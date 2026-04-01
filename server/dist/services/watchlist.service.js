import { MarketDataService } from './market-data.service.js';
export class WatchlistService {
    prisma;
    marketData = new MarketDataService();
    constructor(prisma) {
        this.prisma = prisma;
    }
    async list(userId) {
        const watchlists = await this.prisma.watchlist.findMany({
            where: { userId },
            include: { items: true },
            orderBy: { createdAt: 'desc' },
        });
        // Enrich all watchlist items in parallel (best effort, non-blocking)
        await Promise.all(watchlists.map(async (wl) => {
            const enriched = await Promise.all(wl.items.map(async (item) => {
                try {
                    const quote = await this.marketData.getQuote(item.symbol, item.exchange);
                    return {
                        ...item,
                        ltp: quote.ltp,
                        change: quote.change,
                        changePercent: quote.changePercent,
                        volume: quote.volume ?? 0,
                    };
                }
                catch {
                    return { ...item, ltp: 0, change: 0, changePercent: 0, volume: 0 };
                }
            }));
            wl.items = enriched;
        }));
        return watchlists;
    }
    async create(userId, name) {
        return this.prisma.watchlist.create({
            data: { userId, name },
            include: { items: true },
        });
    }
    async getById(watchlistId, userId) {
        const watchlist = await this.prisma.watchlist.findUnique({
            where: { id: watchlistId },
            include: { items: true },
        });
        if (!watchlist || watchlist.userId !== userId) {
            throw new WatchlistError('Watchlist not found', 404);
        }
        return watchlist;
    }
    async addItem(watchlistId, userId, symbol, exchange) {
        await this.getById(watchlistId, userId);
        const existing = await this.prisma.watchlistItem.findFirst({
            where: { watchlistId, symbol, exchange: exchange },
        });
        if (existing) {
            throw new WatchlistError('Symbol already in watchlist', 409);
        }
        return this.prisma.watchlistItem.create({
            data: {
                watchlistId,
                symbol,
                exchange: exchange,
            },
        });
    }
    async removeItem(watchlistId, itemId, userId) {
        await this.getById(watchlistId, userId);
        const item = await this.prisma.watchlistItem.findUnique({
            where: { id: itemId },
        });
        if (!item || item.watchlistId !== watchlistId) {
            throw new WatchlistError('Item not found', 404);
        }
        return this.prisma.watchlistItem.delete({ where: { id: itemId } });
    }
    async deleteWatchlist(watchlistId, userId) {
        await this.getById(watchlistId, userId);
        return this.prisma.watchlist.delete({ where: { id: watchlistId } });
    }
}
export class WatchlistError extends Error {
    statusCode;
    constructor(message, statusCode) {
        super(message);
        this.statusCode = statusCode;
        this.name = 'WatchlistError';
    }
}
//# sourceMappingURL=watchlist.service.js.map