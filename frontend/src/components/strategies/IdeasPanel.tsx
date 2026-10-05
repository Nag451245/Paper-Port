import { useCallback, useEffect, useRef, useState } from 'react';
import { Area, AreaChart, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { AlertTriangle, CheckCircle2, Lightbulb, Loader2, RefreshCw } from 'lucide-react';
import { formatINR } from '@/lib/utils';
import { optionsApi, tradingApi, type StrategyIdea, type StrategyIdeas, type StrategyCardData } from '@/services/api';

const UNDERLYINGS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'SENSEX'];
const errorText = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;
const legText = (i: StrategyIdea) => i.legs.map((l) => `${l.action === 'SELL' ? 'Sell' : 'Buy'} ${l.strike} ${l.type === 'CE' ? 'call' : 'put'} at ${l.premium}`).join(' · ');

function Fact({ label, value, cls = 'text-slate-800', hint }: { label: string; value: string; cls?: string; hint?: string }) {
  return (
    <div title={hint}>
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-sm font-semibold font-mono ${cls}`}>{value}</p>
    </div>
  );
}

function IdeaCard({ idea, spot, underlying, onPlace, placing, alreadyOpen }: {
  idea: StrategyIdea; spot: number; underlying: string; onPlace?: () => void; placing: boolean; alreadyOpen: boolean;
}) {
  const off = !!idea.blocked;
  return (
    <div className={`rounded-xl border p-4 space-y-3 ${off ? 'border-slate-200 bg-slate-50' : 'border-slate-200 bg-white shadow-sm'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div className="flex flex-wrap items-center gap-2">
          <h3 className="text-sm font-semibold text-slate-800">{idea.name}</h3>
          <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-slate-100 text-slate-600">
            {idea.view === 'neutral' ? 'Range-bound view' : idea.view === 'bullish' ? 'Bullish view' : 'Bearish view'}
          </span>
          {!off && idea.fit === 'with' && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-emerald-50 text-emerald-700">Suits today's market</span>}
          {off && <span className="text-[10px] font-semibold px-2 py-0.5 rounded-full bg-amber-50 text-amber-700">Not offered</span>}
        </div>
        {onPlace && (
          <button onClick={onPlace} disabled={placing} className="px-3 py-1.5 rounded-lg bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-500 disabled:opacity-50">
            {placing ? <Loader2 className="w-3.5 h-3.5 animate-spin inline" /> : 'Place this strategy'}
          </button>
        )}
      </div>
      {off && <p className="text-xs text-amber-700">Turned down because {idea.blocked}.</p>}
      <p className="text-xs font-mono text-slate-600">{legText(idea)}</p>

      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        <div className="lg:col-span-2 grid grid-cols-2 sm:grid-cols-4 gap-3">
          <Fact label={idea.kind === 'credit' ? 'Credit received' : 'Cost to enter'} value={formatINR(Math.abs(idea.netPremium), 0)} />
          <Fact label="Most it can make" value={formatINR(idea.maxProfit, 0)} cls="text-emerald-600" hint="At expiry, after charges" />
          <Fact label="Most it can lose" value={formatINR(Math.abs(idea.maxLoss), 0)} cls="text-red-600" hint="At expiry, after charges. Known in advance." />
          <Fact label="Chance of profit" value={`${idea.pop.toFixed(0)}%`} hint="At expiry, from current implied volatility" />
          <Fact label="Expected result" value={`${idea.expectedPnl >= 0 ? '+' : '−'}${formatINR(Math.abs(idea.expectedPnl), 0)}`} cls={idea.expectedPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}
            hint="Average outcome if the index keeps moving as it has over the last 20 sessions, after charges" />
          <Fact label="Margin blocked" value={formatINR(idea.margin, 0)} />
          <Fact label="Return on margin" value={`${idea.returnOnMargin.toFixed(1)}%`} hint="Expected result as a share of the margin blocked" />
          <Fact label="Charges to enter" value={formatINR(idea.charges, 0)} />
        </div>
        <div className="h-28">
          <ResponsiveContainer width="100%" height="100%">
            <AreaChart data={idea.payoff} margin={{ top: 4, right: 4, left: 0, bottom: 0 }}>
              <XAxis dataKey="spot" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 9 }} tickFormatter={(v) => Number(v).toFixed(0)} />
              <YAxis hide />
              <Tooltip formatter={(v) => [formatINR(Number(v), 0), 'At expiry']} labelFormatter={(v) => `${underlying} at ${Number(v).toLocaleString('en-IN')}`} />
              <ReferenceLine y={0} stroke="#94a3b8" />
              <ReferenceLine x={spot} stroke="#6366f1" strokeDasharray="4 3" />
              <Area type="linear" dataKey="pnl" stroke="#0f766e" strokeWidth={1.5} fill="#14b8a6" fillOpacity={0.12} isAnimationActive={false} />
            </AreaChart>
          </ResponsiveContainer>
        </div>
      </div>

      <ul className="text-xs text-slate-600 space-y-1">
        {idea.why.map((w) => <li key={w} className="flex gap-1.5"><CheckCircle2 className="w-3.5 h-3.5 mt-0.5 shrink-0 text-emerald-500" />{w}</li>)}
        {idea.warnings.map((w) => <li key={w} className="flex gap-1.5 text-amber-700"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />{w}</li>)}
        {alreadyOpen && <li className="flex gap-1.5 text-amber-700"><AlertTriangle className="w-3.5 h-3.5 mt-0.5 shrink-0" />You already have a strategy open on {underlying} for this expiry; this would add to that exposure.</li>}
      </ul>
    </div>
  );
}

/** Defined-risk strategies worked out from the live chain for the user to consider. Nothing is placed without a click. */
export default function IdeasPanel({ portfolioId, netWorth, open, onPlaced }: {
  portfolioId: string | null; netWorth: number | null; open: StrategyCardData[]; onPlaced: () => void;
}) {
  const [symbol, setSymbol] = useState('NIFTY');
  const [lots, setLots] = useState('1');
  const [maxLoss, setMaxLoss] = useState('');
  const [data, setData] = useState<StrategyIdeas | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [placing, setPlacing] = useState('');
  const [notice, setNotice] = useState('');
  const seq = useRef(0);
  // To the nearest thousand, so a tick in net worth does not trigger a recalculation.
  const worth = netWorth && netWorth > 0 ? Math.round(netWorth / 1000) * 1000 : undefined;

  const load = useCallback(async () => {
    const mine = ++seq.current;
    setLoading(true);
    setError('');
    try {
      const n = Math.max(1, Math.min(50, Math.floor(Number(lots)) || 1));
      const cap = Number(maxLoss) > 0 ? Number(maxLoss) : undefined;
      const { data: res } = await optionsApi.ideas(symbol, { lots: n, maxLoss: cap, netWorth: worth });
      if (mine === seq.current) setData(res);
    } catch (err) {
      if (mine === seq.current) { setData(null); setError(errorText(err, 'Could not work out ideas right now.')); }
    }
    if (mine === seq.current) setLoading(false);
  }, [symbol, lots, maxLoss, worth]);

  // Recalculate shortly after the inputs settle.
  useEffect(() => {
    const t = setTimeout(load, 400);
    return () => clearTimeout(t);
  }, [load]);

  const place = async (idea: StrategyIdea) => {
    if (!data?.expiry || !portfolioId) return;
    const ok = window.confirm(
      `Place ${idea.name} on ${symbol}?\n\n${legText(idea)}\n\nMargin blocked: about ${formatINR(idea.margin, 0)}\nMost it can lose: ${formatINR(Math.abs(idea.maxLoss), 0)}\n\nThis is a paper trade. Prices may have moved since the idea was worked out.`,
    );
    if (!ok) return;
    setPlacing(idea.id);
    setError('');
    setNotice('');
    try {
      const { data: res } = await tradingApi.executeStrategy({
        portfolio_id: portfolioId, symbol, expiry: data.expiry, strategy_name: idea.name,
        legs: idea.legs.map((l) => ({ type: l.type, strike: l.strike, action: l.action, qty: l.qty, premium: l.premium })),
      });
      const failed = (res as { results?: { error?: string }[] })?.results?.find((r) => r.error);
      if (failed?.error) setError(`${idea.name}: ${failed.error}`);
      else { setNotice(`${idea.name} placed. It is now under "Yours".`); onPlaced(); }
    } catch (err) {
      setError(errorText(err, 'The strategy could not be placed.'));
    }
    setPlacing('');
  };

  const openHere = !!data && open.some((c) => c.owner === 'user' && c.underlying === symbol && c.expiry === data.expiry);
  const input = 'h-9 rounded-lg border border-slate-200 px-2 text-sm bg-white';
  const turned = data ? Object.entries(data.rejected).sort((a, b) => b[1] - a[1]) : [];

  return (
    <div className="space-y-4">
      <div className="bg-white rounded-xl border border-slate-200 p-4 space-y-3">
        <div className="flex flex-wrap items-end gap-3">
          <label className="text-xs text-slate-500">Underlying
            <select value={symbol} onChange={(e) => setSymbol(e.target.value)} className={`${input} block mt-1`}>
              {UNDERLYINGS.map((u) => <option key={u}>{u}</option>)}
            </select>
          </label>
          <label className="text-xs text-slate-500">Lots
            <input value={lots} onChange={(e) => setLots(e.target.value)} inputMode="numeric" className={`${input} block mt-1 w-20`} />
          </label>
          <label className="text-xs text-slate-500">Most I will lose on one idea (₹, optional)
            <input value={maxLoss} onChange={(e) => setMaxLoss(e.target.value)} inputMode="numeric" placeholder="no limit" className={`${input} block mt-1 w-44`} />
          </label>
          <button onClick={load} className="h-9 px-3 rounded-lg border border-slate-200 text-sm text-slate-600 hover:bg-slate-50 flex items-center gap-1.5">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} /> Refresh
          </button>
          {data && <p className="text-xs text-slate-400 ml-auto">{symbol} at {data.read.spot.toLocaleString('en-IN')} · expiry {data.expiry ?? '—'} · {data.qty} units per leg</p>}
        </div>
        {data && (
          <ul className="text-xs text-slate-600 space-y-1 border-t border-slate-100 pt-3">
            {data.read.summary.map((s) => <li key={s} className="flex gap-1.5"><Lightbulb className="w-3.5 h-3.5 mt-0.5 shrink-0 text-amber-500" />{s}</li>)}
          </ul>
        )}
      </div>

      {error && <p className="px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">{error}</p>}
      {notice && <p className="px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-700">{notice}</p>}

      {!data && loading && <div className="flex justify-center py-16"><Loader2 className="w-8 h-8 animate-spin text-slate-400" /></div>}

      {data && data.ideas.map((i) => (
        <IdeaCard key={i.id} idea={i} spot={data.read.spot} underlying={symbol} placing={placing === i.id}
          onPlace={portfolioId ? () => place(i) : undefined} alreadyOpen={openHere} />
      ))}

      {data && data.ideas.length === 0 && (
        <div className="bg-white rounded-xl border border-slate-200 p-6 text-sm text-slate-600 space-y-1">
          <p className="font-semibold text-slate-800">{data.message ?? 'No ideas right now.'}</p>
          {data.nearMisses.length > 0 && <p className="text-xs text-slate-500">The closest candidates are below, with the reason each was turned down. They are shown for information and cannot be placed from here.</p>}
        </div>
      )}
      {data && data.nearMisses.map((i) => <IdeaCard key={i.id} idea={i} spot={data.read.spot} underlying={symbol} placing={false} alreadyOpen={false} />)}

      {data && (
        <p className="text-[11px] text-slate-400">
          {data.considered} combinations were checked.{turned.length > 0 && <> Turned down: {turned.map(([why, n]) => `${n} because ${why}`).join('; ')}.</>}
          {' '}Every idea has a known worst case. Sold legs are priced at the bid and bought legs at the ask. These are worked out from prices and past movement; they are not a prediction and not advice.
        </p>
      )}
    </div>
  );
}
