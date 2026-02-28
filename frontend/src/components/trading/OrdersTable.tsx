import { X } from 'lucide-react';
import type { Order } from '@/types';
import { formatINR } from '@/types';

interface Props {
  orders: Order[];
  onCancel?: (orderId: string) => void;
}

const statusColors: Record<string, string> = {
  PENDING: 'text-amber-600 bg-amber-50',
  OPEN: 'text-blue-600 bg-blue-50',
  EXECUTED: 'text-emerald-600 bg-emerald-50',
  CANCELLED: 'text-slate-500 bg-slate-100',
  REJECTED: 'text-red-600 bg-red-50',
};

export default function OrdersTable({ orders, onCancel }: Props) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-medium text-slate-500">Orders</h3>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-400">
              <th className="pb-2 pr-3 font-medium">Time</th>
              <th className="pb-2 pr-3 font-medium">Symbol</th>
              <th className="pb-2 pr-3 font-medium">Type</th>
              <th className="pb-2 pr-3 font-medium">Side</th>
              <th className="pb-2 pr-3 text-right font-medium">Qty</th>
              <th className="pb-2 pr-3 text-right font-medium">Price</th>
              <th className="pb-2 pr-3 font-medium">Status</th>
              <th className="pb-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {orders.map((order) => (
              <tr key={order.id} className="border-b border-slate-100 transition-colors hover:bg-slate-50/50">
                <td className="py-2 pr-3 text-slate-400">
                  {new Date(order.placedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                </td>
                <td className="py-2 pr-3 font-medium text-slate-900">{order.symbol}</td>
                <td className="py-2 pr-3 text-slate-500">{order.type}</td>
                <td className="py-2 pr-3">
                  <span className={order.side === 'BUY' ? 'text-emerald-600' : 'text-red-600'}>
                    {order.side}
                  </span>
                </td>
                <td className="py-2 pr-3 text-right text-slate-800">{order.quantity}</td>
                <td className="py-2 pr-3 text-right text-slate-800">{formatINR(order.price)}</td>
                <td className="py-2 pr-3">
                  <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${statusColors[order.status] ?? ''}`}>
                    {order.status}
                  </span>
                </td>
                <td className="py-2">
                  {(order.status === 'PENDING' || order.status === 'OPEN') && (
                    <button
                      onClick={() => onCancel?.(order.id)}
                      className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-red-500"
                      title="Cancel order"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
            {orders.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-slate-400">No active orders</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
