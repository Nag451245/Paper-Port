import { env } from '../config.js';

const BREEZE_BRIDGE_URL = env.BREEZE_BRIDGE_URL;
const FETCH_TIMEOUT = 15_000;
const RETRY_DELAYS = [1000, 2000, 4000]; // exponential backoff: 1s, 2s, 4s
const CB_FAILURE_THRESHOLD = 5;
const CB_RESET_MS = 30_000;

type CircuitState = 'CLOSED' | 'OPEN' | 'HALF_OPEN';

class CircuitBreaker {
  private state: CircuitState = 'CLOSED';
  private failures = 0;
  private lastFailureTime = 0;

  isAllowed(): boolean {
    if (this.state === 'CLOSED') return true;
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

  recordSuccess(): void {
    if (this.state === 'HALF_OPEN') {
      console.log('[CircuitBreaker] HALF_OPEN → CLOSED (success)');
    }
    this.state = 'CLOSED';
    this.failures = 0;
  }

  recordFailure(): void {
    this.failures++;
    this.lastFailureTime = Date.now();
    if (this.failures >= CB_FAILURE_THRESHOLD) {
      this.state = 'OPEN';
      console.log(`[CircuitBreaker] OPEN after ${this.failures} consecutive failures (reset in ${CB_RESET_MS / 1000}s)`);
    }
  }

  getState(): CircuitState { return this.state; }
}

async function withRetry<T>(
  fn: () => Promise<T>,
  cb: CircuitBreaker,
  label: string,
): Promise<T> {
  if (!cb.isAllowed()) {
    throw new Error(`Circuit breaker OPEN for ${label} — rejecting request`);
  }

  let lastErr: Error | null = null;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    try {
      const result = await fn();
      cb.recordSuccess();
      return result;
    } catch (err) {
      lastErr = err as Error;
      if (attempt < RETRY_DELAYS.length) {
        const delay = RETRY_DELAYS[attempt];
        console.log(`[Broker] ${label} attempt ${attempt + 1} failed: ${lastErr.message}, retrying in ${delay}ms`);
        await new Promise(r => setTimeout(r, delay));
      }
    }
  }
  cb.recordFailure();
  throw lastErr!;
}

export interface BrokerQuote {
  symbol: string;
  ltp: number;
  change: number;
  changePercent: number;
  volume: number;
  timestamp: string;
}

export interface BrokerHistoricalBar {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface BrokerOrderInput {
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  orderType: 'MARKET' | 'LIMIT' | 'SL_M' | 'SL_LIMIT';
  qty: number;
  price?: number;
  triggerPrice?: number;
  product?: 'INTRADAY' | 'DELIVERY' | 'MARGIN';
  validity?: 'DAY' | 'IOC';
  expiry?: string;
  strike?: number;
  optionType?: 'CE' | 'PE';
}

export interface BrokerOrderResult {
  orderId: string;
  status: string;
  message: string;
  brokerOrderId?: string;
}

export interface BrokerAdapter {
  name: string;
  isConnected(): boolean;
  connect(credentials: Record<string, string>): Promise<void>;
  disconnect(): Promise<void>;

  getQuote(symbol: string, exchange?: string): Promise<BrokerQuote>;
  getHistory(symbol: string, interval: string, from: string, to: string): Promise<BrokerHistoricalBar[]>;
  search(query: string): Promise<Array<{ symbol: string; name: string; exchange: string }>>;

  placeOrder(input: BrokerOrderInput): Promise<BrokerOrderResult>;
  modifyOrder(orderId: string, changes: Partial<Pick<BrokerOrderInput, 'price' | 'qty' | 'triggerPrice'>>): Promise<BrokerOrderResult>;
  cancelOrder(orderId: string): Promise<BrokerOrderResult>;
  getOrderStatus(orderId: string): Promise<{ status: string; filledQty: number; avgPrice: number; message?: string }>;

  getPositions(): Promise<Array<{
    symbol: string;
    qty: number;
    avgPrice: number;
    ltp: number;
    pnl: number;
    product: string;
  }>>;

  getOrders?(): Promise<Array<{
    orderId: string;
    symbol: string;
    side: string;
    qty: number;
    filledQty: number;
    avgPrice: number;
    status: string;
    timestamp: string;
  }>>;

  getMarginAvailable(): Promise<{ available: number; used: number; total: number }>;
}

// Registry
const adapters = new Map<string, () => BrokerAdapter>();

export function registerBrokerAdapter(name: string, factory: () => BrokerAdapter): void {
  adapters.set(name.toLowerCase(), factory);
}

export function getBrokerAdapter(name: string): BrokerAdapter | null {
  const factory = adapters.get(name.toLowerCase());
  return factory ? factory() : null;
}

export function getAvailableBrokers(): string[] {
  return [...adapters.keys()];
}

// ── ICICI Breeze Live Adapter ──
class BreezeAdapter implements BrokerAdapter {
  name = 'ICICI Breeze';
  private connected = false;
  private credentials: Record<string, string> = {};
  private cb = new CircuitBreaker();

  isConnected(): boolean { return this.connected; }

  async connect(credentials: Record<string, string>): Promise<void> {
    this.credentials = credentials;
    try {
      const res = await fetch(`${BREEZE_BRIDGE_URL}/health`, { signal: AbortSignal.timeout(5000) });
      if (res.ok) {
        const data = await res.json() as any;
        this.connected = data.session_active === true;
        if (!this.connected) throw new Error('Breeze session not active');
      }
    } catch (err) {
      this.connected = false;
      throw new Error(`Breeze connection failed: ${(err as Error).message}`);
    }
  }

  async disconnect(): Promise<void> { this.connected = false; }

  async getQuote(symbol: string, exchange = 'NSE'): Promise<BrokerQuote> {
    const res = await this.bridgeFetch(`/quote/${encodeURIComponent(symbol)}?exchange=${exchange}`);
    return res as BrokerQuote;
  }

  async getHistory(symbol: string, interval: string, from: string, to: string): Promise<BrokerHistoricalBar[]> {
    const res = await this.bridgeFetch(`/history/${encodeURIComponent(symbol)}?interval=${interval}&from=${from}&to=${to}`);
    return (res as any).bars ?? [];
  }

  async search(query: string): Promise<Array<{ symbol: string; name: string; exchange: string }>> {
    const res = await this.bridgeFetch(`/search?q=${encodeURIComponent(query)}`);
    return (res as any).results ?? [];
  }

  async placeOrder(input: BrokerOrderInput): Promise<BrokerOrderResult> {
    const orderTypeMap: Record<string, string> = {
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
    } catch (err) {
      return { orderId: '', status: 'FAILED', message: (err as Error).message };
    }
  }

  async modifyOrder(orderId: string, changes: Partial<Pick<BrokerOrderInput, 'price' | 'qty' | 'triggerPrice'>>): Promise<BrokerOrderResult> {
    try {
      const res = await this.bridgePost('/order/modify', { order_id: orderId, ...changes });
      return {
        orderId, status: 'MODIFIED',
        message: res?.message ?? 'Order modified',
      };
    } catch (err) {
      return { orderId, status: 'FAILED', message: (err as Error).message };
    }
  }

  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    try {
      const res = await this.bridgePost('/order/cancel', { order_id: orderId });
      return { orderId, status: 'CANCELLED', message: res?.message ?? 'Order cancelled' };
    } catch (err) {
      return { orderId, status: 'FAILED', message: (err as Error).message };
    }
  }

  async getOrderStatus(orderId: string): Promise<{ status: string; filledQty: number; avgPrice: number; message?: string }> {
    try {
      const res = await this.bridgeFetch(`/order/status/${orderId}`);
      return {
        status: (res as any).status ?? 'UNKNOWN',
        filledQty: Number((res as any).filled_qty ?? 0),
        avgPrice: Number((res as any).avg_price ?? 0),
        message: (res as any).message ?? (res as any).rejection_reason,
      };
    } catch {
      return { status: 'UNKNOWN', filledQty: 0, avgPrice: 0 };
    }
  }

  async getPositions(): Promise<Array<{ symbol: string; qty: number; avgPrice: number; ltp: number; pnl: number; product: string }>> {
    try {
      const res = await this.bridgeFetch('/positions');
      return ((res as any).positions ?? []).map((p: any) => ({
        symbol: p.stock_code ?? p.symbol ?? '',
        qty: Number(p.quantity ?? 0),
        avgPrice: Number(p.average_price ?? p.avg_price ?? 0),
        ltp: Number(p.ltp ?? 0),
        pnl: Number(p.pnl ?? 0),
        product: p.product ?? 'cash',
      }));
    } catch { return []; }
  }

  async getOrders(): Promise<Array<{ orderId: string; symbol: string; side: string; qty: number; filledQty: number; avgPrice: number; status: string; timestamp: string }>> {
    try {
      const res = await this.bridgeFetch('/orders');
      return ((res as any).orders ?? []).map((o: any) => ({
        orderId: String(o.order_id ?? ''),
        symbol: o.stock_code ?? o.symbol ?? '',
        side: (o.action ?? o.side ?? '').toUpperCase(),
        qty: Number(o.quantity ?? o.qty ?? 0),
        filledQty: Number(o.filled_qty ?? o.filledQty ?? 0),
        avgPrice: Number(o.avg_price ?? o.average_price ?? 0),
        status: (o.status ?? 'UNKNOWN').toUpperCase(),
        timestamp: o.order_datetime ?? o.timestamp ?? '',
      }));
    } catch { return []; }
  }

  async getMarginAvailable(): Promise<{ available: number; used: number; total: number }> {
    try {
      const res = await this.bridgeFetch('/margin');
      return {
        available: Number((res as any).available ?? 0),
        used: Number((res as any).used ?? 0),
        total: Number((res as any).total ?? 0),
      };
    } catch {
      return { available: 0, used: 0, total: 0 };
    }
  }

  private async bridgeFetch(path: string): Promise<unknown> {
    return withRetry(async () => {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), FETCH_TIMEOUT);
      try {
        const res = await fetch(`${BREEZE_BRIDGE_URL}${path}`, { signal: ac.signal });
        clearTimeout(timer);
        if (!res.ok) throw new Error(`Bridge returned ${res.status}`);
        return await res.json();
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    }, this.cb, `GET ${path}`);
  }

  private async bridgePost(path: string, body: unknown): Promise<any> {
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
        if (!res.ok) throw new Error(`Bridge returned ${res.status}`);
        return await res.json();
      } catch (err) {
        clearTimeout(timer);
        throw err;
      }
    }, this.cb, `POST ${path}`);
  }
}

registerBrokerAdapter('breeze', () => new BreezeAdapter());

// ── Paper Trading Adapter (default) ──
class PaperAdapter implements BrokerAdapter {
  name = 'Paper Trading';
  isConnected(): boolean { return true; }
  async connect(): Promise<void> {}
  async disconnect(): Promise<void> {}
  async getQuote(): Promise<BrokerQuote> { return { symbol: '', ltp: 0, change: 0, changePercent: 0, volume: 0, timestamp: '' }; }
  async getHistory(): Promise<BrokerHistoricalBar[]> { return []; }
  async search(): Promise<Array<{ symbol: string; name: string; exchange: string }>> { return []; }
  async placeOrder(input: BrokerOrderInput): Promise<BrokerOrderResult> {
    return { orderId: `PAPER-${Date.now()}`, status: 'SIMULATED', message: 'Paper trade executed' };
  }
  async modifyOrder(orderId: string): Promise<BrokerOrderResult> {
    return { orderId, status: 'MODIFIED', message: 'Paper order modified' };
  }
  async cancelOrder(orderId: string): Promise<BrokerOrderResult> {
    return { orderId, status: 'CANCELLED', message: 'Paper order cancelled' };
  }
  async getOrderStatus(): Promise<{ status: string; filledQty: number; avgPrice: number }> {
    return { status: 'FILLED', filledQty: 0, avgPrice: 0 };
  }
  async getPositions(): Promise<Array<{ symbol: string; qty: number; avgPrice: number; ltp: number; pnl: number; product: string }>> {
    return [];
  }
  async getMarginAvailable(): Promise<{ available: number; used: number; total: number }> {
    return { available: 0, used: 0, total: 0 };
  }
}

registerBrokerAdapter('paper', () => new PaperAdapter());
