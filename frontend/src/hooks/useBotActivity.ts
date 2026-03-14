import { useEffect, useState, useCallback, useRef } from 'react';
import { liveSocket } from '../services/websocket';

export interface TimelineItem {
  id: string;
  type: 'bot_scan' | 'bot_decision' | 'signal' | 'trade' | 'risk_alert' | 'system';
  botName: string;
  summary: string;
  details?: Record<string, unknown>;
  timestamp: string;
}

export function useBotActivity(maxItems = 100) {
  const [items, setItems] = useState<TimelineItem[]>([]);
  const counterRef = useRef(0);

  const pushItem = useCallback((item: Omit<TimelineItem, 'id'>) => {
    const id = `ws-${++counterRef.current}-${Date.now()}`;
    setItems(prev => [{ ...item, id }, ...prev].slice(0, maxItems));
  }, [maxItems]);

  useEffect(() => {
    liveSocket.connect();

    const unsubs = [
      liveSocket.on('bot_activity', (msg: any) => {
        const typeMap: Record<string, TimelineItem['type']> = {
          scan_complete: 'bot_scan',
          signal_generated: 'signal',
          trade_executed: 'trade',
          risk_blocked: 'risk_alert',
          decision_made: 'bot_decision',
          status_change: 'system',
        };
        pushItem({
          type: typeMap[msg.activityType] ?? 'system',
          botName: msg.botName ?? 'System',
          summary: msg.summary ?? '',
          details: msg.details,
          timestamp: msg.timestamp ?? new Date().toISOString(),
        });
      }),

      liveSocket.on('signal', (msg: any) => {
        pushItem({
          type: 'signal',
          botName: msg.source ?? 'AI Agent',
          summary: `${msg.direction} ${msg.symbol} — ${((msg.confidence ?? 0) * 100).toFixed(0)}% confidence`,
          details: msg,
          timestamp: new Date().toISOString(),
        });
      }),

      liveSocket.on('trade_executed', (msg: any) => {
        pushItem({
          type: 'trade',
          botName: 'Trade Engine',
          summary: `${msg.side} ${msg.symbol}: ${msg.qty} @ ₹${Number(msg.price).toFixed(2)}`,
          details: msg,
          timestamp: new Date().toISOString(),
        });
      }),

      liveSocket.on('risk_violation', (msg: any) => {
        const d = msg.data ?? msg;
        pushItem({
          type: 'risk_alert',
          botName: 'Risk Monitor',
          summary: d.reason ?? d.message ?? 'Risk limit breached',
          details: d,
          timestamp: new Date().toISOString(),
        });
      }),

      liveSocket.on('circuit_breaker', (msg: any) => {
        const d = msg.data ?? msg;
        pushItem({
          type: 'risk_alert',
          botName: 'Circuit Breaker',
          summary: d.reason ?? 'Trading halted due to risk limits',
          details: d,
          timestamp: new Date().toISOString(),
        });
      }),

      liveSocket.on('notification', (msg: any) => {
        pushItem({
          type: 'system',
          botName: 'System',
          summary: msg.message ?? msg.title ?? '',
          details: msg,
          timestamp: new Date().toISOString(),
        });
      }),
    ];

    return () => { for (const u of unsubs) u(); };
  }, [pushItem]);

  const clearItems = useCallback(() => setItems([]), []);

  return { items, clearItems };
}
