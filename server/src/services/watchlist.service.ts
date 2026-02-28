import { PrismaClient } from '@prisma/client';

export class WatchlistService {
  constructor(private prisma: PrismaClient) {}

  async list(userId: string) {
    return this.prisma.watchlist.findMany({
      where: { userId },
      include: { items: true },
      orderBy: { createdAt: 'desc' },
    });
  }

  async create(userId: string, name: string) {
    return this.prisma.watchlist.create({
      data: { userId, name },
      include: { items: true },
    });
  }

  async getById(watchlistId: string, userId: string) {
    const watchlist = await this.prisma.watchlist.findUnique({
      where: { id: watchlistId },
      include: { items: true },
    });

    if (!watchlist || watchlist.userId !== userId) {
      throw new WatchlistError('Watchlist not found', 404);
    }

    return watchlist;
  }

  async addItem(watchlistId: string, userId: string, symbol: string, exchange: string) {
    await this.getById(watchlistId, userId);

    const existing = await this.prisma.watchlistItem.findFirst({
      where: { watchlistId, symbol, exchange: exchange as any },
    });

    if (existing) {
      throw new WatchlistError('Symbol already in watchlist', 409);
    }

    return this.prisma.watchlistItem.create({
      data: {
        watchlistId,
        symbol,
        exchange: exchange as any,
      },
    });
  }

  async removeItem(watchlistId: string, itemId: string, userId: string) {
    await this.getById(watchlistId, userId);

    const item = await this.prisma.watchlistItem.findUnique({
      where: { id: itemId },
    });

    if (!item || item.watchlistId !== watchlistId) {
      throw new WatchlistError('Item not found', 404);
    }

    return this.prisma.watchlistItem.delete({ where: { id: itemId } });
  }

  async deleteWatchlist(watchlistId: string, userId: string) {
    await this.getById(watchlistId, userId);
    return this.prisma.watchlist.delete({ where: { id: watchlistId } });
  }
}

export class WatchlistError extends Error {
  constructor(
    message: string,
    public statusCode: number,
  ) {
    super(message);
    this.name = 'WatchlistError';
  }
}
