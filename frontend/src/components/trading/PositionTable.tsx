import { useState } from 'react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { SideBadge, StrategyBadge } from './StatusBadge';
import { tradingApi } from '@/services/api';

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

interface PositionTableProps {
  positions: any[];
  posLtpMap: Record<string, number>;
  onSuccess: (msg: string) => void;
  onError: (msg: string) => void;
  onRefresh: () => void;
}

export default function PositionTable({ positions, posLtpMap, onSuccess, onError, onRefresh }: PositionTableProps) {
  const [page, setPage] = useState(0);

  if (positions.length === 0) {
    return <p className="text-center text-slate-400 text-sm py-8">No open positions</p>;
  }

  const totalPages = Math.ceil(positions.length / PAGE_SIZE);
  const paged = positions.slice(page * PAGE_SIZE, (page + 1) * PAGE_SIZE);

  return (
    <div>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-400 border-b border-slate-200">
              <th className="text-left pb-2 font-medium">Symbol</th>
              <th className="text-center pb-2 font-medium">Side</th>
              <th className="text-right pb-2 font-medium">Qty</th>
              <th className="text-right pb-2 font-medium">Avg Price</th>
              <th className="text-right pb-2 font-medium">LTP</th>
              <th className="text-right pb-2 font-medium">Unrealized P&L</th>
              <th className="text-right pb-2 font-medium">Realized P&L</th>
              <th className="text-left pb-2 font-medium hidden md:table-cell">Strategy</th>
              <th className="text-right pb-2 font-medium hidden sm:table-cell">Opened</th>
              <th className="text-center pb-2 font-medium">Action</th>
            </tr>
          </thead>
          <tbody>
            {paged.map((pos: any) => {
              const avgPrice = num(pos.avgEntryPrice ?? pos.avg_entry_price);
              const qty = num(pos.qty);
              const liveLtp = posLtpMap[pos.symbol] || 0;
              const uPnl = liveLtp > 0 && avgPrice > 0
                ? (liveLtp - avgPrice) * qty * (pos.side === 'SHORT' ? -1 : 1)
                : num(pos.unrealizedPnl ?? pos.unrealized_pnl);
              const rPnl = num(pos.realizedPnl ?? pos.realized_pnl);
              return (
                <tr key={pos.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                  <td className="py-2.5 text-slate-800 font-medium">
                    {pos.symbol}<span className="text-slate-400 ml-1 text-[10px]">{pos.exchange}</span>
                  </td>
                  <td className="py-2.5 text-center"><SideBadge side={pos.side} /></td>
                  <td className="py-2.5 text-right font-mono text-slate-600">{qty}</td>
                  <td className="py-2.5 text-right font-mono text-slate-600">₹{avgPrice.toFixed(2)}</td>
                  <td className="py-2.5 text-right font-mono text-slate-600">{liveLtp > 0 ? `₹${liveLtp.toFixed(2)}` : '...'}</td>
                  <td className={`py-2.5 text-right font-mono ${uPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {uPnl >= 0 ? '+' : ''}₹{uPnl.toFixed(2)}
                  </td>
                  <td className={`py-2.5 text-right font-mono ${rPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {rPnl >= 0 ? '+' : ''}₹{rPnl.toFixed(2)}
                  </td>
                  <td className="py-2.5 text-left hidden md:table-cell">
                    <StrategyBadge tag={pos.strategyTag ?? pos.strategy_tag} />
                  </td>
                  <td className="py-2.5 text-right text-slate-400 hidden sm:table-cell">{fmtTime(pos.openedAt ?? pos.opened_at)}</td>
                  <td className="py-2.5 text-center">
                    <button
                      onClick={async () => {
                        if (!liveLtp || liveLtp <= 0) { onError('No live price available to close position'); return; }
                        try {
                          await tradingApi.closePosition(pos.id, liveLtp);
                          onSuccess(`${pos.side === 'SHORT' ? 'Covered' : 'Sold'} ${qty} ${pos.symbol} @ ₹${liveLtp.toFixed(2)}`);
                          onRefresh();
                        } catch (err: any) {
                          onError(err?.response?.data?.error || 'Failed to close position');
                        }
                      }}
                      className={`text-[10px] font-bold px-2 py-1 rounded transition ${pos.side === 'SHORT' ? 'bg-emerald-50 text-emerald-600 hover:bg-emerald-100' : 'bg-red-50 text-red-600 hover:bg-red-100'}`}
                    >
                      {pos.side === 'SHORT' ? 'COVER' : 'EXIT'}
                    </button>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>

      {totalPages > 1 && (
        <div className="flex items-center justify-between pt-3 border-t border-slate-100 mt-2">
          <span className="text-xs text-slate-400">
            Showing {page * PAGE_SIZE + 1}–{Math.min((page + 1) * PAGE_SIZE, positions.length)} of {positions.length}
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
