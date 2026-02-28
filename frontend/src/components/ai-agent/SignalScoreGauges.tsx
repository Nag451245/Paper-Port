import type { SignalScores } from '@/types';

interface Props {
  data: SignalScores;
}

function scoreColor(score: number) {
  if (score < 40) return { bar: 'bg-red-500', text: 'text-red-600' };
  if (score <= 60) return { bar: 'bg-amber-500', text: 'text-amber-600' };
  return { bar: 'bg-emerald-500', text: 'text-emerald-600' };
}

export default function SignalScoreGauges({ data }: Props) {
  const compositeColor = scoreColor(data.compositeScore);

  return (
    <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
      <div className="mb-4 flex items-center justify-between">
        <h3 className="text-sm font-medium text-slate-500">Signal Score Gates</h3>
        <div className="flex items-center gap-2">
          <span className="text-xs text-slate-400">Composite</span>
          <span className={`text-lg font-bold ${compositeColor.text}`}>
            {data.compositeScore.toFixed(0)}
          </span>
        </div>
      </div>

      <div className="space-y-2.5">
        {data.gates.map((gate) => {
          const color = scoreColor(gate.score);
          return (
            <div key={gate.key}>
              <div className="mb-1 flex items-center justify-between text-xs">
                <span className="text-slate-500">
                  <span className="font-medium text-slate-700">{gate.key}</span>
                  {' '}{gate.label}
                </span>
                <span className={`font-semibold ${color.text}`}>{gate.score.toFixed(0)}</span>
              </div>
              <div className="h-2 w-full overflow-hidden rounded-full bg-slate-100">
                <div
                  className={`h-full rounded-full ${color.bar} transition-all`}
                  style={{ width: `${gate.score}%` }}
                />
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
