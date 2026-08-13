import type { RiskMetrics } from '@/types';

interface Props {
  metrics: RiskMetrics;
}

interface MetricConfig {
  label: string;
  key: keyof RiskMetrics;
  format: (v: number) => string;
  goodThreshold: (v: number) => 'good' | 'neutral' | 'bad';
}

const METRICS: MetricConfig[] = [
  {
    label: 'Sharpe Ratio',
    key: 'sharpeRatio',
    format: (v) => v.toFixed(2),
    goodThreshold: (v) => (v >= 1.5 ? 'good' : v >= 1 ? 'neutral' : 'bad'),
  },
  {
    label: 'Max Drawdown',
    key: 'maxDrawdown',
    format: (v) => `${v.toFixed(2)}%`,
    goodThreshold: (v) => (Math.abs(v) <= 10 ? 'good' : Math.abs(v) <= 20 ? 'neutral' : 'bad'),
  },
  {
    label: 'Win Rate',
    key: 'winRate',
    format: (v) => `${v.toFixed(1)}%`,
    goodThreshold: (v) => (v >= 55 ? 'good' : v >= 45 ? 'neutral' : 'bad'),
  },
  {
    label: 'Profit Factor',
    key: 'profitFactor',
    format: (v) => v.toFixed(2),
    goodThreshold: (v) => (v >= 1.5 ? 'good' : v >= 1 ? 'neutral' : 'bad'),
  },
  {
    label: 'Portfolio Beta',
    key: 'beta',
    format: (v) => v.toFixed(2),
    goodThreshold: (v) => (v <= 0.8 ? 'good' : v <= 1.2 ? 'neutral' : 'bad'),
  },
];

const colorMap = {
  good: 'text-emerald-600',
  neutral: 'text-amber-600',
  bad: 'text-red-600',
};

const ringMap = {
  good: 'border-emerald-200',
  neutral: 'border-amber-200',
  bad: 'border-red-200',
};

export default function RiskMetricsCards({ metrics }: Props) {
  return (
    <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
      {METRICS.map((m) => {
        const value = metrics[m.key];
        const quality = m.goodThreshold(value);
        return (
          <div
            key={m.key}
            className={`rounded-xl border bg-white p-4 shadow-sm card-hover ${ringMap[quality]}`}
          >
            <p className="mb-1 text-xs text-slate-400">{m.label}</p>
            <p className={`text-xl font-bold ${colorMap[quality]}`}>{m.format(value)}</p>
          </div>
        );
      })}
    </div>
  );
}
