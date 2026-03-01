import { useState, useMemo } from 'react';
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

// ─── Simulated Market Data ───────────────────────────────────────────────────

const NIFTY_SPOT = 24_285.55;
const BANKNIFTY_SPOT = 51_430.20;
const INDIA_VIX = 13.42;
const OVERALL_PCR = 0.85;

const marketCards = [
  {
    label: 'NIFTY 50',
    value: NIFTY_SPOT.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
    change: +0.38,
    points: '+92.15',
    icon: TrendingUp,
    accent: 'emerald',
  },
  {
    label: 'BANK NIFTY',
    value: BANKNIFTY_SPOT.toLocaleString('en-IN', { minimumFractionDigits: 2 }),
    change: -0.12,
    points: '-61.80',
    icon: TrendingDown,
    accent: 'red',
  },
  {
    label: 'India VIX',
    value: INDIA_VIX.toFixed(2),
    change: +7.83,
    points: '+0.97',
    icon: Activity,
    accent: 'amber',
  },
  {
    label: 'Overall PCR',
    value: OVERALL_PCR.toFixed(2),
    change: -3.41,
    points: '-0.03',
    icon: Gauge,
    accent: 'sky',
  },
];

// ─── IV Surface Data ─────────────────────────────────────────────────────────

const ivStrikes = [24000, 24100, 24200, 24300, 24400, 24500, 24600];
const ivExpiries = ['06 Mar', '13 Mar', '27 Mar', '24 Apr'];
const ivSurface: number[][] = [
  [18.2, 15.8, 13.1, 12.4, 13.5, 16.1, 19.0],
  [17.5, 14.9, 12.8, 11.9, 12.7, 15.3, 17.8],
  [16.1, 14.2, 12.5, 11.5, 12.2, 14.0, 16.5],
  [15.0, 13.8, 12.2, 11.2, 12.0, 13.5, 15.8],
];
const IV_PERCENTILE = 72;

// ─── Expiry Analysis Data ────────────────────────────────────────────────────

const expiryData = {
  dte: 5,
  expiryDate: '06 Mar 2026',
  ivCrush: 68,
  gammaRisk: 82,
  pinRisk: 45,
  maxPain: 24300,
};

// ─── FII/DII Flow Data ──────────────────────────────────────────────────────

const fiiDiiToday = { fii: -2310, dii: 1870 };
const fiiDii5Day = [
  { day: 'Mon', FII: -1200, DII: 980 },
  { day: 'Tue', FII: 450, DII: -320 },
  { day: 'Wed', FII: -890, DII: 1100 },
  { day: 'Thu', FII: -1750, DII: 1450 },
  { day: 'Fri', FII: -2310, DII: 1870 },
];

// ─── OI Change Data ─────────────────────────────────────────────────────────

const oiStrikes = [24000, 24100, 24200, 24300, 24400, 24500, 24600];
const oiChangeData = [
  { strike: 24000, callOI: 12500, putOI: 45200, callChange: -3200, putChange: 18400 },
  { strike: 24100, callOI: 18900, putOI: 38700, callChange: 5600, putChange: 12100 },
  { strike: 24200, callOI: 31200, putOI: 29400, callChange: 8900, putChange: 7600 },
  { strike: 24300, callOI: 52100, putOI: 48300, callChange: 22400, putChange: 19800 },
  { strike: 24400, callOI: 44600, putOI: 21800, callChange: 15200, putChange: -4500 },
  { strike: 24500, callOI: 38200, putOI: 14300, callChange: 11800, putChange: -2100 },
  { strike: 24600, callOI: 28700, putOI: 9100, callChange: 7400, putChange: -5600 },
];

// ─── Narrative ───────────────────────────────────────────────────────────────

const marketNarrative =
  'Markets opened flat but VIX spiked 8% suggesting nervousness ahead of RBI policy. ' +
  'FII sold ₹2,310 Cr in index futures — biggest selling in 2 weeks. ' +
  'Nifty PCR at 0.85 is mildly bearish with heavy call writing at 24300–24500. ' +
  'Consider defensive strategies like Iron Condors or wait for clarity post-event.';

// ─── Helpers ─────────────────────────────────────────────────────────────────

function ivColor(iv: number): string {
  if (iv <= 12) return 'bg-blue-100 text-blue-800';
  if (iv <= 13) return 'bg-blue-200 text-blue-900';
  if (iv <= 14) return 'bg-sky-200 text-sky-900';
  if (iv <= 15) return 'bg-yellow-100 text-yellow-800';
  if (iv <= 16) return 'bg-amber-200 text-amber-900';
  if (iv <= 17) return 'bg-orange-200 text-orange-900';
  return 'bg-red-200 text-red-900';
}

function oiIntensity(value: number, max: number): string {
  const ratio = Math.abs(value) / max;
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
        <div
          className={`h-full rounded-full transition-all duration-700 ${color}`}
          style={{ width: `${value}%` }}
        />
      </div>
    </div>
  );
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function FnOAnalytics() {
  const [selectedIndex] = useState<'NIFTY' | 'BANKNIFTY'>('NIFTY');

  const maxOiChange = useMemo(
    () => Math.max(...oiChangeData.flatMap((r) => [Math.abs(r.callChange), Math.abs(r.putChange)])),
    [],
  );

  return (
    <div className="space-y-6 pb-8">
      {/* Page header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-800 flex items-center gap-2">
            <BarChart3 className="w-7 h-7 text-teal-600" />
            F&O Analytics
          </h1>
          <p className="text-sm text-slate-500 mt-0.5">
            Real-time derivatives intelligence for {selectedIndex}
          </p>
        </div>
        <div className="flex items-center gap-2">
          <span className="relative flex h-2.5 w-2.5">
            <span className="animate-ping absolute inline-flex h-full w-full rounded-full bg-emerald-400 opacity-75" />
            <span className="relative inline-flex rounded-full h-2.5 w-2.5 bg-emerald-500" />
          </span>
          <span className="text-xs text-slate-400 font-medium">Live • Simulated Data</span>
        </div>
      </div>

      {/* ── 1. Market Pulse ─────────────────────────────────────────────── */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        {marketCards.map((c) => {
          const isUp = c.change >= 0;
          const accentMap: Record<string, string> = {
            emerald: 'from-emerald-500/10 to-emerald-500/5 border-emerald-200/60',
            red: 'from-red-500/10 to-red-500/5 border-red-200/60',
            amber: 'from-amber-500/10 to-amber-500/5 border-amber-200/60',
            sky: 'from-sky-500/10 to-sky-500/5 border-sky-200/60',
          };
          return (
            <div
              key={c.label}
              className={`relative rounded-2xl border bg-gradient-to-br ${accentMap[c.accent]} p-4 shadow-sm overflow-hidden`}
            >
              <div className="flex items-center justify-between mb-2">
                <span className="text-xs font-semibold text-slate-500 uppercase tracking-wide">
                  {c.label}
                </span>
                <c.icon className={`w-4 h-4 ${isUp ? 'text-emerald-500' : 'text-red-500'}`} />
              </div>
              <p className="text-2xl font-bold text-slate-800">{c.value}</p>
              <div className="flex items-center gap-1.5 mt-1">
                {isUp ? (
                  <ArrowUpRight className="w-3.5 h-3.5 text-emerald-500" />
                ) : (
                  <ArrowDownRight className="w-3.5 h-3.5 text-red-500" />
                )}
                <span className={`text-xs font-semibold ${isUp ? 'text-emerald-600' : 'text-red-600'}`}>
                  {c.points} ({isUp ? '+' : ''}{c.change}%)
                </span>
              </div>
            </div>
          );
        })}
      </div>

      {/* ── 2. IV Surface + IV Percentile ──────────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-3 gap-6">
        <div className="xl:col-span-2 rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Flame className="w-4 h-4 text-orange-500" />
            Implied Volatility Surface — {selectedIndex}
          </h2>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr>
                  <th className="text-left text-slate-400 font-medium pb-2 pr-3">Expiry ↓ / Strike →</th>
                  {ivStrikes.map((s) => (
                    <th key={s} className="text-center text-slate-500 font-medium pb-2 px-1">
                      {s}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {ivExpiries.map((exp, ei) => (
                  <tr key={exp}>
                    <td className="text-slate-600 font-medium py-1 pr-3 whitespace-nowrap">{exp}</td>
                    {ivSurface[ei].map((iv, si) => (
                      <td key={si} className="px-1 py-1">
                        <div
                          className={`rounded-lg text-center py-1.5 font-semibold ${ivColor(iv)}`}
                        >
                          {iv.toFixed(1)}
                        </div>
                      </td>
                    ))}
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
          <div className="flex items-center gap-2 mt-3 text-[10px] text-slate-400">
            <span className="px-2 py-0.5 rounded bg-blue-100">Low IV</span>
            <span className="px-2 py-0.5 rounded bg-yellow-100">Medium</span>
            <span className="px-2 py-0.5 rounded bg-red-200">High IV</span>
          </div>
        </div>

        {/* IV Percentile gauge */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5 flex flex-col justify-between">
          <div>
            <h2 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2">
              <Gauge className="w-4 h-4 text-sky-500" />
              IV Percentile
            </h2>
            <p className="text-xs text-slate-400 mb-5">Where current IV sits vs. last 252 sessions</p>
          </div>
          <div className="space-y-3">
            <div className="relative h-5 bg-gradient-to-r from-emerald-200 via-yellow-200 to-red-300 rounded-full overflow-hidden">
              <div
                className="absolute top-0 bottom-0 w-1 bg-slate-800 rounded-full shadow-md"
                style={{ left: `${IV_PERCENTILE}%` }}
              />
            </div>
            <div className="flex justify-between text-[10px] text-slate-400">
              <span>0%</span>
              <span>50%</span>
              <span>100%</span>
            </div>
            <p className="text-3xl font-bold text-slate-800 text-center">{IV_PERCENTILE}%</p>
          </div>
          <div className="mt-4 p-3 rounded-xl bg-sky-50 border border-sky-100">
            <p className="text-xs text-sky-700 leading-relaxed">
              <Info className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
              Current IV is cheaper than <strong>{IV_PERCENTILE}%</strong> of the last year — good
              time to <strong>buy options</strong>. Historically, IV tends to mean-revert from these levels.
            </p>
          </div>
        </div>
      </div>

      {/* ── 3. Expiry Analysis + 5. Market Narrative ───────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
        {/* Expiry Analysis */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
          <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Clock className="w-4 h-4 text-violet-500" />
            Expiry Analysis — {expiryData.expiryDate}
          </h2>

          <div className="grid grid-cols-2 gap-4 mb-5">
            <div className="rounded-xl bg-violet-50 border border-violet-100 p-3 text-center">
              <p className="text-3xl font-bold text-violet-700">{expiryData.dte}</p>
              <p className="text-xs text-violet-500 font-medium mt-0.5">Days to Expiry</p>
            </div>
            <div className="rounded-xl bg-amber-50 border border-amber-100 p-3 text-center">
              <p className="text-3xl font-bold text-amber-700">₹{expiryData.maxPain.toLocaleString('en-IN')}</p>
              <p className="text-xs text-amber-500 font-medium mt-0.5">Max Pain Strike</p>
            </div>
          </div>

          <div className="space-y-4">
            <div>
              <MeterBar value={expiryData.ivCrush} color="bg-gradient-to-r from-orange-400 to-red-500" label="IV Crush Probability" />
              <p className="text-[11px] text-slate-400 mt-1">
                <Zap className="w-3 h-3 inline mr-0.5 -mt-0.5 text-orange-400" />
                IV typically drops ~{expiryData.ivCrush}% post-event. Selling options before event captures this premium decay.
              </p>
            </div>
            <div>
              <MeterBar value={expiryData.gammaRisk} color="bg-gradient-to-r from-purple-400 to-pink-500" label="Gamma Risk" />
              <p className="text-[11px] text-slate-400 mt-1">
                <Zap className="w-3 h-3 inline mr-0.5 -mt-0.5 text-purple-400" />
                High gamma — delta changes rapidly. ATM options can swing ±₹15-20 per ₹100 move in underlying.
              </p>
            </div>
            <div>
              <MeterBar value={expiryData.pinRisk} color="bg-gradient-to-r from-sky-400 to-blue-500" label="Pin Risk (Max Pain)" />
              <p className="text-[11px] text-slate-400 mt-1">
                <Target className="w-3 h-3 inline mr-0.5 -mt-0.5 text-sky-400" />
                Moderate chance price gravitates to ₹{expiryData.maxPain.toLocaleString('en-IN')} by expiry where most options expire worthless.
              </p>
            </div>
          </div>
        </div>

        {/* Market Forces Narrative */}
        <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5 flex flex-col">
          <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
            <Brain className="w-4 h-4 text-pink-500" />
            Today's Market Story
            <span className="ml-auto text-[10px] font-medium text-pink-500 bg-pink-50 px-2 py-0.5 rounded-full">
              AI Synthesis
            </span>
          </h2>
          <div className="flex-1 rounded-xl bg-gradient-to-br from-slate-50 to-pink-50/40 border border-slate-100 p-4">
            <p className="text-sm text-slate-700 leading-relaxed">{marketNarrative}</p>
          </div>
          <div className="mt-4 grid grid-cols-3 gap-3">
            {[
              { label: 'Sentiment', value: 'Cautious', color: 'text-amber-600 bg-amber-50', icon: Shield },
              { label: 'Volatility', value: 'Rising', color: 'text-red-600 bg-red-50', icon: Activity },
              { label: 'Bias', value: 'Neutral-Bear', color: 'text-slate-600 bg-slate-100', icon: TrendingDown },
            ].map((tag) => (
              <div key={tag.label} className={`rounded-lg p-2.5 text-center ${tag.color}`}>
                <tag.icon className="w-4 h-4 mx-auto mb-1" />
                <p className="text-[10px] font-medium opacity-70">{tag.label}</p>
                <p className="text-xs font-bold">{tag.value}</p>
              </div>
            ))}
          </div>
        </div>
      </div>

      {/* ── 4. FII/DII Flows ───────────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
          <TrendingUp className="w-4 h-4 text-indigo-500" />
          FII / DII F&O Activity
        </h2>
        <div className="grid grid-cols-1 lg:grid-cols-3 gap-6">
          {/* Today's snapshot */}
          <div className="space-y-3">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Today's Net Flow</h3>
            <div className="rounded-xl border border-red-100 bg-red-50/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">FII (Index Futures)</span>
                <span className="text-sm font-bold text-red-600">
                  -₹{Math.abs(fiiDiiToday.fii).toLocaleString('en-IN')} Cr
                </span>
              </div>
              <p className="text-[11px] text-red-500 mt-1">Net sellers — bearish institutional flow</p>
            </div>
            <div className="rounded-xl border border-emerald-100 bg-emerald-50/60 p-3">
              <div className="flex items-center justify-between">
                <span className="text-xs font-medium text-slate-600">DII (Index Futures)</span>
                <span className="text-sm font-bold text-emerald-600">
                  +₹{fiiDiiToday.dii.toLocaleString('en-IN')} Cr
                </span>
              </div>
              <p className="text-[11px] text-emerald-500 mt-1">Net buyers — domestic support continues</p>
            </div>
            <div className="p-3 rounded-xl bg-indigo-50 border border-indigo-100">
              <p className="text-xs text-indigo-700 leading-relaxed">
                <Info className="w-3.5 h-3.5 inline mr-1 -mt-0.5" />
                FII buying index futures aggressively on the sell side — bearish institutional sentiment.
                DII providing contra support but net flow remains negative.
              </p>
            </div>
          </div>

          {/* 5-Day Trend Chart */}
          <div className="lg:col-span-2">
            <h3 className="text-xs font-semibold text-slate-500 uppercase tracking-wide mb-3">
              5-Day Trend (₹ Cr)
            </h3>
            <ResponsiveContainer width="100%" height={220}>
              <BarChart data={fiiDii5Day} barGap={4}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="day" tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <YAxis tick={{ fontSize: 11, fill: '#94a3b8' }} />
                <Tooltip
                  contentStyle={{
                    borderRadius: '12px',
                    border: '1px solid #e2e8f0',
                    fontSize: '12px',
                    boxShadow: '0 4px 12px rgba(0,0,0,0.08)',
                  }}
                  formatter={(val: number) => [`₹${val.toLocaleString('en-IN')} Cr`]}
                />
                <Legend iconType="circle" wrapperStyle={{ fontSize: '11px' }} />
                <Bar dataKey="FII" radius={[6, 6, 0, 0]}>
                  {fiiDii5Day.map((entry, i) => (
                    <Cell key={i} fill={entry.FII >= 0 ? '#34d399' : '#f87171'} />
                  ))}
                </Bar>
                <Bar dataKey="DII" radius={[6, 6, 0, 0]}>
                  {fiiDii5Day.map((entry, i) => (
                    <Cell key={i} fill={entry.DII >= 0 ? '#60a5fa' : '#fbbf24'} />
                  ))}
                </Bar>
              </BarChart>
            </ResponsiveContainer>
          </div>
        </div>
      </div>

      {/* ── 6. OI Change Heatmap ───────────────────────────────────────── */}
      <div className="rounded-2xl border border-slate-200/60 bg-white shadow-sm p-5">
        <h2 className="text-sm font-semibold text-slate-700 mb-1 flex items-center gap-2">
          <BarChart3 className="w-4 h-4 text-teal-500" />
          OI Change Heatmap — Today's Build-up
        </h2>
        <p className="text-xs text-slate-400 mb-4">
          Strikes with highest Open Interest additions today. Green = bullish build-up, Red = bearish build-up.
        </p>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="border-b border-slate-100">
                <th className="text-left text-slate-400 font-medium py-2 pr-4" />
                <th colSpan={2} className="text-center text-emerald-600 font-semibold py-2">
                  CALL Side
                </th>
                <th className="w-px" />
                <th colSpan={2} className="text-center text-red-500 font-semibold py-2">
                  PUT Side
                </th>
              </tr>
              <tr className="border-b border-slate-100">
                <th className="text-left text-slate-400 font-medium py-2 pr-4">Strike</th>
                <th className="text-center text-slate-400 font-medium py-2 px-3">Total OI</th>
                <th className="text-center text-slate-400 font-medium py-2 px-3">OI Change</th>
                <th className="w-px bg-slate-100" />
                <th className="text-center text-slate-400 font-medium py-2 px-3">OI Change</th>
                <th className="text-center text-slate-400 font-medium py-2 px-3">Total OI</th>
              </tr>
            </thead>
            <tbody>
              {oiChangeData.map((row) => (
                <tr key={row.strike} className="border-b border-slate-50 hover:bg-slate-50/50 transition-colors">
                  <td className="py-2 pr-4 font-semibold text-slate-700">
                    {row.strike}
                    {row.strike === expiryData.maxPain && (
                      <span className="ml-1.5 text-[9px] font-bold text-amber-600 bg-amber-50 px-1.5 py-0.5 rounded">
                        MAX PAIN
                      </span>
                    )}
                  </td>
                  <td className="text-center text-slate-500 py-2 px-3">
                    {(row.callOI / 1000).toFixed(1)}K
                  </td>
                  <td className="py-2 px-3">
                    <div
                      className={`text-center rounded-md py-1 px-2 font-semibold ${oiIntensity(row.callChange, maxOiChange)}`}
                    >
                      {row.callChange > 0 ? '+' : ''}
                      {(row.callChange / 1000).toFixed(1)}K
                    </div>
                  </td>
                  <td className="w-px bg-slate-100" />
                  <td className="py-2 px-3">
                    <div
                      className={`text-center rounded-md py-1 px-2 font-semibold ${oiIntensity(row.putChange, maxOiChange)}`}
                    >
                      {row.putChange > 0 ? '+' : ''}
                      {(row.putChange / 1000).toFixed(1)}K
                    </div>
                  </td>
                  <td className="text-center text-slate-500 py-2 px-3">
                    {(row.putOI / 1000).toFixed(1)}K
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        <div className="flex items-center gap-4 mt-4 text-[10px] text-slate-400">
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-emerald-200" /> Call OI Build-up (bearish)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-red-200" /> Put OI Build-up (bullish)
          </span>
          <span className="flex items-center gap-1">
            <span className="w-3 h-3 rounded bg-emerald-300" /> Heavy Build-up
          </span>
        </div>
      </div>
    </div>
  );
}
