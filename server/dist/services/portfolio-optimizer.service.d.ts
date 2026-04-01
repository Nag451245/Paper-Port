export interface PortfolioView {
    symbol: string;
    expectedReturn: number;
    confidence: number;
    direction: 'BUY' | 'SELL';
    currentWeight: number;
    sector?: string;
}
export interface OptimizedPosition {
    symbol: string;
    optimalWeight: number;
    adjustedQty: number;
    reason: string;
    cvarContribution: number;
}
export interface PortfolioConstraints {
    maxSingleWeight: number;
    maxSectorWeight: number;
    maxTurnover: number;
    riskBudget: number;
}
export declare class PortfolioOptimizerService {
    private constraints;
    private riskFreeRate;
    constructor(constraints?: Partial<PortfolioConstraints>, riskFreeRate?: number);
    optimizePosition(view: PortfolioView, portfolio: {
        capital: number;
        positions: Array<{
            symbol: string;
            side: string;
            qty: number;
            avgPrice: number;
            sector?: string;
        }>;
        currentPrice: number;
    }): OptimizedPosition;
    private estimateCVaR;
    getConstraints(): PortfolioConstraints;
    setConstraints(updates: Partial<PortfolioConstraints>): void;
}
//# sourceMappingURL=portfolio-optimizer.service.d.ts.map