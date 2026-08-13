import { ShieldCheck, ShieldAlert, AlertTriangle } from 'lucide-react';
import type { CPRule, CPRuleStatus } from '@/types';

interface Props {
  rules: CPRule[];
}

const statusConfig: Record<CPRuleStatus, { icon: typeof ShieldCheck; color: string; bgColor: string }> = {
  Active: { icon: ShieldCheck, color: 'text-emerald-600', bgColor: 'bg-emerald-50' },
  Triggered: { icon: ShieldAlert, color: 'text-red-600', bgColor: 'bg-red-50' },
  Warning: { icon: AlertTriangle, color: 'text-amber-600', bgColor: 'bg-amber-50' },
};

export default function CapitalPreservationStatus({ rules }: Props) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <h3 className="mb-4 text-sm font-medium text-slate-500">Capital Preservation Rules</h3>

      <div className="space-y-2">
        {rules.map((rule) => {
          const config = statusConfig[rule.status];
          const Icon = config.icon;
          return (
            <div
              key={rule.id}
              className={`flex items-center gap-3 rounded-lg px-3 py-2.5 ${config.bgColor}`}
            >
              <Icon className={`h-4 w-4 shrink-0 ${config.color}`} />
              <div className="min-w-0 flex-1">
                <div className="flex items-center gap-2">
                  <span className="text-xs font-medium text-slate-400">{rule.id}</span>
                  <span className="truncate text-sm font-medium text-slate-800">{rule.name}</span>
                </div>
              </div>
              <span className={`shrink-0 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${config.color} border-current/20`}>
                {rule.status}
              </span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
