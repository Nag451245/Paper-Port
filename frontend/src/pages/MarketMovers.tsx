import { useCallback, useEffect, useState } from 'react';
import { useNavigate } from 'react-router-dom';
import { Loader2, RefreshCw, TrendingDown, TrendingUp, Activity, Info } from 'lucide-react';
import { marketApi, type MoverKind, type MoversResponse } from '@/services/api';

const KINDS: { id: MoverKind; label: string; short: string; icon: typeof TrendingUp }[] = [
  { id: 'gainers', label: 'Price Gainers', short: 'Gainers', icon: TrendingUp },
  { id: 'losers', label: 'Price Losers', short: 'Losers', icon: TrendingDown },
  { id: 'volume', label: 'Volume Gainers', short: 'Volume', icon: Activity },
];

const SOURCE_LABEL: Record<MoversResponse['source'], string> = {
  nse: 'NSE',
  upstox: 'computed from Upstox quotes',
  none: 'no source',
};

const chip = (active: boolean) =>
  `shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${active ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`;

const fmtVolume = (v: number) =>
  v >= 1e7 ? `${(v / 1e7).toFixed(2)} Cr` : v >= 1e5 ? `${(v / 1e5).toFixed(2)} L` : v.toLocaleString('en-IN');

function remembered<T extends string>(key: string, fallback: T): T {
  try { return (localStorage.getItem(key) as T) || fallback; } catch { return fallback; }
}
function remember(key: string, value: string) {
  try { localStorage.setItem(key, value); } catch { /* private mode */ }
}

export default function MarketMovers() {
  const navigate = useNavigate();
  const [exchange, setExchange] = useState<'NSE' | 'BSE'>(() => remembered('movers.exchange', 'NSE'));
  const [kind, setKind] = useState<MoverKind>(() => remembered('movers.kind', 'gainers'));
  const [group, setGroup] = useState<string | undefined>(undefined);
  const [data, setData] = useState<MoversResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(async (quiet = false) => {
    if (!quiet) setLoading(true);
    try {
      const { data: res } = await marketApi.movers({ exchange, kind, group, count: 50 });
      setData(res);
      setError(null);
    } catch {
      setError('Could not load market movers. Try again in a moment.');
    } finally {
      if (!quiet) setLoading(false);
    }
  }, [exchange, kind, group]);

  useEffect(() => { void load(); }, [load]);
  // Lists refresh on the server once a minute; follow along while the page is open.
  useEffect(() => {
    const id = window.setInterval(() => { if (!document.hidden) void load(true); }, 60_000);
    return () => window.clearInterval(id);
  }, [load]);

  const pickExchange = (ex: 'NSE' | 'BSE') => { setExchange(ex); setGroup(undefined); remember('movers.exchange', ex); };
  const pickKind = (k: MoverKind) => { setKind(k); remember('movers.kind', k); };
  const open = (symbol: string) => navigate(`/terminal?symbol=${encodeURIComponent(symbol)}&exchange=${exchange}`);

  const rows = data?.rows ?? [];
  const isVolume = kind === 'volume';

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2"><TrendingUp className="w-5 h-5 text-indigo-600" /> Market Movers</h1>
        <p className="text-sm text-slate-500 mt-0.5">Today's biggest price and volume moves on NSE and BSE. The bots and the Rust engine scan these too. Tap a stock to open it in the terminal.</p>
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white p-3 sm:p-4 shadow-sm space-y-3">
        <div className="flex flex-wrap items-center gap-2">
          <div className="flex gap-1.5 overflow-x-auto touch-pan-x" role="tablist" aria-label="List">
            {KINDS.map(({ id, label, short, icon: Icon }) => (
              <button key={id} role="tab" aria-selected={kind === id} className={`${chip(kind === id)} flex items-center gap-1.5`} onClick={() => pickKind(id)}>
                <Icon className="w-3.5 h-3.5" /> <span className="sm:hidden">{short}</span><span className="hidden sm:inline">{label}</span>
              </button>
            ))}
          </div>
          <div className="flex gap-1.5 ml-auto">
            {(['NSE', 'BSE'] as const).map((ex) => (
              <button key={ex} className={chip(exchange === ex)} onClick={() => pickExchange(ex)}>{ex}</button>
            ))}
            <button onClick={() => void load()} className="p-1.5 rounded-lg hover:bg-slate-100 text-slate-400" title="Refresh" aria-label="Refresh">
              <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
            </button>
          </div>
        </div>

        {data && data.groups.length > 1 && !(isVolume && exchange === 'NSE') && (
          <div className="flex gap-1.5 overflow-x-auto touch-pan-x pb-0.5" aria-label="Group">
            {data.groups.map((g) => (
              <button key={g.id} className={chip(data.group === g.id)} onClick={() => setGroup(g.id)}>{g.label}</button>
            ))}
          </div>
        )}

        {data && (
          <p className="text-[11px] text-slate-400">
            Source: {SOURCE_LABEL[data.source]}{data.asOf ? ` · as of ${data.asOf.includes('T') ? new Date(data.asOf).toLocaleString('en-IN', { dateStyle: 'medium', timeStyle: 'short' }) : data.asOf}` : ''}
            {isVolume && ' · volume compared with the average of the previous 5 sessions'}
          </p>
        )}
        {data?.note && (
          <p className="flex items-start gap-1.5 text-xs text-amber-700 bg-amber-50 border border-amber-200 rounded-lg px-2 sm:px-3 py-2">
            <Info className="w-3.5 h-3.5 mt-0.5 shrink-0" /> {data.note}
          </p>
        )}
        {error && <p className="text-xs text-red-600">{error}</p>}
      </div>

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        {loading && !rows.length ? (
          <div className="flex items-center justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : !rows.length ? (
          <p className="text-center text-sm text-slate-400 py-16">No stocks in this list right now.</p>
        ) : (
          <div className="overflow-x-auto touch-pan-x">
            <table className="w-full text-xs">
              <thead className="bg-slate-50 text-slate-500">
                <tr>
                  <th className="hidden sm:table-cell text-left font-medium px-3 py-2">#</th>
                  <th className="text-left font-medium px-2 sm:px-3 py-2">Stock</th>
                  <th className="text-right font-medium px-2 sm:px-3 py-2">Price</th>
                  <th className="text-right font-medium px-2 sm:px-3 py-2">Change</th>
                  <th className="text-right font-medium px-2 sm:px-3 py-2">Volume</th>
                  {isVolume && <th className="hidden sm:table-cell text-right font-medium px-3 py-2">Wk avg</th>}
                  {isVolume && <th className="text-right font-medium px-2 sm:px-3 py-2">× avg</th>}
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {rows.map((r, i) => (
                  <tr key={r.symbol} onClick={() => open(r.symbol)} className="hover:bg-indigo-50/60 cursor-pointer">
                    <td className="hidden sm:table-cell px-3 py-2 text-slate-400">{i + 1}</td>
                    <td className="px-2 sm:px-3 py-2 max-w-[8rem] sm:max-w-[14rem]">
                      <div className="font-semibold text-slate-800">{r.symbol}</div>
                      {r.name !== r.symbol && <div className="text-[10px] text-slate-400 truncate">{r.name}</div>}
                    </td>
                    <td className="px-2 sm:px-3 py-2 text-right font-mono text-slate-800">₹{r.ltp.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</td>
                    <td className={`px-2 sm:px-3 py-2 text-right font-mono whitespace-nowrap ${r.changePercent >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {r.changePercent >= 0 ? '+' : ''}{r.changePercent.toFixed(2)}%
                    </td>
                    <td className="px-2 sm:px-3 py-2 text-right font-mono text-slate-600 whitespace-nowrap">{fmtVolume(r.volume)}</td>
                    {isVolume && <td className="hidden sm:table-cell px-3 py-2 text-right font-mono text-slate-400 whitespace-nowrap">{r.avgVolume ? fmtVolume(r.avgVolume) : '—'}</td>}
                    {isVolume && <td className="px-2 sm:px-3 py-2 text-right font-mono font-semibold text-indigo-600 whitespace-nowrap">{r.volumeRatio ? `${r.volumeRatio.toFixed(1)}×` : '—'}</td>}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
