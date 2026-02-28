import { useState, useEffect, useCallback } from 'react';
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
  PieChart as RPieChart,
  Pie,
} from 'recharts';
import { intelligenceApi } from '@/services/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

type IntelligenceTab = 'fii-dii' | 'options' | 'sectors' | 'events' | 'global';

const TABS: { id: IntelligenceTab; label: string; icon: typeof BarChart3 }[] = [
  { id: 'fii-dii', label: 'FII/DII', icon: BarChart3 },
  { id: 'options', label: 'Options', icon: Activity },
  { id: 'sectors', label: 'Sectors', icon: PieChart },
  { id: 'events', label: 'Events', icon: Calendar },
  { id: 'global', label: 'Global', icon: Globe },
];

function num(v: any): number {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v) || 0;
}

export default function IntelligenceDashboard() {
  const [activeTab, setActiveTab] = useState<IntelligenceTab>('fii-dii');

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-slate-900">Intelligence Dashboard</h1>

      <div className="flex gap-1 rounded-lg bg-slate-100 p-1">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors ${isActive
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

  const fetch = useCallback(async () => {
    setLoading(true);
    try {
      const [fiiRes, trendRes] = await Promise.all([
        intelligenceApi.fiiDii().catch(() => ({ data: null })),
        intelligenceApi.fiiDiiTrend(30).catch(() => ({ data: [] })),
      ]);
      setData(fiiRes.data);
      const trendArray = trendRes.data?.daily_flows ?? trendRes.data;
      setTrend(Array.isArray(trendArray) ? trendArray : []);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { fetch(); }, [fetch]);

  if (loading) return <LoadingSpinner />;

  const fiiNet = num(data?.fii?.net_value ?? data?.fii_net ?? data?.fiiNet);
  const diiNet = num(data?.dii?.net_value ?? data?.dii_net ?? data?.diiNet);
  const fiiBuy = num(data?.fii?.buy_value ?? data?.fii_buy ?? data?.fiiBuy);
  const fiiSell = num(data?.fii?.sell_value ?? data?.fii_sell ?? data?.fiiSell);
  const diiBuy = num(data?.dii?.buy_value ?? data?.dii_buy ?? data?.diiBuy);
  const diiSell = num(data?.dii?.sell_value ?? data?.dii_sell ?? data?.diiSell);

  const trendData = trend.map((d: any) => ({
    date: d.date ? new Date(d.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }) : '',
    fiiNet: num(d.fii_net ?? d.fiiNet),
    diiNet: num(d.dii_net ?? d.diiNet),
  }));

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h2 className="text-base font-semibold text-slate-800">FII/DII Flow Analysis</h2>
        <button onClick={fetch} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400">
          <RefreshCcw className="w-4 h-4" />
        </button>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <FlowCard label="FII Net" value={fiiNet} />
        <FlowCard label="DII Net" value={diiNet} />
        <FlowCard label="FII Buy" value={fiiBuy} positive />
        <FlowCard label="FII Sell" value={fiiSell} negative />
      </div>

      <div className="grid grid-cols-2 gap-4">
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">FII Activity</h3>
          <div className="space-y-2">
            <FlowBar label="Buy" value={fiiBuy} max={Math.max(fiiBuy, fiiSell, 1)} color="bg-emerald-500" />
            <FlowBar label="Sell" value={fiiSell} max={Math.max(fiiBuy, fiiSell, 1)} color="bg-red-500" />
          </div>
          <p className={`text-sm font-bold mt-3 ${fiiNet >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            Net: {fiiNet >= 0 ? '+' : ''}₹{(fiiNet / 100).toFixed(0)} Cr
          </p>
        </div>
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">DII Activity</h3>
          <div className="space-y-2">
            <FlowBar label="Buy" value={diiBuy} max={Math.max(diiBuy, diiSell, 1)} color="bg-emerald-500" />
            <FlowBar label="Sell" value={diiSell} max={Math.max(diiBuy, diiSell, 1)} color="bg-red-500" />
          </div>
          <p className={`text-sm font-bold mt-3 ${diiNet >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            Net: {diiNet >= 0 ? '+' : ''}₹{(diiNet / 100).toFixed(0)} Cr
          </p>
        </div>
      </div>

      {trendData.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Net FII vs DII — Last 30 Days</h3>
          <div className="h-[250px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={trendData}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${(v / 100).toFixed(0)}Cr`} />
                <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px' }} />
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

  useEffect(() => {
    setLoading(true);
    Promise.all([
      intelligenceApi.pcr(symbol).catch(() => ({ data: null })),
      intelligenceApi.maxPain(symbol).catch(() => ({ data: null })),
      intelligenceApi.oiHeatmap(symbol).catch(() => ({ data: null })),
      intelligenceApi.ivPercentile(symbol).catch(() => ({ data: null })),
    ]).then(([pcrRes, mpRes, oiRes, ivRes]) => {
      setPcr(pcrRes.data);
      setMaxPain(mpRes.data);
      setOiHeatmap(oiRes.data);
      setIvPercentile(ivRes.data);
    }).finally(() => setLoading(false));
  }, [symbol]);

  if (loading) return <LoadingSpinner />;

  const pcrValue = num(pcr?.pcr_oi ?? pcr?.pcr ?? pcr?.value);
  const maxPainValue = num(maxPain?.max_pain_strike ?? maxPain?.max_pain ?? maxPain?.maxPain);
  const ivValue = num(ivPercentile?.iv_percentile ?? ivPercentile?.ivPercentile);
  const heatmapDataSrc = oiHeatmap?.rows ?? oiHeatmap?.strikes ?? oiHeatmap?.data;
  const heatmapRows = Array.isArray(heatmapDataSrc) ? heatmapDataSrc : [];

  return (
    <div className="space-y-6">
      <div className="flex items-center gap-3">
        <h2 className="text-base font-semibold text-slate-800">Options Intelligence —</h2>
        <select
          value={symbol}
          onChange={(e) => setSymbol(e.target.value)}
          className="text-sm px-2 py-1 bg-slate-50 border border-slate-200 rounded text-slate-700"
        >
          <option value="NIFTY">NIFTY</option>
          <option value="BANKNIFTY">BANK NIFTY</option>
          <option value="FINNIFTY">FIN NIFTY</option>
          <option value="CRUDEOIL">CRUDE OIL (MCX)</option>
          <option value="GOLD">GOLD (MCX)</option>
          <option value="SILVER">SILVER (MCX)</option>
          <option value="USDINR">USDINR (CDS)</option>
        </select>
      </div>

      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <MetricBox label="Put-Call Ratio" value={pcrValue.toFixed(2)} color={pcrValue > 1 ? 'text-emerald-600' : 'text-red-600'} />
        <MetricBox label="Max Pain" value={`₹${maxPainValue.toLocaleString('en-IN')}`} color="text-indigo-600" />
        <MetricBox label="IV Percentile" value={`${ivValue.toFixed(0)}%`} color={ivValue > 50 ? 'text-red-600' : 'text-emerald-600'} />
        <MetricBox label="Sentiment" value={pcrValue > 1.2 ? 'Bullish' : pcrValue < 0.8 ? 'Bearish' : 'Neutral'} color={pcrValue > 1.2 ? 'text-emerald-600' : pcrValue < 0.8 ? 'text-red-600' : 'text-amber-600'} />
      </div>

      {heatmapRows.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Open Interest Heatmap</h3>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-200">
                  <th className="text-right pb-2 font-medium">Call OI</th>
                  <th className="text-right pb-2 font-medium">Call Chg</th>
                  <th className="text-center pb-2 font-medium">Strike</th>
                  <th className="text-left pb-2 font-medium">Put Chg</th>
                  <th className="text-left pb-2 font-medium">Put OI</th>
                </tr>
              </thead>
              <tbody>
                {heatmapRows.slice(0, 15).map((row: any, i: number) => (
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

  useEffect(() => {
    setLoading(true);
    Promise.all([
      intelligenceApi.sectorPerformance().catch(() => ({ data: [] })),
      intelligenceApi.sectorHeatmap().catch(() => ({ data: [] })),
    ]).then(([perfRes, heatRes]) => {
      setPerformance(Array.isArray(perfRes.data) ? perfRes.data : []);
      setHeatmap(Array.isArray(heatRes.data) ? heatRes.data : []);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  const SECTOR_COLORS = ['#4f46e5', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#ec4899', '#14b8a6', '#8b5cf6'];

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
      <h2 className="text-base font-semibold text-slate-800">Sector Analysis</h2>

      {perfData.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Sector Performance</h3>
          <div className="h-[300px]">
            <ResponsiveContainer width="100%" height="100%">
              <BarChart data={perfData} layout="vertical">
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis type="number" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} tickFormatter={(v) => `${v}%`} />
                <YAxis type="category" dataKey="name" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} width={120} />
                <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px' }} formatter={(v) => [`${Number(v).toFixed(2)}%`, 'Change']} />
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
        <EmptyState message="No sector data available" />
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
      <h2 className="text-base font-semibold text-slate-800">Market Events</h2>

      <div className="rounded-lg border border-slate-200 p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Earnings Calendar</h3>
        {earnings.length > 0 ? (
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="text-slate-400 border-b border-slate-200">
                  <th className="text-left pb-2 font-medium">Company</th>
                  <th className="text-left pb-2 font-medium">Date</th>
                  <th className="text-left pb-2 font-medium">Quarter</th>
                  <th className="text-right pb-2 font-medium">Est. Revenue</th>
                  <th className="text-right pb-2 font-medium">Est. EPS</th>
                </tr>
              </thead>
              <tbody>
                {earnings.slice(0, 20).map((e: any, i: number) => (
                  <tr key={i} className="border-b border-slate-100 hover:bg-slate-50/50">
                    <td className="py-2 font-medium text-slate-800">{e.symbol ?? e.company}</td>
                    <td className="py-2 text-slate-600">{e.date ? new Date(e.date).toLocaleDateString('en-IN') : '—'}</td>
                    <td className="py-2 text-slate-500">{e.quarter ?? '—'}</td>
                    <td className="py-2 text-right font-mono text-slate-600">{e.est_revenue ? `₹${num(e.est_revenue).toLocaleString('en-IN')}Cr` : '—'}</td>
                    <td className="py-2 text-right font-mono text-slate-600">{e.est_eps ? `₹${num(e.est_eps).toFixed(2)}` : '—'}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        ) : (
          <EmptyState message="No upcoming earnings" />
        )}
      </div>

      <div className="rounded-lg border border-slate-200 p-4">
        <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Economic & Macro Events</h3>
        {macroEvents.length > 0 ? (
          <div className="space-y-2">
            {macroEvents.slice(0, 15).map((evt: any, i: number) => {
              const impact = (evt.impact ?? 'medium').toLowerCase();
              const impactColor = impact === 'high' ? 'bg-red-100 text-red-700' : impact === 'medium' ? 'bg-amber-100 text-amber-700' : 'bg-slate-100 text-slate-600';
              return (
                <div key={i} className="flex items-center gap-3 py-2 border-b border-slate-100 last:border-0">
                  <div className="flex-1">
                    <p className="text-sm text-slate-800">{evt.event ?? evt.name}</p>
                    <p className="text-xs text-slate-400">{evt.date ? new Date(evt.date).toLocaleDateString('en-IN') : ''} {evt.country ? `· ${evt.country}` : ''}</p>
                  </div>
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${impactColor}`}>{impact.toUpperCase()}</span>
                </div>
              );
            })}
          </div>
        ) : (
          <EmptyState message="No upcoming events" />
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

  useEffect(() => {
    setLoading(true);
    Promise.all([
      intelligenceApi.globalIndices().catch(() => ({ data: [] })),
      intelligenceApi.fxRates().catch(() => ({ data: [] })),
      intelligenceApi.commodities().catch(() => ({ data: [] })),
    ]).then(([idxRes, fxRes, comRes]) => {
      setIndices(Array.isArray(idxRes.data) ? idxRes.data : []);
      setFx(Array.isArray(fxRes.data) ? fxRes.data : []);
      setCommodities(Array.isArray(comRes.data) ? comRes.data : []);
    }).finally(() => setLoading(false));
  }, []);

  if (loading) return <LoadingSpinner />;

  return (
    <div className="space-y-6">
      <h2 className="text-base font-semibold text-slate-800">Global Markets Overview</h2>

      {indices.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Global Indices</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {indices.map((idx: any, i: number) => {
              const change = num(idx.change ?? idx.changePercent ?? idx.change_pct);
              return (
                <div key={i} className="p-3 rounded-lg border border-slate-200 hover:border-slate-300 transition-colors">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs font-medium text-slate-500">{idx.name ?? idx.index}</span>
                    {change >= 0 ? <ArrowUpRight className="w-3.5 h-3.5 text-emerald-500" /> : <ArrowDownRight className="w-3.5 h-3.5 text-red-500" />}
                  </div>
                  <p className="text-sm font-bold font-mono text-slate-800">{num(idx.value ?? idx.last ?? idx.price).toLocaleString()}</p>
                  <p className={`text-xs font-mono ${change >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {commodities.length > 0 && (
        <div className="rounded-lg border border-slate-200 p-4">
          <h3 className="text-xs font-semibold text-slate-500 uppercase mb-3">Commodities</h3>
          <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3">
            {commodities.map((c: any, i: number) => {
              const change = num(c.change ?? c.changePercent ?? c.change_pct);
              return (
                <div key={i} className="p-3 rounded-lg border border-slate-200">
                  <span className="text-xs font-medium text-slate-500">{c.name ?? c.commodity}</span>
                  <p className="text-sm font-bold font-mono text-slate-800 mt-1">${num(c.price ?? c.value ?? c.last).toLocaleString()}</p>
                  <p className={`text-xs font-mono ${change >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {change >= 0 ? '+' : ''}{change.toFixed(2)}%
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
              const change = num(pair.change ?? pair.changePercent ?? pair.change_pct);
              return (
                <div key={i} className="p-3 rounded-lg border border-slate-200">
                  <span className="text-xs font-medium text-slate-500">{pair.pair ?? pair.name}</span>
                  <p className="text-sm font-bold font-mono text-slate-800 mt-1">{num(pair.rate ?? pair.value ?? pair.price).toFixed(4)}</p>
                  <p className={`text-xs font-mono ${change >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {change >= 0 ? '+' : ''}{change.toFixed(2)}%
                  </p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {indices.length === 0 && commodities.length === 0 && fx.length === 0 && (
        <EmptyState message="No global market data available" />
      )}
    </div>
  );
}

function FlowCard({ label, value, positive, negative }: { label: string; value: number; positive?: boolean; negative?: boolean }) {
  const color = positive ? 'text-emerald-600' : negative ? 'text-red-600' : value >= 0 ? 'text-emerald-600' : 'text-red-600';
  const Icon = value >= 0 ? TrendingUp : TrendingDown;
  return (
    <div className="rounded-lg border border-slate-200 p-3">
      <p className="text-[10px] text-slate-400 uppercase font-medium mb-1">{label}</p>
      <div className="flex items-center gap-1.5">
        <Icon className={`w-3.5 h-3.5 ${color}`} />
        <p className={`text-lg font-bold font-mono ${color}`}>
          ₹{Math.abs(value / 100).toFixed(0)} Cr
        </p>
      </div>
    </div>
  );
}

function FlowBar({ label, value, max, color }: { label: string; value: number; max: number; color: string }) {
  const pct = max > 0 ? (value / max) * 100 : 0;
  return (
    <div>
      <div className="flex items-center justify-between text-[10px] text-slate-500 mb-0.5">
        <span>{label}</span>
        <span className="font-mono">₹{(value / 100).toFixed(0)} Cr</span>
      </div>
      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
        <div className={`h-full ${color} rounded-full transition-all`} style={{ width: `${pct}%` }} />
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
