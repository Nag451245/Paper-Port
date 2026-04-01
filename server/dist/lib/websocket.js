import websocket from '@fastify/websocket';
const HEARTBEAT_INTERVAL_MS = 30_000;
class WebSocketHub {
    clients = new Map();
    symbolSubscriptions = new Map();
    heartbeatTimer = null;
    register(socket, userId) {
        const client = {
            socket,
            userId,
            subscribedSymbols: new Set(),
            channels: new Set(['signals', 'notifications', 'bot_messages']),
            isAlive: true,
            pendingMessages: [],
            maxPendingMessages: 100,
        };
        this.clients.set(socket, client);
        socket.on('pong', () => {
            const c = this.clients.get(socket);
            if (c)
                c.isAlive = true;
        });
        socket.on('message', (raw) => {
            try {
                const msg = JSON.parse(raw.toString());
                this.handleMessage(socket, msg);
            }
            catch { /* ignore malformed */ }
        });
        socket.on('close', () => this.unregister(socket));
        socket.on('error', () => this.unregister(socket));
        socket.send(JSON.stringify({ type: 'connected', timestamp: new Date().toISOString() }));
        this.ensureHeartbeat();
    }
    ensureHeartbeat() {
        if (this.heartbeatTimer)
            return;
        this.heartbeatTimer = setInterval(() => {
            for (const [ws, client] of this.clients) {
                if (!client.isAlive) {
                    this.unregister(ws);
                    continue;
                }
                client.isAlive = false;
                try {
                    ws.ping();
                }
                catch {
                    this.unregister(ws);
                    continue;
                }
                if (client.pendingMessages.length > 0) {
                    this.drainPending(ws, client);
                }
            }
            if (this.clients.size === 0 && this.heartbeatTimer) {
                clearInterval(this.heartbeatTimer);
                this.heartbeatTimer = null;
            }
        }, HEARTBEAT_INTERVAL_MS);
    }
    handleMessage(socket, msg) {
        const client = this.clients.get(socket);
        if (!client)
            return;
        if (msg.action === 'ping') {
            client.isAlive = true;
            try {
                socket.send(JSON.stringify({ type: 'pong' }));
            }
            catch { /* closed */ }
            return;
        }
        if (msg.action === 'subscribe_prices' && Array.isArray(msg.symbols)) {
            for (const sym of msg.symbols.slice(0, 50)) {
                client.subscribedSymbols.add(sym);
                if (!this.symbolSubscriptions.has(sym)) {
                    this.symbolSubscriptions.set(sym, new Set());
                }
                this.symbolSubscriptions.get(sym).add(socket);
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
    unregister(socket) {
        const client = this.clients.get(socket);
        if (client) {
            for (const sym of client.subscribedSymbols) {
                this.symbolSubscriptions.get(sym)?.delete(socket);
            }
        }
        this.clients.delete(socket);
        try {
            socket.close();
        }
        catch { /* already closed */ }
    }
    safeSend(ws, client, payload) {
        if (ws.readyState !== 1)
            return;
        if (ws.bufferedAmount > 65536) {
            if (client.pendingMessages.length >= client.maxPendingMessages) {
                client.pendingMessages.shift();
            }
            client.pendingMessages.push(payload);
            return;
        }
        ws.send(payload);
    }
    drainPending(ws, client) {
        let sent = 0;
        while (client.pendingMessages.length > 0 && sent < 10) {
            if (ws.readyState !== 1 || ws.bufferedAmount > 65536)
                break;
            const msg = client.pendingMessages.shift();
            ws.send(msg);
            sent++;
        }
    }
    broadcastPriceUpdate(symbol, data) {
        const subs = this.symbolSubscriptions.get(symbol);
        if (!subs || subs.size === 0)
            return;
        const payload = JSON.stringify({ type: 'price', symbol, ...data });
        for (const ws of subs) {
            const client = this.clients.get(ws);
            if (client)
                this.safeSend(ws, client, payload);
        }
    }
    broadcastToUser(userId, event) {
        const payload = JSON.stringify(event);
        for (const [ws, client] of this.clients) {
            if (client.userId === userId) {
                this.safeSend(ws, client, payload);
            }
        }
    }
    broadcastSignal(userId, signal) {
        this.broadcastToUser(userId, { type: 'signal', ...signal });
    }
    broadcastBotMessage(userId, message) {
        this.broadcastToUser(userId, { type: 'bot_message', ...message });
    }
    broadcastBotActivity(userId, activity) {
        this.broadcastToUser(userId, {
            type: 'bot_activity',
            ...activity,
            timestamp: new Date().toISOString(),
        });
    }
    broadcastNotification(userId, notification) {
        this.broadcastToUser(userId, { type: 'notification', ...notification });
    }
    broadcastTradeExecution(userId, trade) {
        this.broadcastToUser(userId, { type: 'trade_executed', ...trade });
    }
    broadcastEngineSignal(symbol, data) {
        const subs = this.symbolSubscriptions.get(symbol);
        if (!subs || subs.size === 0)
            return;
        const payload = JSON.stringify({ type: 'engine_signal', symbol, ...data });
        for (const ws of subs) {
            const client = this.clients.get(ws);
            if (client)
                this.safeSend(ws, client, payload);
        }
    }
    broadcastRegime(data) {
        const payload = JSON.stringify({ type: 'regime_update', ...data });
        for (const [ws, client] of this.clients) {
            if (client.channels.has('signals')) {
                this.safeSend(ws, client, payload);
            }
        }
    }
    broadcastAnomaly(data) {
        const payload = JSON.stringify({ type: 'anomaly', ...data });
        for (const [ws, client] of this.clients) {
            if (client.channels.has('signals')) {
                this.safeSend(ws, client, payload);
            }
        }
    }
    getConnectedCount() {
        return this.clients.size;
    }
    getSubscribedSymbols() {
        return [...this.symbolSubscriptions.keys()].filter(sym => {
            const subs = this.symbolSubscriptions.get(sym);
            return subs && subs.size > 0;
        });
    }
    shutdown() {
        if (this.heartbeatTimer) {
            clearInterval(this.heartbeatTimer);
            this.heartbeatTimer = null;
        }
        for (const [ws] of this.clients) {
            try {
                ws.close(1001, 'Server shutting down');
            }
            catch { /* ignore */ }
        }
        this.clients.clear();
        this.symbolSubscriptions.clear();
    }
}
export const wsHub = new WebSocketHub();
export async function registerWebSocket(app) {
    await app.register(websocket, { options: { maxPayload: 1048576 } });
    app.server.setMaxListeners(50);
    app.get('/ws', { websocket: true }, (socket, req) => {
        let userId = null;
        try {
            const authHeader = req.headers['authorization'];
            let token = null;
            if (authHeader?.startsWith('Bearer ')) {
                token = authHeader.slice(7);
            }
            else {
                const url = new URL(req.url ?? '', `http://${req.headers.host}`);
                token = url.searchParams.get('token');
            }
            if (token) {
                const decoded = app.jwt.verify(token);
                userId = decoded.sub;
            }
        }
        catch {
            // Invalid token
        }
        if (!userId) {
            socket.send(JSON.stringify({ type: 'error', message: 'Authentication required' }));
            socket.close(4401, 'Unauthorized');
            return;
        }
        wsHub.register(socket, userId);
    });
}
//# sourceMappingURL=websocket.js.map