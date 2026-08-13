import { X, ChevronLeft, ChevronRight, ChevronsLeft, ChevronsRight } from 'lucide-react';
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

interface OrderTableProps {
  orders: any[];
  onCancelOrder: (orderId: string) => void;
  total: number;
  page: number;
  pageSize: number;
  onPageChange: (page: number) => void;
}

export default function OrderTable({ orders, onCancelOrder, total, page, pageSize, onPageChange }: OrderTableProps) {
  if (total === 0 && orders.length === 0) {
    return <p className="text-center text-slate-400 text-sm py-8">No orders yet</p>;
  }

  const totalPages = Math.max(1, Math.ceil(total / pageSize));
  const startItem = (page - 1) * pageSize + 1;
  const endItem = Math.min(page * pageSize, total);

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
            {orders.map((order: any) => (
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
            Showing {startItem}–{endItem} of {total}
          </span>
          <div className="flex items-center gap-1">
            <button
              onClick={() => onPageChange(1)}
              disabled={page <= 1}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
              title="First page"
            >
              <ChevronsLeft className="w-4 h-4 text-slate-500" />
            </button>
            <button
              onClick={() => onPageChange(page - 1)}
              disabled={page <= 1}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronLeft className="w-4 h-4 text-slate-500" />
            </button>
            {Array.from({ length: totalPages }, (_, i) => i + 1)
              .filter(p => p === 1 || p === totalPages || (p >= page - 2 && p <= page + 2))
              .reduce<(number | 'ellipsis')[]>((acc, p, idx, arr) => {
                if (idx > 0 && p - (arr[idx - 1] as number) > 1) acc.push('ellipsis');
                acc.push(p);
                return acc;
              }, [])
              .map((item, idx) =>
                item === 'ellipsis' ? (
                  <span key={`e-${idx}`} className="w-7 h-7 flex items-center justify-center text-xs text-slate-400">…</span>
                ) : (
                  <button
                    key={item}
                    onClick={() => onPageChange(item as number)}
                    className={`w-7 h-7 text-xs rounded font-medium ${
                      item === page ? 'bg-indigo-600 text-white' : 'text-slate-500 hover:bg-slate-100'
                    }`}
                  >
                    {item}
                  </button>
                )
              )}
            <button
              onClick={() => onPageChange(page + 1)}
              disabled={page >= totalPages}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
            >
              <ChevronRight className="w-4 h-4 text-slate-500" />
            </button>
            <button
              onClick={() => onPageChange(totalPages)}
              disabled={page >= totalPages}
              className="p-1 rounded hover:bg-slate-100 disabled:opacity-30 disabled:cursor-not-allowed"
              title="Last page"
            >
              <ChevronsRight className="w-4 h-4 text-slate-500" />
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
