import { createChildLogger } from '../lib/logger.js';
const log = createChildLogger('OrderBook');
const MAX_DEPTH_LEVELS = 5;
const DEFAULT_LAMBDA = 0.1;
const DEFAULT_AVG_DAILY_VOLUME = 1_000_000;
export class OrderBookService {
    books = new Map();
    update(symbol, bids, asks) {
        const state = this.getOrCreate(symbol);
        state.bids = bids
            .filter(l => l.price > 0 && l.qty >= 0)
            .sort((a, b) => b.price - a.price)
            .slice(0, MAX_DEPTH_LEVELS);
        state.asks = asks
            .filter(l => l.price > 0 && l.qty >= 0)
            .sort((a, b) => a.price - b.price)
            .slice(0, MAX_DEPTH_LEVELS);
        state.lastUpdate = new Date();
        this.trackSpread(state);
    }
    updateFromTick(symbol, ltp, bid, ask, bidQty, askQty, volume) {
        const state = this.getOrCreate(symbol);
        const bestBid = bid && bid > 0 ? bid : ltp * 0.9998;
        const bestAsk = ask && ask > 0 ? ask : ltp * 1.0002;
        const bQty = bidQty ?? 100;
        const aQty = askQty ?? 100;
        const tickSize = this.estimateTickSize(ltp);
        state.bids = [];
        state.asks = [];
        for (let i = 0; i < MAX_DEPTH_LEVELS; i++) {
            const decay = 1 / (1 + i * 0.3);
            state.bids.push({
                price: Number((bestBid - tickSize * i).toFixed(2)),
                qty: Math.round(bQty * decay),
            });
            state.asks.push({
                price: Number((bestAsk + tickSize * i).toFixed(2)),
                qty: Math.round(aQty * decay),
            });
        }
        if (volume && volume > 0) {
            state.cumulativeVolume += volume;
            state.cumulativeVwapNumerator += ltp * volume;
        }
        state.lastUpdate = new Date();
        this.trackSpread(state);
    }
    getSnapshot(symbol) {
        const state = this.books.get(symbol);
        if (!state || (state.bids.length === 0 && state.asks.length === 0)) {
            return {
                symbol,
                bids: [],
                asks: [],
                spread: 0,
                spreadBps: 0,
                midPrice: 0,
                vwap: 0,
                depthImbalance: 0,
                lastUpdate: new Date(0),
            };
        }
        const bestBid = state.bids[0]?.price ?? 0;
        const bestAsk = state.asks[0]?.price ?? 0;
        const spread = bestAsk > 0 && bestBid > 0 ? bestAsk - bestBid : 0;
        const midPrice = bestBid > 0 && bestAsk > 0 ? (bestBid + bestAsk) / 2 : bestBid || bestAsk;
        const spreadBps = midPrice > 0 ? (spread / midPrice) * 10_000 : 0;
        const vwap = state.cumulativeVolume > 0
            ? state.cumulativeVwapNumerator / state.cumulativeVolume
            : midPrice;
        return {
            symbol,
            bids: [...state.bids],
            asks: [...state.asks],
            spread: Number(spread.toFixed(2)),
            spreadBps: Number(spreadBps.toFixed(2)),
            midPrice: Number(midPrice.toFixed(2)),
            vwap: Number(vwap.toFixed(2)),
            depthImbalance: this.computeImbalance(state),
            lastUpdate: state.lastUpdate,
        };
    }
    getSpread(symbol) {
        const state = this.books.get(symbol);
        if (!state || state.bids.length === 0 || state.asks.length === 0)
            return 0;
        const mid = (state.bids[0].price + state.asks[0].price) / 2;
        if (mid <= 0)
            return 0;
        return Number((((state.asks[0].price - state.bids[0].price) / mid) * 10_000).toFixed(2));
    }
    getDepthImbalance(symbol) {
        const state = this.books.get(symbol);
        if (!state)
            return 0;
        return this.computeImbalance(state);
    }
    getMarketImpact(symbol, qty, side) {
        const state = this.books.get(symbol);
        if (!state || state.bids.length === 0 || state.asks.length === 0)
            return 0;
        const midPrice = (state.bids[0].price + state.asks[0].price) / 2;
        if (midPrice <= 0 || qty <= 0)
            return 0;
        const lambda = this.calibrateLambda(state);
        const avgDailyVolume = state.cumulativeVolume > 0
            ? state.cumulativeVolume
            : DEFAULT_AVG_DAILY_VOLUME;
        const normalizedQty = qty / avgDailyVolume;
        const impactPct = lambda * Math.sqrt(normalizedQty) * 100;
        const levels = side === 'BUY' ? state.asks : state.bids;
        let remaining = qty;
        let totalCost = 0;
        for (const level of levels) {
            const filled = Math.min(remaining, level.qty);
            totalCost += filled * level.price;
            remaining -= filled;
            if (remaining <= 0)
                break;
        }
        if (remaining > 0 && levels.length > 0) {
            const worstPrice = levels[levels.length - 1].price;
            const tickSize = this.estimateTickSize(midPrice);
            totalCost += remaining * (worstPrice + (side === 'BUY' ? tickSize : -tickSize));
        }
        const avgFillPrice = totalCost / qty;
        const bookImpact = Math.abs(avgFillPrice - midPrice) / midPrice * 100;
        return Number(Math.max(impactPct, bookImpact).toFixed(4));
    }
    getOrCreate(symbol) {
        let state = this.books.get(symbol);
        if (!state) {
            state = {
                bids: [],
                asks: [],
                lastUpdate: new Date(),
                recentSpreads: [],
                cumulativeVolume: 0,
                cumulativeVwapNumerator: 0,
            };
            this.books.set(symbol, state);
        }
        return state;
    }
    computeImbalance(state) {
        const totalBidQty = state.bids.reduce((s, l) => s + l.qty, 0);
        const totalAskQty = state.asks.reduce((s, l) => s + l.qty, 0);
        const total = totalBidQty + totalAskQty;
        if (total === 0)
            return 0;
        return Number(((totalBidQty - totalAskQty) / total).toFixed(4));
    }
    trackSpread(state) {
        if (state.bids.length === 0 || state.asks.length === 0)
            return;
        const spread = state.asks[0].price - state.bids[0].price;
        state.recentSpreads.push(spread);
        if (state.recentSpreads.length > 100) {
            state.recentSpreads.shift();
        }
    }
    calibrateLambda(state) {
        if (state.recentSpreads.length < 5)
            return DEFAULT_LAMBDA;
        const avgSpread = state.recentSpreads.reduce((a, b) => a + b, 0) / state.recentSpreads.length;
        const midPrice = state.bids.length > 0 && state.asks.length > 0
            ? (state.bids[0].price + state.asks[0].price) / 2
            : 0;
        if (midPrice <= 0)
            return DEFAULT_LAMBDA;
        const relativeSpread = avgSpread / midPrice;
        return Math.max(0.01, Math.min(1.0, relativeSpread * 50));
    }
    estimateTickSize(price) {
        if (price >= 500)
            return 0.05;
        if (price >= 50)
            return 0.05;
        return 0.01;
    }
}
//# sourceMappingURL=order-book.service.js.map