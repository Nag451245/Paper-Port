import { SideBadge, StrategyBadge } from './StatusBadge';

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

interface TradeTableProps {
  trades: any[];
}

export default function TradeTable({ trades }: TradeTableProps) {
  if (trades.length === 0) {
    return <p className="text-center text-slate-400 text-sm py-8">No completed trades yet</p>;
  }

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-xs">
        <thead>
          <tr className="text-slate-400 border-b border-slate-200">
            <th className="text-left pb-2 font-medium">Symbol</th>
            <th className="text-center pb-2 font-medium">Side</th>
            <th className="text-right pb-2 font-medium">Qty</th>
            <th className="text-right pb-2 font-medium">Entry</th>
            <th className="text-right pb-2 font-medium">Exit</th>
            <th className="text-right pb-2 font-medium">Net P&L</th>
            <th className="text-left pb-2 font-medium hidden md:table-cell">Source</th>
            <th className="text-right pb-2 font-medium hidden sm:table-cell">Duration</th>
            <th className="text-right pb-2 font-medium hidden sm:table-cell">Closed</th>
          </tr>
        </thead>
        <tbody>
          {trades.map((trade: any) => {
            const netPnl = num(trade.netPnl ?? trade.net_pnl);
            return (
              <tr key={trade.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                <td className="py-2.5 text-slate-800 font-medium">
                  {trade.symbol}<span className="text-slate-400 ml-1 text-[10px]">{trade.exchange}</span>
                </td>
                <td className="py-2.5 text-center"><SideBadge side={trade.side} /></td>
                <td className="py-2.5 text-right font-mono text-slate-600">{trade.qty}</td>
                <td className="py-2.5 text-right font-mono text-slate-600">₹{num(trade.entryPrice ?? trade.entry_price).toFixed(2)}</td>
                <td className="py-2.5 text-right font-mono text-slate-600">₹{num(trade.exitPrice ?? trade.exit_price).toFixed(2)}</td>
                <td className={`py-2.5 text-right font-mono font-semibold ${netPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {netPnl >= 0 ? '+' : ''}₹{netPnl.toFixed(2)}
                </td>
                <td className="py-2.5 text-left hidden md:table-cell">
                  <StrategyBadge tag={trade.strategyTag ?? trade.strategy_tag} />
                </td>
                <td className="py-2.5 text-right text-slate-400 hidden sm:table-cell">{trade.holdDuration ?? trade.hold_duration ?? '—'}</td>
                <td className="py-2.5 text-right text-slate-400 hidden sm:table-cell">{fmtTime(trade.exitTime ?? trade.exit_time)}</td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </div>
  );
}
