import { Check, X } from 'lucide-react';
import type { AISignal } from '@/types';

interface Props {
  signal: AISignal;
  showActions?: boolean;
  onExecute?: (signalId: string) => void;
  onReject?: (signalId: string) => void;
}

function scoreColor(score: number) {
  if (score < 40) return 'text-red-600';
  if (score <= 60) return 'text-amber-600';
  return 'text-emerald-600';
}

function scoreBarColor(score: number) {
  if (score < 40) return 'bg-red-500';
  if (score <= 60) return 'bg-amber-500';
  return 'bg-emerald-500';
}

export default function SignalCard({ signal, showActions = false, onExecute, onReject }: Props) {
  const isBuy = signal.signalType === 'BUY';

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm card-hover">
      <div className="mb-3 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <span className="text-base font-semibold text-slate-900">{signal.symbol}</span>
          <span
            className={`rounded px-2 py-0.5 text-xs font-bold ${
              isBuy ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
            }`}
          >
            {signal.signalType}
          </span>
        </div>
        <div className="text-right">
          <span className={`text-xl font-bold ${scoreColor(signal.compositeScore)}`}>
            {signal.compositeScore.toFixed(0)}
          </span>
          <span className="text-xs text-slate-400">/100</span>
        </div>
      </div>

      {/* Score gauge bar */}
      <div className="mb-3 h-1.5 w-full overflow-hidden rounded-full bg-slate-100">
        <div
          className={`h-full rounded-full ${scoreBarColor(signal.compositeScore)} transition-all`}
          style={{ width: `${signal.compositeScore}%` }}
        />
      </div>

      <div className="mb-2">
        <span className="rounded bg-slate-100 px-2 py-0.5 text-xs text-slate-500">
          {signal.strategyId ?? 'General'}
        </span>
      </div>

      <p className="mb-3 line-clamp-2 text-xs leading-relaxed text-slate-500">
        {signal.rationale}
      </p>

      <div className="flex items-center justify-between">
        <span className="text-[10px] text-slate-300">
          {new Date(signal.createdAt).toLocaleString('en-IN')}
        </span>

        {showActions && (
          <div className="flex gap-2">
            <button
              onClick={() => onReject?.(signal.id)}
              className="flex items-center gap-1 rounded-lg border border-slate-200 px-3 py-1.5 text-xs text-slate-500 transition-colors hover:border-red-300 hover:text-red-500"
            >
              <X className="h-3.5 w-3.5" />
              Reject
            </button>
            <button
              onClick={() => onExecute?.(signal.id)}
              className="flex items-center gap-1 rounded-lg bg-emerald-600 px-3 py-1.5 text-xs font-medium text-white transition-colors hover:bg-emerald-500"
            >
              <Check className="h-3.5 w-3.5" />
              Execute
            </button>
          </div>
        )}
      </div>
    </div>
  );
}
