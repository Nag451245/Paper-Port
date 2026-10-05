import { useEffect, useState } from 'react';
import { Area, CartesianGrid, ComposedChart, Line, ReferenceLine, ResponsiveContainer, Tooltip, XAxis, YAxis } from 'recharts';
import { Loader2, Plus, X } from 'lucide-react';
import { formatINR } from '@/lib/utils';
import { tradingApi, marketApi, type StrategyCardData, type StrategyLegInput } from '@/services/api';

const signed = (n: number) => `${n >= 0 ? '+' : '−'}${formatINR(Math.abs(n), 0)}`;
const tone = (n: number | null | undefined) => ((n ?? 0) > 0 ? 'text-emerald-600' : (n ?? 0) < 0 ? 'text-red-600' : 'text-slate-700');
const errorText = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

function Stat({ label, value, cls = 'text-slate-800', hint }: { label: string; value: string; cls?: string; hint?: string }) {
  return (
    <div className="rounded-lg bg-slate-50 px-3 py-2" title={hint}>
      <p className="text-[10px] uppercase tracking-wide text-slate-400">{label}</p>
      <p className={`text-sm font-semibold font-mono ${cls}`}>{value}</p>
    </div>
  );
}

function Payoff({ card }: { card: StrategyCardData }) {
  const p = card.payoff;
  if (!p) return <p className="text-xs text-amber-600 py-6 text-center">{card.note ?? 'No payoff available.'}</p>;
  return (
    <div className="h-64">
      <ResponsiveContainer width="100%" height="100%">
        <ComposedChart data={p.curve} margin={{ top: 8, right: 12, left: 0, bottom: 0 }}>
          <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
          <XAxis dataKey="spot" type="number" domain={['dataMin', 'dataMax']} tick={{ fontSize: 10 }} tickFormatter={(v) => Number(v).toFixed(0)} />
          <YAxis tick={{ fontSize: 10 }} width={56} tickFormatter={(v) => formatINR(Number(v), 0)} />
          <Tooltip formatter={(v, name) => [formatINR(Number(v), 0), name === 'atExpiry' ? 'At expiry' : 'If closed today']}
            labelFormatter={(v) => `${card.underlying ?? 'Spot'} at ${Number(v).toLocaleString('en-IN')}`} />
          <ReferenceLine y={0} stroke="#64748b" />
          {card.spot && <ReferenceLine x={card.spot} stroke="#6366f1" strokeDasharray="4 3" label={{ value: 'now', fontSize: 10, fill: '#6366f1', position: 'top' }} />}
          {p.breakevens.map((b) => <ReferenceLine key={b} x={b} stroke="#f59e0b" strokeDasharray="2 3" />)}
          <Area type="linear" dataKey="atExpiry" stroke="#0f766e" strokeWidth={2} fill="#14b8a6" fillOpacity={0.08} isAnimationActive={false} />
          <Line type="monotone" dataKey="today" stroke="#f97316" strokeWidth={1.5} dot={false} isAnimationActive={false} />
        </ComposedChart>
      </ResponsiveContainer>
      <p className="text-[11px] text-slate-400 text-center">Green: held to expiry, after charges paid. Orange: closed today at current prices. Amber lines: breakevens.</p>
    </div>
  );
}

interface ChainStrike { strike: number; call: number; put: number; callBid: number; callAsk: number; putBid: number; putAsk: number }
const shortDate = (iso: string) => new Date(`${iso.slice(0, 10)}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' });

/** Try a new leg on the strategy (any contract week, any listed strike), see the payoff with it, then place it. */
function AddLeg({ card, portfolioId, onPreview, onDone }: {
  card: StrategyCardData; portfolioId: string | null; onPreview: (c: StrategyCardData | null) => void; onDone: () => void;
}) {
  const lot = card.legs[0]?.qty ?? 1;
  const underlying = card.underlying;
  const [type, setType] = useState<'CE' | 'PE'>('CE');
  const [action, setAction] = useState<'BUY' | 'SELL'>('BUY');
  const [expiry, setExpiry] = useState(card.expiry ?? '');
  const [expiries, setExpiries] = useState<string[]>(card.expiry ? [card.expiry] : []);
  const [chain, setChain] = useState<{ expiry: string; rows: ChainStrike[] } | null>(null);
  const [chainError, setChainError] = useState('');
  const [strike, setStrike] = useState('');
  const [qty, setQty] = useState(String(lot));
  const [leg, setLeg] = useState<StrategyLegInput | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');

  const reset = () => { setLeg(null); onPreview(null); };

  // The contract weeks on offer, once.
  useEffect(() => {
    if (!underlying) return;
    let live = true;
    marketApi.optionsExpiries(underlying)
      .then(({ data }) => {
        const list = (data?.expiries ?? []).map((e) => String(e).slice(0, 10)).filter(Boolean);
        if (live && list.length) setExpiries((own) => [...new Set([...own, ...list])].sort());
      })
      .catch(() => { /* the strategy's own week stays available */ });
    return () => { live = false; };
  }, [underlying]);

  // The strikes and prices of the chosen week.
  useEffect(() => {
    if (!underlying || !expiry) return;
    let live = true;
    marketApi.optionsChain(underlying, expiry)
      .then(({ data }) => {
        if (!live) return;
        const d = data as unknown as { strikes?: Record<string, unknown>[]; sessionError?: boolean; message?: string };
        const rows = (d?.strikes ?? []).map((r) => ({
          strike: Number(r.strike) || 0, call: Number(r.callLTP) || 0, put: Number(r.putLTP) || 0,
          callBid: Number(r.callBidPrice) || 0, callAsk: Number(r.callAskPrice) || 0,
          putBid: Number(r.putBidPrice) || 0, putAsk: Number(r.putAskPrice) || 0,
        })).filter((r) => r.strike > 0).sort((x, y) => x.strike - y.strike);
        setChain({ expiry, rows });
        setChainError(rows.length ? '' : d?.message ?? 'No strikes are listed for this week right now.');
        // Start at the strike nearest the price.
        if (rows.length && card.spot) {
          const atm = rows.reduce((m, r) => (Math.abs(r.strike - card.spot!) < Math.abs(m.strike - card.spot!) ? r : m), rows[0]);
          setStrike((cur) => (rows.some((r) => String(r.strike) === cur) ? cur : String(atm.strike)));
        }
      })
      .catch(() => { if (live) { setChain({ expiry, rows: [] }); setChainError('Could not load the option chain for this week.'); } });
    return () => { live = false; };
  }, [underlying, expiry, card.spot]);

  const rows = chain?.expiry === expiry ? chain.rows : [];
  const loadingChain = !!expiry && chain?.expiry !== expiry;
  // What this leg would trade at: the bid when selling, the ask when buying, else the last price.
  const priceOf = (r: ChainStrike) => {
    const last = type === 'CE' ? r.call : r.put;
    const side = action === 'SELL' ? (type === 'CE' ? r.callBid : r.putBid) : (type === 'CE' ? r.callAsk : r.putAsk);
    return side > 0 ? side : last;
  };
  const chosen = rows.find((r) => String(r.strike) === strike);

  const preview = async () => {
    setError('');
    const q = Math.floor(Number(qty));
    if (!chosen || !(q > 0) || !underlying || !expiry) { setError('Choose a strike and a quantity.'); return; }
    const premium = priceOf(chosen);
    if (!(premium > 0)) { setError(`The ${chosen.strike} ${type === 'CE' ? 'call' : 'put'} has no price right now. Pick another strike.`); return; }
    setBusy(true);
    try {
      const next: StrategyLegInput = { type, strike: chosen.strike, action, qty: q, premium, expiry };
      const res = await tradingApi.previewStrategyLegs(card.strategyTag, [next]);
      setLeg(next);
      onPreview(res.data);
    } catch (err) {
      setError(errorText(err, 'Could not work out the payoff with this leg.'));
    }
    setBusy(false);
  };

  const place = async () => {
    if (!leg || !portfolioId || !underlying || !leg.expiry) return;
    setBusy(true);
    setError('');
    try {
      const { data } = await tradingApi.executeStrategy({
        portfolio_id: portfolioId, symbol: underlying, expiry: leg.expiry, add_to: card.strategyTag,
        legs: [{ type: leg.type, strike: leg.strike, action: leg.action, qty: leg.qty, premium: leg.premium }],
      });
      const failed = (data as { results?: { error?: string }[] })?.results?.find((r) => r.error);
      if (failed?.error) setError(failed.error);
      else { reset(); onDone(); }
    } catch (err) {
      setError(errorText(err, 'The leg could not be placed.'));
    }
    setBusy(false);
  };

  const input = 'h-8 rounded-lg border border-slate-200 px-2 text-xs bg-white';
  const otherWeek = !!card.expiry && !!expiry && expiry !== card.expiry;
  return (
    <div className="rounded-lg border border-dashed border-slate-300 p-3 space-y-2">
      <p className="text-xs font-semibold text-slate-600">Add a leg</p>
      <div className="flex flex-wrap items-end gap-2">
        <label className="text-[10px] text-slate-400">Side
          <select value={action} onChange={(e) => { setAction(e.target.value as 'BUY' | 'SELL'); reset(); }} className={`${input} block mt-0.5`}>
            <option value="BUY">Buy</option><option value="SELL">Sell</option>
          </select>
        </label>
        <label className="text-[10px] text-slate-400">Option
          <select value={type} onChange={(e) => { setType(e.target.value as 'CE' | 'PE'); reset(); }} className={`${input} block mt-0.5`}>
            <option value="CE">Call</option><option value="PE">Put</option>
          </select>
        </label>
        <label className="text-[10px] text-slate-400">Contract week
          <select value={expiry} onChange={(e) => { setExpiry(e.target.value); reset(); }} className={`${input} block mt-0.5`}>
            {expiries.map((e) => <option key={e} value={e}>{shortDate(e)}{e === card.expiry ? ' (this strategy)' : ''}</option>)}
          </select>
        </label>
        <label className="text-[10px] text-slate-400">Strike and price
          <select value={strike} onChange={(e) => { setStrike(e.target.value); reset(); }} disabled={loadingChain || rows.length === 0} className={`${input} block mt-0.5 w-44 font-mono`}>
            {loadingChain && <option value="">Loading…</option>}
            {!loadingChain && rows.length === 0 && <option value="">No strikes</option>}
            {rows.map((r) => {
              const p = priceOf(r);
              return <option key={r.strike} value={String(r.strike)}>{r.strike} — {p > 0 ? `₹${p.toFixed(2)}` : 'no price'}</option>;
            })}
          </select>
        </label>
        <label className="text-[10px] text-slate-400">Quantity
          <input value={qty} onChange={(e) => { setQty(e.target.value); reset(); }} inputMode="numeric" className={`${input} block mt-0.5 w-20`} />
        </label>
        {!leg ? (
          <button onClick={preview} disabled={busy || loadingChain || !chosen} className="h-8 px-3 rounded-lg bg-slate-800 text-white text-xs font-semibold disabled:opacity-50">
            {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : 'See the effect'}
          </button>
        ) : (
          <>
            <button onClick={place} disabled={busy || !portfolioId} className="h-8 px-3 rounded-lg bg-emerald-600 text-white text-xs font-semibold disabled:opacity-50">
              {busy ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : `${leg.action === 'SELL' ? 'Sell' : 'Buy'} it at about ₹${leg.premium}`}
            </button>
            <button onClick={reset} className="h-8 px-2 rounded-lg text-xs text-slate-500 hover:bg-slate-100">Cancel</button>
          </>
        )}
      </div>
      <p className="text-[11px] text-slate-400">
        Prices are {action === 'SELL' ? 'the bid (what a seller gets)' : 'the ask (what a buyer pays)'} where the chain has one, otherwise the last trade.
        {otherWeek && ' A leg in another week does not lower the margin of this week\'s sold options.'}
      </p>
      {leg && <p className="text-[11px] text-slate-500">The chart, Greeks and figures above now include this leg. Nothing is placed until you press the green button.</p>}
      {chainError && <p className="text-[11px] text-amber-600">{chainError}</p>}
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

function ExitPlan({ card, onDone }: { card: StrategyCardData; onDone: () => void }) {
  const [target, setTarget] = useState(card.exitPlan?.target != null ? String(card.exitPlan.target) : '');
  const [stop, setStop] = useState(card.exitPlan?.stop != null ? String(card.exitPlan.stop) : '');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const save = async () => {
    setError('');
    const t = Number(target), s = Number(stop);
    if (!(t > 0) && !(s > 0)) { setError('Enter a profit target or a loss limit in rupees.'); return; }
    setBusy(true);
    try {
      await tradingApi.setExitPlan(card.strategyTag, { target: t > 0 ? t : undefined, stop: s > 0 ? s : undefined });
      onDone();
    } catch (err) { setError(errorText(err, 'Could not save the exit plan.')); }
    setBusy(false);
  };
  const clear = async () => {
    setBusy(true);
    try { await tradingApi.cancelExitPlan(card.strategyTag); setTarget(''); setStop(''); onDone(); } catch (err) { setError(errorText(err, 'Could not remove the exit plan.')); }
    setBusy(false);
  };
  const input = 'h-8 w-28 rounded-lg border border-slate-200 px-2 text-xs bg-white';
  return (
    <div className="rounded-lg bg-slate-50 p-3 space-y-2">
      <p className="text-xs font-semibold text-slate-600">Automatic exit <span className="font-normal text-slate-400">— closes every leg when profit or loss after charges reaches your figure</span></p>
      <div className="flex flex-wrap items-center gap-2">
        <input value={target} onChange={(e) => setTarget(e.target.value)} placeholder="Take profit ₹" inputMode="numeric" className={input} aria-label="Profit target in rupees" />
        <input value={stop} onChange={(e) => setStop(e.target.value)} placeholder="Stop at loss ₹" inputMode="numeric" className={input} aria-label="Loss limit in rupees" />
        <button onClick={save} disabled={busy} className="h-8 px-3 rounded-lg bg-indigo-600 text-white text-xs font-semibold disabled:opacity-50">Save</button>
        {card.exitPlan && <button onClick={clear} disabled={busy} className="h-8 px-2 rounded-lg text-xs text-slate-500 hover:bg-slate-200">Remove</button>}
        {card.exitPlan
          ? <span className="text-[11px] text-emerald-600">Active</span>
          : <span className="text-[11px] text-slate-400">None set: this strategy stays open until you close it or it expires.</span>}
      </div>
      {error && <p className="text-[11px] text-red-600">{error}</p>}
    </div>
  );
}

export default function StrategyCard({ card: live, portfolioId, onChanged }: { card: StrategyCardData; portfolioId: string | null; onChanged: () => void }) {
  // While a leg is being tried out, the card shows the strategy with it.
  const [preview, setPreview] = useState<StrategyCardData | null>(null);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const card = preview ?? live;
  const mine = live.owner === 'user';

  const run = async (key: string, question: string, call: () => Promise<unknown>) => {
    if (!window.confirm(question)) return;
    setBusy(key);
    setError('');
    try { await call(); onChanged(); } catch (err) { setError(errorText(err, 'That did not go through.')); }
    setBusy('');
  };

  const g = card.greeks;
  const p = card.payoff;
  return (
    <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4 space-y-3">
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div>
          <h2 className="text-sm font-semibold text-slate-800">{live.name}</h2>
          <p className="text-xs text-slate-500">
            {live.underlying ?? ''}{live.spot ? ` at ${live.spot.toLocaleString('en-IN')}` : ''}
            {live.expiry ? ` · expires ${new Date(`${live.expiry}T00:00:00+05:30`).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', timeZone: 'Asia/Kolkata' })}` : ''}
            {' · opened '}{new Date(live.deployedAt).toLocaleString('en-IN', { timeZone: 'Asia/Kolkata', day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' })}
          </p>
        </div>
        {mine && (
          <button onClick={() => run('all', `Close every leg of "${live.name}" at market?`, () => tradingApi.exitAllLegs(live.strategyTag))}
            disabled={!!busy} className="px-3 py-1.5 rounded-lg border border-red-200 text-red-600 text-xs font-semibold hover:bg-red-50 disabled:opacity-50">
            {busy === 'all' ? 'Closing…' : 'Close all legs'}
          </button>
        )}
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-2">
        <Stat label="P&L after charges" value={live.netPnl != null ? signed(live.netPnl) : '—'} cls={tone(live.netPnl)}
          hint="Open legs at current prices, less charges paid and the cost of closing now" />
        <Stat label="Charges so far" value={live.chargesPaid != null ? formatINR(live.chargesPaid, 0) : '—'} />
        <Stat label="Margin blocked" value={formatINR(live.marginBlocked, 0)} />
        <Stat label="Most it can make" value={p ? (p.unlimitedProfit ? 'Not capped' : formatINR(p.maxProfit, 0)) : '—'} cls="text-emerald-600" hint="Held to expiry" />
        <Stat label="Most it can lose" value={p ? (p.unlimitedLoss ? 'Not capped' : formatINR(Math.abs(p.maxLoss), 0)) : '—'} cls="text-red-600" hint="Held to expiry" />
        <Stat label="Chance of profit" value={p ? `${(p.pop * 100).toFixed(0)}%` : '—'} hint="At expiry, from current implied volatility" />
      </div>

      <div className="grid grid-cols-1 xl:grid-cols-3 gap-4">
        <div className="xl:col-span-2"><Payoff card={card} /></div>
        <div className="space-y-2">
          {g && (
            <div className="grid grid-cols-2 gap-2">
              <Stat label="Per 100-point move" value={signed(g.delta * 100)} cls={tone(g.delta)} hint="Delta: change in value if the underlying rises 100 points" />
              <Stat label="Per day" value={signed(g.theta)} cls={tone(g.theta)} hint="Theta: change in value over one day, all else equal" />
              <Stat label="Per 1 vol point" value={signed(g.vega)} cls={tone(g.vega)} hint="Vega: change in value if implied volatility rises one point" />
              <Stat label="Gamma" value={g.gamma.toFixed(3)} hint="How fast the direction exposure changes as the underlying moves" />
            </div>
          )}
          <ul className="text-xs text-slate-600 space-y-1 list-disc pl-4">
            {card.reading.map((line) => <li key={line}>{line}</li>)}
          </ul>
          {p && p.breakevens.length > 0 && <p className="text-[11px] text-slate-400">Breakevens at expiry: {p.breakevens.map((b) => b.toLocaleString('en-IN')).join(' and ')}</p>}
        </div>
      </div>

      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-400 text-left">
              <th className="py-1 font-medium">Leg</th>{(card.expiries ?? []).length > 1 && <th className="font-medium">Week</th>}<th className="font-medium">Side</th><th className="font-medium text-right">Qty</th>
              <th className="font-medium text-right">Entry</th><th className="font-medium text-right">Now</th><th className="font-medium text-right">IV</th>
              <th className="font-medium text-right">P&L</th><th />
            </tr>
          </thead>
          <tbody className="font-mono">
            {card.legs.map((l) => (
              <tr key={l.positionId ?? `new-${l.symbol}-${l.expiry}`} className={`border-t border-slate-100 ${l.proposed ? 'bg-amber-50' : ''}`}>
                <td className="py-1.5 font-sans text-slate-700">{l.symbol}{l.proposed && <span className="ml-1 text-[10px] text-amber-600">not placed yet</span>}</td>
                {(card.expiries ?? []).length > 1 && <td className="font-sans text-slate-500">{l.expiry ? shortDate(l.expiry) : '—'}</td>}
                <td className={l.side === 'SHORT' ? 'text-red-600' : 'text-emerald-600'}>{l.side === 'SHORT' ? 'Sold' : 'Bought'}</td>
                <td className="text-right">{l.qty}</td>
                <td className="text-right">{l.entry.toFixed(2)}</td>
                <td className="text-right">{l.last != null ? l.last.toFixed(2) : '—'}</td>
                <td className="text-right text-slate-500">{l.iv != null ? `${l.iv.toFixed(1)}%` : '—'}</td>
                <td className={`text-right ${tone(l.pnl)}`}>{l.pnl != null ? signed(l.pnl) : '—'}</td>
                <td className="text-right">
                  {mine && l.positionId && (
                    <button onClick={() => run(l.positionId!, `Close ${l.symbol} at market? The other legs stay open.`, () => tradingApi.exitLegs([l.positionId!]))}
                      disabled={!!busy} className="inline-flex items-center gap-0.5 px-2 py-0.5 rounded text-[11px] font-sans text-slate-500 hover:bg-slate-100 disabled:opacity-50" title="Close this leg only">
                      <X className="w-3 h-3" />{busy === l.positionId ? 'Closing…' : 'Close leg'}
                    </button>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {error && <p className="text-xs text-red-600">{error}</p>}

      {mine ? (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-3">
          {live.payoff ? <AddLeg card={live} portfolioId={portfolioId} onPreview={setPreview} onDone={onChanged} />
            : <p className="text-[11px] text-slate-400 flex items-center gap-1"><Plus className="w-3 h-3" />Legs can be added once the underlying has a price.</p>}
          <ExitPlan key={`${live.exitPlan?.target}-${live.exitPlan?.stop}`} card={live} onDone={onChanged} />
        </div>
      ) : (
        <p className="text-[11px] text-slate-400">Opened by the app's bots. It is shown here for information; the bots manage it.</p>
      )}
    </div>
  );
}
