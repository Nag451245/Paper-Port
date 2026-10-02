import { useQuery } from '@tanstack/react-query';
import { Loader2, ShieldCheck, ShieldAlert, ShieldQuestion } from 'lucide-react';
import { edgeApi, type ShadowEvidence } from '@/services/api';

const VERDICT = {
  proven: { label: 'Proven edge', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200', icon: ShieldCheck },
  disproven: { label: 'Loses money', cls: 'bg-red-50 text-red-700 border-red-200', icon: ShieldAlert },
  unproven: { label: 'Not proven', cls: 'bg-slate-50 text-slate-600 border-slate-200', icon: ShieldQuestion },
} as const;

const fmt = (v: number, dp = 2) => `${v >= 0 ? '+' : ''}${v.toFixed(dp)}`;

/**
 * Each engine strategy's live record: every signal traded on paper ("shadow")
 * on real 5-minute candles with costs, never placing an order.
 */
export default function ShadowEvidencePanel() {
  const { data, isLoading } = useQuery({
    queryKey: ['edge-shadow'],
    queryFn: async () => (await edgeApi.getShadow()).data,
    refetchInterval: 5 * 60_000,
  });

  if (isLoading) return <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>;
  if (!data) return <p className="text-sm text-slate-400 py-16 text-center">Could not load the live evidence.</p>;

  return (
    <div className="space-y-4">
      <div className="rounded-xl border border-slate-200/60 bg-white p-4 shadow-sm text-sm text-slate-600 space-y-1.5">
        <p>
          Every signal the Rust engine raises is traded here on paper, on live 5-minute candles: entry at the next candle's open,
          its own stop and target, out by 3:15 PM, minus about {data.rule.costPct.toFixed(2)}% costs. Nothing is ordered.
        </p>
        <p>
          A strategy counts as <b>proven</b> after {data.rule.minTrades}+ trades with an average result clearly above zero
          (t ≥ {data.rule.minT}). Gate: <b>{data.gateMode === 'enforce' ? 'unproven strategies cannot auto-trade' : 'unproven strategies are labelled, not blocked'}</b>.
          {data.open > 0 && <> {data.open} trade{data.open === 1 ? '' : 's'} still open.</>}
        </p>
      </div>

      <div className="rounded-xl border border-slate-200/60 bg-white shadow-sm overflow-hidden">
        {data.strategies.length === 0 ? (
          <p className="text-sm text-slate-400 py-12 text-center px-4">No settled shadow trades yet. They start collecting from the next market session.</p>
        ) : (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="text-left font-medium px-3 py-2">Strategy</th>
                  <th className="text-left font-medium px-3 py-2">Verdict</th>
                  <th className="text-right font-medium px-3 py-2">Trades</th>
                  <th className="text-right font-medium px-3 py-2">Win rate</th>
                  <th className="text-right font-medium px-3 py-2">Avg / trade</th>
                  <th className="text-right font-medium px-3 py-2">Avg R</th>
                  <th className="text-right font-medium px-3 py-2">t</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {data.strategies.map((s: ShadowEvidence) => {
                  const v = VERDICT[s.verdict];
                  return (
                    <tr key={s.strategy}>
                      <td className="px-3 py-2 font-semibold text-slate-800">{s.strategy}</td>
                      <td className="px-3 py-2">
                        <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px] whitespace-nowrap ${v.cls}`}>
                          <v.icon className="w-3 h-3" /> {v.label}
                          {s.verdict === 'unproven' && s.trades < data.rule.minTrades && ` · ${s.trades}/${data.rule.minTrades}`}
                        </span>
                      </td>
                      <td className="px-3 py-2 text-right font-mono">{s.trades}</td>
                      <td className="px-3 py-2 text-right font-mono">{(s.winRate * 100).toFixed(0)}%</td>
                      <td className={`px-3 py-2 text-right font-mono ${s.avgNetReturnPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmt(s.avgNetReturnPct, 3)}%</td>
                      <td className="px-3 py-2 text-right font-mono">{fmt(s.avgR)}</td>
                      <td className="px-3 py-2 text-right font-mono text-slate-500">{s.tStat.toFixed(1)}</td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>

      {data.recent.length > 0 && (
        <div className="rounded-xl border border-slate-200/60 bg-white p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-2">Latest settled shadow trades</h3>
          <ul className="divide-y divide-slate-100 text-xs">
            {data.recent.map((t, i) => (
              <li key={i} className="flex flex-wrap items-center justify-between gap-x-3 gap-y-0.5 py-1.5">
                <span><b className="text-slate-800">{t.side} {t.symbol}</b> <span className="text-slate-400">{t.strategy} · {t.day}</span></span>
                <span className="font-mono text-slate-500">
                  ₹{t.entry?.toFixed(2)} → ₹{t.exitPrice?.toFixed(2)} ({t.exitReason})
                  <b className={`ml-2 ${(t.rMultiple ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{fmt(t.rMultiple ?? 0)}R</b>
                </span>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
