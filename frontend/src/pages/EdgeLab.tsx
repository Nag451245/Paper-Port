import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  XAxis, YAxis, CartesianGrid, Tooltip, ResponsiveContainer,
  BarChart, Bar, PieChart, Pie, Cell, AreaChart, Area,
} from 'recharts';
import {
  Rocket, TrendingUp, Shield, Activity, Gauge, BarChart3,
  PieChart as PieIcon, Target, Zap, AlertTriangle,
} from 'lucide-react';
import { edgeApi } from '@/services/api';

const TABS = [
  { id: 'track-record', label: 'Track Record', icon: TrendingUp },
  { id: 'sentiment', label: 'Sentiment', icon: Activity },
  { id: 'composition', label: 'Strategy Weights', icon: PieIcon },
  { id: 'advanced', label: 'VWAP & Flow', icon: BarChart3 },
] as const;

type TabId = typeof TABS[number]['id'];

const COLORS = ['#10b981', '#3b82f6', '#f59e0b', '#ef4444', '#8b5cf6', '#ec4899', '#14b8a6', '#f97316'];

function StatCard({ label, value, sub, color = 'emerald' }: { label: string; value: string | number; sub?: string; color?: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm">
      <p className="text-xs font-medium text-slate-400 uppercase tracking-wide">{label}</p>
      <p className={`text-2xl font-bold text-${color}-600 mt-1`}>{value}</p>
      {sub && <p className="text-xs text-slate-400 mt-0.5">{sub}</p>}
    </div>
  );
}

function TrackRecordPanel() {
  const { data, isLoading } = useQuery({ queryKey: ['track-record'], queryFn: () => edgeApi.getTrackRecord() });
  const record = data as any;

  if (isLoading) return <LoadingSkeleton />;
  if (!record?.summary) return <EmptyState message="No trade history yet. Start trading to build your track record." />;

  const s = record.summary;
  const timeline = record.timeline ?? [];
  const strategyEntries = Object.entries(record.byStrategy ?? {}) as [string, any][];

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Return" value={`${s.totalReturn > 0 ? '+' : ''}${s.totalReturn}%`} color={s.totalReturn >= 0 ? 'emerald' : 'red'} />
        <StatCard label="Win Rate" value={`${s.winRate}%`} sub={`${s.totalTrades} trades`} />
        <StatCard label="Profit Factor" value={s.profitFactor} color={s.profitFactor >= 1.5 ? 'emerald' : s.profitFactor >= 1 ? 'amber' : 'red'} />
        <StatCard label="Max Drawdown" value={`${s.maxDrawdown}%`} color={s.maxDrawdown < 10 ? 'emerald' : 'red'} />
      </div>

      <div className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm">
        <h3 className="text-sm font-semibold text-slate-700 mb-4">Cumulative P&L Timeline</h3>
        <ResponsiveContainer width="100%" height={300}>
          <AreaChart data={timeline}>
            <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
            <XAxis dataKey="date" tick={{ fontSize: 11 }} />
            <YAxis tick={{ fontSize: 11 }} />
            <Tooltip formatter={(v: number | undefined) => [`₹${(v ?? 0).toFixed(0)}`, 'Cumulative P&L']} />
            <defs>
              <linearGradient id="pnlGrad" x1="0" y1="0" x2="0" y2="1">
                <stop offset="5%" stopColor="#10b981" stopOpacity={0.3} />
                <stop offset="95%" stopColor="#10b981" stopOpacity={0} />
              </linearGradient>
            </defs>
            <Area type="monotone" dataKey="cumPnl" stroke="#10b981" fill="url(#pnlGrad)" strokeWidth={2} />
          </AreaChart>
        </ResponsiveContainer>
      </div>

      {strategyEntries.length > 0 && (
        <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
          <div className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">P&L by Strategy</h3>
            <ResponsiveContainer width="100%" height={250}>
              <BarChart data={strategyEntries.map(([name, v]) => ({ name, pnl: v.pnl, winRate: v.winRate }))}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="name" tick={{ fontSize: 10 }} />
                <YAxis tick={{ fontSize: 11 }} />
                <Tooltip />
                <Bar dataKey="pnl" fill="#3b82f6" radius={[4, 4, 0, 0]} />
              </BarChart>
            </ResponsiveContainer>
          </div>
          <div className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm">
            <h3 className="text-sm font-semibold text-slate-700 mb-4">Capital Breakdown</h3>
            <div className="flex items-center gap-2 mb-2 text-sm text-slate-500">
              <span>Initial: ₹{s.initialCapital?.toLocaleString()}</span>
              <span className="text-slate-300">|</span>
              <span className={s.currentNav >= s.initialCapital ? 'text-emerald-600' : 'text-red-600'}>
                Current: ₹{s.currentNav?.toLocaleString()}
              </span>
            </div>
            <div className="space-y-2 mt-4">
              {strategyEntries.map(([name, v]: [string, any], i: number) => (
                <div key={name} className="flex items-center gap-3">
                  <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                  <span className="text-sm text-slate-600 flex-1">{name}</span>
                  <span className={`text-sm font-medium ${v.pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    ₹{v.pnl?.toLocaleString()}
                  </span>
                  <span className="text-xs text-slate-400">{v.winRate}% WR</span>
                </div>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SentimentPanel() {
  const { data, isLoading } = useQuery({ queryKey: ['sentiment'], queryFn: () => edgeApi.getSentiment(), refetchInterval: 300_000 });
  const snap = data as any;

  if (isLoading) return <LoadingSkeleton />;
  if (!snap) return <EmptyState message="Sentiment data unavailable." />;

  const fgColor = snap.fearGreedIndex > 60 ? '#10b981' : snap.fearGreedIndex < 40 ? '#ef4444' : '#f59e0b';
  const fgLabel = snap.fearGreedIndex > 70 ? 'Extreme Greed' : snap.fearGreedIndex > 55 ? 'Greed' : snap.fearGreedIndex > 45 ? 'Neutral' : snap.fearGreedIndex > 30 ? 'Fear' : 'Extreme Fear';

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <div className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm text-center">
          <p className="text-xs font-medium text-slate-400 mb-2">Fear & Greed Index</p>
          <p className="text-4xl font-bold" style={{ color: fgColor }}>{snap.fearGreedIndex}</p>
          <p className="text-xs mt-1" style={{ color: fgColor }}>{fgLabel}</p>
        </div>
        <StatCard label="Sentiment" value={snap.overallSentiment} color={snap.overallSentiment === 'BULLISH' ? 'emerald' : snap.overallSentiment === 'BEARISH' ? 'red' : 'amber'} />
        <StatCard label="Advancers" value={snap.marketBreadth?.advancers ?? 0} sub={`vs ${snap.marketBreadth?.decliners ?? 0} decliners`} />
        <StatCard label="A/D Ratio" value={snap.marketBreadth?.ratio ?? '-'} />
      </div>

      {snap.fiiDiiFlow && (
        <div className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">FII / DII Flow</h3>
          <div className="grid grid-cols-2 gap-4">
            <div>
              <p className="text-xs text-slate-400">FII Net</p>
              <p className={`text-xl font-bold ${snap.fiiDiiFlow.fiiNet >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                ₹{snap.fiiDiiFlow.fiiNet?.toLocaleString()} Cr
              </p>
            </div>
            <div>
              <p className="text-xs text-slate-400">DII Net</p>
              <p className={`text-xl font-bold ${snap.fiiDiiFlow.diiNet >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                ₹{snap.fiiDiiFlow.diiNet?.toLocaleString()} Cr
              </p>
            </div>
          </div>
          <p className="text-xs text-slate-500 mt-2">Signal: <span className="font-medium">{snap.fiiDiiFlow.signal}</span></p>
        </div>
      )}

      {snap.signals?.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-3">Sentiment Signals</h3>
          <div className="space-y-2">
            {(snap.signals as any[]).map((sig: any, i: number) => (
              <div key={i} className="flex items-start gap-3 p-3 rounded-lg bg-slate-50">
                <div className={`w-2 h-2 rounded-full mt-1.5 ${sig.sentiment === 'BULLISH' ? 'bg-emerald-500' : sig.sentiment === 'BEARISH' ? 'bg-red-500' : 'bg-amber-500'}`} />
                <div className="flex-1">
                  <p className="text-sm text-slate-700">{sig.headline}</p>
                  <p className="text-xs text-slate-400 mt-0.5">{sig.source} | Strength: {(sig.strength * 100).toFixed(0)}%</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

function CompositionPanel() {
  const { data, isLoading } = useQuery({ queryKey: ['composition'], queryFn: () => edgeApi.getComposition() });
  const comp = data as any;

  if (isLoading) return <LoadingSkeleton />;
  if (!comp?.strategies) return <EmptyState message="No strategy data available yet." />;

  const pieData = comp.strategies.map((s: any, i: number) => ({
    name: s.strategyId,
    value: Number((s.weight * 100).toFixed(1)),
    fill: COLORS[i % COLORS.length],
    allocation: s.capitalAllocation,
  }));

  return (
    <div className="space-y-6">
      <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
        <StatCard label="Total Capital" value={`₹${comp.totalCapital?.toLocaleString()}`} />
        <StatCard label="Diversification" value={`${(comp.diversificationScore * 100).toFixed(0)}%`} color={comp.diversificationScore > 0.6 ? 'emerald' : 'amber'} />
        <StatCard label="Expected Sharpe" value={comp.expectedSharpe} />
        <StatCard label="Rebalance" value={comp.rebalanceNeeded ? 'Needed' : 'OK'} color={comp.rebalanceNeeded ? 'amber' : 'emerald'} />
      </div>

      <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
        <div className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Capital Allocation (Kelly Criterion)</h3>
          <ResponsiveContainer width="100%" height={280}>
            <PieChart>
              <Pie data={pieData} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={100} label={({ name, value }: any) => `${name}: ${value}%`}>
                {pieData.map((entry: any, i: number) => (
                  <Cell key={i} fill={entry.fill} />
                ))}
              </Pie>
              <Tooltip formatter={(v: number | undefined) => [`${(v ?? 0)}%`, 'Weight']} />
            </PieChart>
          </ResponsiveContainer>
        </div>
        <div className="bg-white rounded-xl border border-slate-200/60 p-4 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-700 mb-4">Strategy Details</h3>
          <div className="space-y-3">
            {comp.strategies.map((s: any, i: number) => (
              <div key={s.strategyId} className="flex items-center gap-3 p-3 rounded-lg bg-slate-50">
                <div className="w-3 h-3 rounded-full" style={{ backgroundColor: COLORS[i % COLORS.length] }} />
                <div className="flex-1">
                  <p className="text-sm font-medium text-slate-700">{s.strategyId}</p>
                  <p className="text-xs text-slate-400">{s.correlationGroup} | Max DD: {s.maxDrawdownLimit}%</p>
                </div>
                <div className="text-right">
                  <p className="text-sm font-bold text-slate-700">₹{s.capitalAllocation?.toLocaleString()}</p>
                  <p className="text-xs text-slate-400">{(s.weight * 100).toFixed(1)}%</p>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

function AdvancedSignalsPanel() {
  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-slate-200/60 p-6 shadow-sm">
        <div className="flex items-center gap-3 mb-4">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center">
            <Zap className="w-5 h-5 text-white" />
          </div>
          <div>
            <h3 className="text-lg font-semibold text-slate-800">Advanced Signal Engine</h3>
            <p className="text-sm text-slate-500">Powered by Rust for microsecond-level analysis</p>
          </div>
        </div>

        <div className="grid grid-cols-1 md:grid-cols-2 gap-4 mt-4">
          <FeatureCard
            title="VWAP Bands"
            description="Volume Weighted Average Price with standard deviation bands for intraday mean reversion signals."
            icon={<Target className="w-5 h-5" />}
            status="ACTIVE"
          />
          <FeatureCard
            title="Volume Profile"
            description="Identify Point of Control (POC) and Value Area to find high-volume price zones."
            icon={<BarChart3 className="w-5 h-5" />}
            status="ACTIVE"
          />
          <FeatureCard
            title="Order Flow Imbalance"
            description="Detect buying/selling pressure via delta analysis and cumulative order flow."
            icon={<Activity className="w-5 h-5" />}
            status="ACTIVE"
          />
          <FeatureCard
            title="Market Profile"
            description="TPO-based market structure with Initial Balance and P/B-shaped day detection."
            icon={<Gauge className="w-5 h-5" />}
            status="ACTIVE"
          />
          <FeatureCard
            title="IV Surface Modeling"
            description="Options volatility surface with skew analysis and mispricing anomaly detection."
            icon={<AlertTriangle className="w-5 h-5" />}
            status="ACTIVE"
          />
          <FeatureCard
            title="Walk-Forward Validation"
            description="Out-of-sample testing across multiple folds to prevent overfitting."
            icon={<Shield className="w-5 h-5" />}
            status="ACTIVE"
          />
        </div>
        <p className="text-xs text-slate-400 mt-4">
          All signals are automatically integrated into AI Agent decisions and bot execution pipelines.
          Use the Backtest page with walk-forward mode for robust strategy validation.
        </p>
      </div>
    </div>
  );
}

function FeatureCard({ title, description, icon, status }: { title: string; description: string; icon: React.ReactNode; status: string }) {
  return (
    <div className="p-4 rounded-xl border border-slate-200/60 bg-slate-50 hover:bg-slate-100 transition-colors">
      <div className="flex items-center gap-3 mb-2">
        <div className="text-slate-600">{icon}</div>
        <h4 className="text-sm font-semibold text-slate-700">{title}</h4>
        <span className="ml-auto text-xs font-medium text-emerald-600 bg-emerald-50 px-2 py-0.5 rounded-full">{status}</span>
      </div>
      <p className="text-xs text-slate-500 leading-relaxed">{description}</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-4 animate-pulse">
      <div className="grid grid-cols-4 gap-4">
        {[1, 2, 3, 4].map(i => <div key={i} className="h-20 bg-slate-100 rounded-xl" />)}
      </div>
      <div className="h-64 bg-slate-100 rounded-xl" />
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="flex flex-col items-center justify-center py-16 text-center">
      <div className="w-16 h-16 rounded-full bg-slate-100 flex items-center justify-center mb-4">
        <Rocket className="w-8 h-8 text-slate-400" />
      </div>
      <p className="text-sm text-slate-500">{message}</p>
    </div>
  );
}

export default function EdgeLab() {
  const [activeTab, setActiveTab] = useState<TabId>('track-record');

  return (
    <div className="max-w-7xl mx-auto space-y-6 p-4 md:p-6">
      <div className="flex items-center gap-4">
        <div className="w-12 h-12 rounded-2xl bg-gradient-to-br from-orange-500 to-red-500 flex items-center justify-center shadow-lg shadow-orange-500/20">
          <Rocket className="w-6 h-6 text-white" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-slate-800">Edge Lab</h1>
          <p className="text-sm text-slate-500">Advanced analytics, signals & strategy intelligence</p>
        </div>
      </div>

      <div className="flex gap-2 bg-white rounded-xl p-1.5 border border-slate-200/60 shadow-sm overflow-x-auto">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setActiveTab(id)}
            className={`flex items-center gap-2 px-4 py-2.5 rounded-lg text-sm font-medium transition-all whitespace-nowrap ${
              activeTab === id
                ? 'bg-gradient-to-r from-orange-500 to-red-500 text-white shadow-md'
                : 'text-slate-500 hover:bg-slate-50'
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {activeTab === 'track-record' && <TrackRecordPanel />}
      {activeTab === 'sentiment' && <SentimentPanel />}
      {activeTab === 'composition' && <CompositionPanel />}
      {activeTab === 'advanced' && <AdvancedSignalsPanel />}
    </div>
  );
}
