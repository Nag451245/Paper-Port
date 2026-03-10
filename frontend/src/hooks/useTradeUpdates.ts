import { useEffect, useCallback, useRef, useState } from 'react';
import { liveSocket } from '../services/websocket';

/* eslint-disable @typescript-eslint/no-explicit-any */

export interface TradeEvent {
  type: string;
  data: any;
  receivedAt: number;
}

/**
 * Subscribes to real-time order/position WebSocket events.
 * Calls `onRefresh` to trigger data refetch whenever an order/position event arrives.
 * Returns the latest event for UI display.
 */
export function useTradeUpdates(onRefresh: () => void) {
  const [lastEvent, setLastEvent] = useState<TradeEvent | null>(null);
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;

  useEffect(() => {
    liveSocket.connect();

    const eventTypes = [
      'order_placed',
      'order_filled',
      'order_state_change',
      'position_opened',
      'position_closed',
      'trade_executed',
    ];

    const unsubs = eventTypes.map(type =>
      liveSocket.on(type, (msg: any) => {
        setLastEvent({ type, data: msg.data ?? msg, receivedAt: Date.now() });
        refreshRef.current();
      })
    );

    return () => { for (const u of unsubs) u(); };
  }, []);

  return lastEvent;
}

export interface RiskAlert {
  id: string;
  type: 'risk_violation' | 'circuit_breaker' | 'kill_switch' | 'signal_generated';
  title: string;
  message: string;
  severity: string;
  timestamp: number;
}

/**
 * Subscribes to real-time risk alerts (risk violations, circuit breaker, kill switch).
 * Maintains a rolling list of recent alerts for display.
 */
export function useRiskAlerts(maxAlerts = 20) {
  const [alerts, setAlerts] = useState<RiskAlert[]>([]);

  const dismissAlert = useCallback((id: string) => {
    setAlerts(prev => prev.filter(a => a.id !== id));
  }, []);

  const clearAlerts = useCallback(() => setAlerts([]), []);

  useEffect(() => {
    liveSocket.connect();
    let counter = 0;

    const unsubs = [
      liveSocket.on('risk_violation', (msg: any) => {
        const d = msg.data ?? msg;
        const alert: RiskAlert = {
          id: `rv-${++counter}`,
          type: 'risk_violation',
          title: 'Risk Violation',
          message: d.reason ?? d.message ?? `${d.ruleType ?? 'Risk'} limit breached`,
          severity: 'warning',
          timestamp: Date.now(),
        };
        setAlerts(prev => [alert, ...prev].slice(0, maxAlerts));
      }),

      liveSocket.on('circuit_breaker', (msg: any) => {
        const d = msg.data ?? msg;
        const alert: RiskAlert = {
          id: `cb-${++counter}`,
          type: 'circuit_breaker',
          title: 'Circuit Breaker Triggered',
          message: d.reason ?? 'Trading halted due to risk limits',
          severity: 'critical',
          timestamp: Date.now(),
        };
        setAlerts(prev => [alert, ...prev].slice(0, maxAlerts));
      }),

      liveSocket.on('kill_switch', (msg: any) => {
        const d = msg.data ?? msg;
        const alert: RiskAlert = {
          id: `ks-${++counter}`,
          type: 'kill_switch',
          title: d.active ? 'Kill Switch ACTIVATED' : 'Kill Switch Deactivated',
          message: d.reason ?? (d.active ? 'All trading halted immediately' : 'Trading resumed'),
          severity: d.active ? 'critical' : 'info',
          timestamp: Date.now(),
        };
        setAlerts(prev => [alert, ...prev].slice(0, maxAlerts));
      }),

      liveSocket.on('signal_generated', (msg: any) => {
        const d = msg.data ?? msg;
        const alert: RiskAlert = {
          id: `sig-${++counter}`,
          type: 'signal_generated',
          title: 'Signal Generated',
          message: `${d.symbol ?? ''} ${d.direction ?? ''} — confidence ${((d.confidence ?? 0) * 100).toFixed(0)}%`,
          severity: 'info',
          timestamp: Date.now(),
        };
        setAlerts(prev => [alert, ...prev].slice(0, maxAlerts));
      }),
    ];

    return () => { for (const u of unsubs) u(); };
  }, [maxAlerts]);

  return { alerts, dismissAlert, clearAlerts };
}
