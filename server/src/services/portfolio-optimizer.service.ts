import { createChildLogger } from '../lib/logger.js';

const log = createChildLogger('PortfolioOptimizer');

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

const DEFAULT_CONSTRAINTS: PortfolioConstraints = {
  maxSingleWeight: 0.05,
  maxSectorWeight: 0.30,
  maxTurnover: 0.20,
  riskBudget: 0.02,
};

export class PortfolioOptimizerService {
  private constraints: PortfolioConstraints;
  private riskFreeRate: number;

  constructor(constraints?: Partial<PortfolioConstraints>, riskFreeRate = 0.065) {
    this.constraints = { ...DEFAULT_CONSTRAINTS, ...constraints };
    this.riskFreeRate = riskFreeRate;
  }

  optimizePosition(
    view: PortfolioView,
    portfolio: {
      capital: number;
      positions: Array<{ symbol: string; side: string; qty: number; avgPrice: number; sector?: string }>;
      currentPrice: number;
    },
  ): OptimizedPosition {
    const { capital, positions, currentPrice } = portfolio;
    if (capital <= 0 || currentPrice <= 0) {
      return { symbol: view.symbol, optimalWeight: 0, adjustedQty: 0, reason: 'Invalid capital or price', cvarContribution: 0 };
    }

    const existingPosition = positions.find(p => p.symbol === view.symbol);
    const existingWeight = existingPosition
      ? (existingPosition.qty * existingPosition.avgPrice) / capital
      : 0;

    const totalInvestedWeight = positions.reduce(
      (s, p) => s + (p.qty * p.avgPrice) / capital, 0,
    );

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

    const cvar = this.estimateCVaR(
      view.expectedReturn,
      view.confidence,
      optimalWeight,
      capital,
    );

    if (cvar > this.constraints.riskBudget * capital) {
      const scale = (this.constraints.riskBudget * capital) / cvar;
      optimalWeight *= scale;
      log.info({ symbol: view.symbol, scale: scale.toFixed(2) }, 'CVaR budget exceeded — scaling down');
    }

    const positionValue = optimalWeight * capital;
    const adjustedQty = Math.max(0, Math.floor(positionValue / currentPrice));

    const reasons: string[] = [];
    if (blWeight !== optimalWeight) reasons.push('constrained');
    if (view.confidence > 0.7) reasons.push('high-confidence view');
    if (cvar > this.constraints.riskBudget * capital * 0.5) reasons.push('CVaR-aware sizing');
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

  private estimateCVaR(
    expectedReturn: number,
    confidence: number,
    weight: number,
    capital: number,
  ): number {
    const dailyVol = 0.02;
    const positionVol = dailyVol * weight * capital;
    const zAlpha95 = 1.645;
    const var95 = positionVol * zAlpha95;
    const cvar = var95 * 1.25;

    const adjustedCVar = cvar * (1 - Math.max(0, expectedReturn) * confidence);

    return Math.max(0, adjustedCVar);
  }

  getConstraints(): PortfolioConstraints {
    return { ...this.constraints };
  }

  setConstraints(updates: Partial<PortfolioConstraints>): void {
    this.constraints = { ...this.constraints, ...updates };
  }
}
