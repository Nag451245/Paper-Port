import { useState, useMemo, useEffect, useCallback, useRef } from 'react';
import { marketApi, intelligenceApi } from '@/services/api';
import {
  BarChart3,
  TrendingUp,
  TrendingDown,
  Activity,
  Gauge,
  Clock,
  Zap,
  Target,
  Brain,
  ArrowUpRight,
  ArrowDownRight,
  Info,
  Flame,
  Shield,
  Wifi,
  RefreshCcw,
  Loader2,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
  Legend,
  Cell,
} from 'recharts';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

const REFRESH_MARKET = 15_000;
const REFRESH_OFF = 5 * 60_000;

function fmtCr(n: number): string {
  const abs = Math.abs(n);
  if (abs >= 10000000) return (n / 10000000).toFixed(2) + ' Cr';
  if (abs >= 100000) return (n / 100000).toFixed(2) + ' L';
  if (abs >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}

function fmtNum(n: number): string {
  if (Math.abs(n) >= 10000000) return (n / 10000000).toFixed(2) + 'Cr';
  if (Math.abs(n) >= 100000) return (n / 100000).toFixed(2) + 'L';
  if (Math.abs(n) >= 1000) return (n / 1000).toFixed(1) + 'K';
  return n.toLocaleString('en-IN');
}

function ivColor(iv: number): string {
  if (iv <= 0) return 'bg-slate-50 text-slate-400';
  if (iv <= 12) return 'bg-blue-100 text-blue-800';
  if (iv <= 14) return 'bg-sky-200 text-sky-900';
  if (iv <= 16) return 'bg-yellow-100 text-yellow-800';
  if (iv <= 18) return 'bg-amber-200 text-amber-900';
  if (iv <= 22) return 'bg-orange-200 text-orange-900';
  return 'bg-red-200 text-red-900';
}

function oiIntensity(value: number, max: number): string {
  const ratio = Math.abs(value) / (max || 1);
  if (ratio < 0.2) return 'bg-slate-50';
  if (ratio < 0.4) return 'bg-slate-100';
  if (ratio < 0.6) return value > 0 ? 'bg-emerald-100' : 'bg-red-100';
  if (ratio < 0.8) return value > 0 ? 'bg-emerald-200' : 'bg-red-200';
  return value > 0 ? 'bg-emerald-300 font-semibold' : 'bg-red-300 font-semibold';
}

function MeterBar({ value, color, label }: { value: number; color: string; label: string }) {
  return (
    <div className="space-y-1.5">
      <div className="flex items-center justify-between text-xs">
        <span className="text-slate-500">{label}</span>
        <span className="font-semibold text-slate-700">{value}%</span>
      </div>
      <div className="h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full rounded-full transition-all duration-700 ${color}`} style={{ width: `${Math.min(100, value)}%` }} />
      </div>
    </div>
  );
}

interface MarketCard {
  label: string;
  value: string;
  change: number;
  points: string;
  icon: React.ElementType;
  accent: string;
}

interface StrikeData {
  strike: number;
  callOI: number;
  callOIChange: number;
  callVolume: number;
  callIV: number;
  callLTP: number;
  callNetChange: number;
  callBuildup: string;
  putOI: number;
  putOIChange: number;
  putVolume: number;
  putIV: number;
  putLTP: number;
  putNetChange: number;
  putBuildup: string;
}

// ─── Narrative Generator ─────────────────────────────────────────────────────

function generateNarrative(
  vixValue: number, vixChange: number,
  pcr: number,
  fiiNet: number, _diiNet: number,
  spotPrice: number, maxPain: number,
  topCallOIStrike: number, topPutOIStrike: number,
): { text: string; sentiment: string; volatility: string; bias: string } {
  const parts: string[] = [];

  if (vixValue > 0) {
    if (Math.abs(vixChange) > 3) {
      parts.push(`VIX at ${vixValue.toFixed(1)} ${vixChange > 0 ? 'spiked' : 'dropped'} ${Math.abs(vixChange).toFixed(1)}%, signalling ${vixChange > 0 ? 'rising nervousness' : 'easing fear'}.`);
    } else {
      parts.push(`VIX at ${vixValue.toFixed(1)} remains ${vixValue > 18 ? 'elevated' : vixValue > 14 ? 'moderate' : 'subdued'}.`);
    }
  }

  if (fiiNet !== 0) {
    const fiiAbs = Math.abs(fiiNet);
    const fiiLabel = fiiAbs >= 10000000 ? `₹${(fiiAbs / 10000000).toFixed(0)} Cr` : `₹${fmtCr(fiiAbs)}`;
    parts.push(`FII ${fiiNet < 0 ? 'sold' : 'bought'} ${fiiLabel} net — ${fiiNet < 0 ? 'bearish' : 'bullish'} institutional flow.`);
  }

  if (pcr > 0) {
    const pcrLabel = pcr > 1.3 ? 'strongly bullish' : pcr > 1.0 ? 'moderately bullish' : pcr > 0.8 ? 'neutral' : pcr > 0.6 ? 'mildly bearish' : 'strongly bearish';
    parts.push(`PCR at ${pcr.toFixed(2)} is ${pcrLabel}.`);
  }

  if (topCallOIStrike > 0 && topPutOIStrike > 0) {
    parts.push(`Highest call OI at ${topCallOIStrike.toLocaleString('en-IN')} (resistance) and put OI at ${topPutOIStrike.toLocaleString('en-IN')} (support).`);
  }

  if (maxPain > 0 && spotPrice > 0) {
    const diff = spotPrice - maxPain;
    if (Math.abs(diff) > spotPrice * 0.005) {
      parts.push(`Spot is ${Math.abs(diff).toFixed(0)} pts ${diff > 0 ? 'above' : 'below'} max pain (${maxPain.toLocaleString('en-IN')}) — ${diff > 0 ? 'call writers may push down' : 'put writers may support'}.`);
    } else {
      parts.push(`Spot near max pain ${maxPain.toLocaleString('en-IN')} — expiry pinning likely.`);
    }
  }

  let sentiment = 'Neutral';
  if (pcr > 1.2 && fiiNet > 0) sentiment = 'Bullish';
  else if (pcr > 1.0 || fiiNet > 0) sentiment = 'Cautiously Bullish';
  else if (pcr < 0.7 && fiiNet < 0) sentiment = 'Bearish';
  else if (pcr < 0.9 || fiiNet < 0) sentiment = 'Cautious';

  let volatility = 'Stable';
  if (vixValue > 20) volatility = 'High';
  else if (vixValue > 15 || Math.abs(vixChange) > 5) volatility = 'Rising';
  else if (vixValue < 12) volatility = 'Low';

  let bias = 'Neutral';
  if (pcr > 1.2) bias = 'Bullish';
  else if (pcr > 1.0) bias = 'Neutral-Bull';
  else if (pcr < 0.7) bias = 'Bearish';
  else if (pcr < 0.9) bias = 'Neutral-Bear';

  return { text: parts.join(' ') || 'Loading market data...', sentiment, volatility, bias };
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function FnOAnalytics() {
  const [selectedIndex] = useState<'NIFTY' | 'BANKNIFTY'>('NIFTY');

  // Market cards
  const [marketCards, setMarketCards] = useState<MarketCard[]>([
    { label: 'NIFTY 50', value: '—', change: 0, points: '—', icon: TrendingUp, accent: 'emerald' },
    { label: 'BANK NIFTY', value: '—', change: 0, points: '—', icon: TrendingUp, accent: 'red' },
    { label: 'India VIX', value: '—', change: 0, points: '—', icon: Activity, accent: 'amber' },
    { label: 'Overall PCR', value: '—', change: 0, points: '—', icon: Gauge, accent: 'sky' },
  ]);

  // Live data
  const [optionChain, setOptionChain] = useState<StrikeData[]>([]);
  const [spotPrice, setSpotPrice] = useState(0);
  const [expiry, setExpiry] = useState('');
  const [vixData, setVixData] = useState({ value: 0, change: 0, changePct: 0 });
  const [pcrValue, setPcrValue] = useState(0);
  const [ivPercentileData, setIvPercentileData] = useState({ currentIV: 0, ivPercentile: 0 });
  const [maxPainValue, setMaxPainValue] = useState(0);
  const [fiiDiiToday, setFiiDiiToday] = useState({ fii: 0, dii: 0 });
  const [fiiDii5Day, setFiiDii5Day] = useState<{ day: string; FII: number; DII: number }[]>([]);

  const [isLiveData, setIsLiveData] = useState(false);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const [dataError, setDataError] = useState<string | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  const fetchAll = useCallback(async (silent = false) => {
    if (!silent) setLoading(true);
    let anySuccess = false;

    try {
      const results = await Promise.allSettled([
        marketApi.quote('NIFTY'),
        marketApi.quote('BANKNIFTY'),
        marketApi.vix(),
        intelligenceApi.pcr(selectedIndex),
        intelligenceApi.fiiDii(),
        intelligenceApi.fiiDiiTrend(5),
        marketApi.optionsChain(selectedIndex),
        intelligenceApi.ivPercentile(selectedIndex),
        intelligenceApi.maxPain(selectedIndex),
      ]);

      // NIFTY
      if (results[0].status === 'fulfilled') {
        const d = results[0].value.data;
        if (d?.ltp != null) {
          anySuccess = true;
          setMarketCards(prev => prev.map(c =>
            c.label === 'NIFTY 50' ? {
              ...c, value: d.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
              change: d.changePercent ?? 0,
              points: (d.change >= 0 ? '+' : '') + d.change.toFixed(2),
              icon: d.change >= 0 ? TrendingUp : TrendingDown,
            } : c
          ));
        }
      }

      // BANKNIFTY
      if (results[1].status === 'fulfilled') {
        const d = results[1].value.data;
        if (d?.ltp != null) {
          anySuccess = true;
          setMarketCards(prev => prev.map(c =>
            c.label === 'BANK NIFTY' ? {
              ...c, value: d.ltp.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
              change: d.changePercent ?? 0,
              points: (d.change >= 0 ? '+' : '') + d.change.toFixed(2),
              icon: d.change >= 0 ? TrendingUp : TrendingDown,
            } : c
          ));
        }
      }

      // VIX
      if (results[2].status === 'fulfilled') {
        const d = results[2].value.data;
        if (d?.value != null) {
          anySuccess = true;
          setVixData({ value: d.value, change: d.change ?? 0, changePct: d.changePercent ?? 0 });
          setMarketCards(prev => prev.map(c =>
            c.label === 'India VIX' ? {
              ...c, value: d.value.toFixed(2),
              change: d.changePercent ?? 0,
              points: (d.change >= 0 ? '+' : '') + (d.change ?? 0).toFixed(2),
            } : c
          ));
        }
      }

      // PCR
      if (results[3].status === 'fulfilled') {
        const d = results[3].value.data as any;
        const pcr = d?.pcr ?? d?.value;
        if (typeof pcr === 'number' && pcr > 0) {
          anySuccess = true;
          setPcrValue(pcr);
          setMarketCards(prev => prev.map(c =>
            c.label === 'Overall PCR' ? { ...c, value: pcr.toFixed(2), change: 0, points: d?.interpretation ?? '' } : c
          ));
        }
      }

      // FII/DII
      if (results[4].status === 'fulfilled') {
        const d = results[4].value.data as any;
        const fii = d?.fiiNet ?? d?.fii ?? 0;
        const dii = d?.diiNet ?? d?.dii ?? 0;
        if (fii !== 0 || dii !== 0) { anySuccess = true; setFiiDiiToday({ fii, dii }); }
      }

      // FII/DII 5-day
      if (results[5].status === 'fulfilled') {
        const res = results[5].value;
        const flows = (res.data as any)?.daily_flows ?? (Array.isArray(res.data) ? res.data : []);
        if (flows.length > 0) {
          const dayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
          const mapped = flows.slice(-5).map((r: any, i: number) => {
            const day = r.date ? dayNames[new Date(r.date).getDay()] : `Day ${i + 1}`;
            return { day, FII: r.fiiNet ?? r.fii ?? 0, DII: r.diiNet ?? r.dii ?? 0 };
          });
          anySuccess = true;
          setFiiDii5Day(mapped);
        }
      }

      // Option chain
      if (results[6].status === 'fulfilled') {
        const d = results[6].value.data as any;
        if (d?.strikes?.length > 0) {
          anySuccess = true;
          setOptionChain(d.strikes);
          setSpotPrice(d.spotPrice ?? d.underlyingValue ?? 0);
          setExpiry(d.expiry ?? '');
          if (d.maxPain > 0) setMaxPainValue(d.maxPain);
          if (d.pcr > 0 && pcrValue === 0) setPcrValue(d.pcr);
        }
      }

      // IV Percentile
      if (results[7].status === 'fulfilled') {
        const d = results[7].value.data as any;
        if (d?.ivPercentile != null) {
          anySuccess = true;
          setIvPercentileData({ currentIV: d.currentIV ?? 0, ivPercentile: d.ivPercentile });
        }
      }

      // Max Pain
      if (results[8].status === 'fulfilled') {
        const d = results[8].value.data as any;
        if (d?.maxPain > 0) { anySuccess = true; setMaxPainValue(d.maxPain); }
      }

      if (anySuccess) {
        setIsLiveData(true);
        setLastUpdated(new Date());
        setDataError(null);
      } else if (!silent) {
        setDataError('Unable to fetch F&O data. The Breeze API session may have expired — check Settings.');
      }
    } catch {
      if (!silent) setDataError('Failed to connect to market data services. Please check your connection.');
    }
    finally { if (!silent) setLoading(false); }
  }, [selectedIndex, pcrValue]);

  useEffect(() => { fetchAll(); }, [fetchAll]);

  useEffect(() => {
    const schedule = () => {
      const interval = isMarketOpen() ? REFRESH_MARKET : REFRESH_OFF;
      timerRef.current = setTimeout(() => { fetchAll(true); schedule(); }, interval);
    };
    schedule();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [fetchAll]);

  // ─── Derived computations ─────────────────────────────────────────

  const strikeDivisor = spotPrice > 40000 ? 100 : 50;
  const atmStrike = useMemo(() => Math.round(spotPrice / strikeDivisor) * strikeDivisor, [spotPrice, strikeDivisor]);

  // IV Smile: strikes near ATM with their call and put IV
  const ivSmile = useMemo(() => {
    if (optionChain.length === 0 || spotPrice === 0) return [];
    const atmIdx = optionChain.findIndex(s => s.strike >= atmStrike);
    const start = Math.max(0, atmIdx - 8);
    const end = Math.min(optionChain.length, atmIdx + 9);
    return optionChain.slice(start, end).filter(s => s.callIV > 0 || s.putIV > 0);
  }, [optionChain, atmStrike, spotPrice]);

  // OI Heatmap: 10 strikes around ATM
  const oiHeatmapData = useMemo(() => {
    if (optionChain.length === 0 || spotPrice === 0) return [];
    const atmIdx = optionChain.findIndex(s => s.strike >= atmStrike);
    const start = Math.max(0, atmIdx - 5);
    const end = Math.min(optionChain.length, atmIdx + 6);
    return optionChain.slice(start, end);
  }, [optionChain, atmStrike, spotPrice]);

  const maxOiChange = useMemo(
    () => Math.max(...oiHeatmapData.flatMap(r => [Math.abs(r.callOIChange), Math.abs(r.putOIChange)]), 1),
    [oiHeatmapData],
  );

  // Expiry metrics
  const expiryMetrics = useMemo(() => {
    const dte = expiry ? Math.max(0, Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000)) : 0;
    const vix = vixData.value;
    const ivCrush = vix > 0 ? Math.min(95, Math.max(10, 40 + (vix - 15) * 2 + Math.max(0, 8 - dte) * 3)) : 0;

    // Gamma risk: higher near expiry and when spot is near ATM
    const gammaRisk = dte > 0 ? Math.min(95, Math.max(10, 30 + Math.max(0, 7 - dte) * 8 + (vix > 15 ? 10 : 0))) : 0;

    // Pin risk: closer to max pain = higher pin risk
    const pinRisk = (maxPainValue > 0 && spotPrice > 0)
      ? Math.max(0, Math.min(95, Math.round(100 - (Math.abs(spotPrice - maxPainValue) / spotPrice * 100) * 20)))
      : 0;

    // Expected move from ATM straddle
    const atmCall = optionChain.find(s => s.strike === atmStrike);
    const straddlePremium = atmCall ? (atmCall.callLTP + atmCall.putLTP) : 0;
    const expectedMove = straddlePremium;
    const expectedMovePercent = spotPrice > 0 && straddlePremium > 0 ? (straddlePremium / spotPrice * 100) : 0;

    return {
      dte,
      expiryDate: expiry ? new Date(expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short', year: 'numeric' }) : '—',
      ivCrush: Math.round(ivCrush),
      gammaRisk: Math.round(gammaRisk),
      pinRisk: Math.round(pinRisk),
      maxPain: maxPainValue,
      straddlePremium,
      expectedMove,
      expectedMovePercent,
    };
  }, [expiry, vixData, maxPainValue, spotPrice, optionChain, atmStrike]);

  // Support / Resistance from OI
  const topCallOIStrike = useMemo(() => {
    let max = 0, strike = 0;
    for (const s of optionChain) { if (s.callOI > max) { max = s.callOI; strike = s.strike; } }
    return strike;
  }, [optionChain]);

  const topPutOIStrike = useMemo(() => {
    let max = 0, strike = 0;
    for (const s of optionChain) { if (s.putOI > max) { max = s.putOI; strike = s.strike; } }
    return strike;
  }, [optionChain]);

  // Narrative
  const narrative = useMemo(
    () => generateNarrative(vixData.value, vixData.changePct, pcrValue, fiiDiiToday.fii, fiiDiiToday.dii, spotPrice, maxPainValue, topCallOIStrike, topPutOIStrike),
    [vixData, pcrValue, fiiDiiToday, spotPrice, maxPainValue, topCallOIStrike, topPutOIStrike],
  );

  const timeAgo = lastUpdated ? `${Math.max(0, Math.round((Date.now() - lastUpdated.getTime()) / 1000))}s ago` : '';

  // ─── Render ───────────────────────────────────────────────────────

  return (
    <div className="space-y-6 pb-8">
      {dataError && (
        <div className="rounded-lg border border-amber-300 bg-amber-50 px-4 py-3 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Shield className="h-5 w-5 text-amber-600 flex-shrink-0" />
            <p className="text-sm text-amber-800">{dataError}</p>
          </div>
          <button
            onClick={() => { setDataError(null); fetchAll(); }}
            className="text-sm font-medium text-amber-700 hover:text-amber-900 underline flex-shrink-0"
          >
            Retry
          </button>
        </div>
      )}
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <BarChart3 className="w-7 h-7 text-teal-600" />
            F&O Analytics
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">Real-time derivatives intelligence for {selectedIndex}</p>
        </div>
        <div className="flex items-center gap-3">
          {isLiveData && (
            <div className="flex items-center gap-1.5 text-xs text-slate-500">
              {isMarketOpen() ? (
                <span className="flex items-center gap-1 text-emerald-600 font-medium"><Wifi className="h-3 w-3" /> LIVE</span>
              ) : (
                <span className="text-slate-400">Market Closed</span>
              )}
              <span className="text-slate-300">|</span>
              <span>{timeAgo}</span>
            </div>
          )}
          <button onClick={() => fetchAll()} disabled={loading} className="p-2 hover:bg-slate-100 rounded-lg transition disabled:opacity-50">
            {loading ? <Loader2 className="w-4 h-4 animate-spin text-slate-400" /> : <RefreshCcw className="w-4 h-4 text-slate-400" />}
          </button>
        </div>
      </div>

      {/* 1. Market Pulse Cards */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {marketCards.map(c => {
          const isUp = c.change >= 0;
          const accentMap: Record<string, string> = {
            emerald: 'from-emerald-500/10 to-emerald-500/5 border-emerald-200/60',
            red: 'from-red-500/10 to-red-500/5 border-red-200/60',
            amber: 'from-amber-500/10 to-amber-500/5 border-amber-200/60',
            sky: 'from-sky-500/10 to-sky-500/5 border-sky-200/60',
          };
          return (
            <div key={c.label} className={`relative rounded-2xl border bg-gradient-to-br ${accentMap[c.accent]} p-4 shadow-sm overflow-hidden`}>
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">{c.label}</span>
                <c.icon className={`w-4 h-4 ${isUp ? 'text-emerald-500' : 'text-red-500'}`} />
              </div>
              <p className="text-2xl font-bold text-slate-800">{c.value}</p>
              <div className="flex items-center gap-1.5 mt-1">
                {isUp ? <ArrowUpRight className="w-3.5 h-3.5 text-emerald-500" /> : <ArrowDownRight className="w-3.5 h-3.5 text-red-500" />}
                <span className={`text-xs font-semibold ${isUp ? 'text-emerald-600' : 'text-red-600'}`}>
                  {c.points} {c.label !== 'Overall PCR' ? `(${isUp ? '+' : ''}${c.change.toFixed(2)}%)` : ''}
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* 2. IV Smile + IV Percentile */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Flame className="w-4 h-4 text-orange-500" />
            IV Smile — {selectedIndex} {expiry ? `(${new Date(expiry).toLocaleDateString('en-IN', { day: '2-digit', month: 'short' })})` : ''}
          </h2>
          {ivSmile.length > 0 ? (
            <>
              <div className="overflow-x-auto">
                <table className="w-full text-xs">
                  <thead>
                    <tr>
                      <th className="text-left text-slate-400 font-medium pb-2 pr-3">Strike</th>
                      {ivSmile.map(s => (
                        <th key={s.strike} className={`text-center font-medium pb-2 px-1 ${s.strike === atmStrike ? 'text-amber-600' : 'text-slate-500'}`}>
                          {s.strike.toLocaleString('en-IN')}
                          {s.strike === atmStrike && <span className="block text-[9px] text-amber-500">ATM</span>}
                        </th>
                      ))}
                    </tr>
                  </thead>
                  <tbody>
                    <tr>
                      <td className="text-slate-600 font-medium py-1 pr-3 whitespace-nowrap">Call IV</td>
                      {ivSmile.map(s => (
                        <td key={s.strike} className="px-1 py-1">
                          <div className={`rounded-lg text-center py-1.5 font-semibold ${ivColor(s.callIV)}`}>
                            {s.callIV > 0 ? s.callIV.toFixed(1) : '—'}
                          </div>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="text-slate-600 font-medium py-1 pr-3 whitespace-nowrap">Put IV</td>
                      {ivSmile.map(s => (
                        <td key={s.strike} className="px-1 py-1">
                          <div className={`rounded-lg text-center py-1.5 font-semibold ${ivColor(s.putIV)}`}>
                            {s.putIV > 0 ? s.putIV.toFixed(1) : '—'}
                          </div>
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="text-slate-600 font-medium py-1 pr-3 whitespace-nowrap">Call LTP</td>
                      {ivSmile.map(s => (
                        <td key={s.strike} className="px-1 py-1 text-center text-slate-600 font-mono">
                          {s.callLTP > 0 ? s.callLTP.toFixed(1) : '—'}
                        </td>
                      ))}
                    </tr>
                    <tr>
                      <td className="text-slate-600 font-medium py-1 pr-3 whitespace-nowrap">Put LTP</td>
                      {ivSmile.map(s => (
                        <td key={s.strike} className="px-1 py-1 text-center text-slate-600 font-mono">
                          {s.putLTP > 0 ? s.putLTP.toFixed(1) : '—'}
                        </td>
                      ))}
                    </tr>
                  </tbody>
                </table>
              </div>
              <div className="flex items-center gap-2 mt-3 text-[10px] text-slate-400">
                <span className="px-2 py-0.5 rounded bg-blue-100">Low IV</span>
                <span className="px-2 py-0.5 rounded bg-yellow-100">Medium</span>
                <span className="px-2 py-0.5 rounded bg-red-200">High IV</span>
              </div>
            </>
          ) : (
            <div className="flex items-center justify-center h-32 text-sm text-slate-400">Loading IV data...</div>
          )}
        </div>

        {/* IV Percentile gauge */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5 flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2">
              <Gauge className="w-4 h-4 text-sky-500" /> IV Percentile
            </h2>
            <p className="text-xs text-slate-400 mb-5">Where current IV sits vs. last 252 sessions</p>
          </div>
          <div className="space-y-3">
            <div className="relative h-5 bg-gradient-to-r from-emerald-200 via-yellow-200 to-red-300 rounded-full overflow-hidden">
              <div className="absolute top-0 bottom-0 w-1 bg-slate-800 rounded-full shadow-md" style={{ left: `${ivPercentileData.ivPercentile}%` }} />
            </div>
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>0%</span><span>50%</span><span>100%</span>
            </div>
            <p className="text-3xl font-bold text-slate-800 text-center">{ivPercentileData.ivPercentile}%</p>
          </div>
          <div className="mt-4 p-3 rounded-xl bg-sky-50 border border-sky-100">
            <p className="text-xs text-sky-700 leading-relaxed">
              <Info className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
              {ivPercentileData.ivPercentile > 70
                ? <>Current IV is higher than <strong>{ivPercentileData.ivPercentile}%</strong> of the last year — consider <strong>selling options</strong>. IV tends to mean-revert from these levels.</>
                : ivPercentileData.ivPercentile > 40
                  ? <>Current IV is at <strong>{ivPercentileData.ivPercentile}%</strong> of the last year — moderate levels. Both buying and selling strategies can work.</>
                  : <>Current IV is cheaper than <strong>{100 - ivPercentileData.ivPercentile}%</strong> of the last year — good time to <strong>buy options</strong>. IV tends to mean-revert from these levels.</>
              }
            </p>
          </div>
        </div>
      </div>

      {/* 3. Expiry Analysis + Market Narrative */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Expiry Analysis */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-violet-500" />
            Expiry Analysis — {expiryMetrics.expiryDate}
          </h2>

          <div className="grid grid-cols-3 gap-3 mb-5">
            <div className="rounded-xl bg-violet-50 border border-violet-100 p-3 text-center">
              <p className="text-3xl font-bold text-violet-700">{expiryMetrics.dte}</p>
              <p className="text-xs text-violet-500 font-medium mt-0.5">Days to Expiry</p>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-center">
              <p className="text-2xl font-bold text-amber-700">₹{expiryMetrics.maxPain > 0 ? expiryMetrics.maxPain.toLocaleString('en-IN') : '—'}</p>
              <p className="text-xs text-amber-500 font-medium mt-0.5">Max Pain</p>
            </div>
            <div className="rounded-xl bg-teal-50 border border-teal-100 p-3 text-center">
              <p className="text-2xl font-bold text-teal-700">
                {expiryMetrics.straddlePremium > 0 ? `₹${expiryMetrics.straddlePremium.toFixed(0)}` : '—'}
              </p>
              <p className="text-xs text-teal-500 font-medium mt-0.5">ATM Straddle</p>
              {expiryMetrics.expectedMovePercent > 0 && (
                <p className="text-[10px] text-teal-400 mt-0.5">±{expiryMetrics.expectedMovePercent.toFixed(2)}% expected move</p>
              )}
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <MeterBar value={expiryMetrics.ivCrush} color="bg-gradient-to-r from-orange-400 to-red-500" label="IV Crush Probability" />
              <p className="text-[11px] text-slate-400 mt-1">
                <Zap className="w-3 h-3 inline mr-0.5 -mt-0.5 text-orange-400" />
                {expiryMetrics.ivCrush > 60 ? 'High probability of IV crush post-event. Selling options before event captures premium decay.' : 'Moderate IV crush expected. Consider ratio spreads.'}
              </p>
            </div>
            <div>
              <MeterBar value={expiryMetrics.gammaRisk} color="bg-gradient-to-r from-purple-400 to-pink-500" label="Gamma Risk" />
              <p className="text-[11px] text-slate-400 mt-1">
                <Zap className="w-3 h-3 inline mr-0.5 -mt-0.5 text-purple-400" />
                {expiryMetrics.gammaRisk > 70 ? 'High gamma — delta changes rapidly near expiry. ATM options highly sensitive to spot moves.' : 'Moderate gamma exposure. Standard position sizing appropriate.'}
              </p>
            </div>
            <div>
              <MeterBar value={expiryMetrics.pinRisk} color="bg-gradient-to-r from-sky-400 to-blue-500" label="Pin Risk (Max Pain)" />
              <p className="text-[11px] text-slate-400 mt-1">
                <Target className="w-3 h-3 inline mr-0.5 -mt-0.5 text-sky-400" />
                {expiryMetrics.pinRisk > 60
                  ? `Spot near max pain ₹${expiryMetrics.maxPain.toLocaleString('en-IN')} — high chance of pinning at expiry.`
                  : `Spot ${Math.abs(spotPrice - maxPainValue).toFixed(0)} pts from max pain — moderate pinning probability.`
                }
              </p>
            </div>
          </div>
        </div>

        {/* Market Narrative */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5 flex flex-col">
          <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Brain className="w-4 h-4 text-pink-500" />
            Today's Market Story
            <span className="ml-auto text-[10px] font-medium text-pink-500 bg-pink-50 px-2 py-0.5 rounded-full">Live Synthesis</span>
          </h2>
          <div className="flex-1 rounded-xl bg-gradient-to-br from-slate-50 to-pink-50/40 border border-slate-100 p-4">
            <p className="text-sm text-slate-700 leading-relaxed">{narrative.text}</p>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            {[
              { label: 'Sentiment', value: narrative.sentiment, color: narrative.sentiment.includes('Bull') ? 'text-emerald-600 bg-emerald-50' : narrative.sentiment.includes('Bear') ? 'text-red-600 bg-red-50' : 'text-amber-600 bg-amber-50', icon: Shield },
              { label: 'Volatility', value: narrative.volatility, color: narrative.volatility === 'High' ? 'text-red-600 bg-red-50' : narrative.volatility === 'Rising' ? 'text-amber-600 bg-amber-50' : 'text-emerald-600 bg-emerald-50', icon: Activity },
              { label: 'Bias', value: narrative.bias, color: narrative.bias.includes('Bull') ? 'text-emerald-600 bg-emerald-50' : narrative.bias.includes('Bear') ? 'text-red-600 bg-red-50' : 'text-slate-600 bg-slate-100', icon: narrative.bias.includes('Bull') ? TrendingUp : narrative.bias.includes('Bear') ? TrendingDown : Activity },
            ].map(tag => (
              <div key={tag.label} className={`rounded-lg p-2.5 text-center ${tag.color}`}>
                <tag.icon className="w-4 h-4 mx-auto mb-1" />
                <p className="text-[10px] font-medium opacity-70">{tag.label}</p>
                <p className="text-xs font-bold">{tag.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* 4. Expected Move Range */}
      {expiryMetrics.straddlePremium > 0 && spotPrice > 0 && (
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Target className="w-4 h-4 text-indigo-500" /> Expected Move by Expiry
          </h2>
          <div className="grid grid-cols-3 gap-4">
            <div className="rounded-xl bg-red-50 border border-red-100 p-4 text-center">
              <p className="text-xs text-red-500 font-medium mb-1">Lower Range</p>
              <p className="text-xl font-bold text-red-700">{(spotPrice - expiryMetrics.expectedMove).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
              <p className="text-[10px] text-red-400 mt-1">-{expiryMetrics.expectedMovePercent.toFixed(2)}%</p>
            </div>
            <div className="rounded-xl bg-indigo-50 border border-indigo-100 p-4 text-center">
              <p className="text-xs text-indigo-500 font-medium mb-1">Current Spot</p>
              <p className="text-xl font-bold text-indigo-700">{spotPrice.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
              <p className="text-[10px] text-indigo-400 mt-1">ATM straddle: ₹{expiryMetrics.straddlePremium.toFixed(0)}</p>
            </div>
            <div className="rounded-xl bg-emerald-50 border border-emerald-100 p-4 text-center">
              <p className="text-xs text-emerald-500 font-medium mb-1">Upper Range</p>
              <p className="text-xl font-bold text-emerald-700">{(spotPrice + expiryMetrics.expectedMove).toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
              <p className="text-[10px] text-emerald-400 mt-1">+{expiryMetrics.expectedMovePercent.toFixed(2)}%</p>
            </div>
          </div>
          <p className="text-[11px] text-slate-400 mt-3 text-center">
            Market-priced expected range based on ATM straddle premium. ~68% probability of spot staying within this range.
          </p>
        </div>
      )}

      {/* 5. FII/DII Flows */}
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-500" /> FII / DII F&O Activity
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Today's Net Flow</h3>
            <div className={`rounded-xl border p-3 ${fiiDiiToday.fii >= 0 ? 'border-emerald-100 bg-emerald-50/60' : 'border-red-100 bg-red-50/60'}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">FII (Index Futures)</span>
                <span className={`text-sm font-bold ${fiiDiiToday.fii >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {fiiDiiToday.fii >= 0 ? '+' : '-'}₹{fmtCr(Math.abs(fiiDiiToday.fii))}
                </span>
              </div>
              <p className={`text-[11px] mt-1 ${fiiDiiToday.fii >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                Net {fiiDiiToday.fii >= 0 ? 'buyers — bullish' : 'sellers — bearish'} institutional flow
              </p>
            </div>
            <div className={`rounded-xl border p-3 ${fiiDiiToday.dii >= 0 ? 'border-emerald-100 bg-emerald-50/60' : 'border-red-100 bg-red-50/60'}`}>
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">DII (Index Futures)</span>
                <span className={`text-sm font-bold ${fiiDiiToday.dii >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {fiiDiiToday.dii >= 0 ? '+' : '-'}₹{fmtCr(Math.abs(fiiDiiToday.dii))}
                </span>
              </div>
              <p className={`text-[11px] mt-1 ${fiiDiiToday.dii >= 0 ? 'text-emerald-500' : 'text-red-500'}`}>
                Net {fiiDiiToday.dii >= 0 ? 'buyers — domestic support' : 'sellers — domestic selling'}
              </p>
            </div>
          </div>

          <div className="lg:col-span-2">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">5-Day Trend (₹ Cr)</h3>
            {fiiDii5Day.length > 0 ? (
              <ResponsiveContainer width="100%" height={220}>
                <BarChart data={fiiDii5Day} barGap={4}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                  <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                  <Tooltip contentStyle={{ borderRadius: '12px', border: '1px solid #e2e8f0', fontSize: '12px', boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }} formatter={(val: any) => [`₹${Number(val ?? 0).toLocaleString('en-IN')} Cr`]} />
                  <Legend iconType="circle" wrapperStyle={{ fontSize: '11px' }} />
                  <Bar dataKey="FII" radius={[6, 6, 0, 0]}>
                    {fiiDii5Day.map((entry, i) => <Cell key={i} fill={entry.FII >= 0 ? '#34d399' : '#f87171'} />)}
                  </Bar>
                  <Bar dataKey="DII" radius={[6, 6, 0, 0]}>
                    {fiiDii5Day.map((entry, i) => <Cell key={i} fill={entry.DII >= 0 ? '#60a5fa' : '#fbbf24'} />)}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-[220px] text-sm text-slate-400">Loading FII/DII data...</div>
            )}
          </div>
        </div>
      </div>

      {/* 6. OI Change Heatmap */}
      {oiHeatmapData.length > 0 && (
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2">
            <BarChart3 className="w-4 h-4 text-teal-500" />
            OI Change Heatmap — Today's Build-up
          </h2>
          <p className="text-xs text-slate-400 mb-4">
            Live strikes near ATM with Open Interest changes. Green = bullish build-up, Red = bearish build-up.
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left text-slate-400 font-medium py-2 pr-4" />
                  <th colSpan={3} className="text-center text-blue-600 font-semibold py-2">CALL Side</th>
                  <th className="w-px" />
                  <th colSpan={3} className="text-center text-rose-500 font-semibold py-2">PUT Side</th>
                </tr>
                <tr className="border-b border-slate-100">
                  <th className="text-left text-slate-400 font-medium py-2 pr-4">Strike</th>
                  <th className="text-center text-slate-400 font-medium py-2 px-2">Total OI</th>
                  <th className="text-center text-slate-400 font-medium py-2 px-2">OI Change</th>
                  <th className="text-center text-slate-400 font-medium py-2 px-2">Buildup</th>
                  <th className="w-px bg-slate-100" />
                  <th className="text-center text-slate-400 font-medium py-2 px-2">Buildup</th>
                  <th className="text-center text-slate-400 font-medium py-2 px-2">OI Change</th>
                  <th className="text-center text-slate-400 font-medium py-2 px-2">Total OI</th>
                </tr>
              </thead>
              <tbody>
                {oiHeatmapData.map(row => (
                  <tr key={row.strike} className={`border-b border-slate-50 hover:bg-slate-50/50 transition-colors ${row.strike === atmStrike ? 'bg-amber-50/50' : ''}`}>
                    <td className="py-2 pr-4 font-semibold text-slate-700">
                      {row.strike.toLocaleString('en-IN')}
                      {row.strike === atmStrike && <span className="ml-1.5 text-[9px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">ATM</span>}
                      {row.strike === maxPainValue && <span className="ml-1.5 text-[9px] font-bold text-violet-600 bg-violet-50 px-1.5 py-0.5 rounded">MAX PAIN</span>}
                    </td>
                    <td className="text-center text-slate-500 py-2 px-2">{fmtNum(row.callOI)}</td>
                    <td className="py-2 px-2">
                      <div className={`text-center rounded-md py-1 px-2 font-semibold ${oiIntensity(row.callOIChange, maxOiChange)}`}>
                        {row.callOIChange > 0 ? '+' : ''}{fmtNum(row.callOIChange)}
                      </div>
                    </td>
                    <td className="text-center py-2 px-2">
                      {row.callBuildup && row.callBuildup !== 'No Conclusion' && (
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                          row.callBuildup.includes('Writing') || (row.callBuildup.includes('Short') && row.callBuildup.includes('Build'))
                            ? 'bg-red-50 text-red-600'
                            : row.callBuildup.includes('Long') && row.callBuildup.includes('Build')
                              ? 'bg-emerald-50 text-emerald-600'
                              : row.callBuildup.includes('Cover')
                                ? 'bg-blue-50 text-blue-600'
                                : 'bg-amber-50 text-amber-600'
                        }`}>{row.callBuildup}</span>
                      )}
                    </td>
                    <td className="w-px bg-slate-100" />
                    <td className="text-center py-2 px-2">
                      {row.putBuildup && row.putBuildup !== 'No Conclusion' && (
                        <span className={`text-[10px] font-semibold px-1.5 py-0.5 rounded ${
                          row.putBuildup.includes('Writing') || (row.putBuildup.includes('Short') && row.putBuildup.includes('Build'))
                            ? 'bg-red-50 text-red-600'
                            : row.putBuildup.includes('Long') && row.putBuildup.includes('Build')
                              ? 'bg-emerald-50 text-emerald-600'
                              : row.putBuildup.includes('Cover')
                                ? 'bg-blue-50 text-blue-600'
                                : 'bg-amber-50 text-amber-600'
                        }`}>{row.putBuildup}</span>
                      )}
                    </td>
                    <td className="py-2 px-2">
                      <div className={`text-center rounded-md py-1 px-2 font-semibold ${oiIntensity(row.putOIChange, maxOiChange)}`}>
                        {row.putOIChange > 0 ? '+' : ''}{fmtNum(row.putOIChange)}
                      </div>
                    </td>
                    <td className="text-center text-slate-500 py-2 px-2">{fmtNum(row.putOI)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-4 mt-4 text-[10px] text-slate-400">
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-200" /> OI Build-up</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-red-200" /> OI Unwinding</span>
            <span className="flex items-center gap-1"><span className="w-3 h-3 rounded bg-emerald-300" /> Heavy Build-up</span>
          </div>
        </div>
      )}

      {/* 7. Support / Resistance from OI */}
      {topPutOIStrike > 0 && topCallOIStrike > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-6">
          <div className="rounded-2xl border border-emerald-200/60 bg-gradient-to-br from-emerald-50/50 to-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <ArrowUpRight className="w-4 h-4 text-emerald-500" />
              <h3 className="text-sm font-semibold text-emerald-800">Support (Highest Put OI)</h3>
            </div>
            <p className="text-3xl font-bold text-emerald-700">{topPutOIStrike.toLocaleString('en-IN')}</p>
            <p className="text-xs text-emerald-500 mt-1">
              {spotPrice > 0 ? `${(spotPrice - topPutOIStrike).toFixed(0)} pts below spot (${((spotPrice - topPutOIStrike) / spotPrice * 100).toFixed(2)}%)` : ''}
            </p>
          </div>
          <div className="rounded-2xl border border-red-200/60 bg-gradient-to-br from-red-50/50 to-white p-5 shadow-sm">
            <div className="flex items-center gap-2 mb-2">
              <ArrowDownRight className="w-4 h-4 text-red-500" />
              <h3 className="text-sm font-semibold text-red-800">Resistance (Highest Call OI)</h3>
            </div>
            <p className="text-3xl font-bold text-red-700">{topCallOIStrike.toLocaleString('en-IN')}</p>
            <p className="text-xs text-red-500 mt-1">
              {spotPrice > 0 ? `${(topCallOIStrike - spotPrice).toFixed(0)} pts above spot (${((topCallOIStrike - spotPrice) / spotPrice * 100).toFixed(2)}%)` : ''}
            </p>
          </div>
        </div>
      )}
    </div>
  );
}
