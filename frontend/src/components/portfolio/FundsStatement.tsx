import { formatINR } from '@/lib/utils';
import type { PortfolioSummary } from '@/types';

const money = (n: number) => formatINR(Math.abs(n));
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${money(n)}`;
const tone = (n: number) => (n > 0 ? 'text-emerald-600' : n < 0 ? 'text-red-600' : 'text-slate-700');

function Row({ label, value, cls = 'text-slate-700', hint, total }: { label: string; value: string; cls?: string; hint?: string; total?: boolean }) {
  return (
    <div className={`flex items-baseline justify-between gap-3 ${total ? 'border-t border-slate-200 pt-1.5 mt-1 font-semibold' : ''}`} title={hint}>
      <span className={total ? 'text-slate-800' : 'text-slate-500'}>{label}</span>
      <span className={`font-mono whitespace-nowrap ${total ? 'text-slate-900' : cls}`}>{value}</span>
    </div>
  );
}

/**
 * The account as a broker's funds statement: where the money is now, and how
 * it got there. Both halves end on the same net worth, so every figure on the
 * page can be checked by adding up.
 */
export default function FundsStatement({ summary, columns = false }: { summary: PortfolioSummary; columns?: boolean }) {
  const open = summary.unrealizedPnl;
  const unpriced = summary.openPositions?.unpriced ?? 0;
  const hasHistory = summary.realizedPnl != null && summary.openCharges != null;
  return (
    <div className={`text-xs ${columns ? 'grid grid-cols-1 md:grid-cols-2 gap-x-8 gap-y-3' : 'space-y-3'}`}>
      <div className="space-y-1">
        <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">Where your money is</p>
        <Row label="Free cash" value={money(summary.capitalFree)} hint="Not tied up in any position" />
        <Row label={`In open positions (${summary.openPositions?.count ?? 0})`} value={`+${money(summary.capitalUsed)}`}
          hint="What the open positions cost you, or the margin blocked for sold positions and futures" />
        <Row label={open >= 0 ? 'Open positions: gain so far' : 'Open positions: loss so far'} value={signed(open)} cls={tone(open)}
          hint="Open positions at the current price, compared with what you paid" />
        <Row label="Net worth" value={money(summary.totalNav)} total />
      </div>
      {hasHistory && (
        <div className="space-y-1">
          <p className="text-[10px] font-semibold uppercase tracking-wide text-slate-400">How it got there</p>
          <Row label="Capital you started with" value={money(summary.capital)} />
          <Row label="Closed trades (after charges)" value={signed(summary.realizedPnl!)} cls={tone(summary.realizedPnl!)} />
          <Row label={open >= 0 ? 'Open positions: gain so far' : 'Open positions: loss so far'} value={signed(open)} cls={tone(open)} />
          {Math.abs(summary.openCharges!) >= 0.5 && (
            <Row label="Charges paid on open positions" value={signed(-summary.openCharges!)} cls={tone(-summary.openCharges!)}
              hint="Brokerage and taxes already paid to open the positions you still hold" />
          )}
          <Row label="Net worth" value={money(summary.totalNav)} total />
        </div>
      )}
      {unpriced > 0 && (
        <p className={`text-[11px] text-amber-600 ${columns ? 'md:col-span-2' : ''}`}>
          {unpriced} open position{unpriced === 1 ? ' has' : 's have'} no price right now and {unpriced === 1 ? 'is' : 'are'} counted at cost.
        </p>
      )}
    </div>
  );
}
