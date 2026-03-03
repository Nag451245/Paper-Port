import { useState, useEffect, useCallback, useRef } from 'react';
import {
  BarChart3,
  Activity,
  PieChart,
  Calendar,
  Globe,
  RefreshCcw,
  Loader2,
  TrendingUp,
  TrendingDown,
  ArrowUpRight,
  ArrowDownRight,
  AlertCircle,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import { intelligenceApi } from '@/services/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

type IntelligenceTab = 'fii-dii' | 'options' | 'sectors' | 'events' | 'global';

const TABS: { id: IntelligenceTab; label: string; icon: typeof BarChart3 }[] = [
  { id: 'fii-dii', label: 'Institutional Flow', icon: BarChart3 },
  { id: 'options', label: 'Derivatives', icon: Activity },
  { id: 'sectors', label: 'Sector Pulse', icon: PieChart },
  { id: 'events', label: 'Market Calendar', icon: Calendar },
  { id: 'global', label: 'World Markets', icon: Globe },
];

function num(v: any): number {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v) || 0;
}

function isIndianMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

const REFRESH_MARKET = 5_000;
const REFRESH_OFF = 3_600_000;

function useAutoRefresh(loadFn: () => void, enabled: boolean) {
  const fnRef = useRef(loadFn);
  fnRef.current = loadFn;

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout>;
    const schedule = () => {
      const interval = isIndianMarketOpen() ? REFRESH_MARKET : REFRESH_OFF;
      timer = setTimeout(() => {
        fnRef.current();
        schedule();
      }, interval);
    };
    schedule();
    return () => clearTimeout(timer);
  }, [enabled]);
}

export default function IntelligenceDashboard() {
  const [activeTab, setActiveTab] = useState<IntelligenceTab>('fii-dii');

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-slate-900">Market Intelligence</h1>

      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap ${isActive
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-400 hover:text-slate-600'
                }`}
            >
              <Icon className="h-4 w-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      <div className="rounded-xl border border-slate-200 bg-white p-6 shadow-sm">
        {activeTab === 'fii-dii' && <FIIDIITab />}
        {activeTab === 'options' && <OptionsTab />}
        {activeTab === 'sectors' && <SectorsTab />}
        {activeTab === 'events' && <EventsTab />}
        {activeTab === 'global' && <GlobalTab />}
      </div>
    </div>
  );
}

function FIIDIITab() {
  const [data, setData] = useState<any>(null);
  const [trend, setTrend] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [fiiRes, trendRes] = await Promise.all([
        intelligenceApi.fiiDii().catch(() => ({ data: null })),
        intelligenceApi.fiiDiiTrend(30).catch(() => ({ data: [] })),
      ]);
      setData(fiiRes.data);
      const trendArray = trendRes.data?.daily_flows ?? trendRes.data;
      setTrend(Array.isArray(trendArray) ? trendArray : []);
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, !loading);

  if (loading) return <LoadingSpinner />;

  const fiiNet = num(data?.fiiNet ?? data?.fii_net);
  const diiNet = num(data?.diiNet ?? data?.dii_net);
  const niftyPrice = num(data?.niftyPrice);
  const niftyChangePct = num(data?.niftyChangePct);
  const hasData = fiiNet !== 0 || diiNet !== 0;
  const message = data?.message;
  const date = data?.date ?? '';

  const trendData = trend.map((d: any) => ({
    date: d.date ? new Date(d.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }) : '',
    fiiNet: num(d.fii_net ?? d.fiiNet),
    diiNet: num(d.dii_net ?? d.diiNet),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-800">FII / DII Cash Market Activity</h2>
          <p className="text-xs text-slate-400 mt-0.5">
            Foreign & Domestic Institutional Investors — Daily net flows (₹ Cr)
            {date && <span className="ml-2 text-slate-500">· {new Date(date).toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' })}</span>}
          </p>
        </div>
        <RefreshButton onClick={load} lastUpdated={lastUpdated} />
      </div>

      {message && !hasData && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{message}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <FlowCard label="FII/FPI Net" value={fiiNet} />
        <FlowCard label="DII Net" value={diiNet} />
        {niftyPrice > 0 && (
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-[10px] text-slate-400 uppercase font-medium mb-1">NIFTY 50</p>
            <p className="text-lg font-bold font-mono text-slate-800">{niftyPrice.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</p>
          </div>
        )}
        {niftyPrice > 0 && (
          <div className="rounded-lg border border-slate-200 p-3">
            <p className="text-[10px] text-slate-400 uppercase font-medium mb-1">NIFTY Change</p>
            <div className="flex items-center gap-1.5">
              {niftyChangePct >= 0
                ? <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
                : <TrendingDown className="w-3.5 h-3.5 text-red-600" />}
              <p className={`text-lg font-bold font-mono ${niftyChangePct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {niftyChangePct >= 0 ? '+' : ''}{niftyChangePct.toFixed(2)}%
              </p>
            </div>
          </div>
        )}
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className={`rounded-lg border p-4 ${fiiNet >= 0 ? 'border-emerald-200 bg-emerald-50/30' : 'border-red-200 bg-red-50/30'}`}>
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">FII/FPI (Foreign Investors)</h3>
          <p className={`text-2xl font-bold font-mono ${fiiNet >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {fiiNet >= 0 ? '+' : ''}₹{Math.abs(fiiNet).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr
          </p>
          <p className="text-xs text-slate-400 mt-1">{fiiNet >= 0 ? 'Net Buyers — Bullish signal' : 'Net Sellers — Bearish pressure'}</p>
        </div>
        <div className={`rounded-lg border p-4 ${diiNet >= 0 ? 'border-emerald-200 bg-emerald-50/30' : 'border-red-200 bg-red-50/30'}`}>
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-2">DII (Domestic Investors)</h3>
          <p className={`text-2xl font-bold font-mono ${diiNet >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {diiNet >= 0 ? '+' : ''}₹{Math.abs(diiNet).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr
          </p>
          <p className="text-xs text-slate-400 mt-1">{diiNet >= 0 ? 'Net Buyers — Supporting market' : 'Net Sellers — Reducing exposure'}</p>
        </div>
      </div>

      {trendData.length > 1 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">FII vs DII Net Flow — Last {trendData.length} Sessions</h3>
          <div className="h-[280px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${Math.abs(v) >= 1000 ? `${(v / 1000).toFixed(0)}K` : v.toFixed(0)}Cr`} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px' }}
                  formatter={(v: any) => [`₹${Number(v).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr`]}
                />
                <Bar dataKey="fiiNet" name="FII Net" fill="#4f46e5" radius={[2, 2, 0, 0]} />
                <Bar dataKey="diiNet" name="DII Net" fill="#22c55e" radius={[2, 2, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}
    </div>
  );
}

function OptionsTab() {
  const [pcr, setPcr] = useState<any>(null);
  const [maxPain, setMaxPain] = useState<any>(null);
  const [oiHeatmap, setOiHeatmap] = useState<any>(null);
  const [ivPercentile, setIvPercentile] = useState<any>(null);
  const [loading, setLoading] = useState(true);
  const [symbol, setSymbol] = useState('NIFTY');
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [pcrRes, mpRes, oiRes, ivRes] = await Promise.all([
        intelligenceApi.pcr(symbol).catch(() => ({ data: null })),
        intelligenceApi.maxPain(symbol).catch(() => ({ data: null })),
        intelligenceApi.oiHeatmap(symbol).catch(() => ({ data: null })),
        intelligenceApi.ivPercentile(symbol).catch(() => ({ data: null })),
      ]);
      setPcr(pcrRes.data);
      setMaxPain(mpRes.data);
      setOiHeatmap(oiRes.data);
      setIvPercentile(ivRes.data);
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, [symbol]);

  useEffect(() => { setLoading(true); load(); }, [load]);
  useAutoRefresh(load, !loading);

  if (loading) return <LoadingSpinner />;

  const pcrValue = num(pcr?.pcr_oi ?? pcr?.pcr ?? pcr?.value);
  const pcrInterpretation = pcr?.interpretation ?? '';
  const maxPainValue = num(maxPain?.max_pain_strike ?? maxPain?.max_pain ?? maxPain?.maxPain);
  const ivValue = num(ivPercentile?.iv_percentile ?? ivPercentile?.ivPercentile);
  const heatmapDataSrc = oiHeatmap?.rows ?? oiHeatmap?.strikes ?? oiHeatmap?.data;
  const heatmapRows = Array.isArray(heatmapDataSrc) ? heatmapDataSrc : [];
  const hasOIData = heatmapRows.length > 0 || pcrValue > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <div>
          <h2 className="text-base font-semibold text-slate-800">Derivatives Analytics</h2>
          <p className="text-xs text-slate-400 mt-0.5">Options chain, PCR, Max Pain & IV analysis</p>
        </div>
        <div className="ml-auto flex items-center gap-2">
          <select
            value={symbol}
            onChange={(e) => setSymbol(e.target.value)}
            className="text-sm px-3 py-1.5 bg-slate-50 border border-slate-200 rounded-md text-slate-700"
          >
            <option value="NIFTY">NIFTY 50</option>
            <option value="BANKNIFTY">BANK NIFTY</option>
            <option value="FINNIFTY">FIN NIFTY</option>
          </select>
          <RefreshButton onClick={load} lastUpdated={lastUpdated} />
        </div>
      </div>

      {!hasOIData && (
        <div className="flex items-center gap-2 p-3 rounded-lg bg-amber-50 border border-amber-200 text-amber-700 text-xs">
          <AlertCircle className="w-4 h-4 flex-shrink-0" />
          <span>{pcrInterpretation || 'Options data requires Breeze API credentials. Configure them in Settings to see live data.'}</span>
        </div>
      )}

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricBox label="Put-Call Ratio (OI)" value={pcrValue > 0 ? pcrValue.toFixed(2) : '—'} color={pcrValue > 1 ? 'text-emerald-600' : pcrValue > 0 ? 'text-red-600' : 'text-slate-400'} />
        <MetricBox label="Max Pain Strike" value={maxPainValue > 0 ? `₹${maxPainValue.toLocaleString('en-IN')}` : '—'} color="text-indigo-600" />
        <MetricBox label="IV Percentile" value={ivValue > 0 ? `${ivValue.toFixed(0)}%` : '—'} color={ivValue > 50 ? 'text-red-600' : ivValue > 0 ? 'text-emerald-600' : 'text-slate-400'} />
        <MetricBox
          label="Market Sentiment"
          value={pcrValue > 1.2 ? 'Bullish' : pcrValue > 0 && pcrValue < 0.8 ? 'Bearish' : pcrValue > 0 ? 'Neutral' : '—'}
          color={pcrValue > 1.2 ? 'text-emerald-600' : pcrValue > 0 && pcrValue < 0.8 ? 'text-red-600' : pcrValue > 0 ? 'text-amber-600' : 'text-slate-400'}
        />
      </div>

      {heatmapRows.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Open Interest by Strike</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-200">
                  <th className="text-right pb-2 font-medium">Call OI</th>
                  <th className="text-right pb-2 font-medium">Call OI Chg</th>
                  <th className="text-center pb-2 font-medium">Strike</th>
                  <th className="text-left pb-2 font-medium">Put OI Chg</th>
                  <th className="text-left pb-2 font-medium">Put OI</th>
                </tr>
              </thead>
              <tbody>
                {heatmapRows.slice(0, 20).map((row: any, i: number) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50/50">
                    <td className="py-1.5 text-right font-mono text-slate-600">{num(row.call_oi ?? row.callOI).toLocaleString()}</td>
                    <td className={`py-1.5 text-right font-mono ${num(row.call_oi_change ?? row.callOIChange) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {num(row.call_oi_change ?? row.callOIChange).toLocaleString()}
                    </td>
                    <td className="py-1.5 text-center font-bold text-slate-800">{row.strike}</td>
                    <td className={`py-1.5 text-left font-mono ${num(row.put_oi_change ?? row.putOIChange) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {num(row.put_oi_change ?? row.putOIChange).toLocaleString()}
                    </td>
                    <td className="py-1.5 text-left font-mono text-slate-600">{num(row.put_oi ?? row.putOI).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}

function SectorsTab() {
  const [performance, setPerformance] = useState<any[]>([]);
  const [heatmap, setHeatmap] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [perfRes, heatRes] = await Promise.all([
        intelligenceApi.sectorPerformance().catch(() => ({ data: [] })),
        intelligenceApi.sectorHeatmap().catch(() => ({ data: [] })),
      ]);
      setPerformance(Array.isArray(perfRes.data) ? perfRes.data : []);
      setHeatmap(Array.isArray(heatRes.data) ? heatRes.data : []);
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, !loading);

  if (loading) return <LoadingSpinner />;

  const perfData = performance.map((s: any) => ({
    name: s.sector ?? s.name ?? 'Unknown',
    change: num(s.change ?? s.changePercent ?? s.change_pct),
  }));

  const heatmapData = heatmap.map((s: any) => ({
    name: s.sector ?? s.name ?? 'Unknown',
    value: Math.abs(num(s.change ?? s.changePercent ?? s.value)),
    change: num(s.change ?? s.changePercent),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-800">NSE Sector Performance</h2>
          <p className="text-xs text-slate-400 mt-0.5">Live Nifty sectoral indices — intraday change %</p>
        </div>
        <RefreshButton onClick={load} lastUpdated={lastUpdated} />
      </div>

      {perfData.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Today's Sector Movement</h3>
          <div className="h-[350px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={perfData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} tickFormatter={(v) => `${v}%`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#64748b' }} tickLine={false} width={130} />
                <Tooltip
                  contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px' }}
                  formatter={(v) => [`${Number(v).toFixed(2)}%`, 'Change']}
                />
                <Bar dataKey="change" radius={[0, 3, 3, 0]}>
                  {perfData.map((entry, i) => (
                    <Cell key={i} fill={entry.change >= 0 ? '#22c55e' : '#ef4444'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      )}

      {heatmapData.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Sector Heatmap</h3>
          <div className="grid grid-cols-3 sm:grid-cols-4 md:grid-cols-5 gap-2">
            {heatmapData.map((s, i) => (
              <div
                key={i}
                className="p-3 rounded-lg text-center text-white text-xs font-medium"
                style={{ backgroundColor: s.change >= 0 ? '#22c55e' : '#ef4444', opacity: 0.6 + Math.min(Math.abs(s.change) / 5, 0.4) }}
              >
                <p className="font-bold text-[10px]">{s.name}</p>
                <p className="text-sm font-bold mt-0.5">{s.change >= 0 ? '+' : ''}{s.change.toFixed(2)}%</p>
              </div>
            ))}
          </div>
        </div>
      )}

      {perfData.length === 0 && heatmapData.length === 0 && (
        <EmptyState message="Sector data unavailable — NSE API may be down or market is closed" />
      )}
    </div>
  );
}

function EventsTab() {
  const [earnings, setEarnings] = useState<any[]>([]);
  const [macroEvents, setMacroEvents] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    Promise.all([
      intelligenceApi.earningsCalendar().catch(() => ({ data: [] })),
      intelligenceApi.macroEvents().catch(() => ({ data: [] })),
    ]).then(([earningsRes, eventsRes]) => {
      setEarnings(Array.isArray(earningsRes.data) ? earningsRes.data : []);
      setMacroEvents(Array.isArray(eventsRes.data) ? eventsRes.data : []);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      <div>
        <h2 className="text-base font-semibold text-slate-800">Upcoming Events & Announcements</h2>
        <p className="text-xs text-slate-400 mt-0.5">Corporate actions, RBI policy, US Fed, and key data releases</p>
      </div>

      <div className="rounded-lg border border-slate-200 p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Economic & Policy Events</h3>
        {macroEvents.length > 0 ? (
          <div className="space-y-2">
            {macroEvents.slice(0, 15).map((evt: any, i: number) => {
              const impact = (evt.impact ?? 'medium').toLowerCase();
              const impactColor = impact === 'high' ? 'bg-red-100 text-red-700' : impact === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
              const eventDate = evt.date ? new Date(evt.date) : null;
              const isToday = eventDate && eventDate.toDateString() === new Date().toDateString();
              return (
                <div key={i} className={`flex items-center gap-3 py-2.5 px-2 border-b border-slate-100 last:border-0 rounded ${isToday ? 'bg-blue-50/50' : ''}`}>
                  <div className="flex-1">
                    <p className="text-sm text-slate-800 font-medium">{evt.event ?? evt.name}</p>
                    <p className="text-xs text-slate-400">
                      {eventDate ? eventDate.toLocaleDateString('en-IN', { weekday: 'short', month: 'short', day: 'numeric' }) : ''}
                      {evt.country ? ` · ${evt.country}` : ''}
                      {isToday && <span className="ml-1.5 text-blue-600 font-semibold">TODAY</span>}
                    </p>
                  </div>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${impactColor}`}>{impact.toUpperCase()}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState message="No upcoming macro events" />
        )}
      </div>

      <div className="rounded-lg border border-slate-200 p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Corporate Announcements (NSE)</h3>
        {earnings.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-200">
                  <th className="text-left pb-2 font-medium">Symbol</th>
                  <th className="text-left pb-2 font-medium">Date</th>
                  <th className="text-left pb-2 font-medium">Announcement</th>
                </tr>
              </thead>
              <tbody>
                {earnings.slice(0, 25).map((e: any, i: number) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50/50">
                    <td className="py-2 font-medium text-slate-800">{e.symbol ?? e.company}</td>
                    <td className="py-2 text-slate-600">{e.date ? new Date(e.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }) : '—'}</td>
                    <td className="py-2 text-slate-500 max-w-xs truncate">{e.description ?? e.quarter ?? '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="No corporate announcements available" />
        )}
      </div>
    </div>
  );
}

function GlobalTab() {
  const [indices, setIndices] = useState<any[]>([]);
  const [fx, setFx] = useState<any[]>([]);
  const [commodities, setCommodities] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);

  const load = useCallback(async () => {
    try {
      const [idxRes, fxRes, comRes] = await Promise.all([
        intelligenceApi.globalIndices().catch(() => ({ data: [] })),
        intelligenceApi.fxRates().catch(() => ({ data: [] })),
        intelligenceApi.commodities().catch(() => ({ data: [] })),
      ]);
      setIndices(Array.isArray(idxRes.data) ? idxRes.data : []);
      setFx(Array.isArray(fxRes.data) ? fxRes.data : []);
      setCommodities(Array.isArray(comRes.data) ? comRes.data : []);
      setLastUpdated(new Date());
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);
  useAutoRefresh(load, !loading);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h2 className="text-base font-semibold text-slate-800">World Markets Overview</h2>
          <p className="text-xs text-slate-400 mt-0.5">Live quotes — indices, currencies & commodities</p>
        </div>
        <RefreshButton onClick={load} lastUpdated={lastUpdated} />
      </div>

      {indices.length > 0 && (() => {
        const regions = new Map<string, any[]>();
        for (const idx of indices) {
          const region = idx.region ?? 'Other';
          if (!regions.has(region)) regions.set(region, []);
          regions.get(region)!.push(idx);
        }
        const regionOrder = ['India', 'US', 'UK', 'Europe', 'Japan', 'China/HK', 'China', 'Australia', 'South Korea', 'Singapore', 'Other'];
        const sortedRegions = [...regions.entries()].sort((a, b) => {
          const ai = regionOrder.indexOf(a[0]);
          const bi = regionOrder.indexOf(b[0]);
          return (ai === -1 ? 99 : ai) - (bi === -1 ? 99 : bi);
        });
        return sortedRegions.map(([region, items]) => (
          <div key={region} className="rounded-lg border border-slate-200 p-4">
            <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">{region}</h3>
            <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
              {items.map((idx: any, i: number) => {
                const absChange = num(idx.change);
                const pctChange = num(idx.changePercent);
                return (
                  <div key={i} className="p-3 rounded-lg border border-slate-200 hover:border-slate-300 transition-colors">
                    <div className="flex items-center justify-between mb-1">
                      <span className="text-xs font-medium text-slate-500">{idx.name ?? idx.index}</span>
                      {pctChange >= 0 ? <ArrowUpRight className="w-3.5 h-3.5 text-emerald-500" /> : <ArrowDownRight className="w-3.5 h-3.5 text-red-500" />}
                    </div>
                    <p className="text-sm font-bold font-mono text-slate-800">{num(idx.value).toLocaleString('en-IN', { maximumFractionDigits: 2 })}</p>
                    <p className={`text-xs font-mono ${pctChange >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {absChange >= 0 ? '+' : ''}{absChange.toFixed(2)} ({pctChange >= 0 ? '+' : ''}{pctChange.toFixed(2)}%)
                    </p>
                  </div>
                );
              })}
            </div>
          </div>
        ));
      })()}

      {commodities.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Commodities</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {commodities.map((c: any, i: number) => {
              const absChange = num(c.change);
              const pctChange = num(c.changePercent);
              return (
                <div key={i} className="p-3 rounded-lg border border-slate-200">
                  <span className="text-xs font-medium text-slate-500">{c.name ?? c.commodity}</span>
                  {c.unit && <span className="text-[10px] text-slate-300 ml-1">({c.unit})</span>}
                  <p className="text-sm font-bold font-mono text-slate-800 mt-1">${num(c.price ?? c.value ?? c.last).toLocaleString('en-US', { maximumFractionDigits: 2 })}</p>
                  <p className={`text-xs font-mono ${pctChange >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {absChange >= 0 ? '+' : ''}{absChange.toFixed(2)} ({pctChange >= 0 ? '+' : ''}{pctChange.toFixed(2)}%)
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {fx.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Currency Rates</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {fx.map((pair: any, i: number) => {
              const absChange = num(pair.change);
              const pctChange = num(pair.changePercent);
              return (
                <div key={i} className="p-3 rounded-lg border border-slate-200">
                  <span className="text-xs font-medium text-slate-500">{pair.pair ?? pair.name}</span>
                  <p className="text-sm font-bold font-mono text-slate-800 mt-1">{num(pair.rate ?? pair.value ?? pair.price).toFixed(4)}</p>
                  <p className={`text-xs font-mono ${pctChange >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {absChange >= 0 ? '+' : ''}{absChange.toFixed(4)} ({pctChange >= 0 ? '+' : ''}{pctChange.toFixed(2)}%)
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {indices.length === 0 && commodities.length === 0 && fx.length === 0 && (
        <EmptyState message="Market data temporarily unavailable — Yahoo Finance may be unreachable" />
      )}
    </div>
  );
}

function FlowCard({ label, value }: { label: string; value: number; positive?: boolean; negative?: boolean }) {
  const color = value >= 0 ? 'text-emerald-600' : 'text-red-600';
  const Icon = value >= 0 ? TrendingUp : TrendingDown;
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-[10px] text-slate-400 uppercase font-medium mb-1">{label}</p>
      <div className="flex items-center gap-1.5">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <p className={`text-lg font-bold font-mono ${color}`}>
          {value >= 0 ? '+' : ''}₹{Math.abs(value).toLocaleString('en-IN', { maximumFractionDigits: 0 })} Cr
        </p>
      </div>
    </div>
  );
}

function MetricBox({ label, value, color }: { label: string; value: string; color: string }) {
  return (
    <div className="rounded-lg border border-slate-200 p-3 text-center">
      <p className="text-[10px] text-slate-400 uppercase font-medium mb-1">{label}</p>
      <p className={`text-lg font-bold ${color}`}>{value}</p>
    </div>
  );
}

function RefreshButton({ onClick, lastUpdated }: { onClick: () => void; lastUpdated: Date | null }) {
  const [, setTick] = useState(0);
  useEffect(() => {
    const t = setInterval(() => setTick(n => n + 1), 5000);
    return () => clearInterval(t);
  }, []);
  const ago = lastUpdated ? Math.round((Date.now() - lastUpdated.getTime()) / 1000) : null;
  const label = ago !== null ? (ago < 10 ? 'just now' : ago < 60 ? `${ago}s ago` : `${Math.floor(ago / 60)}m ago`) : '';
  const live = isIndianMarketOpen();
  return (
    <div className="flex items-center gap-2">
      {live && <span className="flex items-center gap-1 text-[10px] text-emerald-600 font-semibold"><span className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />LIVE</span>}
      {label && <span className="text-[10px] text-slate-400">{label}</span>}
      <button onClick={onClick} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400">
        <RefreshCcw className="w-4 h-4" />
      </button>
    </div>
  );
}

function LoadingSpinner() {
  return (
    <div className="flex items-center justify-center py-16">
      <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex items-center justify-center py-10 rounded-lg border border-dashed border-slate-300 bg-slate-50">
      <p className="text-sm text-slate-400">{message}</p>
    </div>
  );
}
