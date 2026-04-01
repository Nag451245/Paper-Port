export interface CostBreakdown {
    brokerage: number;
    stt: number;
    exchangeCharges: number;
    gst: number;
    sebiCharges: number;
    stampDuty: number;
    totalCost: number;
}
export declare function calculateCosts(qty: number, price: number, side: string, exchange?: string): CostBreakdown;
//# sourceMappingURL=costs.d.ts.map