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
}

export interface BrokerOrderResult {
  orderId: string;
  status: string;
  message: string;
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
  cancelOrder(orderId: string): Promise<BrokerOrderResult>;
  getOrderStatus(orderId: string): Promise<{ status: string; filledQty: number; avgPrice: number }>;

  getPositions(): Promise<Array<{
    symbol: string;
    qty: number;
    avgPrice: number;
    ltp: number;
    pnl: number;
  }>>;
}

// Registry for available broker adapters
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

// Register ICICI Breeze as the default adapter
registerBrokerAdapter('breeze', () => ({
  name: 'ICICI Breeze',
  isConnected: () => true,
  connect: async () => {},
  disconnect: async () => {},
  getQuote: async () => ({ symbol: '', ltp: 0, change: 0, changePercent: 0, volume: 0, timestamp: '' }),
  getHistory: async () => [],
  search: async () => [],
  placeOrder: async () => ({ orderId: '', status: 'PENDING', message: '' }),
  cancelOrder: async () => ({ orderId: '', status: 'CANCELLED', message: '' }),
  getOrderStatus: async () => ({ status: 'PENDING', filledQty: 0, avgPrice: 0 }),
  getPositions: async () => [],
}));

// Placeholder for future brokers
registerBrokerAdapter('zerodha', () => ({
  name: 'Zerodha Kite',
  isConnected: () => false,
  connect: async () => { throw new Error('Zerodha Kite integration coming soon'); },
  disconnect: async () => {},
  getQuote: async () => { throw new Error('Not connected'); },
  getHistory: async () => { throw new Error('Not connected'); },
  search: async () => { throw new Error('Not connected'); },
  placeOrder: async () => { throw new Error('Not connected'); },
  cancelOrder: async () => { throw new Error('Not connected'); },
  getOrderStatus: async () => { throw new Error('Not connected'); },
  getPositions: async () => { throw new Error('Not connected'); },
}));

registerBrokerAdapter('angelone', () => ({
  name: 'Angel One',
  isConnected: () => false,
  connect: async () => { throw new Error('Angel One integration coming soon'); },
  disconnect: async () => {},
  getQuote: async () => { throw new Error('Not connected'); },
  getHistory: async () => { throw new Error('Not connected'); },
  search: async () => { throw new Error('Not connected'); },
  placeOrder: async () => { throw new Error('Not connected'); },
  cancelOrder: async () => { throw new Error('Not connected'); },
  getOrderStatus: async () => { throw new Error('Not connected'); },
  getPositions: async () => { throw new Error('Not connected'); },
}));
