import type { GlobalIndex } from '@/types';

interface Props {
  indices: GlobalIndex[];
}

const defaultIndices: GlobalIndex[] = [
  { name: 'S&P 500', symbol: 'SPX', value: 0, change: 0, changePercent: 0 },
  { name: 'Dow Jones', symbol: 'DJI', value: 0, change: 0, changePercent: 0 },
  { name: 'NASDAQ', symbol: 'IXIC', value: 0, change: 0, changePercent: 0 },
  { name: 'FTSE 100', symbol: 'FTSE', value: 0, change: 0, changePercent: 0 },
  { name: 'Nikkei 225', symbol: 'N225', value: 0, change: 0, changePercent: 0 },
  { name: 'SGX Nifty', symbol: 'SGX', value: 0, change: 0, changePercent: 0 },
];

export default function GlobalIndicesStrip({ indices = defaultIndices }: Props) {
  return (
    <div className="flex gap-2 overflow-x-auto rounded-xl border border-slate-200 bg-white p-3 shadow-sm scrollbar-thin">
      {indices.map((idx) => {
        const positive = idx.changePercent >= 0;
        return (
          <div
            key={idx.symbol}
            className="flex min-w-[140px] shrink-0 flex-col rounded-lg bg-slate-50 px-3 py-2"
          >
            <span className="text-xs font-medium text-slate-500">{idx.name}</span>
            <span className="text-sm font-semibold text-slate-900">
              {idx.value.toLocaleString('en-US', { maximumFractionDigits: 2 })}
            </span>
            <span className={`text-xs font-medium ${positive ? 'text-emerald-600' : 'text-red-600'}`}>
              {positive ? '+' : ''}{idx.change.toFixed(2)} ({positive ? '+' : ''}{idx.changePercent.toFixed(2)}%)
            </span>
          </div>
        );
      })}
    </div>
  );
}
