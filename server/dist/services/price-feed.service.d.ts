import { PrismaClient } from '@prisma/client';
import type { DataPipelineService } from './data-pipeline.service.js';
import { TickStoreService } from './tick-store.service.js';
import { OrderBookService } from './order-book.service.js';
export declare class PriceFeedService {
    private intervalHandle;
    private pnlPersistHandle;
    private marketData;
    private calendar;
    private prisma;
    private dataPipeline;
    private lastPrices;
    private candleBuilders;
    private running;
    private tickStore;
    private orderBook;
    constructor(prisma?: PrismaClient, dataPipeline?: DataPipelineService);
    start(): void;
    stop(): void;
    isRunning(): boolean;
    getActiveSymbolCount(): number;
    getLastPrice(symbol: string): number | undefined;
    getAllLastPrices(): Record<string, number>;
    getTickStore(): TickStoreService;
    getOrderBook(): OrderBookService;
    private tick;
    private persistUnrealizedPnl;
    private updateCandleBuilder;
    private persistBuiltCandle;
}
//# sourceMappingURL=price-feed.service.d.ts.map