import type { WatchlistItem } from '@/types';
import { formatINR, formatPercent, formatVolume } from '@/types';

interface Props {
  items: WatchlistItem[];
  onSymbolClick?: (symbol: string) => void;
}

export default function WatchlistWidget({ items, onSymbolClick }: Props) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm card-hover">
      <h3 className="mb-3 text-sm font-medium text-slate-500">Watchlist</h3>

      <div className="overflow-x-auto">
        <table className="w-full text-left text-sm">
          <thead>
            <tr className="border-b border-slate-200 text-xs text-slate-400">
              <th className="pb-2 pr-4 font-medium">Symbol</th>
              <th className="pb-2 pr-4 text-right font-medium">LTP</th>
              <th className="pb-2 pr-4 text-right font-medium">Change</th>
              <th className="pb-2 pr-4 text-right font-medium">Chg%</th>
              <th className="pb-2 text-right font-medium">Volume</th>
            </tr>
          </thead>
          <tbody>
            {items.map((item) => {
              const positive = item.change >= 0;
              const colorClass = positive ? 'text-emerald-600' : 'text-red-600';
              return (
                <tr
                  key={item.symbol}
                  className="border-b border-slate-100 transition-colors hover:bg-slate-50/50 cursor-pointer"
                  onClick={() => onSymbolClick?.(item.symbol)}
                >
                  <td className="py-2 pr-4 font-medium text-slate-900">{item.symbol}</td>
                  <td className="py-2 pr-4 text-right text-slate-800">{formatINR(item.ltp)}</td>
                  <td className={`py-2 pr-4 text-right ${colorClass}`}>
                    {positive ? '+' : ''}{item.change.toFixed(2)}
                  </td>
                  <td className={`py-2 pr-4 text-right ${colorClass}`}>
                    {formatPercent(item.changePercent)}
                  </td>
                  <td className="py-2 text-right text-slate-400">{formatVolume(item.volume)}</td>
                </tr>
              );
            })}
            {items.length === 0 && (
              <tr>
                <td colSpan={5} className="py-6 text-center text-slate-400">No items in watchlist</td>
              </tr>
            )}
          </tbody>
        </table>
      </div>
    </div>
  );
}
