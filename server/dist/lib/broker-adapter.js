import { env } from '../config.js';
const BREEZE_BRIDGE_URL = env.BREEZE_BRIDGE_URL;
const FETCH_TIMEOUT = 15_000;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff: 1s, 2s, 4s
const CB_FAILURE_THRESHOLD = 5;
const CB_RESET_MS = 30_000;
class CircuitBreaker {
    state = 'CLOSED';
    failures = 0;
    lastFailureTime = 0;
    isAllowed() {
        if (this.state === 'CLOSED')
            return true;
        if (this.state === 'OPEN') {
            if (Date.now() - this.lastFailureTime >= CB_RESET_MS) {
                this.state = 'HALF_OPEN';
                console.log('[CircuitBreaker] Transitioning to HALF_OPEN');
                return true;
            }
            return false;
        }
        return true; // HALF_OPEN allows one request
    }
    recordSuccess() {
        if (this.state === 'HALF_OPEN') {
            console.log('[CircuitBreaker] HALF_OPEN → CLOSED (success)');
        }
        this.state = 'CLOSED';
        this.failures = 0;
    }
    recordFailure() {
        this.failures++;
        this.lastFailureTime = Date.now();
        if (this.failures >= CB_FAILURE_THRESHOLD) {
            this.state = 'OPEN';
            console.log(`[CircuitBreaker] OPEN after ${this.failures} consecutive failures (reset in ${CB_RESET_MS / 1000}s)`);
        }
    }
    getState() { return this.state; }
}
async function withRetry(fn, cb, label) {
    if (!cb.isAllowed()) {
        throw new Error(`Circuit breaker OPEN for ${label} — rejecting request`);
    }
    let lastErr = null;
    for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
        try {
            const result = await fn();
            cb.recordSuccess();
            return result;
        }
        catch (err) {
            lastErr = err;
            if (attempt < RETRY_DELAYS.length) {
                const delay = RETRY_DELAYS[attempt];
                console.log(`[Broker] ${label} attempt ${attempt + 1} failed: ${lastErr.message}, retrying in ${delay}ms`);
                await new Promise(r => setTimeout(r, delay));
            }
        }
    }
    cb.recordFailure();
    throw lastErr;
}
// Registry
const adapters = new Map();
export function registerBrokerAdapter(name, factory) {
    adapters.set(name.toLowerCase(), factory);
}
export function getBrokerAdapter(name) {
    const factory = adapters.get(name.toLowerCase());
    return factory ? factory() : null;
}
export function getAvailableBrokers() {
    return [...adapters.keys()];
}
// ── ICICI Breeze Live Adapter ──
class BreezeAdapter {
    name = 'ICICI Breeze';
    connected = false;
    credentials = {};
    cb = new CircuitBreaker();
    isConnected() { return this.connected; }
    async connect(credentials) {
        this.credentials = credentials;
        try {
            const res = await fetch(`${BREEZE_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(5000) });
            if (res.ok) {
                const data = await res.json();
                this.connected = data.session_active === true;
                if (!this.connected)
                    throw new Error('Breeze session not active');
            }
        }
        catch (err) {
            this.connected = false;
            throw new Error(`Breeze connection failed: ${err.message}`);
        }
    }
    async disconnect() { this.connected = false; }
    async getQuote(symbol, exchange = 'NSE') {
        const res = await this.bridgeFetch(`/quote/${encodeURIComponent(symbol)}?exchange=${exchange}`);
        return res;
    }
    async getHistory(symbol, interval, from, to) {
        const res = await this.bridgeFetch(`/history/${encodeURIComponent(symbol)}?interval=${interval}&from=${from}&to=${to}`);
        return res.bars ?? [];
    }
    async search(query) {
        const res = await this.bridgeFetch(`/search?q=${encodeURIComponent(query)}`);
        return res.results ?? [];
    }
    async placeOrder(input) {
        const orderTypeMap = {
            'MARKET': 'market', 'LIMIT': 'limit', 'SL_M': 'stop_loss_market', 'SL_LIMIT': 'stop_loss_limit',
        };
        const payload = {
            stock_code: input.symbol,
            exchange_code: input.exchange === 'NSE' ? 'NSE' : input.exchange,
            product: input.product === 'INTRADAY' ? 'intraday' : 'cash',
            action: input.side.toLowerCase(),
            order_type: orderTypeMap[input.orderType] || 'market',
            quantity: input.qty,
            price: input.price ?? 0,
            stoploss: input.triggerPrice ?? 0,
            validity: input.validity ?? 'day',
        };
        try {
            const res = await this.bridgePost('/order/place', payload);
            const orderId = res?.order_id ?? res?.Success?.order_id ?? '';
            return {
                orderId: String(orderId),
                brokerOrderId: String(orderId),
                status: orderId ? 'PLACED' : 'FAILED',
                message: orderId ? `Order placed: ${orderId}` : (res?.Error ?? res?.message ?? 'Order placement failed'),
            };
        }
        catch (err) {
            return { orderId: '', status: 'FAILED', message: err.message };
        }
    }
    async modifyOrder(orderId, changes) {
        try {
            const res = await this.bridgePost('/order/modify', { order_id: orderId, ...changes });
            return {
                orderId, status: 'MODIFIED',
                message: res?.message ?? 'Order modified',
            };
        }
        catch (err) {
            return { orderId, status: 'FAILED', message: err.message };
        }
    }
    async cancelOrder(orderId) {
        try {
            const res = await this.bridgePost('/order/cancel', { order_id: orderId });
            return { orderId, status: 'CANCELLED', message: res?.message ?? 'Order cancelled' };
        }
        catch (err) {
            return { orderId, status: 'FAILED', message: err.message };
        }
    }
    async getOrderStatus(orderId) {
        try {
            const res = await this.bridgeFetch(`/order/status/${orderId}`);
            return {
                status: res.status ?? 'UNKNOWN',
                filledQty: Number(res.filled_qty ?? 0),
                avgPrice: Number(res.avg_price ?? 0),
                message: res.message ?? res.rejection_reason,
            };
        }
        catch {
            return { status: 'UNKNOWN', filledQty: 0, avgPrice: 0 };
        }
    }
    async getPositions() {
        try {
            const res = await this.bridgeFetch('/positions');
            return (res.positions ?? []).map((p) => ({
                symbol: p.stock_code ?? p.symbol ?? '',
                qty: Number(p.quantity ?? 0),
                avgPrice: Number(p.average_price ?? p.avg_price ?? 0),
                ltp: Number(p.ltp ?? 0),
                pnl: Number(p.pnl ?? 0),
                product: p.product ?? 'cash',
            }));
        }
        catch {
            return [];
        }
    }
    async getOrders() {
        try {
            const res = await this.bridgeFetch('/orders');
            return (res.orders ?? []).map((o) => ({
                orderId: String(o.order_id ?? ''),
                symbol: o.stock_code ?? o.symbol ?? '',
                side: (o.action ?? o.side ?? '').toUpperCase(),
                qty: Number(o.quantity ?? o.qty ?? 0),
                filledQty: Number(o.filled_qty ?? o.filledQty ?? 0),
                avgPrice: Number(o.avg_price ?? o.average_price ?? 0),
                status: (o.status ?? 'UNKNOWN').toUpperCase(),
                timestamp: o.order_datetime ?? o.timestamp ?? '',
            }));
        }
        catch {
            return [];
        }
    }
    async getMarginAvailable() {
        try {
            const res = await this.bridgeFetch('/margin');
            return {
                available: Number(res.available ?? 0),
                used: Number(res.used ?? 0),
                total: Number(res.total ?? 0),
            };
        }
        catch {
            return { available: 0, used: 0, total: 0 };
        }
    }
    async bridgeFetch(path) {
        return withRetry(async () => {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
            try {
                const res = await fetch(`${BREEZE_BRIDGE_URL}${path}`, { signal: ac.signal });
                clearTimeout(timer);
                if (!res.ok)
                    throw new Error(`Bridge returned ${res.status}`);
                return await res.json();
            }
            catch (err) {
                clearTimeout(timer);
                throw err;
            }
        }, this.cb, `GET ${path}`);
    }
    async bridgePost(path, body) {
        return withRetry(async () => {
            const ac = new AbortController();
            const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
            try {
                const res = await fetch(`${BREEZE_BRIDGE_URL}${path}`, {
                    method: 'POST',
                    headers: { 'Content-Type': 'application/json' },
                    body: JSON.stringify(body),
                    signal: ac.signal,
                });
                clearTimeout(timer);
                if (!res.ok)
                    throw new Error(`Bridge returned ${res.status}`);
                return await res.json();
            }
            catch (err) {
                clearTimeout(timer);
                throw err;
            }
        }, this.cb, `POST ${path}`);
    }
}
registerBrokerAdapter('breeze', () => new BreezeAdapter());
// ── Paper Trading Adapter (default) ──
class PaperAdapter {
    name = 'Paper Trading';
    isConnected() { return true; }
    async connect() { }
    async disconnect() { }
    async getQuote() { return { symbol: '', ltp: 0, change: 0, changePercent: 0, volume: 0, timestamp: '' }; }
    async getHistory() { return []; }
    async search() { return []; }
    async placeOrder(input) {
        return { orderId: `PAPER-${Date.now()}`, status: 'SIMULATED', message: 'Paper trade executed' };
    }
    async modifyOrder(orderId) {
        return { orderId, status: 'MODIFIED', message: 'Paper order modified' };
    }
    async cancelOrder(orderId) {
        return { orderId, status: 'CANCELLED', message: 'Paper order cancelled' };
    }
    async getOrderStatus() {
        return { status: 'FILLED', filledQty: 0, avgPrice: 0 };
    }
    async getPositions() {
        return [];
    }
    async getMarginAvailable() {
        return { available: 0, used: 0, total: 0 };
    }
}
registerBrokerAdapter('paper', () => new PaperAdapter());
//# sourceMappingURL=broker-adapter.js.map