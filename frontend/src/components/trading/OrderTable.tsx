import { useState } from 'react';
import { X, ChevronLeft, ChevronRight } from 'lucide-react';
import { OrderStatusBadge, SideBadge, StrategyBadge } from './StatusBadge';

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(v: any): number {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v);
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
  } catch { return String(iso); }
}

const PAGE_SIZE = 20;

interface OrderTableProps {
  orders: any[];
  onCancelOrder: (orderId: string) => void;
}

export default function OrderTable({ orders, onCancelOrder }: OrderTableProps) {
  const [page, setPage] = useState(0);

  if (orders.length === 0) {
    return <p className="text-center text-slate-400 text-sm py-8">No orders yet</p>;
  }

  const totalPages = Math.ceil(orders.length / PAGE_SIZE);
  const paged = orders.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-400 border-b border-slate-200">
              <th className="text-left pb-2 font-medium">Time</th>
              <th className="text-left pb-2 font-medium">Symbol</th>
              <th className="text-center pb-2 font-medium">Side</th>
              <th className="text-center pb-2 font-medium">Type</th>
              <th className="text-right pb-2 font-medium">Qty</th>
              <th className="text-right pb-2 font-medium">Price</th>
              <th className="text-center pb-2 font-medium">Status</th>
              <th className="text-left pb-2 font-medium hidden md:table-cell">Source</th>
              <th className="text-center pb-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((order: any) => (
              <tr key={order.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                <td className="py-2.5 text-slate-400 whitespace-nowrap">{fmtTime(order.createdAt ?? order.created_at)}</td>
                <td className="py-2.5 text-slate-800 font-medium">{order.symbol}</td>
                <td className="py-2.5 text-center"><SideBadge side={order.side} /></td>
                <td className="py-2.5 text-center text-slate-500">{order.orderType ?? order.order_type}</td>
                <td className="py-2.5 text-right font-mono text-slate-600">{order.filledQty ?? order.filled_qty}/{order.qty}</td>
                <td className="py-2.5 text-right font-mono text-slate-600">{order.price ? `₹${num(order.price).toFixed(2)}` : 'MKT'}</td>
                <td className="py-2.5 text-center"><OrderStatusBadge status={order.status} /></td>
                <td className="py-2.5 text-left hidden md:table-cell"><StrategyBadge tag={order.strategyTag ?? order.strategy_tag} /></td>
                <td className="py-2.5 text-center">
                  {(order.status === 'PENDING' || order.status === 'SUBMITTED') && (
                    <button onClick={() => onCancelOrder(order.id)} className="text-red-500 hover:text-red-600" title="Cancel order">
                      <X className="w-3.5 h-3.5" />
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-3 border-t border-slate-100 mt-2">
          <span className="text-xs text-slate-400">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, orders.length)} of {orders.length}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => setPage(p => Math.max(0, p - 1))}
              disabled={page === 0}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4 text-slate-500" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => (
              <button
                key={i}
                onClick={() => setPage(i)}
                className={`w-7 h-7 text-xs rounded font-medium ${
                  i === page ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {i + 1}
              </button>
            )).slice(Math.max(0, page - 2), page + 3)}
            <button
              onClick={() => setPage(p => Math.min(totalPages - 1, p + 1))}
              disabled={page >= totalPages - 1}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4 text-slate-500" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
