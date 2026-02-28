import { Bot, Activity, BarChart3 } from 'lucide-react';
import type { AIAgentStatus } from '@/types';

interface Props {
  data: AIAgentStatus;
}

const modeBadgeColors: Record<string, string> = {
  Autonomous: 'bg-purple-50 text-purple-600 border-purple-200',
  'Semi-Auto': 'bg-blue-50 text-blue-600 border-blue-200',
  Signal: 'bg-amber-50 text-amber-600 border-amber-200',
  Manual: 'bg-slate-100 text-slate-500 border-slate-200',
};

export default function AIAgentStatusCard({ data }: Props) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm card-hover">
      <div className="mb-4 flex items-center justify-between">
        <div className="flex items-center gap-2">
          <Bot className="h-4 w-4 text-slate-400" />
          <h3 className="text-sm font-medium text-slate-500">AI Agent</h3>
        </div>
        <span
          className={`rounded-full border px-2.5 py-0.5 text-xs font-medium ${modeBadgeColors[data.mode] ?? modeBadgeColors.Manual}`}
        >
          {data.mode}
        </span>
      </div>

      <div className="mb-4 flex items-center gap-2">
        <span
          className={`inline-block h-2.5 w-2.5 rounded-full ${data.isRunning ? 'animate-pulse bg-emerald-500' : 'bg-slate-300'}`}
        />
        <span className="text-sm text-slate-700">{data.isRunning ? 'Running' : 'Stopped'}</span>
        <span className="ml-auto text-xs text-slate-400">
          Last action: {data.lastAction}
        </span>
      </div>

      <div className="grid grid-cols-3 gap-3">
        <Stat icon={<Activity className="h-3.5 w-3.5" />} label="Strategies" value={data.activeStrategies} />
        <Stat icon={<BarChart3 className="h-3.5 w-3.5" />} label="Trades" value={data.todayTrades} />
        <Stat icon={<BarChart3 className="h-3.5 w-3.5" />} label="Signals" value={data.todaySignals} />
      </div>
    </div>
  );
}

function Stat({ icon, label, value }: { icon: React.ReactNode; label: string; value: number }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2 text-center">
      <div className="mb-1 flex items-center justify-center gap-1 text-slate-400">{icon}<span className="text-xs">{label}</span></div>
      <p className="text-lg font-semibold text-slate-900">{value}</p>
    </div>
  );
}
