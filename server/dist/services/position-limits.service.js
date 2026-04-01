import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';
const log = createChildLogger('PositionLimits');
const DEFAULT_MWPL = 2_000_000;
const CLIENT_LIMIT_EQ_PCT = 0.01;
const CLIENT_LIMIT_FO_PCT = 0.05;
const BAN_THRESHOLD_PCT = 0.95;
export class PositionLimitsService {
    prisma;
    mwplLookup = new Map();
    bannedSymbols = new Set();
    constructor(prisma) {
        this.prisma = prisma ?? getPrisma();
        this.seedDefaultMWPL();
    }
    seedDefaultMWPL() {
        const largeCaps = {
            RELIANCE: 20_000_000,
            TCS: 15_000_000,
            HDFCBANK: 18_000_000,
            INFY: 16_000_000,
            ICICIBANK: 14_000_000,
            SBIN: 25_000_000,
            BHARTIARTL: 12_000_000,
            ITC: 30_000_000,
            HINDUNILVR: 10_000_000,
            KOTAKBANK: 8_000_000,
            LT: 10_000_000,
            BAJFINANCE: 6_000_000,
            TATAMOTORS: 20_000_000,
            MARUTI: 4_000_000,
            AXISBANK: 15_000_000,
        };
        for (const [sym, limit] of Object.entries(largeCaps)) {
            this.mwplLookup.set(sym, limit);
        }
    }
    updateMWPL(symbol, limit) {
        this.mwplLookup.set(symbol, limit);
        log.info({ symbol, limit }, 'MWPL updated');
    }
    getMWPL(symbol) {
        return this.mwplLookup.get(symbol) ?? DEFAULT_MWPL;
    }
    setBanPeriod(symbol) {
        this.bannedSymbols.add(symbol);
        log.warn({ symbol }, 'symbol entered ban period');
    }
    clearBanPeriod(symbol) {
        this.bannedSymbols.delete(symbol);
        log.info({ symbol }, 'symbol ban period cleared');
    }
    isBanned(symbol) {
        return this.bannedSymbols.has(symbol);
    }
    getClientLimitPct(segment) {
        if (segment === 'FO')
            return CLIENT_LIMIT_FO_PCT;
        return CLIENT_LIMIT_EQ_PCT;
    }
    checkPositionLimit(params) {
        const { symbol, segment, proposedQty, currentQty } = params;
        const mwpl = this.getMWPL(symbol);
        const clientPct = this.getClientLimitPct(segment);
        const maxAllowed = Math.floor(mwpl * clientPct);
        const totalQtyAfter = currentQty + proposedQty;
        const banned = this.isBanned(symbol);
        if (banned) {
            log.warn({ symbol, proposedQty }, 'order rejected — ban period active');
            return {
                allowed: false,
                reason: `${symbol} is in ban period (aggregate OI > ${BAN_THRESHOLD_PCT * 100}% of MWPL). Fresh positions blocked.`,
                currentUtilization: maxAllowed > 0 ? (currentQty / maxAllowed) * 100 : 100,
                maxAllowed,
                isBanPeriod: true,
            };
        }
        if (totalQtyAfter > maxAllowed) {
            log.warn({ symbol, proposedQty, currentQty, maxAllowed }, 'position limit breach');
            return {
                allowed: false,
                reason: `Proposed position ${totalQtyAfter} exceeds client limit of ${maxAllowed} (${clientPct * 100}% of MWPL ${mwpl}).`,
                currentUtilization: maxAllowed > 0 ? (currentQty / maxAllowed) * 100 : 100,
                maxAllowed,
                isBanPeriod: false,
            };
        }
        return {
            allowed: true,
            currentUtilization: maxAllowed > 0 ? round((totalQtyAfter / maxAllowed) * 100) : 0,
            maxAllowed,
            isBanPeriod: false,
        };
    }
    async getPositionSummary(userId) {
        const positions = await this.prisma.order.groupBy({
            by: ['symbol'],
            where: {
                portfolio: { userId },
                status: 'FILLED',
            },
            _sum: { filledQty: true },
        });
        return positions.map((pos) => {
            const symbol = pos.symbol;
            const currentQty = Math.abs(pos._sum.filledQty ?? 0);
            const mwpl = this.getMWPL(symbol);
            const maxAllowed = Math.floor(mwpl * CLIENT_LIMIT_EQ_PCT);
            const utilizationPct = maxAllowed > 0 ? round((currentQty / maxAllowed) * 100) : 0;
            return {
                symbol,
                currentQty,
                maxAllowed,
                utilizationPct,
                isBanned: this.isBanned(symbol),
            };
        });
    }
    checkAndUpdateBanStatus(symbol, aggregateOI) {
        const mwpl = this.getMWPL(symbol);
        const threshold = mwpl * BAN_THRESHOLD_PCT;
        if (aggregateOI > threshold) {
            this.setBanPeriod(symbol);
            return true;
        }
        if (aggregateOI <= mwpl * 0.80 && this.isBanned(symbol)) {
            this.clearBanPeriod(symbol);
        }
        return false;
    }
}
function round(n) {
    return Math.round(n * 100) / 100;
}
//# sourceMappingURL=position-limits.service.js.map