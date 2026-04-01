import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';
const log = createChildLogger('MarginCalculator');
const GROUP_VAR_RATES = {
    I: 0.105,
    II: 0.165,
    III: 0.265,
};
const DEFAULT_SPAN_PCT = 0.15;
const ELM_RATE_EQ = 0.035;
const ELM_RATE_FO = 0.02;
export class MarginCalculatorService {
    prisma;
    symbolGroupOverrides = new Map();
    varRateOverrides = new Map();
    spanPct = DEFAULT_SPAN_PCT;
    constructor(prisma) {
        this.prisma = prisma ?? getPrisma();
        this.seedDefaultGroups();
    }
    seedDefaultGroups() {
        const groupI = [
            'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK',
            'HINDUNILVR', 'ITC', 'SBIN', 'BHARTIARTL', 'KOTAKBANK',
            'LT', 'AXISBANK', 'BAJFINANCE', 'MARUTI', 'TATAMOTORS',
            'SUNPHARMA', 'TITAN', 'ASIANPAINT', 'NTPC', 'POWERGRID',
        ];
        const groupIII = [
            'YESBANK', 'SUZLON', 'RPOWER', 'IRFC', 'IDEA',
            'PNB', 'JPASSOCIAT', 'SAIL', 'NHPC', 'IDFCFIRSTB',
        ];
        for (const sym of groupI)
            this.symbolGroupOverrides.set(sym, 'I');
        for (const sym of groupIII)
            this.symbolGroupOverrides.set(sym, 'III');
    }
    setSymbolGroup(symbol, group) {
        this.symbolGroupOverrides.set(symbol, group);
    }
    setVarRateOverride(symbol, rate) {
        this.varRateOverrides.set(symbol, rate);
    }
    setSpanPct(pct) {
        this.spanPct = pct;
    }
    getVarRate(symbol) {
        const override = this.varRateOverrides.get(symbol);
        if (override !== undefined)
            return override;
        const group = this.symbolGroupOverrides.get(symbol) ?? 'II';
        return GROUP_VAR_RATES[group];
    }
    getElmRate(segment) {
        return segment === 'FO' ? ELM_RATE_FO : ELM_RATE_EQ;
    }
    calculateMarginRequired(params) {
        const { symbol, qty, price, segment } = params;
        const notional = qty * price;
        const varRate = this.getVarRate(symbol);
        const varMargin = notional * varRate;
        const elmRate = this.getElmRate(segment);
        const elmMargin = notional * elmRate;
        let spanMargin = 0;
        if (segment === 'FO') {
            const delta = params.delta ?? 1;
            const underlying = params.underlyingPrice ?? price;
            spanMargin = Math.abs(delta) * underlying * qty * this.spanPct;
        }
        const totalRequired = varMargin + elmMargin + spanMargin;
        const utilizationPct = 0;
        log.debug({ symbol, segment, varMargin, elmMargin, spanMargin, totalRequired }, 'margin calculated');
        return {
            varMargin: round(varMargin),
            elmMargin: round(elmMargin),
            spanMargin: round(spanMargin),
            totalRequired: round(totalRequired),
            utilizationPct,
        };
    }
    async getPeakMarginUtilization(userId) {
        const todayStart = startOfDay(new Date());
        const peak = await this.prisma.marginRecord.findFirst({
            where: {
                userId,
                snapshotAt: { gte: todayStart },
            },
            orderBy: { peakUtilPct: 'desc' },
        });
        if (!peak) {
            return {
                peakUtilizationPct: 0,
                currentMarginUsed: 0,
                availableMargin: 0,
                snapshotAt: new Date(),
            };
        }
        const allSnapshots = await this.prisma.marginRecord.findMany({
            where: {
                userId,
                snapshotAt: { gte: todayStart },
            },
            orderBy: { snapshotAt: 'desc' },
            take: 1,
        });
        const latest = allSnapshots[0];
        const currentUsed = latest?.totalRequired ?? 0;
        return {
            peakUtilizationPct: peak.peakUtilPct,
            currentMarginUsed: currentUsed,
            availableMargin: 0,
            snapshotAt: peak.snapshotAt,
        };
    }
    async recordMarginSnapshot(userId, symbol, margin, exchange = 'NSE', segment = 'EQ') {
        await this.prisma.marginRecord.create({
            data: {
                userId,
                symbol,
                exchange,
                segment,
                varMargin: margin.varMargin,
                elmMargin: margin.elmMargin,
                spanMargin: margin.spanMargin,
                totalRequired: margin.totalRequired,
                peakUtilPct: margin.utilizationPct,
                snapshotAt: new Date(),
            },
        });
        log.info({ userId, symbol, totalRequired: margin.totalRequired }, 'margin snapshot recorded');
    }
    checkMarginSufficiency(userId, requiredMargin, availableCapital) {
        const utilizationPct = availableCapital > 0
            ? (requiredMargin / availableCapital) * 100
            : 100;
        const shortfall = Math.max(0, requiredMargin - availableCapital);
        const sufficient = requiredMargin <= availableCapital;
        if (!sufficient) {
            log.warn({ userId, requiredMargin, availableCapital, shortfall }, 'margin insufficient');
        }
        return {
            sufficient,
            shortfall: round(shortfall),
            utilizationPct: round(utilizationPct),
        };
    }
}
function round(n) {
    return Math.round(n * 100) / 100;
}
function startOfDay(d) {
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    return s;
}
//# sourceMappingURL=margin-calculator.service.js.map