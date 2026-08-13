import { Brain, TrendingUp, TrendingDown, Minus } from 'lucide-react';
import type { PreMarketBriefing } from '@/types';

interface Props {
  data: PreMarketBriefing;
}

const stanceColors: Record<string, string> = {
  bullish: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  bearish: 'bg-red-50 text-red-700 border-red-200',
  neutral: 'bg-blue-50 text-blue-700 border-blue-200',
};

const stanceIcon: Record<string, React.ReactNode> = {
  bullish: <TrendingUp className="h-4 w-4 text-emerald-600" />,
  bearish: <TrendingDown className="h-4 w-4 text-red-600" />,
  neutral: <Minus className="h-4 w-4 text-amber-500" />,
};

const stanceColor: Record<string, string> = {
  bullish: 'text-emerald-600',
  bearish: 'text-red-600',
  neutral: 'text-amber-600',
};

export default function PreMarketBriefingCard({ data }: Props) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm card-hover">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Brain className="h-4 w-4 text-slate-400" />
          <h3 className="text-sm font-medium text-slate-500">Pre-Market Briefing</h3>
        </div>
        <span className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${stanceColors[data.stance]}`}>
          {data.stance}
        </span>
      </div>

      <ul className="mb-4 space-y-1.5">
        {data.keyPoints.map((point, i) => (
          <li key={i} className="flex items-start gap-2 text-sm text-slate-600">
            <span className="mt-1.5 h-1.5 w-1.5 shrink-0 rounded-full bg-slate-400" />
            {point}
          </li>
        ))}
      </ul>

      <div className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2">
        <div className="flex items-center gap-2">
          {stanceIcon[data.stance]}
          <span className={`text-sm font-medium ${stanceColor[data.stance]}`}>
            Nifty: {data.stance.charAt(0).toUpperCase() + data.stance.slice(1)}
          </span>
        </div>
      </div>
    </div>
  );
}
