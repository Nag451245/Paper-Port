import { PrismaClient } from '@prisma/client';
import { OrderManagementService } from './oms.service.js';
import { ExecutionEngineService } from './execution-engine.service.js';
type OrderSide = string;
type OrderType = string;
type Exchange = string;
export interface PlaceOrderInput {
    portfolioId: string;
    symbol: string;
    side: OrderSide;
    orderType: OrderType;
    qty: number;
    price?: number;
    triggerPrice?: number;
    instrumentToken: string;
    exchange?: Exchange;
    strategyTag?: string;
    expiry?: string;
    strike?: number;
    optionType?: 'CE' | 'PE';
    stopLoss?: number;
    target?: number;
}
export declare class TradeService {
    private prisma;
    private marketData;
    private calendar;
    private riskService;
    private broker;
    private oms;
    private _twapExecutor;
    private fillSimulator;
    private smartRouter;
    private executionEngine;
    constructor(prisma: PrismaClient, oms?: OrderManagementService);
    private getTwapExecutor;
    isLiveMode(): boolean;
    getExecutionStats(): {
        latency: ReturnType<ExecutionEngineService['getLatencyStats']>;
        queueDepth: number;
    };
    executeLiveOrder(input: PlaceOrderInput): Promise<{
        orderId: string;
        status: string;
        brokerOrderId?: string;
    }>;
    getBrokerPositions(): Promise<{
        symbol: string;
        qty: number;
        avgPrice: number;
        ltp: number;
        pnl: number;
        product: string;
    }[]>;
    getBrokerMargin(): Promise<{
        available: number;
        used: number;
        total: number;
    }>;
    getTotalInvestedValue(portfolioId: string): Promise<number>;
    recoverCapital(portfolioId: string, userId: string, amountNeeded: number): Promise<{
        recovered: number;
        closedPositions: string[];
    }>;
    placeOrder(userId: string, input: PlaceOrderInput, skipMarketCheck?: boolean): Promise<any>;
    private shortMarginRequired;
    private safeUpdateNav;
    private handleFill;
    private handleBuyFill;
    private openLongPosition;
    private handleSellFill;
    private openShortPosition;
    cancelOrder(orderId: string, userId: string): Promise<{
        symbol: string;
        status: string;
        id: string;
        createdAt: Date;
        exchange: string;
        portfolioId: string;
        instrumentToken: string;
        qty: number;
        side: string;
        strategyTag: string | null;
        positionId: string | null;
        orderType: string;
        price: import("@prisma/client/runtime/library").Decimal | null;
        triggerPrice: import("@prisma/client/runtime/library").Decimal | null;
        filledQty: number;
        avgFillPrice: import("@prisma/client/runtime/library").Decimal | null;
        brokerage: import("@prisma/client/runtime/library").Decimal;
        stt: import("@prisma/client/runtime/library").Decimal;
        exchangeCharges: import("@prisma/client/runtime/library").Decimal;
        gst: import("@prisma/client/runtime/library").Decimal;
        sebiCharges: import("@prisma/client/runtime/library").Decimal;
        stampDuty: import("@prisma/client/runtime/library").Decimal;
        totalCost: import("@prisma/client/runtime/library").Decimal;
        idealPrice: import("@prisma/client/runtime/library").Decimal | null;
        slippageBps: import("@prisma/client/runtime/library").Decimal | null;
        fillLatencyMs: number | null;
        spreadCostBps: import("@prisma/client/runtime/library").Decimal | null;
        impactCost: import("@prisma/client/runtime/library").Decimal | null;
        brokerOrderId: string | null;
        filledAt: Date | null;
    } | null>;
    listOrders(userId: string, params?: {
        status?: string;
        page?: number;
        limit?: number;
    }): Promise<{
        orders: {
            symbol: string;
            status: string;
            id: string;
            createdAt: Date;
            exchange: string;
            portfolioId: string;
            instrumentToken: string;
            qty: number;
            side: string;
            strategyTag: string | null;
            positionId: string | null;
            orderType: string;
            price: import("@prisma/client/runtime/library").Decimal | null;
            triggerPrice: import("@prisma/client/runtime/library").Decimal | null;
            filledQty: number;
            avgFillPrice: import("@prisma/client/runtime/library").Decimal | null;
            brokerage: import("@prisma/client/runtime/library").Decimal;
            stt: import("@prisma/client/runtime/library").Decimal;
            exchangeCharges: import("@prisma/client/runtime/library").Decimal;
            gst: import("@prisma/client/runtime/library").Decimal;
            sebiCharges: import("@prisma/client/runtime/library").Decimal;
            stampDuty: import("@prisma/client/runtime/library").Decimal;
            totalCost: import("@prisma/client/runtime/library").Decimal;
            idealPrice: import("@prisma/client/runtime/library").Decimal | null;
            slippageBps: import("@prisma/client/runtime/library").Decimal | null;
            fillLatencyMs: number | null;
            spreadCostBps: import("@prisma/client/runtime/library").Decimal | null;
            impactCost: import("@prisma/client/runtime/library").Decimal | null;
            brokerOrderId: string | null;
            filledAt: Date | null;
        }[];
        total: number;
        page: number;
        limit: number;
    }>;
    getOrder(orderId: string, userId: string): Promise<{
        portfolio: {
            name: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            initialCapital: import("@prisma/client/runtime/library").Decimal;
            currentNav: import("@prisma/client/runtime/library").Decimal;
            isDefault: boolean;
            userId: string;
        };
    } & {
        symbol: string;
        status: string;
        id: string;
        createdAt: Date;
        exchange: string;
        portfolioId: string;
        instrumentToken: string;
        qty: number;
        side: string;
        strategyTag: string | null;
        positionId: string | null;
        orderType: string;
        price: import("@prisma/client/runtime/library").Decimal | null;
        triggerPrice: import("@prisma/client/runtime/library").Decimal | null;
        filledQty: number;
        avgFillPrice: import("@prisma/client/runtime/library").Decimal | null;
        brokerage: import("@prisma/client/runtime/library").Decimal;
        stt: import("@prisma/client/runtime/library").Decimal;
        exchangeCharges: import("@prisma/client/runtime/library").Decimal;
        gst: import("@prisma/client/runtime/library").Decimal;
        sebiCharges: import("@prisma/client/runtime/library").Decimal;
        stampDuty: import("@prisma/client/runtime/library").Decimal;
        totalCost: import("@prisma/client/runtime/library").Decimal;
        idealPrice: import("@prisma/client/runtime/library").Decimal | null;
        slippageBps: import("@prisma/client/runtime/library").Decimal | null;
        fillLatencyMs: number | null;
        spreadCostBps: import("@prisma/client/runtime/library").Decimal | null;
        impactCost: import("@prisma/client/runtime/library").Decimal | null;
        brokerOrderId: string | null;
        filledAt: Date | null;
    }>;
    listPositions(userId: string, strategyTag?: string): Promise<{
        symbol: string;
        status: string;
        id: string;
        exchange: string;
        portfolioId: string;
        instrumentToken: string;
        qty: number;
        avgEntryPrice: import("@prisma/client/runtime/library").Decimal;
        side: string;
        positionType: string;
        unrealizedPnl: import("@prisma/client/runtime/library").Decimal | null;
        realizedPnl: import("@prisma/client/runtime/library").Decimal | null;
        stopLoss: import("@prisma/client/runtime/library").Decimal | null;
        target: import("@prisma/client/runtime/library").Decimal | null;
        strategyTag: string | null;
        openedAt: Date;
        closedAt: Date | null;
    }[]>;
    listActiveStrategies(userId: string): Promise<{
        strategyTag: string;
        legs: {
            symbol: string;
            status: string;
            id: string;
            exchange: string;
            portfolioId: string;
            instrumentToken: string;
            qty: number;
            avgEntryPrice: import("@prisma/client/runtime/library").Decimal;
            side: string;
            positionType: string;
            unrealizedPnl: import("@prisma/client/runtime/library").Decimal | null;
            realizedPnl: import("@prisma/client/runtime/library").Decimal | null;
            stopLoss: import("@prisma/client/runtime/library").Decimal | null;
            target: import("@prisma/client/runtime/library").Decimal | null;
            strategyTag: string | null;
            openedAt: Date;
            closedAt: Date | null;
        }[];
        realizedPnl: number;
        unrealizedPnl: number;
        deployedAt: Date;
    }[]>;
    exitStrategyLegs(userId: string, positionIds: string[]): Promise<{
        closed: number;
        failed: number;
        totalPnl: number;
        results: {
            positionId: string;
            success: boolean;
            message: string;
            pnl?: number;
        }[];
    }>;
    getPosition(positionId: string, userId: string): Promise<{
        portfolio: {
            name: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            initialCapital: import("@prisma/client/runtime/library").Decimal;
            currentNav: import("@prisma/client/runtime/library").Decimal;
            isDefault: boolean;
            userId: string;
        };
    } & {
        symbol: string;
        status: string;
        id: string;
        exchange: string;
        portfolioId: string;
        instrumentToken: string;
        qty: number;
        avgEntryPrice: import("@prisma/client/runtime/library").Decimal;
        side: string;
        positionType: string;
        unrealizedPnl: import("@prisma/client/runtime/library").Decimal | null;
        realizedPnl: import("@prisma/client/runtime/library").Decimal | null;
        stopLoss: import("@prisma/client/runtime/library").Decimal | null;
        target: import("@prisma/client/runtime/library").Decimal | null;
        strategyTag: string | null;
        openedAt: Date;
        closedAt: Date | null;
    }>;
    closePosition(positionId: string, userId: string, exitPrice: number): Promise<{
        symbol: string;
        id: string;
        exchange: string;
        portfolioId: string;
        grossPnl: import("@prisma/client/runtime/library").Decimal;
        netPnl: import("@prisma/client/runtime/library").Decimal;
        qty: number;
        side: string;
        strategyTag: string | null;
        positionId: string;
        entryPrice: import("@prisma/client/runtime/library").Decimal;
        exitPrice: import("@prisma/client/runtime/library").Decimal;
        totalCosts: import("@prisma/client/runtime/library").Decimal;
        entryTime: Date;
        exitTime: Date;
        holdDuration: string | null;
        aiRationale: string | null;
    }>;
    listTrades(userId: string, params?: {
        page?: number;
        limit?: number;
        fromDate?: string;
        toDate?: string;
        symbol?: string;
    }): Promise<{
        trades: {
            symbol: string;
            id: string;
            exchange: string;
            portfolioId: string;
            grossPnl: import("@prisma/client/runtime/library").Decimal;
            netPnl: import("@prisma/client/runtime/library").Decimal;
            qty: number;
            side: string;
            strategyTag: string | null;
            positionId: string;
            entryPrice: import("@prisma/client/runtime/library").Decimal;
            exitPrice: import("@prisma/client/runtime/library").Decimal;
            totalCosts: import("@prisma/client/runtime/library").Decimal;
            entryTime: Date;
            exitTime: Date;
            holdDuration: string | null;
            aiRationale: string | null;
        }[];
        total: number;
        page: number;
        limit: number;
    }>;
    getTrade(tradeId: string, userId: string): Promise<{
        portfolio: {
            name: string;
            id: string;
            createdAt: Date;
            updatedAt: Date;
            initialCapital: import("@prisma/client/runtime/library").Decimal;
            currentNav: import("@prisma/client/runtime/library").Decimal;
            isDefault: boolean;
            userId: string;
        };
    } & {
        symbol: string;
        id: string;
        exchange: string;
        portfolioId: string;
        grossPnl: import("@prisma/client/runtime/library").Decimal;
        netPnl: import("@prisma/client/runtime/library").Decimal;
        qty: number;
        side: string;
        strategyTag: string | null;
        positionId: string;
        entryPrice: import("@prisma/client/runtime/library").Decimal;
        exitPrice: import("@prisma/client/runtime/library").Decimal;
        totalCosts: import("@prisma/client/runtime/library").Decimal;
        entryTime: Date;
        exitTime: Date;
        holdDuration: string | null;
        aiRationale: string | null;
    }>;
    /**
     * Match pending orders against current market prices.
     * - MARKET orders placed after hours: fill at current LTP when market opens
     * - LIMIT BUY orders: fill when LTP <= order price
     * - LIMIT SELL orders: fill when LTP >= order price
     */
    matchPendingOrders(): Promise<{
        matched: number;
        failed: number;
    }>;
}
export declare class TradeError extends Error {
    statusCode: number;
    constructor(message: string, statusCode: number);
}
export {};
//# sourceMappingURL=trade.service.d.ts.map