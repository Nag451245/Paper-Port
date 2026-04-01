export interface HistoricalBarRecord {
    id: string;
    symbol: string;
    exchange: string;
    timeframe: string;
    open: number;
    high: number;
    low: number;
    close: number;
    volume: bigint;
    adjClose: number | null;
    timestamp: Date;
}
export interface AdjustedPoint {
    timestamp: Date;
    close: number;
    adjClose: number;
}
export declare class HistoricalDataService {
    fetchAndStore(symbol: string, exchange: string, timeframe: string, startDate: Date, endDate: Date): Promise<number>;
    getHistory(symbol: string, exchange: string, timeframe: string, startDate: Date, endDate: Date): Promise<HistoricalBarRecord[]>;
    adjustForCorporateActions(symbol: string, bars: HistoricalBarRecord[], actions: {
        ratio: number | null;
        exDate: Date;
    }[]): HistoricalBarRecord[];
    getAdjustedSeries(symbol: string, exchange: string, startDate: Date, endDate: Date): Promise<AdjustedPoint[]>;
    recordCorporateAction(symbol: string, actionType: string, ratio: number | null, exDate: Date, details?: Record<string, unknown>): Promise<void>;
}
//# sourceMappingURL=historical-data.service.d.ts.map