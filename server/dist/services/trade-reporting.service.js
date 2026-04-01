import { createChildLogger } from '../lib/logger.js';
import { getPrisma } from '../lib/prisma.js';
const log = createChildLogger('TradeReporting');
const BROKERAGE_MAX_PCT = 0.0003;
const BROKERAGE_MAX_FLAT = 20;
const STT_DELIVERY_PCT = 0.001;
const STT_INTRADAY_PCT = 0.00025;
const EXCHANGE_CHARGE_NSE_PCT = 0.0000345;
const SEBI_CHARGE_PCT = 0.000001;
const GST_PCT = 0.18;
const STAMP_DUTY_DELIVERY_PCT = 0.00015;
const STAMP_DUTY_INTRADAY_PCT = 0.00003;
const STCG_RATE = 0.15;
const LTCG_RATE = 0.10;
const LTCG_EXEMPTION = 100_000;
export class TradeReportingService {
    prisma;
    constructor(prisma) {
        this.prisma = prisma ?? getPrisma();
    }
    async generateContractNote(orderId) {
        const order = await this.prisma.order.findUnique({
            where: { id: orderId },
            include: { portfolio: true },
        });
        if (!order)
            throw new Error(`Order ${orderId} not found`);
        if (order.status !== 'FILLED')
            throw new Error(`Order ${orderId} is not filled`);
        const qty = order.filledQty ?? order.qty;
        const price = Number(order.avgFillPrice ?? order.price ?? 0);
        const turnover = qty * price;
        const side = order.side;
        const exchange = order.exchange ?? 'NSE';
        const isIntraday = detectIntraday(order);
        const brokerage = Math.min(turnover * BROKERAGE_MAX_PCT, BROKERAGE_MAX_FLAT);
        let stt = 0;
        if (side === 'SELL') {
            stt = isIntraday
                ? turnover * STT_INTRADAY_PCT
                : turnover * STT_DELIVERY_PCT;
        }
        const exchangeCharges = turnover * EXCHANGE_CHARGE_NSE_PCT;
        const sebiCharges = turnover * SEBI_CHARGE_PCT;
        const gst = (brokerage + exchangeCharges + sebiCharges) * GST_PCT;
        let stampDuty = 0;
        if (side === 'BUY') {
            stampDuty = isIntraday
                ? turnover * STAMP_DUTY_INTRADAY_PCT
                : turnover * STAMP_DUTY_DELIVERY_PCT;
        }
        const totalCharges = brokerage + stt + exchangeCharges + gst + sebiCharges + stampDuty;
        const netAmount = side === 'BUY'
            ? turnover + totalCharges
            : turnover - totalCharges;
        log.debug({ orderId, totalCharges, netAmount }, 'contract note generated');
        return {
            orderId,
            tradeDate: order.createdAt,
            symbol: order.symbol,
            exchange,
            side,
            qty,
            price: round(price),
            brokerage: round(brokerage),
            stt: round(stt),
            exchangeCharges: round(exchangeCharges),
            gst: round(gst),
            sebiCharges: round(sebiCharges),
            stampDuty: round(stampDuty),
            totalCharges: round(totalCharges),
            netAmount: round(netAmount),
        };
    }
    async generateDailySummary(userId, date) {
        const dayStart = startOfDay(date);
        const dayEnd = endOfDay(date);
        const orders = await this.prisma.order.findMany({
            where: {
                portfolio: { userId },
                status: 'FILLED',
                createdAt: { gte: dayStart, lte: dayEnd },
            },
            include: { portfolio: true },
        });
        const trades = [];
        let totalBuyValue = 0;
        let totalSellValue = 0;
        let totalCharges = 0;
        for (const order of orders) {
            const note = await this.generateContractNote(order.id);
            trades.push(note);
            totalCharges += note.totalCharges;
            const tradeValue = note.qty * note.price;
            if (note.side === 'BUY') {
                totalBuyValue += tradeValue;
            }
            else {
                totalSellValue += tradeValue;
            }
        }
        return {
            date: dayStart,
            trades,
            totalBuyValue: round(totalBuyValue),
            totalSellValue: round(totalSellValue),
            netSettlement: round(totalSellValue - totalBuyValue - totalCharges),
            totalCharges: round(totalCharges),
        };
    }
    async generatePnLStatement(userId, from, to) {
        const orders = await this.prisma.order.findMany({
            where: {
                portfolio: { userId },
                status: 'FILLED',
                createdAt: { gte: startOfDay(from), lte: endOfDay(to) },
            },
            include: { portfolio: true },
            orderBy: { createdAt: 'asc' },
        });
        const speculative = createEmptyCategory();
        const nonSpeculative = createEmptyCategory();
        const businessIncome = createEmptyCategory();
        const groupedBySymbolDate = groupOrdersBySymbolDate(orders);
        for (const [, dayOrders] of groupedBySymbolDate) {
            const buys = dayOrders.filter((o) => o.side === 'BUY');
            const sells = dayOrders.filter((o) => o.side === 'SELL');
            const exchange = dayOrders[0]?.exchange ?? 'NSE';
            const isFO = exchange === 'NFO' || exchange === 'MCX' || exchange === 'CDS';
            const buyValue = buys.reduce((s, o) => s + (o.filledQty ?? o.qty) * (o.avgPrice ?? o.price ?? 0), 0);
            const sellValue = sells.reduce((s, o) => s + (o.filledQty ?? o.qty) * (o.avgPrice ?? o.price ?? 0), 0);
            const pnl = sellValue - buyValue;
            const totalCharges = await this.sumCharges(dayOrders);
            if (isFO) {
                const premiumReceived = sells.reduce((s, o) => {
                    return s + (o.filledQty ?? o.qty) * (o.avgPrice ?? o.price ?? 0);
                }, 0);
                businessIncome.turnover += Math.abs(pnl) + premiumReceived;
                businessIncome.grossPnl += pnl;
                businessIncome.expenses += totalCharges;
                businessIncome.netPnl += pnl - totalCharges;
            }
            else if (buys.length > 0 && sells.length > 0) {
                speculative.turnover += Math.abs(pnl);
                speculative.grossPnl += pnl;
                speculative.expenses += totalCharges;
                speculative.netPnl += pnl - totalCharges;
            }
            else {
                nonSpeculative.turnover += buyValue + sellValue;
                nonSpeculative.grossPnl += pnl;
                nonSpeculative.expenses += totalCharges;
                nonSpeculative.netPnl += pnl - totalCharges;
            }
        }
        roundCategory(speculative);
        roundCategory(nonSpeculative);
        roundCategory(businessIncome);
        return {
            period: { from, to },
            speculative,
            nonSpeculative,
            businessIncome,
            totalNetPnl: round(speculative.netPnl + nonSpeculative.netPnl + businessIncome.netPnl),
        };
    }
    async generateTaxSummary(userId, fy) {
        const { from, to } = parseFY(fy);
        const pnl = await this.generatePnLStatement(userId, from, to);
        const stcgGains = Math.max(0, pnl.nonSpeculative.netPnl);
        const stcgTax = stcgGains * STCG_RATE;
        const ltcgGains = 0;
        const ltcgExemption = Math.min(ltcgGains, LTCG_EXEMPTION);
        const ltcgTaxable = Math.max(0, ltcgGains - ltcgExemption);
        const ltcgTax = ltcgTaxable * LTCG_RATE;
        const speculativeIncome = pnl.speculative.netPnl + pnl.businessIncome.netPnl;
        return {
            fy,
            stcg: {
                gains: round(stcgGains),
                tax: round(stcgTax),
            },
            ltcg: {
                gains: round(ltcgGains),
                exemption: round(ltcgExemption),
                taxableGains: round(ltcgTaxable),
                tax: round(ltcgTax),
            },
            speculativeIncome: {
                income: round(speculativeIncome),
                note: 'Speculative and F&O business income taxed at applicable slab rate. Consult a CA for exact computation.',
            },
            totalTaxLiability: round(stcgTax + ltcgTax),
        };
    }
    async sumCharges(orders) {
        let total = 0;
        for (const order of orders) {
            const qty = order.filledQty ?? order.qty;
            const price = Number(order.avgFillPrice ?? order.price ?? 0);
            const turnover = qty * price;
            const brokerage = Math.min(turnover * BROKERAGE_MAX_PCT, BROKERAGE_MAX_FLAT);
            const exchangeCharges = turnover * EXCHANGE_CHARGE_NSE_PCT;
            const sebiCharges = turnover * SEBI_CHARGE_PCT;
            const gst = (brokerage + exchangeCharges + sebiCharges) * GST_PCT;
            total += brokerage + exchangeCharges + sebiCharges + gst;
        }
        return total;
    }
}
function detectIntraday(order) {
    if (order.orderType === 'MIS' || order.productType === 'MIS' || order.productType === 'INTRADAY') {
        return true;
    }
    return false;
}
function groupOrdersBySymbolDate(orders) {
    const map = new Map();
    for (const order of orders) {
        const dateKey = order.createdAt.toISOString().slice(0, 10);
        const key = `${order.symbol}:${dateKey}`;
        const list = map.get(key) ?? [];
        list.push(order);
        map.set(key, list);
    }
    return map;
}
function createEmptyCategory() {
    return { turnover: 0, grossPnl: 0, expenses: 0, netPnl: 0 };
}
function roundCategory(cat) {
    cat.turnover = round(cat.turnover);
    cat.grossPnl = round(cat.grossPnl);
    cat.expenses = round(cat.expenses);
    cat.netPnl = round(cat.netPnl);
}
function parseFY(fy) {
    const parts = fy.split('-');
    if (parts.length !== 2)
        throw new Error(`Invalid FY format: ${fy}. Expected format: 2025-26`);
    const startYear = parseInt(parts[0], 10);
    if (isNaN(startYear))
        throw new Error(`Invalid FY start year: ${parts[0]}`);
    return {
        from: new Date(startYear, 3, 1),
        to: new Date(startYear + 1, 2, 31, 23, 59, 59, 999),
    };
}
function round(n) {
    return Math.round(n * 100) / 100;
}
function startOfDay(d) {
    const s = new Date(d);
    s.setHours(0, 0, 0, 0);
    return s;
}
function endOfDay(d) {
    const e = new Date(d);
    e.setHours(23, 59, 59, 999);
    return e;
}
//# sourceMappingURL=trade-reporting.service.js.map