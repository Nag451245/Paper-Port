import { useEffect, useState, useCallback } from 'react';
import { X, AlertTriangle, ShieldAlert, Zap, Bell } from 'lucide-react';
import { liveSocket } from '@/services/websocket';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Notification {
  id: number;
  type: 'trade' | 'risk' | 'signal' | 'system';
  title: string;
  message: string;
  severity: 'info' | 'success' | 'warning' | 'critical';
  timestamp: number;
}

const SEVERITY_STYLES: Record<string, string> = {
  info: 'border-l-blue-500 bg-blue-50/90',
  success: 'border-l-emerald-500 bg-emerald-50/90',
  warning: 'border-l-amber-500 bg-amber-50/90',
  critical: 'border-l-red-500 bg-red-50/90',
};

const SEVERITY_ICONS = {
  info: Bell,
  success: Zap,
  warning: AlertTriangle,
  critical: ShieldAlert,
};

const AUTO_DISMISS_MS: Record<string, number> = {
  info: 5000,
  success: 4000,
  warning: 8000,
  critical: 15000,
};

/**
 * Fixed-position toast stack that auto-subscribes to WebSocket events.
 * Renders in top-right corner. Mount once in App shell.
 */
export default function NotificationToaster() {
  const [notifications, setNotifications] = useState<Notification[]>([]);
  let counter = 0;

  const push = useCallback((n: Omit<Notification, 'id' | 'timestamp'>) => {
    const notif: Notification = { ...n, id: ++counter, timestamp: Date.now() };
    setNotifications(prev => [notif, ...prev].slice(0, 6));
    setTimeout(() => {
      setNotifications(prev => prev.filter(x => x.id !== notif.id));
    }, AUTO_DISMISS_MS[n.severity] ?? 5000);
  }, []);

  const dismiss = useCallback((id: number) => {
    setNotifications(prev => prev.filter(n => n.id !== id));
  }, []);

  useEffect(() => {
    liveSocket.connect();

    const unsubs = [
      liveSocket.on('order_filled', (msg: any) => {
        const d = msg.data ?? msg;
        push({ type: 'trade', title: 'Order Filled', message: `${d.side ?? ''} ${d.qty ?? ''} ${d.symbol ?? ''} @ ₹${d.fillPrice ?? d.price ?? ''}`, severity: 'success' });
      }),
      liveSocket.on('position_opened', (msg: any) => {
        const d = msg.data ?? msg;
        push({ type: 'trade', title: 'Position Opened', message: `${d.side ?? 'LONG'} ${d.symbol ?? ''}`, severity: 'info' });
      }),
      liveSocket.on('position_closed', (msg: any) => {
        const d = msg.data ?? msg;
        const pnl = Number(d.pnl ?? 0);
        push({ type: 'trade', title: 'Position Closed', message: `${d.symbol ?? ''} P&L: ${pnl >= 0 ? '+' : ''}₹${pnl.toFixed(2)}`, severity: pnl >= 0 ? 'success' : 'warning' });
      }),
      liveSocket.on('risk_violation', (msg: any) => {
        const d = msg.data ?? msg;
        push({ type: 'risk', title: 'Risk Violation', message: d.reason ?? d.message ?? 'Risk limit breached', severity: 'warning' });
      }),
      liveSocket.on('circuit_breaker', (msg: any) => {
        const d = msg.data ?? msg;
        push({ type: 'risk', title: 'Circuit Breaker', message: d.reason ?? 'Trading halted', severity: 'critical' });
      }),
      liveSocket.on('kill_switch', (msg: any) => {
        const d = msg.data ?? msg;
        push({ type: 'system', title: d.active ? 'KILL SWITCH' : 'Kill Switch Off', message: d.active ? 'All trading halted' : 'Trading resumed', severity: d.active ? 'critical' : 'info' });
      }),
      liveSocket.on('signal_generated', (msg: any) => {
        const d = msg.data ?? msg;
        push({ type: 'signal', title: 'New Signal', message: `${d.symbol ?? ''} ${d.direction ?? ''} (${((d.confidence ?? 0) * 100).toFixed(0)}%)`, severity: 'info' });
      }),
    ];

    return () => { for (const u of unsubs) u(); };
  }, [push]);

  if (notifications.length === 0) return null;

  return (
    <div className="fixed top-16 right-4 z-50 flex flex-col gap-2 w-80 pointer-events-none">
      {notifications.map((n) => {
        const Icon = SEVERITY_ICONS[n.severity];
        return (
          <div
            key={n.id}
            className={`pointer-events-auto border-l-4 rounded-lg shadow-lg p-3 flex items-start gap-2.5 animate-slide-in backdrop-blur-sm ${SEVERITY_STYLES[n.severity]}`}
          >
            <Icon className="w-4 h-4 mt-0.5 shrink-0 opacity-70" />
            <div className="flex-1 min-w-0">
              <p className="text-xs font-semibold text-slate-800">{n.title}</p>
              <p className="text-xs text-slate-600 truncate">{n.message}</p>
            </div>
            <button onClick={() => dismiss(n.id)} className="shrink-0 opacity-50 hover:opacity-100">
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        );
      })}
    </div>
  );
}
