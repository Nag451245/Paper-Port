import { useState, useEffect, useMemo, useCallback, useRef } from 'react';
import { ALL_FNO_SYMBOLS, INDEX_SYMBOLS } from '../constants/fno-symbols';
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
  ChevronDown,
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
  callBidPrice: number;
  callAskPrice: number;
  callDelta: number;
  callGamma: number;
  callTheta: number;
  callVega: number;
  putOI: number;
  putOIChange: number;
  putVolume: number;
  putIV: number;
  putLTP: number;
  putNetChange: number;
  putBidPrice: number;
  putAskPrice: number;
  putDelta: number;
  putGamma: number;
  putTheta: number;
  putVega: number;
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

function fmtNum(n: number): string {
  if (n === 0) return '0';
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

const REFRESH_MARKET = 15_000;
const REFRESH_OFF = 60_000;
const STRIKES_AROUND_ATM = 20;

export default function OptionChain() {
  const [symbol, setSymbol] = useState('NIFTY');
  const [searchInput, setSearchInput] = useState('NIFTY');
  const [exchange, setExchange] = useState('NSE');
  const [strikes, setStrikes] = useState<Strike[]>([]);
  const [spotPrice, setSpotPrice] = useState(0);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [, setSource] = useState('');
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [showGreeks, setShowGreeks] = useState(true);
  const [showAllStrikes, setShowAllStrikes] = useState(false);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);
  const fetchingRef = useRef(false);
  const atmRowRef = useRef<HTMLTableRowElement | null>(null);
  const tableContainerRef = useRef<HTMLDivElement | null>(null);
  const hasScrolledRef = useRef(false);

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
    hasScrolledRef.current = false;
    return () => { cancelled = true; };
  }, [symbol]);

  const fetchData = useCallback(async (sym: string, silent = false) => {
    if (!selectedExpiry) return;
    if (fetchingRef.current) return;
    fetchingRef.current = true;
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
          callBidPrice: s.callBidPrice ?? 0,
          callAskPrice: s.callAskPrice ?? 0,
          callDelta: s.callDelta ?? 0,
          callGamma: s.callGamma ?? 0,
          callTheta: s.callTheta ?? 0,
          callVega: s.callVega ?? 0,
          putOI: s.putOI ?? 0,
          putOIChange: s.putOIChange ?? 0,
          putVolume: s.putVolume ?? 0,
          putIV: s.putIV ?? 0,
          putLTP: s.putLTP ?? 0,
          putNetChange: s.putNetChange ?? 0,
          putBidPrice: s.putBidPrice ?? 0,
          putAskPrice: s.putAskPrice ?? 0,
          putDelta: s.putDelta ?? 0,
          putGamma: s.putGamma ?? 0,
          putTheta: s.putTheta ?? 0,
          putVega: s.putVega ?? 0,
        })));
        setSpotPrice(data.spotPrice ?? data.underlyingValue ?? 0);
        setSource(data.source ?? '');
        setLastUpdated(new Date());
      } else {
        setStrikes([]);
        setSpotPrice(0);
        if (!silent) setError(data?.sessionError
          ? 'Breeze API session not active. Please enter your session key in Settings.'
          : 'No option chain data available for this symbol.');
      }
    } catch {
      if (!silent) setError('Failed to fetch option chain data. Please try again.');
    } finally {
      if (!silent) setLoading(false);
      fetchingRef.current = false;
    }
  }, [selectedExpiry]);

  useEffect(() => { fetchData(symbol); hasScrolledRef.current = false; }, [symbol, selectedExpiry, fetchData]);

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

  const [showSymbolDropdown, setShowSymbolDropdown] = useState(false);

  const filteredSymbols = useMemo(() => {
    if (!searchInput) return [...INDEX_SYMBOLS];
    const q = searchInput.toLowerCase();
    return ALL_FNO_SYMBOLS.filter(s => s.toLowerCase().includes(q));
  }, [searchInput]);

  const handleSearch = () => {
    const s = searchInput.trim().toUpperCase();
    if (s) { setSymbol(s); setShowSymbolDropdown(false); }
  };

  const selectSymbol = (s: string) => {
    setSymbol(s);
    setSearchInput(s);
    setShowSymbolDropdown(false);
  };

  const atmStrike = useMemo(() => {
    if (strikes.length === 0 || spotPrice <= 0) return 0;
    let closest = strikes[0].strike;
    let minDiff = Math.abs(spotPrice - closest);
    for (const s of strikes) {
      const diff = Math.abs(spotPrice - s.strike);
      if (diff < minDiff) { minDiff = diff; closest = s.strike; }
    }
    return closest;
  }, [strikes, spotPrice]);

  const visibleStrikes = useMemo(() => {
    if (showAllStrikes || strikes.length === 0 || atmStrike === 0) return strikes;
    const atmIdx = strikes.findIndex(s => s.strike >= atmStrike);
    if (atmIdx < 0) return strikes;
    const start = Math.max(0, atmIdx - STRIKES_AROUND_ATM);
    const end = Math.min(strikes.length, atmIdx + STRIKES_AROUND_ATM + 1);
    return strikes.slice(start, end);
  }, [strikes, atmStrike, showAllStrikes]);

  useEffect(() => {
    if (hasScrolledRef.current) return;
    if (atmRowRef.current && tableContainerRef.current) {
      const container = tableContainerRef.current;
      const row = atmRowRef.current;
      const containerRect = container.getBoundingClientRect();
      const rowRect = row.getBoundingClientRect();
      const scrollTop = container.scrollTop + (rowRect.top - containerRect.top) - containerRect.height / 2 + rowRect.height / 2;
      if (typeof container.scrollTo === 'function') {
        container.scrollTo({ top: scrollTop, behavior: 'smooth' });
      } else {
        container.scrollTop = scrollTop;
      }
      hasScrolledRef.current = true;
    }
  }, [visibleStrikes, atmStrike]);

  const maxOI = useMemo(() => Math.max(...strikes.map(s => Math.max(s.callOI, s.putOI)), 1), [strikes]);
  const maxPain = useMemo(() => calcMaxPain(strikes), [strikes]);
  const pcr = useMemo(() => calcPCR(strikes), [strikes]);

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

  const chgCls = (v: number) => v > 0 ? 'text-emerald-600' : v < 0 ? 'text-red-500' : 'text-slate-400';

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex flex-col sm:flex-row items-start sm:items-center justify-between gap-3">
        <h1 className="text-xl font-bold text-slate-900">Option Chain</h1>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              {isMarketOpen() ? (
                <span className="flex items-center gap-1 text-emerald-600 font-medium">
                  <Wifi className="h-3 w-3 animate-pulse" /> LIVE
                </span>
              ) : (
                <span className="text-slate-400">Market Closed</span>
              )}
              <span className="text-slate-300">|</span>
              <span>{timeAgo}</span>
            </div>
          )}
          {error && (
            <div className="inline-flex items-center gap-2 rounded-lg bg-amber-50 px-3 py-1.5 text-xs font-medium text-amber-800 border border-amber-200">
              <AlertCircle className="h-3.5 w-3.5 text-amber-600 flex-shrink-0" />
              <span>{error}</span>
              <button
                onClick={() => { setError(''); fetchData(symbol); }}
                className="ml-1 inline-flex items-center gap-1 px-2 py-0.5 rounded bg-amber-100 hover:bg-amber-200 text-amber-700 transition text-xs font-semibold"
              >
                <RefreshCcw className="h-3 w-3" /> Retry
              </button>
              {error.includes('session') && (
                <a href="/settings" className="ml-1 text-amber-700 underline hover:text-amber-900 text-xs font-semibold">Settings</a>
              )}
            </div>
          )}
        </div>
      </div>

      {/* Top Bar */}
      <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm flex flex-wrap items-center gap-2">
        <div className="relative flex-1 min-w-[160px] max-w-[200px]">
          <Search className="absolute left-2.5 top-1/2 -translate-y-1/2 h-3.5 w-3.5 text-slate-400 z-10" />
          <input
            value={searchInput}
            onChange={e => { setSearchInput(e.target.value.toUpperCase()); setShowSymbolDropdown(true); }}
            onFocus={() => setShowSymbolDropdown(true)}
            onKeyDown={e => { if (e.key === 'Enter') handleSearch(); if (e.key === 'Escape') setShowSymbolDropdown(false); }}
            placeholder="Search symbol..."
            className="w-full rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-8 pr-2 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30 focus:border-teal-400"
          />
          {showSymbolDropdown && filteredSymbols.length > 0 && (
            <div className="absolute z-20 top-full mt-1 w-full bg-white border border-slate-200 rounded-xl shadow-lg max-h-60 overflow-y-auto">
              {filteredSymbols.slice(0, 50).map(s => (
                <button
                  key={s}
                  onMouseDown={e => e.preventDefault()}
                  onClick={() => selectSymbol(s)}
                  className={`w-full text-left px-3 py-1.5 text-sm transition ${s === symbol ? 'bg-teal-50 text-teal-700 font-semibold' : 'hover:bg-slate-50 text-slate-700'}`}
                >
                  {s}
                </button>
              ))}
            </div>
          )}
        </div>
        <button onClick={() => { handleSearch(); setShowSymbolDropdown(false); }} className="rounded-lg bg-teal-600 px-3 py-1.5 text-sm font-medium text-white hover:bg-teal-700 transition-colors">
          Search
        </button>

        <select
          value={exchange}
          onChange={e => setExchange(e.target.value)}
          className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30"
        >
          <option value="NSE">NSE</option>
          <option value="BSE">BSE</option>
        </select>

        {expiries.length > 0 && (
          <select
            value={selectedExpiry}
            onChange={e => setSelectedExpiry(e.target.value)}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1.5 text-sm focus:outline-none focus:ring-2 focus:ring-teal-500/30"
          >
            {expiries.map(exp => (
              <option key={exp} value={exp}>
                {new Date(exp + 'T00:00:00').toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' })}
              </option>
            ))}
          </select>
        )}

        <div className="flex items-center gap-2 ml-auto">
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
            <input type="checkbox" checked={showAllStrikes} onChange={e => { setShowAllStrikes(e.target.checked); hasScrolledRef.current = false; }} className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 h-3.5 w-3.5" />
            All Strikes
          </label>
          <label className="flex items-center gap-1.5 text-xs text-slate-500 cursor-pointer select-none">
            <input type="checkbox" checked={showGreeks} onChange={e => setShowGreeks(e.target.checked)} className="rounded border-slate-300 text-teal-600 focus:ring-teal-500 h-3.5 w-3.5" />
            Greeks
          </label>
        </div>

        <button onClick={() => fetchData(symbol)} disabled={loading} className="rounded-lg border border-slate-200 p-1.5 text-slate-400 hover:text-teal-600 hover:bg-slate-50 transition-colors disabled:opacity-50">
          {loading ? <Loader2 className="h-4 w-4 animate-spin" /> : <RefreshCcw className="h-4 w-4" />}
        </button>

        {spotPrice > 0 && (
          <div className="text-sm font-medium text-slate-700">
            {symbol} Spot: <span className="text-teal-700 font-semibold">{spotPrice.toLocaleString('en-IN', { maximumFractionDigits: 2 })}</span>
          </div>
        )}
      </div>

      {/* Main Grid */}
      {visibleStrikes.length > 0 ? (
        <div className="grid grid-cols-1 xl:grid-cols-[1fr_280px] gap-4">
          {/* Option Chain Table */}
          <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
            <div ref={tableContainerRef} className="overflow-x-auto overflow-y-auto max-h-[75vh]">
              <table className="w-full text-[11px] tabular-nums">
                <thead className="sticky top-0 z-10">
                  <tr className="border-b border-slate-200">
                    <th colSpan={showGreeks ? 11 : 7} className="bg-blue-50 text-blue-800 py-1.5 px-2 text-center font-semibold text-[10px] uppercase tracking-wider">
                      Calls
                    </th>
                    <th className="bg-slate-100 py-1.5 px-2 text-center font-semibold text-slate-700 text-[10px] uppercase tracking-wider">
                      Strike
                    </th>
                    <th colSpan={showGreeks ? 11 : 7} className="bg-rose-50 text-rose-800 py-1.5 px-2 text-center font-semibold text-[10px] uppercase tracking-wider">
                      Puts
                    </th>
                  </tr>
                  <tr className="border-b border-slate-100 text-[9px] uppercase tracking-wider text-slate-500 bg-white">
                    {showGreeks && (
                      <>
                        <th className="bg-blue-50/40 py-1 px-1.5 text-right font-medium">Delta</th>
                        <th className="bg-blue-50/40 py-1 px-1.5 text-right font-medium">Gamma</th>
                        <th className="bg-blue-50/40 py-1 px-1.5 text-right font-medium">Theta</th>
                        <th className="bg-blue-50/40 py-1 px-1.5 text-right font-medium">Vega</th>
                      </>
                    )}
                    <th className="bg-blue-50/20 py-1 px-1.5 text-right font-medium">OI</th>
                    <th className="bg-blue-50/20 py-1 px-1.5 text-right font-medium">OI Chg</th>
                    <th className="bg-blue-50/20 py-1 px-1.5 text-right font-medium">Vol</th>
                    <th className="bg-blue-50/20 py-1 px-1.5 text-right font-medium">IV</th>
                    <th className="bg-blue-50/20 py-1 px-1.5 text-right font-medium">LTP</th>
                    <th className="bg-blue-50/20 py-1 px-1.5 text-right font-medium">Chg</th>
                    <th className="bg-blue-50/20 py-1 px-1.5 text-right font-medium">Bid/Ask</th>
                    <th className="bg-slate-100 py-1 px-2 text-center font-bold text-slate-700">Strike</th>
                    <th className="bg-rose-50/20 py-1 px-1.5 text-left font-medium">Bid/Ask</th>
                    <th className="bg-rose-50/20 py-1 px-1.5 text-left font-medium">Chg</th>
                    <th className="bg-rose-50/20 py-1 px-1.5 text-left font-medium">LTP</th>
                    <th className="bg-rose-50/20 py-1 px-1.5 text-left font-medium">IV</th>
                    <th className="bg-rose-50/20 py-1 px-1.5 text-left font-medium">Vol</th>
                    <th className="bg-rose-50/20 py-1 px-1.5 text-left font-medium">OI Chg</th>
                    <th className="bg-rose-50/20 py-1 px-1.5 text-left font-medium">OI</th>
                    {showGreeks && (
                      <>
                        <th className="bg-rose-50/40 py-1 px-1.5 text-left font-medium">Delta</th>
                        <th className="bg-rose-50/40 py-1 px-1.5 text-left font-medium">Gamma</th>
                        <th className="bg-rose-50/40 py-1 px-1.5 text-left font-medium">Theta</th>
                        <th className="bg-rose-50/40 py-1 px-1.5 text-left font-medium">Vega</th>
                      </>
                    )}
                  </tr>
                </thead>
                <tbody>
                  {visibleStrikes.map((s) => {
                    const isATM = s.strike === atmStrike;
                    const isCallITM = s.strike < spotPrice;
                    const isPutITM = s.strike > spotPrice;
                    const callOIPct = (s.callOI / maxOI) * 100;
                    const putOIPct = (s.putOI / maxOI) * 100;
                    const hasCallData = s.callOI > 0 || s.callLTP > 0;
                    const hasPutData = s.putOI > 0 || s.putLTP > 0;

                    const rowBg = isATM
                      ? 'bg-amber-50/80 border-amber-200'
                      : isCallITM
                        ? 'bg-blue-50/20'
                        : isPutITM
                          ? 'bg-rose-50/20'
                          : 'bg-white';

                    return (
                      <tr
                        key={s.strike}
                        ref={isATM ? atmRowRef : undefined}
                        className={`border-b border-slate-100/70 hover:bg-slate-50/60 transition-colors ${rowBg} ${isATM ? 'border-y-2 border-amber-300' : ''}`}
                      >
                        {/* Call Greeks */}
                        {showGreeks && (
                          <>
                            <td className={`py-1 px-1.5 text-right ${hasCallData ? 'text-blue-700 font-medium' : 'text-slate-300'}`}>
                              {s.callDelta ? s.callDelta.toFixed(2) : '-'}
                            </td>
                            <td className={`py-1 px-1.5 text-right ${hasCallData ? 'text-slate-500' : 'text-slate-300'}`}>
                              {s.callGamma ? s.callGamma.toFixed(4) : '-'}
                            </td>
                            <td className={`py-1 px-1.5 text-right ${s.callTheta < 0 ? 'text-red-500' : 'text-slate-300'}`}>
                              {s.callTheta ? s.callTheta.toFixed(2) : '-'}
                            </td>
                            <td className={`py-1 px-1.5 text-right ${hasCallData ? 'text-slate-500' : 'text-slate-300'}`}>
                              {s.callVega ? s.callVega.toFixed(2) : '-'}
                            </td>
                          </>
                        )}
                        {/* Call OI with bar */}
                        <td className="py-1 px-1.5 text-right relative">
                          <div className="absolute inset-y-0 right-0 bg-blue-100/60 rounded-l" style={{ width: `${Math.min(callOIPct, 100)}%` }} />
                          <span className={`relative font-medium ${hasCallData ? 'text-slate-800' : 'text-slate-300'}`}>{hasCallData ? fmtNum(s.callOI) : '0'}</span>
                        </td>
                        <td className={`py-1 px-1.5 text-right font-medium ${chgCls(s.callOIChange)}`}>
                          {s.callOIChange !== 0 ? `${s.callOIChange > 0 ? '+' : ''}${fmtNum(s.callOIChange)}` : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-right ${hasCallData ? 'text-slate-600' : 'text-slate-300'}`}>
                          {s.callVolume > 0 ? fmtNum(s.callVolume) : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-right ${hasCallData ? 'text-slate-600' : 'text-slate-300'}`}>
                          {s.callIV > 0 ? s.callIV.toFixed(1) : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-right font-bold ${hasCallData ? 'text-slate-900' : 'text-slate-300'}`}>
                          {s.callLTP > 0 ? s.callLTP.toFixed(2) : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-right font-medium ${chgCls(s.callNetChange)}`}>
                          {s.callNetChange !== 0 ? `${s.callNetChange > 0 ? '+' : ''}${s.callNetChange.toFixed(2)}` : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-right text-[10px] ${hasCallData ? 'text-slate-400' : 'text-slate-300'}`}>
                          {s.callBidPrice > 0 || s.callAskPrice > 0
                            ? `${s.callBidPrice.toFixed(1)}/${s.callAskPrice.toFixed(1)}`
                            : '-'}
                        </td>

                        {/* Strike */}
                        <td className={`py-1 px-2 text-center font-bold ${isATM ? 'text-amber-800 bg-amber-100/70 text-sm' : 'text-slate-800'}`}>
                          {s.strike.toLocaleString('en-IN')}
                          {isATM && <span className="ml-1 text-[8px] font-semibold text-amber-600 bg-amber-200/60 px-1 rounded">ATM</span>}
                        </td>

                        {/* Put Side (mirrored) */}
                        <td className={`py-1 px-1.5 text-left text-[10px] ${hasPutData ? 'text-slate-400' : 'text-slate-300'}`}>
                          {s.putBidPrice > 0 || s.putAskPrice > 0
                            ? `${s.putBidPrice.toFixed(1)}/${s.putAskPrice.toFixed(1)}`
                            : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-left font-medium ${chgCls(s.putNetChange)}`}>
                          {s.putNetChange !== 0 ? `${s.putNetChange > 0 ? '+' : ''}${s.putNetChange.toFixed(2)}` : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-left font-bold ${hasPutData ? 'text-slate-900' : 'text-slate-300'}`}>
                          {s.putLTP > 0 ? s.putLTP.toFixed(2) : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-left ${hasPutData ? 'text-slate-600' : 'text-slate-300'}`}>
                          {s.putIV > 0 ? s.putIV.toFixed(1) : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-left ${hasPutData ? 'text-slate-600' : 'text-slate-300'}`}>
                          {s.putVolume > 0 ? fmtNum(s.putVolume) : '-'}
                        </td>
                        <td className={`py-1 px-1.5 text-left font-medium ${chgCls(s.putOIChange)}`}>
                          {s.putOIChange !== 0 ? `${s.putOIChange > 0 ? '+' : ''}${fmtNum(s.putOIChange)}` : '-'}
                        </td>
                        <td className="py-1 px-1.5 text-left relative">
                          <div className="absolute inset-y-0 left-0 bg-rose-100/60 rounded-r" style={{ width: `${Math.min(putOIPct, 100)}%` }} />
                          <span className={`relative font-medium ${hasPutData ? 'text-slate-800' : 'text-slate-300'}`}>{hasPutData ? fmtNum(s.putOI) : '0'}</span>
                        </td>
                        {/* Put Greeks */}
                        {showGreeks && (
                          <>
                            <td className={`py-1 px-1.5 text-left ${hasPutData ? 'text-rose-700 font-medium' : 'text-slate-300'}`}>
                              {s.putDelta ? s.putDelta.toFixed(2) : '-'}
                            </td>
                            <td className={`py-1 px-1.5 text-left ${hasPutData ? 'text-slate-500' : 'text-slate-300'}`}>
                              {s.putGamma ? s.putGamma.toFixed(4) : '-'}
                            </td>
                            <td className={`py-1 px-1.5 text-left ${s.putTheta < 0 ? 'text-red-500' : 'text-slate-300'}`}>
                              {s.putTheta ? s.putTheta.toFixed(2) : '-'}
                            </td>
                            <td className={`py-1 px-1.5 text-left ${hasPutData ? 'text-slate-500' : 'text-slate-300'}`}>
                              {s.putVega ? s.putVega.toFixed(2) : '-'}
                            </td>
                          </>
                        )}
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            </div>
            {!showAllStrikes && visibleStrikes.length < strikes.length && (
              <button
                onClick={() => { setShowAllStrikes(true); hasScrolledRef.current = false; }}
                className="w-full py-2 text-xs text-teal-600 hover:text-teal-700 hover:bg-teal-50/50 font-medium flex items-center justify-center gap-1 border-t border-slate-100"
              >
                <ChevronDown className="h-3.5 w-3.5" />
                Show all {strikes.length} strikes (currently showing {visibleStrikes.length} near ATM)
              </button>
            )}
          </div>

          {/* Analytics Sidebar */}
          <div className="space-y-3">
            {/* Max Pain */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 mb-2">
                <Target className="h-3.5 w-3.5 text-violet-500" /> Max Pain
              </div>
              <p className="text-2xl font-bold text-violet-700">{maxPain.toLocaleString('en-IN')}</p>
              <p className="mt-1 text-[10px] text-slate-400 leading-relaxed">
                Strike where combined premium paid by option buyers is maximised. Market often gravitates towards this level at expiry.
              </p>
            </div>

            {/* PCR */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 mb-2">
                <Activity className="h-3.5 w-3.5 text-teal-500" /> Put/Call Ratio
              </div>
              <div className="flex items-center gap-3">
                <p className="text-2xl font-bold text-slate-900">{pcr.toFixed(2)}</p>
                <span className={`inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[10px] font-semibold ${pcrBadge.cls}`}>
                  {pcr > 1.2 ? <TrendingUp className="h-3 w-3" /> : pcr < 0.8 ? <TrendingDown className="h-3 w-3" /> : <Activity className="h-3 w-3" />}
                  {pcrBadge.label}
                </span>
              </div>
            </div>

            {/* IV Percentile */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 mb-2">
                <BarChart3 className="h-3.5 w-3.5 text-blue-500" /> IV Percentile
              </div>
              <div className="flex items-center gap-3">
                <div className="relative w-12 h-12">
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
                  <span className="absolute inset-0 flex items-center justify-center text-xs font-bold text-slate-800">{ivPercentile}</span>
                </div>
                <div className="text-[10px] text-slate-500 leading-relaxed">
                  <p className="font-medium text-slate-700">
                    {ivPercentile > 70 ? 'High IV — premiums expensive' : ivPercentile > 40 ? 'Moderate IV' : 'Low IV — premiums cheap'}
                  </p>
                  Current IV is at the {ivPercentile}th percentile of its 1-year range.
                </div>
              </div>
            </div>

            {/* Support / Resistance */}
            <div className="rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center gap-2 text-xs font-semibold text-slate-600 mb-2">
                <ShieldCheck className="h-3.5 w-3.5 text-emerald-500" /> Support & Resistance
              </div>
              <div className="grid grid-cols-2 gap-2">
                <div className="rounded-lg bg-emerald-50/80 border border-emerald-100 p-2.5 text-center">
                  <p className="text-[9px] uppercase tracking-wider text-emerald-600 font-medium mb-0.5">Support</p>
                  <p className="text-base font-bold text-emerald-700">{highestPutOIStrike.toLocaleString('en-IN')}</p>
                  <p className="text-[9px] text-emerald-500 mt-0.5 flex items-center justify-center gap-0.5">
                    <ArrowUpRight className="h-2.5 w-2.5" /> Highest Put OI
                  </p>
                </div>
                <div className="rounded-lg bg-red-50/80 border border-red-100 p-2.5 text-center">
                  <p className="text-[9px] uppercase tracking-wider text-red-600 font-medium mb-0.5">Resistance</p>
                  <p className="text-base font-bold text-red-700">{highestCallOIStrike.toLocaleString('en-IN')}</p>
                  <p className="text-[9px] text-red-500 mt-0.5 flex items-center justify-center gap-0.5">
                    <ArrowDownRight className="h-2.5 w-2.5" /> Highest Call OI
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
        <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
          <h2 className="text-xs font-semibold text-slate-700 mb-3 flex items-center gap-2">
            <BarChart3 className="h-3.5 w-3.5 text-slate-400" /> Open Interest Distribution
          </h2>
          <div className="h-56">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={chartData} margin={{ top: 5, right: 20, bottom: 5, left: 10 }}>
                <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                <XAxis dataKey="strike" tick={{ fontSize: 9, fill: '#94a3b8' }} tickFormatter={v => v.toLocaleString()} />
                <YAxis tick={{ fontSize: 9, fill: '#94a3b8' }} tickFormatter={v => fmtNum(v as number)} />
                <Tooltip
                  contentStyle={{ borderRadius: 12, border: '1px solid #e2e8f0', fontSize: 11, boxShadow: '0 4px 6px -1px rgba(0,0,0,.05)' }}
                  formatter={(v: number | undefined) => [fmtNum(v ?? 0), undefined]}
                  labelFormatter={l => `Strike: ${Number(l).toLocaleString('en-IN')}`}
                />
                <Legend wrapperStyle={{ fontSize: 11 }} />
                <Bar dataKey="Call OI" fill="#3b82f6" radius={[3, 3, 0, 0]} opacity={0.85} />
                <Bar dataKey="Put OI" fill="#f43f5e" radius={[3, 3, 0, 0]} opacity={0.85} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}
