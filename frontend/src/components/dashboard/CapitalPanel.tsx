import { useState } from 'react';
import { Link } from 'react-router-dom';
import { portfolioApi } from '@/services/api';
import { formatINR } from '@/lib/utils';
import type { PortfolioSummary } from '@/types';

const signed = (n: number) => `${n >= 0 ? '+' : '-'}${formatINR(Math.abs(n))}`;

/**
 * Capital in use and free, open positions split into profit and loss (after
 * the cost of closing them now), and the automatic top-up switch.
 */
export default function CapitalPanel({ summary, portfolioId, onChanged }: {
  summary: PortfolioSummary; portfolioId: string | null; onChanged: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const pos = summary.openPositions;
  const top = summary.autoTopUp;
  if (!pos || !top) return <p className="text-xs text-slate-400 py-6 text-center">Capital details load after the next update.</p>;

  const usedPct = Math.min(100, Math.max(0, summary.capitalUsedPct));
  const toggle = async () => {
    if (!portfolioId || busy) return;
    setBusy(true); setError('');
    try { await portfolioApi.setAutoTopUp(portfolioId, !top.enabled); onChanged(); }
    catch { setError('Could not change the setting. Try again.'); }
    setBusy(false);
  };

  return (
    <div className="space-y-3">
      <div>
        <div className="flex items-baseline justify-between">
          <p className="text-xs text-slate-500">Capital</p>
          <Link to="/settings" className="text-[11px] text-indigo-600 hover:underline">Change</Link>
        </div>
        <p className="text-2xl font-bold font-mono text-slate-900">{formatINR(summary.capital)}</p>
        {top.added > 0 && <p className="text-[11px] text-slate-400">includes {formatINR(top.added)} added automatically</p>}
      </div>

      <div>
        <div className="h-2 rounded-full bg-slate-100 overflow-hidden">
          <div className={`h-full ${usedPct > 85 ? 'bg-red-500' : usedPct > 60 ? 'bg-amber-500' : 'bg-teal-500'}`} style={{ width: `${usedPct}%` }} />
        </div>
        <div className="grid grid-cols-2 gap-3 mt-2">
          <div className="bg-slate-50 rounded-xl p-2.5">
            <p className="text-xs text-slate-500">In use</p>
            <p className="text-base font-semibold font-mono text-slate-800">{formatINR(summary.capitalUsed)}</p>
            <p className="text-[11px] text-slate-400">{usedPct.toFixed(0)}% · {pos.count} open position{pos.count === 1 ? '' : 's'}</p>
          </div>
          <div className="bg-slate-50 rounded-xl p-2.5">
            <p className="text-xs text-slate-500">Free to use</p>
            <p className={`text-base font-semibold font-mono ${summary.capitalFree >= 0 ? 'text-slate-800' : 'text-red-600'}`}>{formatINR(summary.capitalFree)}</p>
            <p className="text-[11px] text-slate-400">cash not in positions</p>
          </div>
        </div>
      </div>

      <div>
        <p className="text-xs text-slate-500 mb-1.5">Open positions right now <span className="text-slate-400">(after the cost of closing)</span></p>
        <div className="grid grid-cols-2 gap-3">
          <div className="rounded-xl p-2.5 bg-emerald-50">
            <p className="text-xs text-emerald-700">In profit · {pos.inProfit.count}</p>
            <p className="text-base font-semibold font-mono text-emerald-600">{signed(pos.inProfit.amount)}</p>
          </div>
          <div className="rounded-xl p-2.5 bg-red-50">
            <p className="text-xs text-red-700">In loss · {pos.inLoss.count}</p>
            <p className="text-base font-semibold font-mono text-red-600">{signed(pos.inLoss.amount)}</p>
          </div>
        </div>
        <p className="text-[11px] text-slate-500 mt-1.5">
          Net <b className={pos.net >= 0 ? 'text-emerald-600' : 'text-red-600'}>{signed(pos.net)}</b>
          {pos.exitCharges > 0 && <> · closing them all would cost {formatINR(pos.exitCharges)} in charges</>}
          {pos.unpriced > 0 && <> · {pos.unpriced} without a price right now</>}
        </p>
      </div>

      <label className="flex items-start gap-2 text-[11px] text-slate-600 border-t border-slate-100 pt-2.5 cursor-pointer">
        <input type="checkbox" className="mt-0.5" checked={top.enabled} disabled={busy} onChange={toggle} />
        <span>
          Add capital automatically when my own order needs it, up to {formatINR(top.limit)} in total.
          <span className="block text-slate-400">Above that, raise it yourself in Settings (up to {formatINR(top.manualLimit)}). Bots never trigger this.</span>
        </span>
      </label>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}
