export interface BrokerQuote {
    symbol: string;
    ltp: number;
    change: number;
    changePercent: number;
    volume: number;
    timestamp: string;
}
export interface BrokerHistoricalBar {
    timestamp: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: number;
}
export interface BrokerOrderInput {
    symbol: string;
    exchange: string;
    side: 'BUY' | 'SELL';
    orderType: 'MARKET' | 'LIMIT' | 'SL_M' | 'SL_LIMIT';
    qty: number;
    price?: number;
    triggerPrice?: number;
    product?: 'INTRADAY' | 'DELIVERY' | 'MARGIN';
    validity?: 'DAY' | 'IOC';
    expiry?: string;
    strike?: number;
    optionType?: 'CE' | 'PE';
}
export interface BrokerOrderResult {
    orderId: string;
    status: string;
    message: string;
    brokerOrderId?: string;
}
export interface BrokerAdapter {
    name: string;
    isConnected(): boolean;
    connect(credentials: Record<string, string>): Promise<void>;
    disconnect(): Promise<void>;
    getQuote(symbol: string, exchange?: string): Promise<BrokerQuote>;
    getHistory(symbol: string, interval: string, from: string, to: string): Promise<BrokerHistoricalBar[]>;
    search(query: string): Promise<Array<{
        symbol: string;
        name: string;
        exchange: string;
    }>>;
    placeOrder(input: BrokerOrderInput): Promise<BrokerOrderResult>;
    modifyOrder(orderId: string, changes: Partial<Pick<BrokerOrderInput, 'price' | 'qty' | 'triggerPrice'>>): Promise<BrokerOrderResult>;
    cancelOrder(orderId: string): Promise<BrokerOrderResult>;
    getOrderStatus(orderId: string): Promise<{
        status: string;
        filledQty: number;
        avgPrice: number;
        message?: string;
    }>;
    getPositions(): Promise<Array<{
        symbol: string;
        qty: number;
        avgPrice: number;
        ltp: number;
        pnl: number;
        product: string;
    }>>;
    getOrders?(): Promise<Array<{
        orderId: string;
        symbol: string;
        side: string;
        qty: number;
        filledQty: number;
        avgPrice: number;
        status: string;
        timestamp: string;
    }>>;
    getMarginAvailable(): Promise<{
        available: number;
        used: number;
        total: number;
    }>;
}
export declare function registerBrokerAdapter(name: string, factory: () => BrokerAdapter): void;
export declare function getBrokerAdapter(name: string): BrokerAdapter | null;
export declare function getAvailableBrokers(): string[];
//# sourceMappingURL=broker-adapter.d.ts.map