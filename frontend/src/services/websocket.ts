type MessageHandler = (data: any) => void;

class LiveSocket {
  private ws: WebSocket | null = null;
  private handlers = new Map<string, Set<MessageHandler>>();
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectDelay = 2000;
  private maxReconnectDelay = 30000;
  private subscribedSymbols = new Set<string>();

  connect(): void {
    if (this.ws?.readyState === WebSocket.OPEN) return;

    const token = localStorage.getItem('token');
    const protocol = window.location.protocol === 'https:' ? 'wss' : 'ws';
    const host = import.meta.env.VITE_WS_URL || `${protocol}://localhost:8000`;
    const url = `${host}/ws${token ? `?token=${token}` : ''}`;

    try {
      this.ws = new WebSocket(url);

      this.ws.onopen = () => {
        this.reconnectDelay = 2000;
        if (this.subscribedSymbols.size > 0) {
          this.send({ action: 'subscribe_prices', symbols: [...this.subscribedSymbols] });
        }
      };

      this.ws.onmessage = (event) => {
        try {
          const msg = JSON.parse(event.data);
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

      this.ws.onclose = () => this.scheduleReconnect();
      this.ws.onerror = () => { /* onclose will fire */ };
    } catch {
      this.scheduleReconnect();
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

type QuoteHandler = (quote: any) => void;

class PriceFeed {
  private symbolHandlers = new Map<string, QuoteHandler>();

  subscribe(symbol: string, handler: QuoteHandler): void {
    this.symbolHandlers.set(symbol, handler);
    liveSocket.subscribePrices([symbol]);
    liveSocket.on('price_update', (msg: any) => {
      if (msg.symbol === symbol) {
        handler(msg);
      }
    });
  }

  unsubscribe(symbol: string): void {
    this.symbolHandlers.delete(symbol);
    liveSocket.unsubscribePrices([symbol]);
  }
}

export const priceFeed = new PriceFeed();

