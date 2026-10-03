import { useCallback, useEffect, useState } from 'react';
import { LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, ReferenceLine } from 'recharts';
import { Loader2, Play, Plus, Trash2, History, AlertTriangle } from 'lucide-react';
import { marketApi, optionsLabApi, type LabBacktestParams, type LabLeg } from '@/services/api';
import { LAB_UNDERLYINGS, inr, tone, istTime, todayIst, shiftDays, useLabJob } from './lab-utils';
import JobProgress from './JobProgress';

/* eslint-disable @typescript-eslint/no-explicit-any */

const PRESETS: { name: string; legs: LabLeg[] }[] = [
  { name: 'Short straddle', legs: [
    { type: 'CE', action: 'SELL', lots: 1, strikeMode: 'atm', offset: 0 },
    { type: 'PE', action: 'SELL', lots: 1, strikeMode: 'atm', offset: 0 }] },
  { name: 'Short strangle', legs: [
    { type: 'CE', action: 'SELL', lots: 1, strikeMode: 'atm', offset: 4 },
    { type: 'PE', action: 'SELL', lots: 1, strikeMode: 'atm', offset: -4 }] },
  { name: 'Strangle by premium', legs: [
    { type: 'CE', action: 'SELL', lots: 1, strikeMode: 'premium', offset: 0, premium: 30 },
    { type: 'PE', action: 'SELL', lots: 1, strikeMode: 'premium', offset: 0, premium: 30 }] },
  { name: 'Iron condor', legs: [
    { type: 'CE', action: 'SELL', lots: 1, strikeMode: 'atm', offset: 3 },
    { type: 'CE', action: 'BUY', lots: 1, strikeMode: 'atm', offset: 6 },
    { type: 'PE', action: 'SELL', lots: 1, strikeMode: 'atm', offset: -3 },
    { type: 'PE', action: 'BUY', lots: 1, strikeMode: 'atm', offset: -6 }] },
  { name: 'Long straddle', legs: [
    { type: 'CE', action: 'BUY', lots: 1, strikeMode: 'atm', offset: 0 },
    { type: 'PE', action: 'BUY', lots: 1, strikeMode: 'atm', offset: 0 }] },
  { name: 'Bull put spread', legs: [
    { type: 'PE', action: 'SELL', lots: 1, strikeMode: 'atm', offset: 0 },
    { type: 'PE', action: 'BUY', lots: 1, strikeMode: 'atm', offset: -4 }] },
  { name: 'Bear call spread', legs: [
    { type: 'CE', action: 'SELL', lots: 1, strikeMode: 'atm', offset: 0 },
    { type: 'CE', action: 'BUY', lots: 1, strikeMode: 'atm', offset: 4 }] },
];

const field = 'mt-0.5 w-full px-2 py-1.5 border border-slate-200 rounded-lg text-xs bg-white focus:outline-none focus:border-indigo-400';
const label = 'text-[10px] font-semibold uppercase tracking-wide text-slate-500';

export default function BacktestPanel() {
  const today = todayIst();
  const [p, setP] = useState<LabBacktestParams>({
    underlying: 'NIFTY', from: shiftDays(today, -91), to: today, expiryKind: 'weekly',
    entryDaysBefore: 0, entryTime: '09:20', exitDaysBefore: 0, exitTime: '15:15', holdToExpiry: false,
    legs: PRESETS[0].legs, lotSize: 0, slippagePct: 0.5, brokeragePerOrder: 20,
  });
  const [target, setTarget] = useState({ kind: 'pct' as 'pct' | 'rupees', value: '' });
  const [stop, setStop] = useState({ kind: 'pct' as 'pct' | 'rupees', value: '' });
  const [lotSizes, setLotSizes] = useState<Record<string, number>>({});
  const [coverage, setCoverage] = useState<any>(null);
  const [runs, setRuns] = useState<any[]>([]);
  const [result, setResult] = useState<any>(null);
  const { job, error, start, running } = useLabJob();
  const set = <K extends keyof LabBacktestParams>(k: K, v: LabBacktestParams[K]) => setP((x) => ({ ...x, [k]: v, ...(k === 'underlying' ? { lotSize: 0 } : {}) }));

  useEffect(() => { marketApi.lotSizes().then(({ data }) => setLotSizes(data.lotSizes ?? {})).catch(() => {}); }, []);
  // Lot size: what the user typed, else today's lot size for the index.
  const lotSize = p.lotSize > 0 ? p.lotSize : lotSizes[p.underlying] > 0 ? lotSizes[p.underlying] : 1;
  const loadCoverage = useCallback(() => {
    optionsLabApi.coverage(p.underlying).then(({ data }) => setCoverage(data)).catch(() => setCoverage(null));
  }, [p.underlying]);
  useEffect(() => { loadCoverage(); }, [loadCoverage]);
  const loadRuns = useCallback(() => { optionsLabApi.backtests().then(({ data }) => setRuns(data)).catch(() => {}); }, []);
  useEffect(() => { loadRuns(); }, [loadRuns]);

  const updateLeg = (i: number, patch: Partial<LabLeg>) => set('legs', p.legs.map((l, j) => (j === i ? { ...l, ...patch } : l)));
  const run = () => {
    const t = Number(target.value), s = Number(stop.value);
    setResult(null);
    start(() => optionsLabApi.startBacktest({
      ...p,
      lotSize,
      target: t > 0 ? { kind: target.kind, value: t } : undefined,
      stop: s > 0 ? { kind: stop.kind, value: s } : undefined,
    }), (r) => { setResult(r); loadRuns(); loadCoverage(); });
  };

  const saved = coverage?.savedExpiries ?? [];
  return (
    <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">
      {/* Settings */}
      <div className="xl:col-span-4 space-y-3">
        <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-3">
          <div className="grid grid-cols-2 gap-2">
            <label className={label}>Index
              <select className={field} value={p.underlying} onChange={(e) => set('underlying', e.target.value)}>
                {LAB_UNDERLYINGS.map((u) => <option key={u}>{u}</option>)}
              </select>
            </label>
            <label className={label}>Expiry
              <select className={field} value={p.expiryKind} onChange={(e) => set('expiryKind', e.target.value as 'weekly' | 'monthly')}>
                <option value="weekly">Nearest (weekly)</option>
                <option value="monthly">Monthly</option>
              </select>
            </label>
            <label className={label}>From
              <input type="date" className={field} value={p.from} max={p.to} onChange={(e) => set('from', e.target.value)} />
            </label>
            <label className={label}>To
              <input type="date" className={field} value={p.to} min={p.from} max={today} onChange={(e) => set('to', e.target.value)} />
            </label>
          </div>
          <p className="text-[10px] text-slate-500">
            {saved.length
              ? <>Prices saved for {saved.length} {p.underlying} expiries ({saved[0].expiry} to {saved[saved.length - 1].expiry}); other dates are fetched from ICICI as needed.</>
              : <>No {p.underlying} option prices saved yet: the first run fetches them from ICICI (Breeze must be connected).</>}
            {coverage?.budget && <> ICICI requests today: {coverage.budget.used} of {coverage.budget.limit}.</>}
          </p>

          <div className="grid grid-cols-2 gap-2">
            <label className={label}>Enter (trading days before expiry)
              <input type="number" min={0} max={20} className={field} value={p.entryDaysBefore}
                onChange={(e) => set('entryDaysBefore', Math.max(0, Math.min(20, Number(e.target.value) || 0)))} />
            </label>
            <label className={label}>Entry time
              <input type="time" min="09:15" max="15:25" className={field} value={p.entryTime} onChange={(e) => set('entryTime', e.target.value)} />
            </label>
          </div>
          <label className="flex items-center gap-2 text-xs text-slate-600">
            <input type="checkbox" checked={p.holdToExpiry} onChange={(e) => set('holdToExpiry', e.target.checked)} />
            Hold to expiry (settle at the close, no closing orders)
          </label>
          {!p.holdToExpiry && (
            <div className="grid grid-cols-2 gap-2">
              <label className={label}>Exit (trading days before expiry)
                <input type="number" min={0} max={p.entryDaysBefore} className={field} value={p.exitDaysBefore}
                  onChange={(e) => set('exitDaysBefore', Math.max(0, Math.min(p.entryDaysBefore, Number(e.target.value) || 0)))} />
              </label>
              <label className={label}>Exit time
                <input type="time" min="09:15" max="15:30" className={field} value={p.exitTime} onChange={(e) => set('exitTime', e.target.value)} />
              </label>
            </div>
          )}
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-2">
          <div className="flex flex-wrap gap-1">
            {PRESETS.map((x) => (
              <button key={x.name} onClick={() => set('legs', x.legs)}
                className="px-2 py-0.5 text-[10px] font-semibold bg-indigo-50 text-indigo-700 rounded hover:bg-indigo-100">{x.name}</button>
            ))}
          </div>
          {p.legs.map((l, i) => (
            <div key={i} className="grid grid-cols-12 gap-1 items-end">
              <select className={`${field} col-span-2`} value={l.action} onChange={(e) => updateLeg(i, { action: e.target.value as 'BUY' | 'SELL' })}>
                <option>SELL</option><option>BUY</option>
              </select>
              <select className={`${field} col-span-2`} value={l.type} onChange={(e) => updateLeg(i, { type: e.target.value as 'CE' | 'PE' })}>
                <option>CE</option><option>PE</option>
              </select>
              <select className={`${field} col-span-3`} value={l.strikeMode} onChange={(e) => updateLeg(i, { strikeMode: e.target.value as 'atm' | 'premium' })}>
                <option value="atm">ATM ± strikes</option><option value="premium">by premium</option>
              </select>
              {l.strikeMode === 'atm'
                ? <input type="number" className={`${field} col-span-2`} value={l.offset} title="Strikes from the money: +2 = two strikes higher"
                    onChange={(e) => updateLeg(i, { offset: Number(e.target.value) || 0 })} />
                : <input type="number" className={`${field} col-span-2`} value={l.premium ?? ''} placeholder="₹" title="Nearest premium at entry"
                    onChange={(e) => updateLeg(i, { premium: Number(e.target.value) || undefined })} />}
              <input type="number" min={1} className={`${field} col-span-2`} value={l.lots} title="Lots"
                onChange={(e) => updateLeg(i, { lots: Math.max(1, Number(e.target.value) || 1) })} />
              <button className="col-span-1 pb-1.5 text-slate-400 hover:text-red-500" onClick={() => set('legs', p.legs.filter((_, j) => j !== i))}>
                <Trash2 className="w-3.5 h-3.5" />
              </button>
            </div>
          ))}
          <div className="flex items-center justify-between">
            <button disabled={p.legs.length >= 6} onClick={() => set('legs', [...p.legs, { type: 'CE', action: 'BUY', lots: 1, strikeMode: 'atm', offset: 0 }])}
              className="flex items-center gap-1 text-[11px] text-indigo-600 disabled:opacity-40"><Plus className="w-3 h-3" /> Add leg</button>
            <span className="text-[10px] text-slate-400">Columns: side · type · strike rule · strikes/₹ · lots</span>
          </div>
        </div>

        <div className="bg-white rounded-2xl border border-slate-200 p-4 space-y-2">
          <div className="grid grid-cols-2 gap-2">
            {([['Target', target, setTarget], ['Stop loss', stop, setStop]] as const).map(([name, v, setV]) => (
              <label key={name} className={label}>{name} (after charges)
                <div className="flex gap-1">
                  <input type="number" min={0} className={field} value={v.value} placeholder="none" onChange={(e) => setV({ ...v, value: e.target.value })} />
                  <select className={`${field} w-20`} value={v.kind} onChange={(e) => setV({ ...v, kind: e.target.value as 'pct' | 'rupees' })}>
                    <option value="pct">% prem</option><option value="rupees">₹</option>
                  </select>
                </div>
              </label>
            ))}
            <label className={label}>Lot size
              <input type="number" min={1} className={field} value={lotSize} onChange={(e) => set('lotSize', Math.max(1, Number(e.target.value) || 1))} />
            </label>
            <label className={label}>Slippage % each way
              <input type="number" min={0} max={5} step={0.1} className={field} value={p.slippagePct} onChange={(e) => set('slippagePct', Math.max(0, Number(e.target.value) || 0))} />
            </label>
            <label className={label}>Brokerage ₹ per order
              <input type="number" min={0} max={100} className={field} value={p.brokeragePerOrder} onChange={(e) => set('brokeragePerOrder', Math.max(0, Number(e.target.value) || 0))} />
            </label>
          </div>
          <p className="text-[10px] text-slate-400">"% prem" is a percentage of the premium received or paid at entry. STT, exchange fees, GST and stamp duty use the rates in force on each trade date.</p>
          <button onClick={run} disabled={running || !p.legs.length}
            className="w-full py-2.5 rounded-xl text-sm font-bold bg-gradient-to-r from-indigo-600 to-violet-600 text-white disabled:opacity-50 flex items-center justify-center gap-2">
            {running ? <Loader2 className="w-4 h-4 animate-spin" /> : <Play className="w-4 h-4" />} Run backtest
          </button>
          {job?.state === 'running' && <JobProgress job={job} />}
          {error && <p className="text-xs text-red-700 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}
        </div>

        {runs.length > 0 && (
          <div className="bg-white rounded-2xl border border-slate-200 p-4">
            <p className="text-xs font-semibold text-slate-600 flex items-center gap-1.5 mb-2"><History className="w-3.5 h-3.5" /> Earlier runs</p>
            <ul className="space-y-1 max-h-60 overflow-y-auto">
              {runs.map((r) => (
                <li key={r.id} className="flex items-center gap-2 text-[11px]">
                  <button className="flex-1 text-left hover:text-indigo-600 truncate"
                    onClick={() => optionsLabApi.backtest(r.id).then(({ data }) => setResult(data)).catch(() => {})}>
                    {r.underlying} {r.dateFrom} → {r.dateTo} · {r.trades} trades · <span className={tone(r.net)}>{inr(r.net)}</span>
                  </button>
                  <button className="text-slate-300 hover:text-red-500" title="Delete"
                    onClick={() => optionsLabApi.deleteBacktest(r.id).then(loadRuns).catch(() => {})}><Trash2 className="w-3 h-3" /></button>
                </li>
              ))}
            </ul>
          </div>
        )}
      </div>

      {/* Results */}
      <div className="xl:col-span-8">
        {result ? <BacktestResult r={result} /> : (
          <div className="bg-white rounded-2xl border border-slate-200 p-10 text-center text-sm text-slate-400">
            Set up a strategy and run it. Every result is after brokerage, STT, exchange fees, GST, stamp duty and slippage.
          </div>
        )}
      </div>
    </div>
  );
}

function Stat({ name, value, cls = 'text-slate-800', hint }: { name: string; value: string; cls?: string; hint?: string }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-2.5" title={hint}>
      <p className="text-[9px] font-semibold uppercase text-slate-400">{name}</p>
      <p className={`text-sm font-bold font-mono ${cls}`}>{value}</p>
    </div>
  );
}

function BacktestResult({ r }: { r: any }) {
  const s = r.summary ?? {};
  const equity = (s.equity ?? []).map((e: any) => ({ ...e, label: istTime(e.t) }));
  return (
    <div className="space-y-3">
      <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
        <Stat name="Net P&L (after charges)" value={inr(s.net)} cls={tone(s.net)} />
        <Stat name="Trades" value={`${s.trades ?? 0}${s.skipped ? ` (+${s.skipped} skipped)` : ''}`} />
        <Stat name="Win rate" value={`${(s.win_rate ?? 0).toFixed(1)}%`} />
        <Stat name="Profit factor" value={(s.profit_factor ?? 0).toFixed(2)} hint="Total won ÷ total lost" />
        <Stat name="Max drawdown" value={inr(-(s.max_drawdown ?? 0))} cls="text-red-600" hint="Largest fall from a running high, after charges" />
        <Stat name="Avg win / loss" value={`${inr(s.avg_win)} / ${inr(s.avg_loss)}`} />
        <Stat name="Charges paid" value={inr(s.charges)} cls="text-amber-700" hint={`STT ${inr(s.stt)}, brokerage ${inr(s.brokerage)}`} />
        <Stat name="Slippage" value={inr(s.slippage)} cls="text-amber-700" />
        <Stat name="Gross before charges" value={inr(s.gross)} cls={tone(s.gross)} />
        <Stat name="Per trade" value={inr(s.expectancy)} cls={tone(s.expectancy)} />
        <Stat name="Avg return on margin" value={`${(s.avg_return_on_margin ?? 0).toFixed(2)}%`} hint="Net per trade ÷ estimated margin" />
        <Stat name="Best / worst" value={`${inr(s.best)} / ${inr(s.worst)}`} />
      </div>

      {(r.notes?.length > 0) && (
        <div className="rounded-xl border border-amber-200 bg-amber-50 p-3 text-[11px] text-amber-800 space-y-1">
          {r.notes.map((n: string, i: number) => <p key={i} className="flex gap-1.5"><AlertTriangle className="w-3.5 h-3.5 shrink-0" />{n}</p>)}
        </div>
      )}

      {equity.length > 1 && (
        <div className="bg-white rounded-2xl border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-600 mb-2">Cumulative P&L after charges</p>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={equity} margin={{ top: 5, right: 10, left: 0, bottom: 0 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="label" tick={{ fontSize: 10, fill: '#94a3b8' }} minTickGap={30} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={(v: number) => inr(v)} width={70} />
                <Tooltip formatter={(v) => inr(Number(v))} />
                <ReferenceLine y={0} stroke="#94a3b8" strokeDasharray="4 4" />
                <Line type="monotone" dataKey="cum" stroke="#6366f1" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-2 gap-3">
        <div className="bg-white rounded-2xl border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-600 mb-2">By entry weekday</p>
          <table className="w-full text-[11px]">
            <thead><tr className="text-slate-400"><th className="text-left">Day</th><th className="text-right">Trades</th><th className="text-right">Wins</th><th className="text-right">Net</th></tr></thead>
            <tbody>{(s.by_weekday ?? []).map((d: any) => (
              <tr key={d.day}><td>{d.day}</td><td className="text-right">{d.trades}</td><td className="text-right">{d.wins}</td><td className={`text-right font-mono ${tone(d.net)}`}>{inr(d.net)}</td></tr>
            ))}</tbody>
          </table>
        </div>
        <div className="bg-white rounded-2xl border border-slate-200 p-3">
          <p className="text-xs font-semibold text-slate-600 mb-2">How trades ended</p>
          <ul className="text-[11px] space-y-0.5">
            {Object.entries(s.by_exit ?? {}).map(([k, v]) => <li key={k} className="flex justify-between"><span className="capitalize">{k}</span><span>{String(v)}</span></li>)}
          </ul>
          {r.basis && <p className="mt-2 text-[10px] text-slate-400">{r.basis}</p>}
        </div>
      </div>

      <div className="bg-white rounded-2xl border border-slate-200 p-3 overflow-x-auto">
        <p className="text-xs font-semibold text-slate-600 mb-2">Every trade</p>
        <table className="w-full text-[11px] whitespace-nowrap">
          <thead><tr className="text-slate-400 border-b border-slate-100">
            <th className="text-left py-1">Expiry</th><th className="text-left">Entry → exit</th><th className="text-left">Legs (entry → exit)</th>
            <th className="text-right">Gross</th><th className="text-right">Charges</th><th className="text-right">Net</th><th className="text-left pl-2">Ended</th>
          </tr></thead>
          <tbody>{(r.trades ?? []).map((t: any) => (
            <tr key={t.id} className="border-b border-slate-50">
              <td className="py-1">{t.expiry}</td>
              <td>{istTime(t.entry_time)} → {istTime(t.exit_time)}</td>
              <td>{(t.legs ?? []).map((l: any) => `${l.qty > 0 ? 'B' : 'S'} ${l.label} ${l.entry}→${l.exit}`).join(' · ')}</td>
              <td className={`text-right font-mono ${tone(t.gross)}`}>{inr(t.gross)}</td>
              <td className="text-right font-mono text-amber-700">{inr(t.charges?.total)}</td>
              <td className={`text-right font-mono font-semibold ${tone(t.net)}`}>{inr(t.net)}</td>
              <td className="pl-2 capitalize">{t.exit_reason}</td>
            </tr>
          ))}</tbody>
        </table>
        {(r.skipped ?? []).length > 0 && (
          <p className="mt-2 text-[10px] text-slate-500">Skipped: {r.skipped.map((x: any) => `${x.expiry} (${x.reason})`).join('; ')}</p>
        )}
      </div>
      <p className="text-[10px] text-slate-400">A backtest shows what would have happened with these rules on past prices. It is not a forecast; markets change.</p>
    </div>
  );
}
