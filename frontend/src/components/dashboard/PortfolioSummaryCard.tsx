import { TrendingUp, TrendingDown } from 'lucide-react';
import type { PortfolioSummary } from '@/types';
import { formatINR, formatPercent } from '@/types';

interface Props {
  data: PortfolioSummary;
}

export default function PortfolioSummaryCard({ data }: Props) {
  const dayPositive = data.dayPnl >= 0;
  const totalPositive = data.totalPnl >= 0;

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm card-hover">
      <h3 className="mb-4 text-sm font-medium text-slate-500">Portfolio Summary</h3>

      <div className="mb-4">
        <p className="text-xs text-slate-400">Net Asset Value</p>
        <p className="text-2xl font-bold text-slate-900">{formatINR(data.totalNav)}</p>
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div>
          <p className="text-xs text-slate-400">Day P&L</p>
          <div className="flex items-center gap-1.5">
            {dayPositive ? (
              <TrendingUp className="h-4 w-4 text-emerald-600" />
            ) : (
              <TrendingDown className="h-4 w-4 text-red-600" />
            )}
            <span className={`text-lg font-semibold ${dayPositive ? 'text-emerald-600' : 'text-red-600'}`}>
              {formatINR(data.dayPnl)}
            </span>
          </div>
          <p className={`text-xs ${dayPositive ? 'text-emerald-600/70' : 'text-red-600/70'}`}>
            {formatPercent(data.dayPnlPercent)}
          </p>
        </div>

        <div>
          <p className="text-xs text-slate-400">Total P&L</p>
          <span className={`text-lg font-semibold ${totalPositive ? 'text-emerald-600' : 'text-red-600'}`}>
            {formatINR(data.totalPnl)}
          </span>
          <p className={`text-xs ${totalPositive ? 'text-emerald-600/70' : 'text-red-600/70'}`}>
            {formatPercent(data.totalPnlPercent)}
          </p>
        </div>
      </div>
    </div>
  );
}
