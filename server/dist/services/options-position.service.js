import { MarketDataService } from './market-data.service.js';
const RISK_FREE_RATE = 0.07;
// ── Black-Scholes Greeks ──
function d1(S, K, T, r, sigma) {
    return (Math.log(S / K) + (r + sigma * sigma / 2) * T) / (sigma * Math.sqrt(T));
}
function d2(S, K, T, r, sigma) {
    return d1(S, K, T, r, sigma) - sigma * Math.sqrt(T);
}
function normCDF(x) {
    const a1 = 0.254829592, a2 = -0.284496736, a3 = 1.421413741, a4 = -1.453152027, a5 = 1.061405429;
    const p = 0.3275911;
    const sign = x < 0 ? -1 : 1;
    const t = 1 / (1 + p * Math.abs(x));
    const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x / 2);
    return 0.5 * (1 + sign * y);
}
function normPDF(x) {
    return Math.exp(-x * x / 2) / Math.sqrt(2 * Math.PI);
}
function computeGreeks(spot, strike, tte, iv, optionType, r = RISK_FREE_RATE) {
    if (tte <= 0 || iv <= 0)
        return { delta: 0, gamma: 0, theta: 0, vega: 0, rho: 0, iv };
    const T = tte;
    const sqrtT = Math.sqrt(T);
    const _d1 = d1(spot, strike, T, r, iv);
    const _d2 = d2(spot, strike, T, r, iv);
    const delta = optionType === 'CE' ? normCDF(_d1) : normCDF(_d1) - 1;
    const gamma = normPDF(_d1) / (spot * iv * sqrtT);
    const vega = spot * normPDF(_d1) * sqrtT / 100;
    const thetaCE = -(spot * normPDF(_d1) * iv) / (2 * sqrtT) - r * strike * Math.exp(-r * T) * normCDF(_d2);
    const thetaPE = -(spot * normPDF(_d1) * iv) / (2 * sqrtT) + r * strike * Math.exp(-r * T) * normCDF(-_d2);
    const theta = (optionType === 'CE' ? thetaCE : thetaPE) / 365;
    const rhoVal = optionType === 'CE'
        ? strike * T * Math.exp(-r * T) * normCDF(_d2) / 100
        : -strike * T * Math.exp(-r * T) * normCDF(-_d2) / 100;
    return {
        delta: Number(delta.toFixed(4)),
        gamma: Number(gamma.toFixed(6)),
        theta: Number(theta.toFixed(2)),
        vega: Number(vega.toFixed(2)),
        rho: Number(rhoVal.toFixed(2)),
        iv: Number(iv.toFixed(4)),
    };
}
export class OptionsPositionService {
    prisma;
    marketData;
    constructor(prisma) {
        this.prisma = prisma;
        this.marketData = new MarketDataService();
    }
    async getOptionsPortfolioGreeks(userId, spotPrice) {
        const portfolios = await this.prisma.portfolio.findMany({
            where: { userId },
            select: { id: true },
        });
        if (!portfolios.length)
            return this.emptyGreeks();
        const positions = await this.prisma.position.findMany({
            where: { portfolioId: { in: portfolios.map(p => p.id) }, status: 'OPEN' },
        });
        // Filter option positions (symbols containing CE/PE or strikePrice in strategyTag)
        const optionPositions = positions.filter(p => p.strategyTag?.includes('OPT:') || p.symbol.match(/(CE|PE)$/i));
        if (optionPositions.length === 0)
            return this.emptyGreeks();
        let spot = spotPrice ?? 0;
        if (spot <= 0) {
            try {
                const q = await this.marketData.getQuote('NIFTY');
                spot = q.ltp;
            }
            catch {
                spot = 22000;
            }
        }
        let netDelta = 0, netGamma = 0, netTheta = 0, netVega = 0, netRho = 0;
        let totalPnl = 0, totalMargin = 0;
        const legs = [];
        for (const pos of optionPositions) {
            const tag = pos.strategyTag ?? '';
            const parts = tag.split(':');
            const optType = (parts[1] ?? (pos.symbol.endsWith('CE') ? 'CE' : 'PE'));
            const strike = parseFloat(parts[2] ?? '0') || Number(pos.avgEntryPrice);
            const expiryStr = parts[3] ?? '';
            const expDate = expiryStr ? new Date(expiryStr) : new Date(Date.now() + 7 * 86400000);
            const tte = Math.max((expDate.getTime() - Date.now()) / (365.25 * 86400000), 0.001);
            const entryPrice = Number(pos.avgEntryPrice);
            const currentPrice = entryPrice;
            const iv = 0.20;
            const multiplier = pos.side === 'LONG' ? 1 : -1;
            const greeks = computeGreeks(spot, strike, tte, iv, optType);
            const scaledDelta = greeks.delta * pos.qty * multiplier;
            const scaledGamma = greeks.gamma * pos.qty * multiplier;
            const scaledTheta = greeks.theta * pos.qty * multiplier;
            const scaledVega = greeks.vega * pos.qty * multiplier;
            const scaledRho = greeks.rho * pos.qty * multiplier;
            netDelta += scaledDelta;
            netGamma += scaledGamma;
            netTheta += scaledTheta;
            netVega += scaledVega;
            netRho += scaledRho;
            const legPnl = (currentPrice - entryPrice) * pos.qty * multiplier;
            totalPnl += legPnl;
            // Margin for selling options: SPAN-like approximation
            let marginReq = 0;
            if (pos.side === 'SHORT') {
                const otmAmount = optType === 'CE' ? Math.max(strike - spot, 0) : Math.max(spot - strike, 0);
                marginReq = Math.max(spot * pos.qty * 0.15 - otmAmount * pos.qty, spot * pos.qty * 0.05);
            }
            totalMargin += marginReq;
            legs.push({
                symbol: pos.symbol,
                strikePrice: strike,
                optionType: optType,
                side: pos.side,
                qty: pos.qty,
                entryPrice,
                currentPrice,
                expiry: expDate.toISOString().split('T')[0],
                positionId: pos.id,
                greeks,
                pnl: Number(legPnl.toFixed(2)),
                marginRequired: Number(marginReq.toFixed(2)),
            });
        }
        const daysToExpiry = legs.length > 0
            ? Math.min(...legs.map(l => Math.max(0, Math.ceil((new Date(l.expiry).getTime() - Date.now()) / 86400000))))
            : 0;
        return {
            netDelta: Number(netDelta.toFixed(2)),
            netGamma: Number(netGamma.toFixed(4)),
            netTheta: Number(netTheta.toFixed(2)),
            netVega: Number(netVega.toFixed(2)),
            netRho: Number(netRho.toFixed(2)),
            legs,
            totalPnl: Number(totalPnl.toFixed(2)),
            totalMarginRequired: Number(totalMargin.toFixed(2)),
            daysToExpiry,
        };
    }
    async rollPosition(userId, positionId, newStrike, newExpiry) {
        const position = await this.prisma.position.findUnique({
            where: { id: positionId },
            include: { portfolio: true },
        });
        if (!position || position.portfolio.userId !== userId || position.status !== 'OPEN') {
            throw new Error('Position not found or not open');
        }
        // Close existing position
        const entryPrice = Number(position.avgEntryPrice);
        await this.prisma.position.update({
            where: { id: positionId },
            data: { status: 'CLOSED', closedAt: new Date(), realizedPnl: 0 },
        });
        // Open new position with new strike/expiry
        const newPosition = await this.prisma.position.create({
            data: {
                portfolioId: position.portfolioId,
                instrumentToken: position.instrumentToken,
                symbol: position.symbol.replace(/\d+(CE|PE)$/i, `${newStrike}$1`),
                exchange: position.exchange,
                side: position.side,
                qty: position.qty,
                avgEntryPrice: entryPrice,
                status: 'OPEN',
                openedAt: new Date(),
                strategyTag: `OPT:${position.strategyTag?.split(':')[1] ?? 'CE'}:${newStrike}:${newExpiry}`,
            },
        });
        return { closed: positionId, opened: newPosition.id };
    }
    async getExpiringPositions(userId, withinDays = 3) {
        const portfolios = await this.prisma.portfolio.findMany({ where: { userId }, select: { id: true } });
        if (!portfolios.length)
            return [];
        const positions = await this.prisma.position.findMany({
            where: { portfolioId: { in: portfolios.map(p => p.id) }, status: 'OPEN' },
        });
        const now = Date.now();
        const results = [];
        for (const pos of positions) {
            const tag = pos.strategyTag ?? '';
            const parts = tag.split(':');
            if (parts[0] !== 'OPT')
                continue;
            const expiryStr = parts[3] ?? '';
            if (!expiryStr)
                continue;
            const expDate = new Date(expiryStr);
            const daysLeft = Math.ceil((expDate.getTime() - now) / 86400000);
            if (daysLeft <= withinDays && daysLeft >= 0) {
                results.push({ symbol: pos.symbol, positionId: pos.id, expiry: expiryStr, daysLeft });
            }
        }
        return results.sort((a, b) => a.daysLeft - b.daysLeft);
    }
    emptyGreeks() {
        return { netDelta: 0, netGamma: 0, netTheta: 0, netVega: 0, netRho: 0, legs: [], totalPnl: 0, totalMarginRequired: 0, daysToExpiry: 0 };
    }
}
//# sourceMappingURL=options-position.service.js.map