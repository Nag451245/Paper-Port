import { TrendingUp, TrendingDown } from 'lucide-react';
import type { VIXData } from '@/types';

interface Props {
  data: VIXData;
}

function getVIXColor(value: number) {
  if (value < 15) return { text: 'text-emerald-600', bg: 'bg-emerald-500', label: 'Low' };
  if (value <= 22) return { text: 'text-amber-600', bg: 'bg-amber-500', label: 'Moderate' };
  return { text: 'text-red-600', bg: 'bg-red-500', label: 'High' };
}

export default function VIXWidget({ data }: Props) {
  const color = getVIXColor(data.current);
  const isUp = data.change >= 0;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm card-hover">
      <div className="mb-3 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-500">India VIX</h3>
        <span className={`rounded-full px-2 py-0.5 text-xs font-medium ${color.text} bg-slate-50`}>
          {color.label}
        </span>
      </div>

      <div className="flex items-end gap-3">
        <span className={`text-3xl font-bold ${color.text}`}>{data.current.toFixed(2)}</span>
        <div className="mb-1 flex items-center gap-1">
          {isUp ? (
            <TrendingUp className="h-4 w-4 text-red-500" />
          ) : (
            <TrendingDown className="h-4 w-4 text-emerald-500" />
          )}
          <span className={`text-sm font-medium ${isUp ? 'text-red-600' : 'text-emerald-600'}`}>
            {isUp ? '+' : ''}{data.change.toFixed(2)} ({isUp ? '+' : ''}{data.changePercent.toFixed(2)}%)
          </span>
        </div>
      </div>

      <div className="mt-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${color.bg} transition-all`}
          style={{ width: `${Math.min((data.current / 40) * 100, 100)}%` }}
        />
      </div>
      <div className="mt-1 flex justify-between text-[10px] text-slate-300">
        <span>0</span>
        <span>15</span>
        <span>22</span>
        <span>40</span>
      </div>
    </div>
  );
}
