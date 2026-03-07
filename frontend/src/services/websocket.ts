type MessageHandler = (data: any) => void;

class LiveSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2000;
  private maxReconnectDelay = 30000;
  private subscribedSymbols = new Set<string>();
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private pongReceived = true;
  private static PING_INTERVAL = 25_000;

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const token = localStorage.getItem('token');
    let host = import.meta.env.VITE_WS_URL;
    if (!host) {
      const apiBase = import.meta.env.VITE_API_BASE_URL || '';
      if (apiBase && apiBase.startsWith('http')) {
        host = apiBase.replace(/^https:/, 'wss:').replace(/^http:/, 'ws:').replace(/\/api$/, '');
      } else {
        const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
        host = `${protocol}://localhost:8000`;
      }
    }
    const url = `${host}/ws${token ? `?token=${token}` : ''}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectDelay = 2000;
        this.startHeartbeat();
        if (this.subscribedSymbols.size > 0) {
          this.send({ action: 'subscribe_prices', symbols: [...this.subscribedSymbols] });
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
          if (msg.type === 'pong') {
            this.pongReceived = true;
            return;
          }
          const type = msg.type as string;
          const typeHandlers = this.handlers.get(type);
          if (typeHandlers) {
            for (const handler of typeHandlers) handler(msg);
          }
          const allHandlers = this.handlers.get('*');
          if (allHandlers) {
            for (const handler of allHandlers) handler(msg);
          }
        } catch { /* ignore */ }
      };

      this.ws.onclose = () => {
        this.stopHeartbeat();
        this.scheduleReconnect();
      };
      this.ws.onerror = () => { /* onclose will fire */ };
    } catch {
      this.scheduleReconnect();
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.pongReceived = true;
    this.pingTimer = setInterval(() => {
      if (!this.pongReceived) {
        this.ws?.close();
        return;
      }
      this.pongReceived = false;
      this.send({ action: 'ping' });
    }, LiveSocket.PING_INTERVAL);
  }

  private stopHeartbeat(): void {
    if (this.pingTimer) {
      clearInterval(this.pingTimer);
      this.pingTimer = null;
    }
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.reconnectDelay = Math.min(this.reconnectDelay * 1.5, this.maxReconnectDelay);
      this.connect();
    }, this.reconnectDelay);
  }

  disconnect(): void {
    this.stopHeartbeat();
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    if (this.ws) {
      this.ws.onclose = null;
      this.ws.close();
      this.ws = null;
    }
  }

  on(type: string, handler: MessageHandler): () => void {
    if (!this.handlers.has(type)) this.handlers.set(type, new Set());
    this.handlers.get(type)!.add(handler);
    return () => this.handlers.get(type)?.delete(handler);
  }

  off(type: string, handler: MessageHandler): void {
    this.handlers.get(type)?.delete(handler);
  }

  subscribePrices(symbols: string[]): void {
    for (const s of symbols) this.subscribedSymbols.add(s);
    this.send({ action: 'subscribe_prices', symbols });
  }

  unsubscribePrices(symbols: string[]): void {
    for (const s of symbols) this.subscribedSymbols.delete(s);
    this.send({ action: 'unsubscribe_prices', symbols });
  }

  private send(data: unknown): void {
    if (this.ws?.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    }
  }
}

export const liveSocket = new LiveSocket();

type QuoteHandler = (quote: { symbol: string; ltp: number; change: number; changePercent: number; volume: number; timestamp: string }) => void;

class PriceFeed {
  private symbolHandlers = new Map<string, Set<QuoteHandler>>();
  private unsubFns = new Map<string, () => void>();

  subscribe(symbol: string, handler: QuoteHandler): () => void {
    if (!this.symbolHandlers.has(symbol)) {
      this.symbolHandlers.set(symbol, new Set());
      liveSocket.subscribePrices([symbol]);

      const unsub = liveSocket.on('price', (msg: any) => {
        if (msg.symbol === symbol) {
          const handlers = this.symbolHandlers.get(symbol);
          if (handlers) for (const h of handlers) h(msg);
        }
      });
      this.unsubFns.set(symbol, unsub);
    }

    this.symbolHandlers.get(symbol)!.add(handler);

    return () => {
      const handlers = this.symbolHandlers.get(symbol);
      if (handlers) {
        handlers.delete(handler);
        if (handlers.size === 0) {
          this.symbolHandlers.delete(symbol);
          this.unsubFns.get(symbol)?.();
          this.unsubFns.delete(symbol);
          liveSocket.unsubscribePrices([symbol]);
        }
      }
    };
  }
}

export const priceFeed = new PriceFeed();

