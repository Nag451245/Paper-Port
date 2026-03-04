import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import {
  Search,
  RefreshCcw,
  Loader2,
  TrendingUp,
  TrendingDown,
  Target,
  ShieldCheck,
  ArrowUpRight,
  ArrowDownRight,
  Activity,
  BarChart3,
  AlertCircle,
  Wifi,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Legend,
} from 'recharts';
import { marketApi } from '@/services/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface Strike {
  strike: number;
  callOI: number;
  callOIChange: number;
  callVolume: number;
  callIV: number;
  callLTP: number;
  callNetChange: number;
  callDelta: number;
  callGamma: number;
  callTheta: number;
  callVega: number;
  callBuildup: string;
  putOI: number;
  putOIChange: number;
  putVolume: number;
  putIV: number;
  putLTP: number;
  putNetChange: number;
  putDelta: number;
  putGamma: number;
  putTheta: number;
  putVega: number;
  putBuildup: string;
}

interface OISignal {
  strike: number;
  type: 'call' | 'put';
  oiChange: number;
  signal: string;
  color: string;
}

function calcMaxPain(strikes: Strike[]): number {
  let minPain = Infinity;
  let maxPainStrike = strikes[0]?.strike ?? 0;
  for (const s of strikes) {
    let pain = 0;
    for (const t of strikes) {
      if (t.strike < s.strike) pain += t.callOI * (s.strike - t.strike);
      if (t.strike > s.strike) pain += t.putOI * (t.strike - s.strike);
    }
    if (pain < minPain) { minPain = pain; maxPainStrike = s.strike; }
  }
  return maxPainStrike;
}

function calcPCR(strikes: Strike[]): number {
  const totalPutOI = strikes.reduce((s, r) => s + r.putOI, 0);
  const totalCallOI = strikes.reduce((s, r) => s + r.callOI, 0);
  return totalCallOI > 0 ? +(totalPutOI / totalCallOI).toFixed(3) : 0;
}

function getOIBuildupSignals(strikes: Strike[]): OISignal[] {
  const signals: OISignal[] = [];
  for (const s of strikes) {
    if (s.callBuildup && s.callBuildup !== 'No Conclusion' && Math.abs(s.callOIChange) > 1000) {
      const buildup = s.callBuildup;
      let color = 'text-slate-600';
      if (buildup.includes('Long') && buildup.includes('Build')) color = 'text-emerald-600';
      else if (buildup.includes('Short') && buildup.includes('Build')) color = 'text-red-600';
      else if (buildup.includes('Short') && buildup.includes('Cover')) color = 'text-blue-600';
      else if (buildup.includes('Long') && (buildup.includes('Unwind') || buildup.includes('Cover'))) color = 'text-amber-600';
      signals.push({ strike: s.strike, type: 'call', oiChange: s.callOIChange, signal: buildup, color });
    }
    if (s.putBuildup && s.putBuildup !== 'No Conclusion' && Math.abs(s.putOIChange) > 1000) {
      const buildup = s.putBuildup;
      let color = 'text-slate-600';
      if (buildup.includes('Long') && buildup.includes('Build')) color = 'text-emerald-600';
      else if (buildup.includes('Short') && (buildup.includes('Build') || buildup.includes('Writ'))) color = 'text-red-600';
      else if (buildup.includes('Short') && buildup.includes('Cover')) color = 'text-blue-600';
      else if (buildup.includes('Long') && (buildup.includes('Unwind') || buildup.includes('Cover'))) color = 'text-amber-600';
      signals.push({ strike: s.strike, type: 'put', oiChange: s.putOIChange, signal: buildup, color });
    }
  }
  signals.sort((a, b) => Math.abs(b.oiChange) - Math.abs(a.oiChange));
  return signals.slice(0, 6);
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 10000000) return (n / 10000000).toFixed(2) + 'Cr';
  if (Math.abs(n) >= 100000) return (n / 100000).toFixed(2) + 'L';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}

function isMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

const REFRESH_MARKET = 2_000;
const REFRESH_OFF = 5 * 60_000;

export default function OptionChain() {
  const [symbol, setSymbol] = useState('NIFTY');
  const [searchInput, setSearchInput] = useState('NIFTY');
  const [exchange, setExchange] = useState('NSE');
  const [strikes, setStrikes] = useState<Strike[]>([]);
  const [spotPrice, setSpotPrice] = useState(0);
  const [expiry, setExpiry] = useState('');
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [, setSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showGreeks, setShowGreeks] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // Fetch expiries when symbol changes
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await marketApi.optionsExpiries(symbol);
        if (cancelled) return;
        if (data?.expiries?.length > 0) {
          setExpiries(data.expiries);
          setSelectedExpiry(data.expiries[0]);
        } else {
          setExpiries([]);
          setSelectedExpiry('');
        }
      } catch {
        if (!cancelled) { setExpiries([]); setSelectedExpiry(''); }
      }
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  const fetchData = useCallback(async (sym: string, silent = false) => {
    if (!selectedExpiry) return;
    if (!silent) setLoading(true);
    setError('');
    try {
      const res = await marketApi.optionsChain(sym, selectedExpiry);
      const data = res.data as any;
      if (data?.strikes?.length) {
        setStrikes(data.strikes.map((s: any) => ({
          strike: s.strike ?? 0,
          callOI: s.callOI ?? 0,
          callOIChange: s.callOIChange ?? 0,
          callVolume: s.callVolume ?? 0,
          callIV: s.callIV ?? 0,
          callLTP: s.callLTP ?? 0,
          callNetChange: s.callNetChange ?? 0,
          callDelta: s.callDelta ?? 0,
          callGamma: s.callGamma ?? 0,
          callTheta: s.callTheta ?? 0,
          callVega: s.callVega ?? 0,
          callBuildup: s.callBuildup ?? '',
          putOI: s.putOI ?? 0,
          putOIChange: s.putOIChange ?? 0,
          putVolume: s.putVolume ?? 0,
          putIV: s.putIV ?? 0,
          putLTP: s.putLTP ?? 0,
          putNetChange: s.putNetChange ?? 0,
          putDelta: s.putDelta ?? 0,
          putGamma: s.putGamma ?? 0,
          putTheta: s.putTheta ?? 0,
          putVega: s.putVega ?? 0,
          putBuildup: s.putBuildup ?? '',
        })));
        setSpotPrice(data.spotPrice ?? data.underlyingValue ?? 0);
        setExpiry(data.expiry ?? '');
        setSource(data.source ?? '');
        setLastUpdated(new Date());
      } else {
        if (!silent) setError('No option chain data available for this symbol.');
      }
    } catch {
      if (!silent) setError('Failed to fetch option chain data. Please try again.');
    } finally {
      if (!silent) setLoading(false);
    }
  }, [selectedExpiry]);

  useEffect(() => { fetchData(symbol); }, [symbol, selectedExpiry, fetchData]);

  useEffect(() => {
    const schedule = () => {
      const interval = isMarketOpen() ? REFRESH_MARKET : REFRESH_OFF;
      timerRef.current = setTimeout(() => {
        fetchData(symbol, true);
        schedule();
      }, interval);
    };
    schedule();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [symbol, fetchData]);

  const handleSearch = () => {
    const s = searchInput.trim().toUpperCase();
    if (s) setSymbol(s);
  };

  const strikeDivisor = spotPrice > 40000 ? 100 : 50;
  const atmStrike = useMemo(() => Math.round(spotPrice / strikeDivisor) * strikeDivisor, [spotPrice, strikeDivisor]);
  const maxOI = useMemo(() => Math.max(...strikes.map(s => Math.max(s.callOI, s.putOI)), 1), [strikes]);
  const maxPain = useMemo(() => calcMaxPain(strikes), [strikes]);
  const pcr = useMemo(() => calcPCR(strikes), [strikes]);
  const oiSignals = useMemo(() => getOIBuildupSignals(strikes), [strikes]);

  const highestPutOIStrike = useMemo(() => {
    let max = 0, strike = 0;
    for (const s of strikes) { if (s.putOI > max) { max = s.putOI; strike = s.strike; } }
    return strike;
  }, [strikes]);

  const highestCallOIStrike = useMemo(() => {
    let max = 0, strike = 0;
    for (const s of strikes) { if (s.callOI > max) { max = s.callOI; strike = s.strike; } }
    return strike;
  }, [strikes]);

  const ivPercentile = useMemo(() => {
    const ivs = strikes.filter(s => s.callIV > 0 || s.putIV > 0).map(s => ((s.callIV || 0) + (s.putIV || 0)) / 2);
    if (ivs.length === 0) return 0;
    const atmIdx = strikes.findIndex(s => s.strike === atmStrike);
    const current = atmIdx >= 0 ? ((strikes[atmIdx].callIV || 0) + (strikes[atmIdx].putIV || 0)) / 2 : ivs[Math.floor(ivs.length / 2)];
    return Math.min(100, Math.max(0, Math.round(((current - 8) / 30) * 100)));
  }, [strikes, atmStrike]);

  const chartData = useMemo(
    () => strikes
      .filter(s => s.callOI > 0 || s.putOI > 0)
      .filter((_, i) => i % 2 === 0)
      .map(s => ({ strike: s.strike, 'Call OI': s.callOI, 'Put OI': s.putOI })),
    [strikes],
  );

  const pcrBadge = pcr > 1.2
    ? { label: 'Bullish', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' }
    : pcr < 0.8
      ? { label: 'Bearish', cls: 'bg-red-50 text-red-700 border-red-200' }
      : { label: 'Neutral', cls: 'bg-amber-50 text-amber-700 border-amber-200' };

  const timeAgo = lastUpdated
    ? `${Math.max(0, Math.round((Date.now() - lastUpdated.getTime()) / 1000))}s ago`
    : '';

  return (
    <div className="space-y-5">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-slate-900">Option Chain</h1>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              {isMarketOpen() ? (
                <span className="flex items-center gap-1 text-emerald-600 font-medium">
                  <Wifi className="h-3 w-3" /> LIVE
                </span>
              ) : (
                <span className="text-slate-400">Market Closed</span>
              )}
              <span className="text-slate-300">|</span>
              <span>{timeAgo}</span>
            </div>
          )}
          {error && (
            <span className="inline-flex items-center gap-1.5 rounded-full bg-red-50 px-3 py-1 text-xs font-medium text-red-700 border border-red-200">
              <AlertCircle className="h-3.5 w-3.5" /> {error}
            </span>
          )}
        </div>
      </div>

      {/* Top Bar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm flex flex-wrap items-center gap-3">
        <div className="relative flex-1 min-w-[180px] max-w-xs">
          <Search className="absolute left-3 top-1/2 -translate-y-1/2 h-4 w-4 text-slate-400" />
          <input
            value={searchInput}
            onChange={e => setSearchInput(e.target.value.toUpperCase())}
            onKeyDown={e => e.key === 'Enter' && handleSearch()}
            placeholder="Symbol e.g. NIFTY"
            className="w-full rounded-xl border border-slate-200 bg-slate-50 py-2 pl-9 pr-3 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-400"
          />
        </div>
        <button onClick={handleSearch} className="rounded-xl bg-teal-600 px-4 py-2 text-sm font-medium text-white hover:bg-teal-700 transition-colors">
          Search
        </button>

        <select
          value={exchange}
          onChange={e => setExchange(e.target.value)}
          className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30"
        >
          <option value="NSE">NSE</option>
          <option value="BSE">BSE</option>
        </select>

        {expiry && (
          <div className="rounded-xl border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-700">
            Expiry: <span className="font-semibold">{new Date(expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}</span>
          </div>
        )}

        <label className="flex items-center gap-2 text-xs text-slate-500 cursor-pointer select-none ml-auto">
          <input type="checkbox" checked={showGreeks} onChange={e => setShowGreeks(e.target.checked)} className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 h-3.5 w-3.5" />
          Greeks
        </label>

        <button onClick={() => fetchData(symbol)} disabled={loading} className="rounded-xl border border-slate-200 p-2 text-slate-400 hover:text-teal-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
        </button>

        {spotPrice > 0 && (
          <div className="text-sm font-medium text-slate-700">
            {symbol} Spot: <span className="text-teal-700 font-semibold">{spotPrice.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
        )}
      </div>

      {/* Main Grid */}
      {strikes.length > 0 ? (
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_320px] gap-5">
          {/* Option Chain Table */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="border-b border-slate-200">
                    <th colSpan={showGreeks ? 11 : 7} className="bg-blue-50/60 text-blue-800 py-2 px-3 text-center font-semibold text-[11px] uppercase tracking-wider">
                      Calls
                    </th>
                    <th className="bg-slate-100 py-2 px-3 text-center font-semibold text-slate-700 text-[11px] uppercase tracking-wider">
                      Strike
                    </th>
                    <th colSpan={showGreeks ? 11 : 7} className="bg-rose-50/60 text-rose-800 py-2 px-3 text-center font-semibold text-[11px] uppercase tracking-wider">
                      Puts
                    </th>
                  </tr>
                  <tr className="border-b border-slate-100 text-[10px] uppercase tracking-wider text-slate-500">
                    <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">OI</th>
                    <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">OI Chg</th>
                    <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">Vol</th>
                    <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">IV</th>
                    <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">LTP</th>
                    <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">Chg</th>
                    <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">Δ</th>
                    {showGreeks && (
                      <>
                        <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">Γ</th>
                        <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">Θ</th>
                        <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium">V</th>
                        <th className="bg-blue-50/30 py-1.5 px-2 text-right font-medium w-0"></th>
                      </>
                    )}
                    <th className="bg-slate-100 py-1.5 px-3 text-center font-semibold text-slate-700">Strike</th>
                    {showGreeks && (
                      <>
                        <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium w-0"></th>
                        <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">V</th>
                        <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">Θ</th>
                        <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">Γ</th>
                      </>
                    )}
                    <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">Δ</th>
                    <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">Chg</th>
                    <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">LTP</th>
                    <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">IV</th>
                    <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">Vol</th>
                    <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">OI Chg</th>
                    <th className="bg-rose-50/30 py-1.5 px-2 text-left font-medium">OI</th>
                  </tr>
                </thead>
                <tbody>
                  {strikes.map((s) => {
                    const isATM = s.strike === atmStrike;
                    const isCallITM = s.strike < spotPrice;
                    const isPutITM = s.strike > spotPrice;
                    const callOIPct = (s.callOI / maxOI) * 100;
                    const putOIPct = (s.putOI / maxOI) * 100;

                    const rowBg = isATM
                      ? 'bg-amber-50/70'
                      : isCallITM
                        ? 'bg-blue-50/20'
                        : isPutITM
                          ? 'bg-rose-50/20'
                          : 'bg-white';

                    return (
                      <tr key={s.strike} className={`border-b border-slate-100/70 hover:bg-slate-50/60 transition-colors ${rowBg}`}>
                        {/* Call Side */}
                        <td className="py-1.5 px-2 text-right relative">
                          <div className="absolute inset-y-0 right-0 bg-blue-100/50 rounded-l" style={{ width: `${callOIPct}%` }} />
                          <span className="relative font-medium text-slate-700">{fmtNum(s.callOI)}</span>
                        </td>
                        <td className={`py-1.5 px-2 text-right font-medium ${s.callOIChange > 0 ? 'text-emerald-600' : s.callOIChange < 0 ? 'text-red-500' : 'text-slate-400'}`}>
                          {s.callOIChange > 0 ? '+' : ''}{fmtNum(s.callOIChange)}
                        </td>
                        <td className="py-1.5 px-2 text-right text-slate-500">{fmtNum(s.callVolume)}</td>
                        <td className="py-1.5 px-2 text-right text-slate-500">{s.callIV > 0 ? `${s.callIV.toFixed(1)}` : '-'}</td>
                        <td className="py-1.5 px-2 text-right font-semibold text-slate-800">{s.callLTP.toFixed(2)}</td>
                        <td className={`py-1.5 px-2 text-right font-medium ${s.callNetChange > 0 ? 'text-emerald-600' : s.callNetChange < 0 ? 'text-red-500' : 'text-slate-400'}`}>
                          {s.callNetChange > 0 ? '+' : ''}{s.callNetChange.toFixed(2)}
                        </td>
                        <td className="py-1.5 px-2 text-right text-slate-400">{s.callDelta !== 0 ? s.callDelta.toFixed(2) : '-'}</td>
                        {showGreeks && (
                          <>
                            <td className="py-1.5 px-2 text-right text-slate-400">{s.callGamma !== 0 ? s.callGamma.toFixed(4) : '-'}</td>
                            <td className="py-1.5 px-2 text-right text-slate-400">{s.callTheta !== 0 ? s.callTheta.toFixed(2) : '-'}</td>
                            <td className="py-1.5 px-2 text-right text-slate-400">{s.callVega !== 0 ? s.callVega.toFixed(2) : '-'}</td>
                            <td className="w-0" />
                          </>
                        )}

                        {/* Strike */}
                        <td className={`py-1.5 px-3 text-center font-bold ${isATM ? 'text-amber-700 bg-amber-100/60 text-sm' : 'text-slate-800'}`}>
                          {s.strike.toLocaleString('en-IN')}
                          {isATM && <span className="ml-1 text-[9px] font-medium text-amber-600">ATM</span>}
                        </td>

                        {/* Put Side */}
                        {showGreeks && (
                          <>
                            <td className="w-0" />
                            <td className="py-1.5 px-2 text-left text-slate-400">{s.putVega !== 0 ? s.putVega.toFixed(2) : '-'}</td>
                            <td className="py-1.5 px-2 text-left text-slate-400">{s.putTheta !== 0 ? s.putTheta.toFixed(2) : '-'}</td>
                            <td className="py-1.5 px-2 text-left text-slate-400">{s.putGamma !== 0 ? s.putGamma.toFixed(4) : '-'}</td>
                          </>
                        )}
                        <td className="py-1.5 px-2 text-left text-slate-400">{s.putDelta !== 0 ? s.putDelta.toFixed(2) : '-'}</td>
                        <td className={`py-1.5 px-2 text-left font-medium ${s.putNetChange > 0 ? 'text-emerald-600' : s.putNetChange < 0 ? 'text-red-500' : 'text-slate-400'}`}>
                          {s.putNetChange > 0 ? '+' : ''}{s.putNetChange.toFixed(2)}
                        </td>
                        <td className="py-1.5 px-2 text-left font-semibold text-slate-800">{s.putLTP.toFixed(2)}</td>
                        <td className="py-1.5 px-2 text-left text-slate-500">{s.putIV > 0 ? `${s.putIV.toFixed(1)}` : '-'}</td>
                        <td className="py-1.5 px-2 text-left text-slate-500">{fmtNum(s.putVolume)}</td>
                        <td className={`py-1.5 px-2 text-left font-medium ${s.putOIChange > 0 ? 'text-emerald-600' : s.putOIChange < 0 ? 'text-red-500' : 'text-slate-400'}`}>
                          {s.putOIChange > 0 ? '+' : ''}{fmtNum(s.putOIChange)}
                        </td>
                        <td className="py-1.5 px-2 text-left relative">
                          <div className="absolute inset-y-0 left-0 bg-rose-100/50 rounded-r" style={{ width: `${putOIPct}%` }} />
                          <span className="relative font-medium text-slate-700">{fmtNum(s.putOI)}</span>
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
          </div>

          {/* Analytics Sidebar */}
          <div className="space-y-4">
            {/* Max Pain */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-3">
                <Target className="h-4 w-4 text-violet-500" /> Max Pain
              </div>
              <p className="text-3xl font-bold text-violet-700">{maxPain.toLocaleString('en-IN')}</p>
              <p className="mt-1.5 text-[11px] text-slate-400 leading-relaxed">
                Strike where combined premium paid by option buyers is maximised. Market often gravitates towards this level at expiry.
              </p>
            </div>

            {/* PCR */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-3">
                <Activity className="h-4 w-4 text-teal-500" /> Put/Call Ratio
              </div>
              <div className="flex items-center gap-3">
                <p className="text-3xl font-bold text-slate-900">{pcr.toFixed(2)}</p>
                <span className={`inline-flex items-center gap-1 rounded-full border px-2.5 py-0.5 text-[11px] font-semibold ${pcrBadge.cls}`}>
                  {pcr > 1.2 ? <TrendingUp className="h-3 w-3" /> : pcr < 0.8 ? <TrendingDown className="h-3 w-3" /> : <Activity className="h-3 w-3" />}
                  {pcrBadge.label}
                </span>
              </div>
            </div>

            {/* IV Percentile */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-3">
                <BarChart3 className="h-4 w-4 text-blue-500" /> IV Percentile
              </div>
              <div className="flex items-center gap-4">
                <div className="relative w-16 h-16">
                  <svg viewBox="0 0 36 36" className="w-full h-full -rotate-90">
                    <circle cx="18" cy="18" r="15" fill="none" stroke="#e2e8f0" strokeWidth="3" />
                    <circle
                      cx="18" cy="18" r="15" fill="none"
                      stroke={ivPercentile > 70 ? '#ef4444' : ivPercentile > 40 ? '#f59e0b' : '#22c55e'}
                      strokeWidth="3"
                      strokeDasharray={`${ivPercentile * 0.942} 94.2`}
                      strokeLinecap="round"
                    />
                  </svg>
                  <span className="absolute inset-0 flex items-center justify-center text-sm font-bold text-slate-800">{ivPercentile}</span>
                </div>
                <div className="text-xs text-slate-500 leading-relaxed">
                  <p className="font-medium text-slate-700">
                    {ivPercentile > 70 ? 'High IV — premiums expensive' : ivPercentile > 40 ? 'Moderate IV' : 'Low IV — premiums cheap'}
                  </p>
                  Current IV is at the {ivPercentile}th percentile of its 1-year range.
                </div>
              </div>
            </div>

            {/* OI Build-up Signals */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-3">
                <TrendingUp className="h-4 w-4 text-emerald-500" /> OI Build-up Signals
              </div>
              <div className="space-y-2">
                {oiSignals.map((sig, i) => (
                  <div key={i} className="flex items-center justify-between rounded-lg bg-slate-50 px-3 py-2 text-xs">
                    <div className="flex items-center gap-2">
                      <span className="font-semibold text-slate-700">{sig.strike.toLocaleString('en-IN')}</span>
                      <span className={`rounded px-1.5 py-0.5 text-[10px] font-medium ${sig.type === 'call' ? 'bg-blue-50 text-blue-600' : 'bg-rose-50 text-rose-600'}`}>
                        {sig.type === 'call' ? 'CE' : 'PE'}
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <span className="text-slate-400">{sig.oiChange > 0 ? '+' : ''}{fmtNum(sig.oiChange)}</span>
                      <span className={`font-semibold ${sig.color}`}>{sig.signal}</span>
                    </div>
                  </div>
                ))}
                {oiSignals.length === 0 && <p className="text-xs text-slate-400">No significant OI changes</p>}
              </div>
            </div>

            {/* Support / Resistance */}
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 text-sm font-semibold text-slate-700 mb-3">
                <ShieldCheck className="h-4 w-4 text-emerald-500" /> Support & Resistance
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="rounded-xl bg-emerald-50/70 border border-emerald-100 p-3 text-center">
                  <p className="text-[10px] uppercase tracking-wider text-emerald-600 font-medium mb-1">Support</p>
                  <p className="text-lg font-bold text-emerald-700">{highestPutOIStrike.toLocaleString('en-IN')}</p>
                  <p className="text-[10px] text-emerald-500 mt-0.5 flex items-center justify-center gap-0.5">
                    <ArrowUpRight className="h-3 w-3" /> Highest Put OI
                  </p>
                </div>
                <div className="rounded-xl bg-red-50/70 border border-red-100 p-3 text-center">
                  <p className="text-[10px] uppercase tracking-wider text-red-600 font-medium mb-1">Resistance</p>
                  <p className="text-lg font-bold text-red-700">{highestCallOIStrike.toLocaleString('en-IN')}</p>
                  <p className="text-[10px] text-red-500 mt-0.5 flex items-center justify-center gap-0.5">
                    <ArrowDownRight className="h-3 w-3" /> Highest Call OI
                  </p>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : !loading && (
        <div className="rounded-2xl border border-slate-200 bg-white p-12 shadow-sm text-center">
          <AlertCircle className="h-8 w-8 text-slate-300 mx-auto mb-3" />
          <p className="text-sm text-slate-500">
            {error || 'No option chain data available. Try searching for NIFTY or BANKNIFTY.'}
          </p>
        </div>
      )}

      {/* OI Distribution Chart */}
      {chartData.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <BarChart3 className="h-4 w-4 text-slate-400" /> Open Interest Distribution
          </h2>
          <div className="h-72">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="strike" tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => v.toLocaleString()} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickFormatter={v => fmtNum(v as number)} />
                <Tooltip
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 12, boxShadow: '0 4px 6px -1px rgba(0,0,0,.05)' }}
                  formatter={(v: number | undefined) => [fmtNum(v ?? 0), undefined]}
                  labelFormatter={l => `Strike: ${Number(l).toLocaleString('en-IN')}`}
                />
                <Legend wrapperStyle={{ fontSize: 12 }} />
                <Bar dataKey="Call OI" fill="#3b82f6" radius={[4, 4, 0, 0]} opacity={0.85} />
                <Bar dataKey="Put OI" fill="#f43f5e" radius={[4, 4, 0, 0]} opacity={0.85} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
