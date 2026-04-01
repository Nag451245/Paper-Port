import { PrismaClient } from '@prisma/client';
export declare class WatchlistService {
    private prisma;
    private marketData;
    constructor(prisma: PrismaClient);
    list(userId: string): Promise<({
        items: {
            symbol: string;
            id: string;
            exchange: string;
            instrumentToken: string | null;
            watchlistId: string;
            addedAt: Date;
        }[];
    } & {
        name: string;
        id: string;
        createdAt: Date;
        isDefault: boolean;
        userId: string;
    })[]>;
    create(userId: string, name: string): Promise<{
        items: {
            symbol: string;
            id: string;
            exchange: string;
            instrumentToken: string | null;
            watchlistId: string;
            addedAt: Date;
        }[];
    } & {
        name: string;
        id: string;
        createdAt: Date;
        isDefault: boolean;
        userId: string;
    }>;
    getById(watchlistId: string, userId: string): Promise<{
        items: {
            symbol: string;
            id: string;
            exchange: string;
            instrumentToken: string | null;
            watchlistId: string;
            addedAt: Date;
        }[];
    } & {
        name: string;
        id: string;
        createdAt: Date;
        isDefault: boolean;
        userId: string;
    }>;
    addItem(watchlistId: string, userId: string, symbol: string, exchange: string): Promise<{
        symbol: string;
        id: string;
        exchange: string;
        instrumentToken: string | null;
        watchlistId: string;
        addedAt: Date;
    }>;
    removeItem(watchlistId: string, itemId: string, userId: string): Promise<{
        symbol: string;
        id: string;
        exchange: string;
        instrumentToken: string | null;
        watchlistId: string;
        addedAt: Date;
    }>;
    deleteWatchlist(watchlistId: string, userId: string): Promise<{
        name: string;
        id: string;
        createdAt: Date;
        isDefault: boolean;
        userId: string;
    }>;
}
export declare class WatchlistError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number);
}
//# sourceMappingURL=watchlist.service.d.ts.map