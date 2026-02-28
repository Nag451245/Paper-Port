import type { MarketDepth } from '@/types';
import { formatINR } from '@/types';

interface Props {
  data: MarketDepth;
}

export default function MarketDepthTable({ data }: Props) {
  const maxQty = Math.max(
    ...data.bids.map((b) => b.quantity),
    ...data.asks.map((a) => a.quantity),
    1,
  );

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-3 text-sm font-medium text-slate-500">
        Market Depth — {data.symbol}
      </h3>

      <div className="grid grid-cols-2 gap-4">
        {/* Bid side */}
        <div>
          <div className="mb-2 flex justify-between text-xs text-slate-400">
            <span>Bid Qty</span>
            <span>Bid Price</span>
          </div>
          {data.bids.slice(0, 5).map((level, i) => (
            <div key={i} className="relative mb-1">
              <div
                className="absolute inset-y-0 left-0 rounded bg-blue-50"
                style={{ width: `${(level.quantity / maxQty) * 100}%` }}
              />
              <div className="relative flex justify-between px-2 py-1 text-sm">
                <span className="font-medium text-blue-600">{level.quantity.toLocaleString('en-IN')}</span>
                <span className="text-slate-800">{formatINR(level.price)}</span>
              </div>
            </div>
          ))}
          <div className="mt-2 border-t border-slate-200 pt-1 text-right text-xs text-slate-400">
            Total: {data.bids.reduce((sum, b) => sum + b.quantity, 0).toLocaleString('en-IN')}
          </div>
        </div>

        {/* Ask side */}
        <div>
          <div className="mb-2 flex justify-between text-xs text-slate-400">
            <span>Ask Price</span>
            <span>Ask Qty</span>
          </div>
          {data.asks.slice(0, 5).map((level, i) => (
            <div key={i} className="relative mb-1">
              <div
                className="absolute inset-y-0 right-0 rounded bg-red-50"
                style={{ width: `${(level.quantity / maxQty) * 100}%` }}
              />
              <div className="relative flex justify-between px-2 py-1 text-sm">
                <span className="text-slate-800">{formatINR(level.price)}</span>
                <span className="font-medium text-red-600">{level.quantity.toLocaleString('en-IN')}</span>
              </div>
            </div>
          ))}
          <div className="mt-2 border-t border-slate-200 pt-1 text-left text-xs text-slate-400">
            Total: {data.asks.reduce((sum, a) => sum + a.quantity, 0).toLocaleString('en-IN')}
          </div>
        </div>
      </div>
    </div>
  );
}
