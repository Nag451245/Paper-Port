import { X } from 'lucide-react';
import type { Position } from '@/types';
import { formatINR, formatPercent } from '@/types';

interface Props {
  positions: Position[];
  onClose?: (symbol: string) => void;
}

export default function PositionsTable({ positions, onClose }: Props) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-medium text-slate-500">Positions</h3>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-400">
              <th className="pb-2 pr-3 font-medium">Symbol</th>
              <th className="pb-2 pr-3 text-right font-medium">Qty</th>
              <th className="pb-2 pr-3 text-right font-medium">Avg Price</th>
              <th className="pb-2 pr-3 text-right font-medium">LTP</th>
              <th className="pb-2 pr-3 text-right font-medium">P&L</th>
              <th className="pb-2 pr-3 text-right font-medium">P&L%</th>
              <th className="pb-2 pr-3 text-right font-medium">Day Chg</th>
              <th className="pb-2 font-medium" />
            </tr>
          </thead>
          <tbody>
            {positions.map((pos) => {
              const pnlPos = pos.unrealizedPnl >= 0;
              const dayPos = pos.dayPnl >= 0;
              return (
                <tr key={pos.symbol} className="border-b border-slate-100 transition-colors hover:bg-slate-50/50">
                  <td className="py-2 pr-3 font-medium text-slate-900">{pos.symbol}</td>
                  <td className="py-2 pr-3 text-right text-slate-800">{pos.quantity}</td>
                  <td className="py-2 pr-3 text-right text-slate-600">{formatINR(pos.avgPrice)}</td>
                  <td className="py-2 pr-3 text-right text-slate-800">{formatINR(pos.ltp)}</td>
                  <td className={`py-2 pr-3 text-right font-medium ${pnlPos ? 'text-emerald-600' : 'text-red-600'}`}>
                    {formatINR(pos.unrealizedPnl)}
                  </td>
                  <td className={`py-2 pr-3 text-right ${pnlPos ? 'text-emerald-600' : 'text-red-600'}`}>
                    {formatPercent(pos.unrealizedPnlPercent)}
                  </td>
                  <td className={`py-2 pr-3 text-right ${dayPos ? 'text-emerald-600' : 'text-red-600'}`}>
                    {formatINR(pos.dayPnl)}
                  </td>
                  <td className="py-2">
                    <button
                      onClick={() => onClose?.(pos.symbol)}
                      className="rounded p-1 text-slate-400 transition-colors hover:bg-slate-100 hover:text-red-500"
                      title="Close position"
                    >
                      <X className="h-4 w-4" />
                    </button>
                  </td>
                </tr>
              );
            })}
            {positions.length === 0 && (
              <tr>
                <td colSpan={8} className="py-6 text-center text-slate-400">No open positions</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
