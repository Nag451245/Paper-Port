import type { FastifyInstance } from 'fastify';
import type { WebSocket } from 'ws';
import websocket from '@fastify/websocket';

interface WsClient {
  socket: WebSocket;
  userId: string;
  subscribedSymbols: Set<string>;
  channels: Set<string>;
}

class WebSocketHub {
  private clients = new Map<WebSocket, WsClient>();
  private symbolSubscriptions = new Map<string, Set<WebSocket>>();

  register(socket: WebSocket, userId: string): void {
    const client: WsClient = {
      socket,
      userId,
      subscribedSymbols: new Set(),
      channels: new Set(['signals', 'notifications', 'bot_messages']),
    };
    this.clients.set(socket, client);

    socket.on('message', (raw) => {
      try {
        const msg = JSON.parse(raw.toString());
        this.handleMessage(socket, msg);
      } catch { /* ignore malformed */ }
    });

    socket.on('close', () => this.unregister(socket));
    socket.on('error', () => this.unregister(socket));

    socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
  }

  private handleMessage(socket: WebSocket, msg: { action?: string; symbols?: string[]; channel?: string }): void {
    const client = this.clients.get(socket);
    if (!client) return;

    if (msg.action === 'subscribe_prices' && Array.isArray(msg.symbols)) {
      for (const sym of msg.symbols.slice(0, 50)) {
        client.subscribedSymbols.add(sym);
        if (!this.symbolSubscriptions.has(sym)) {
          this.symbolSubscriptions.set(sym, new Set());
        }
        this.symbolSubscriptions.get(sym)!.add(socket);
      }
    }

    if (msg.action === 'unsubscribe_prices' && Array.isArray(msg.symbols)) {
      for (const sym of msg.symbols) {
        client.subscribedSymbols.delete(sym);
        this.symbolSubscriptions.get(sym)?.delete(socket);
      }
    }

    if (msg.action === 'subscribe_channel' && msg.channel) {
      client.channels.add(msg.channel);
    }
  }

  private unregister(socket: WebSocket): void {
    const client = this.clients.get(socket);
    if (client) {
      for (const sym of client.subscribedSymbols) {
        this.symbolSubscriptions.get(sym)?.delete(socket);
      }
    }
    this.clients.delete(socket);
    try { socket.close(); } catch { /* already closed */ }
  }

  broadcastPriceUpdate(symbol: string, data: { ltp: number; change: number; changePercent: number; volume: number; timestamp: string }): void {
    const subs = this.symbolSubscriptions.get(symbol);
    if (!subs || subs.size === 0) return;
    const payload = JSON.stringify({ type: 'price', symbol, ...data });
    for (const ws of subs) {
      if (ws.readyState === 1) ws.send(payload);
    }
  }

  broadcastToUser(userId: string, event: { type: string; [key: string]: unknown }): void {
    const payload = JSON.stringify(event);
    for (const [, client] of this.clients) {
      if (client.userId === userId && client.socket.readyState === 1) {
        client.socket.send(payload);
      }
    }
  }

  broadcastSignal(userId: string, signal: { symbol: string; direction: string; confidence: number; source: string }): void {
    this.broadcastToUser(userId, { type: 'signal', ...signal });
  }

  broadcastBotMessage(userId: string, message: { botId: string; content: string; messageType: string }): void {
    this.broadcastToUser(userId, { type: 'bot_message', ...message });
  }

  broadcastNotification(userId: string, notification: { title: string; message: string; notificationType: string }): void {
    this.broadcastToUser(userId, { type: 'notification', ...notification });
  }

  broadcastTradeExecution(userId: string, trade: { symbol: string; side: string; qty: number; price: number }): void {
    this.broadcastToUser(userId, { type: 'trade_executed', ...trade });
  }

  getConnectedCount(): number {
    return this.clients.size;
  }

  getSubscribedSymbols(): string[] {
    return [...this.symbolSubscriptions.keys()].filter(sym => {
      const subs = this.symbolSubscriptions.get(sym);
      return subs && subs.size > 0;
    });
  }
}

export const wsHub = new WebSocketHub();

export async function registerWebSocket(app: FastifyInstance): Promise<void> {
  await app.register(websocket);

  app.get('/ws', { websocket: true }, (socket, req) => {
    let userId = 'anonymous';
    try {
      const url = new URL(req.url ?? '', `http://${req.headers.host}`);
      const token = url.searchParams.get('token');
      if (token) {
        const decoded = app.jwt.verify<{ id: string }>(token);
        userId = decoded.id;
      }
    } catch { /* unauthenticated connection — allowed with limited features */ }

    wsHub.register(socket, userId);
  });
}
