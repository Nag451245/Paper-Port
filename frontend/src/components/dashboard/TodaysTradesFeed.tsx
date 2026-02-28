import { Clock } from 'lucide-react';
import type { Trade } from '@/types';
import { formatINR } from '@/types';

interface Props {
  trades: Trade[];
}

export default function TodaysTradesFeed({ trades }: Props) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm card-hover">
      <h3 className="mb-3 text-sm font-medium text-slate-500">Today's Trades</h3>

      <div className="max-h-[400px] space-y-2 overflow-y-auto pr-1 scrollbar-thin">
        {trades.map((trade) => {
          const isBuy = trade.side === 'BUY';
          const pnlPositive = (trade.pnl ?? 0) >= 0;
          return (
            <div
              key={trade.id}
              className="rounded-lg border border-slate-100 bg-slate-50 px-3 py-2.5"
            >
              <div className="flex items-center justify-between">
                <div className="flex items-center gap-2">
                  <span className="font-medium text-slate-900">{trade.symbol}</span>
                  <span
                    className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                      isBuy
                        ? 'bg-emerald-50 text-emerald-600'
                        : 'bg-red-50 text-red-600'
                    }`}
                  >
                    {trade.side}
                  </span>
                </div>
                <span className={`text-sm font-semibold ${pnlPositive ? 'text-emerald-600' : 'text-red-600'}`}>
                  {formatINR(trade.pnl)}
                </span>
              </div>

              <div className="mt-1.5 flex items-center justify-between text-xs text-slate-400">
                <div className="flex items-center gap-3">
                  <span>Qty: {trade.quantity}</span>
                  <span>@ {formatINR(trade.price)}</span>
                </div>
                <div className="flex items-center gap-2">
                  <span className="rounded bg-slate-200 px-1.5 py-0.5 text-[10px] text-slate-500">
                    {trade.strategy}
                  </span>
                  <span className="flex items-center gap-1">
                    <Clock className="h-3 w-3" />
                    {new Date(trade.time ?? trade.executedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                  </span>
                </div>
              </div>
            </div>
          );
        })}

        {trades.length === 0 && (
          <p className="py-8 text-center text-sm text-slate-400">No trades today</p>
        )}
      </div>
    </div>
  );
}
