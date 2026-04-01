import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('PortfolioOptimizer');
const DEFAULT_CONSTRAINTS = {
    maxSingleWeight: 0.05,
    maxSectorWeight: 0.30,
    maxTurnover: 0.20,
    riskBudget: 0.02,
};
export class PortfolioOptimizerService {
    constraints;
    riskFreeRate;
    constructor(constraints, riskFreeRate = 0.065) {
        this.constraints = { ...DEFAULT_CONSTRAINTS, ...constraints };
        this.riskFreeRate = riskFreeRate;
    }
    optimizePosition(view, portfolio) {
        const { capital, positions, currentPrice } = portfolio;
        if (capital <= 0 || currentPrice <= 0) {
            return { symbol: view.symbol, optimalWeight: 0, adjustedQty: 0, reason: 'Invalid capital or price', cvarContribution: 0 };
        }
        const existingPosition = positions.find(p => p.symbol === view.symbol);
        const existingWeight = existingPosition
            ? (existingPosition.qty * existingPosition.avgPrice) / capital
            : 0;
        const totalInvestedWeight = positions.reduce((s, p) => s + (p.qty * p.avgPrice) / capital, 0);
        const equilibriumWeight = 1 / Math.max(1, positions.length + 1);
        const tau = 0.05;
        const viewWeight = view.expectedReturn > 0
            ? Math.min(this.constraints.maxSingleWeight, view.confidence * view.expectedReturn * 10)
            : 0;
        const blWeight = (equilibriumWeight + tau * viewWeight * view.confidence) /
            (1 + tau * view.confidence);
        let optimalWeight = Math.min(blWeight, this.constraints.maxSingleWeight);
        const turnoverRequired = Math.abs(optimalWeight - existingWeight);
        if (turnoverRequired > this.constraints.maxTurnover) {
            const direction = optimalWeight > existingWeight ? 1 : -1;
            optimalWeight = existingWeight + direction * this.constraints.maxTurnover;
        }
        if (view.sector) {
            const sectorWeight = positions
                .filter(p => p.sector === view.sector)
                .reduce((s, p) => s + (p.qty * p.avgPrice) / capital, 0);
            const newSectorWeight = sectorWeight + optimalWeight - existingWeight;
            if (newSectorWeight > this.constraints.maxSectorWeight) {
                const available = this.constraints.maxSectorWeight - sectorWeight + existingWeight;
                optimalWeight = Math.max(0, Math.min(optimalWeight, available));
            }
        }
        if (totalInvestedWeight - existingWeight + optimalWeight > 1.0) {
            const available = Math.max(0, 1.0 - totalInvestedWeight + existingWeight);
            optimalWeight = Math.min(optimalWeight, available);
        }
        const cvar = this.estimateCVaR(view.expectedReturn, view.confidence, optimalWeight, capital);
        if (cvar > this.constraints.riskBudget * capital) {
            const scale = (this.constraints.riskBudget * capital) / cvar;
            optimalWeight *= scale;
            log.info({ symbol: view.symbol, scale: scale.toFixed(2) }, 'CVaR budget exceeded — scaling down');
        }
        const positionValue = optimalWeight * capital;
        const adjustedQty = Math.max(0, Math.floor(positionValue / currentPrice));
        const reasons = [];
        if (blWeight !== optimalWeight)
            reasons.push('constrained');
        if (view.confidence > 0.7)
            reasons.push('high-confidence view');
        if (cvar > this.constraints.riskBudget * capital * 0.5)
            reasons.push('CVaR-aware sizing');
        reasons.push(`BL weight: ${(blWeight * 100).toFixed(1)}%`);
        reasons.push(`optimal: ${(optimalWeight * 100).toFixed(1)}%`);
        log.info({
            symbol: view.symbol,
            blWeight: (blWeight * 100).toFixed(1),
            optimalWeight: (optimalWeight * 100).toFixed(1),
            adjustedQty,
            cvar: cvar.toFixed(0),
        }, 'Position optimized');
        return {
            symbol: view.symbol,
            optimalWeight,
            adjustedQty,
            reason: reasons.join('; '),
            cvarContribution: Number(cvar.toFixed(2)),
        };
    }
    estimateCVaR(expectedReturn, confidence, weight, capital) {
        const dailyVol = 0.02;
        const positionVol = dailyVol * weight * capital;
        const zAlpha95 = 1.645;
        const var95 = positionVol * zAlpha95;
        const cvar = var95 * 1.25;
        const adjustedCVar = cvar * (1 - Math.max(0, expectedReturn) * confidence);
        return Math.max(0, adjustedCVar);
    }
    getConstraints() {
        return { ...this.constraints };
    }
    setConstraints(updates) {
        this.constraints = { ...this.constraints, ...updates };
    }
}
//# sourceMappingURL=portfolio-optimizer.service.js.map