import type { PrismaClient } from '@prisma/client';
export interface ContractNoteData {
    orderId: string;
    tradeDate: Date;
    symbol: string;
    exchange: string;
    side: string;
    qty: number;
    price: number;
    brokerage: number;
    stt: number;
    exchangeCharges: number;
    gst: number;
    sebiCharges: number;
    stampDuty: number;
    totalCharges: number;
    netAmount: number;
}
export interface DailySummary {
    date: Date;
    trades: ContractNoteData[];
    totalBuyValue: number;
    totalSellValue: number;
    netSettlement: number;
    totalCharges: number;
}
export interface PnLStatement {
    period: {
        from: Date;
        to: Date;
    };
    speculative: PnLCategory;
    nonSpeculative: PnLCategory;
    businessIncome: PnLCategory;
    totalNetPnl: number;
}
export interface PnLCategory {
    turnover: number;
    grossPnl: number;
    expenses: number;
    netPnl: number;
}
export interface TaxSummary {
    fy: string;
    stcg: {
        gains: number;
        tax: number;
    };
    ltcg: {
        gains: number;
        exemption: number;
        taxableGains: number;
        tax: number;
    };
    speculativeIncome: {
        income: number;
        note: string;
    };
    totalTaxLiability: number;
}
export declare class TradeReportingService {
    private prisma;
    constructor(prisma?: PrismaClient);
    generateContractNote(orderId: string): Promise<ContractNoteData>;
    generateDailySummary(userId: string, date: Date): Promise<DailySummary>;
    generatePnLStatement(userId: string, from: Date, to: Date): Promise<PnLStatement>;
    generateTaxSummary(userId: string, fy: string): Promise<TaxSummary>;
    private sumCharges;
}
//# sourceMappingURL=trade-reporting.service.d.ts.map