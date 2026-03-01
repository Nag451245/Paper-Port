import { useState, useEffect, useCallback } from 'react';
import {
  GraduationCap,
  Activity,
  TrendingUp,
  TrendingDown,
  BarChart3,
  RefreshCcw,
  Loader2,
  Brain,
  Zap,
  Target,
  Calendar,
  ChevronRight,
} from 'lucide-react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  LineChart,
  Line,
  Cell,
  ScatterChart,
  Scatter,
  ZAxis,
} from 'recharts';
import { learningApi } from '@/services/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

type Tab = 'overview' | 'heatmap' | 'params' | 'regime' | 'calibration';

const TABS: { id: Tab; label: string; icon: typeof Activity }[] = [
  { id: 'overview', label: 'Overview', icon: Brain },
  { id: 'heatmap', label: 'Strategy Heatmap', icon: BarChart3 },
  { id: 'params', label: 'Param Evolution', icon: Activity },
  { id: 'regime', label: 'Market Regime', icon: Calendar },
  { id: 'calibration', label: 'Calibration', icon: Target },
];

const REGIME_COLORS: Record<string, string> = {
  trending_up: '#10b981',
  trending_down: '#ef4444',
  range_bound: '#f59e0b',
  volatile: '#8b5cf6',
  unknown: '#94a3b8',
};

const REGIME_LABELS: Record<string, string> = {
  trending_up: 'Trending Up',
  trending_down: 'Trending Down',
  range_bound: 'Range Bound',
  volatile: 'Volatile',
  unknown: 'Unknown',
};

function num(v: any): number {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v) || 0;
}

export default function LearningIntelligence() {
  const [activeTab, setActiveTab] = useState<Tab>('overview');

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-xl bg-gradient-to-br from-fuchsia-500 to-pink-500 text-white">
            <GraduationCap className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Learning Intelligence</h1>
            <p className="text-sm text-slate-500">Self-improving algo trading insights</p>
          </div>
        </div>
      </div>

      <div className="flex gap-1 rounded-lg bg-slate-100 p-1 overflow-x-auto">
        {TABS.map((tab) => {
          const Icon = tab.icon;
          const isActive = activeTab === tab.id;
          return (
            <button
              key={tab.id}
              onClick={() => setActiveTab(tab.id)}
              className={`flex items-center gap-2 rounded-md px-4 py-2 text-sm font-medium transition-colors whitespace-nowrap ${
                isActive ? 'bg-white text-slate-900 shadow-sm' : 'text-slate-500 hover:text-slate-700'
              }`}
            >
              <Icon className="w-4 h-4" />
              {tab.label}
            </button>
          );
        })}
      </div>

      {activeTab === 'overview' && <OverviewPanel />}
      {activeTab === 'heatmap' && <HeatmapPanel />}
      {activeTab === 'params' && <ParamsPanel />}
      {activeTab === 'regime' && <RegimePanel />}
      {activeTab === 'calibration' && <CalibrationPanel />}
    </div>
  );
}

function OverviewPanel() {
  const [insight, setInsight] = useState<any>(null);
  const [ledger, setLedger] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);
  const [triggering, setTriggering] = useState(false);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      const [insightRes, ledgerRes] = await Promise.all([
        learningApi.getLatestInsight(),
        learningApi.getLedger(7),
      ]);
      setInsight(insightRes.data?.data);
      setLedger(ledgerRes.data?.data || []);
    } catch { /* empty */ }
    setLoading(false);
  }, []);

  useEffect(() => { load(); }, [load]);

  const triggerNightly = async () => {
    setTriggering(true);
    try {
      await learningApi.triggerNightly();
      await load();
    } catch { /* empty */ }
    setTriggering(false);
  };

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <Loader2 className="w-6 h-6 animate-spin text-fuchsia-500" />
      </div>
    );
  }

  const strategySummary = ledger.reduce((acc: any, l: any) => {
    const key = l.strategyId;
    if (!acc[key]) acc[key] = { trades: 0, wins: 0, netPnl: 0, sharpe: 0, count: 0 };
    acc[key].trades += l.tradesCount;
    acc[key].wins += l.wins;
    acc[key].netPnl += num(l.netPnl);
    acc[key].sharpe += l.sharpeRatio;
    acc[key].count++;
    return acc;
  }, {});

  const strategies = Object.entries(strategySummary).map(([id, data]: [string, any]) => ({
    id,
    trades: data.trades,
    winRate: data.trades > 0 ? (data.wins / data.trades) * 100 : 0,
    netPnl: data.netPnl,
    avgSharpe: data.count > 0 ? data.sharpe / data.count : 0,
  })).sort((a, b) => b.netPnl - a.netPnl);

  const regime = insight?.marketRegime || 'unknown';

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div
            className="px-3 py-1.5 rounded-full text-sm font-semibold text-white"
            style={{ backgroundColor: REGIME_COLORS[regime] || REGIME_COLORS.unknown }}
          >
            {REGIME_LABELS[regime] || regime}
          </div>
          {insight?.date && (
            <span className="text-xs text-slate-400">
              Last insight: {new Date(insight.date).toLocaleDateString()}
            </span>
          )}
        </div>
        <button
          onClick={triggerNightly}
          disabled={triggering}
          className="flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white rounded-lg text-sm font-medium hover:shadow-lg transition disabled:opacity-50"
        >
          {triggering ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
          Run Learning
        </button>
      </div>

      {insight?.narrative && (
        <div className="bg-gradient-to-br from-fuchsia-50 to-pink-50 border border-fuchsia-200 rounded-xl p-5">
          <div className="flex items-center gap-2 mb-3">
            <Brain className="w-5 h-5 text-fuchsia-600" />
            <h3 className="font-semibold text-fuchsia-900">AI Daily Insight</h3>
          </div>
          <p className="text-sm text-slate-700 whitespace-pre-line leading-relaxed">{insight.narrative}</p>
        </div>
      )}

      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        <StatCard
          icon={<Zap className="w-5 h-5" />}
          label="Strategies Active"
          value={strategies.length.toString()}
          color="from-blue-500 to-cyan-500"
        />
        <StatCard
          icon={<TrendingUp className="w-5 h-5" />}
          label="Total Trades (7d)"
          value={strategies.reduce((s, st) => s + st.trades, 0).toString()}
          color="from-emerald-500 to-teal-500"
        />
        <StatCard
          icon={<Target className="w-5 h-5" />}
          label="Net P&L (7d)"
          value={`₹${strategies.reduce((s, st) => s + st.netPnl, 0).toLocaleString('en-IN', { maximumFractionDigits: 0 })}`}
          color={strategies.reduce((s, st) => s + st.netPnl, 0) >= 0 ? 'from-emerald-500 to-green-500' : 'from-red-500 to-rose-500'}
        />
      </div>

      {strategies.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <h3 className="font-semibold text-slate-900">Strategy Performance (7 Days)</h3>
          </div>
          <div className="overflow-x-auto">
            <table className="w-full text-sm">
              <thead>
                <tr className="bg-slate-50 text-slate-500 text-xs uppercase">
                  <th className="text-left px-5 py-3 font-medium">Strategy</th>
                  <th className="text-right px-5 py-3 font-medium">Trades</th>
                  <th className="text-right px-5 py-3 font-medium">Win Rate</th>
                  <th className="text-right px-5 py-3 font-medium">Net P&L</th>
                  <th className="text-right px-5 py-3 font-medium">Avg Sharpe</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-slate-100">
                {strategies.map((s) => (
                  <tr key={s.id} className="hover:bg-slate-50 transition-colors">
                    <td className="px-5 py-3 font-medium text-slate-900">{s.id}</td>
                    <td className="px-5 py-3 text-right text-slate-600">{s.trades}</td>
                    <td className="px-5 py-3 text-right">
                      <span className={s.winRate >= 50 ? 'text-emerald-600' : 'text-red-500'}>
                        {s.winRate.toFixed(1)}%
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right">
                      <span className={s.netPnl >= 0 ? 'text-emerald-600' : 'text-red-500'}>
                        ₹{s.netPnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                      </span>
                    </td>
                    <td className="px-5 py-3 text-right text-slate-600">{s.avgSharpe.toFixed(2)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {!insight && strategies.length === 0 && (
        <div className="text-center py-16 bg-white rounded-xl border border-slate-200">
          <GraduationCap className="w-12 h-12 text-slate-300 mx-auto mb-4" />
          <h3 className="text-lg font-semibold text-slate-700 mb-2">No Learning Data Yet</h3>
          <p className="text-sm text-slate-500 mb-4">
            The system will generate insights after your first day of trading.
            <br />You can also trigger a manual learning run.
          </p>
          <button
            onClick={triggerNightly}
            disabled={triggering}
            className="px-6 py-2 bg-gradient-to-r from-fuchsia-500 to-pink-500 text-white rounded-lg text-sm font-medium"
          >
            Run Learning Now
          </button>
        </div>
      )}
    </div>
  );
}

function HeatmapPanel() {
  const [data, setData] = useState<Record<string, any[]>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await learningApi.getHeatmap(60);
        setData(res.data?.data || {});
      } catch { /* empty */ }
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-fuchsia-500" /></div>;
  }

  const strategies = Object.keys(data);
  if (strategies.length === 0) {
    return <EmptyState message="No heatmap data available yet. Trade for a few days to see strategy performance patterns." />;
  }

  return (
    <div className="space-y-6">
      {strategies.map((strategyId) => {
        const rows = data[strategyId];
        return (
          <div key={strategyId} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100 flex items-center justify-between">
              <h3 className="font-semibold text-slate-900 capitalize">{strategyId.replace(/[-_]/g, ' ')}</h3>
              <span className="text-xs text-slate-400">{rows.length} days</span>
            </div>
            <div className="p-4">
              <div className="flex flex-wrap gap-1">
                {rows.map((day: any, i: number) => {
                  const pnl = num(day.netPnl);
                  const intensity = Math.min(Math.abs(pnl) / 5000, 1);
                  const bg = pnl >= 0
                    ? `rgba(16, 185, 129, ${0.15 + intensity * 0.85})`
                    : `rgba(239, 68, 68, ${0.15 + intensity * 0.85})`;
                  return (
                    <div
                      key={i}
                      className="w-8 h-8 rounded-md flex items-center justify-center text-[9px] font-bold text-white cursor-default"
                      style={{ backgroundColor: bg }}
                      title={`${day.date}: ₹${pnl.toFixed(0)} | Win: ${day.winRate}% | ${day.trades} trades`}
                    >
                      {new Date(day.date).getDate()}
                    </div>
                  );
                })}
              </div>
              <div className="flex items-center gap-4 mt-3 text-xs text-slate-500">
                <span className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-emerald-500" /> Profit</span>
                <span className="flex items-center gap-1"><div className="w-3 h-3 rounded bg-red-500" /> Loss</span>
              </div>
            </div>
            <div className="h-40 px-4 pb-4">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={rows}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="date" tick={{ fontSize: 10 }} tickFormatter={(v: string) => v.slice(5)} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip
                    formatter={(value: number | undefined) => [`₹${(value ?? 0).toFixed(0)}`, 'Net P&L']}
                    labelFormatter={(label: any) => `Date: ${String(label)}`}
                  />
                  <Bar dataKey="netPnl" radius={[3, 3, 0, 0]}>
                    {rows.map((entry: any, idx: number) => (
                      <Cell key={idx} fill={num(entry.netPnl) >= 0 ? '#10b981' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function ParamsPanel() {
  const [params, setParams] = useState<any[]>([]);
  const [activeParams, setActiveParams] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [allRes, activeRes] = await Promise.all([
          learningApi.getParams(),
          learningApi.getActiveParams(),
        ]);
        setParams(allRes.data?.data || []);
        setActiveParams(activeRes.data?.data || []);
      } catch { /* empty */ }
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-fuchsia-500" /></div>;
  }

  if (params.length === 0) {
    return <EmptyState message="No parameter evolution data yet. The system will optimize parameters after the first nightly learning run." />;
  }

  const grouped: Record<string, any[]> = {};
  for (const p of params) {
    if (!grouped[p.strategyId]) grouped[p.strategyId] = [];
    grouped[p.strategyId].push(p);
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900">Active Parameters</h3>
        </div>
        {activeParams.length > 0 ? (
          <div className="divide-y divide-slate-100">
            {activeParams.map((p: any) => {
              let parsed: Record<string, number> = {};
              try { parsed = JSON.parse(p.params); } catch { /* empty */ }
              let metrics: any = {};
              try { metrics = JSON.parse(p.backtestMetrics); } catch { /* empty */ }
              return (
                <div key={p.id} className="px-5 py-4 flex items-center justify-between">
                  <div>
                    <span className="font-medium text-slate-900 capitalize">{p.strategyId.replace(/[-_]/g, ' ')}</span>
                    <span className="ml-2 text-xs text-slate-400">v{p.version}</span>
                    <span className={`ml-2 px-2 py-0.5 rounded-full text-xs font-medium ${
                      p.source === 'backtest_optimized' ? 'bg-fuchsia-100 text-fuchsia-700' :
                      p.source === 'gpt_adjusted' ? 'bg-purple-100 text-purple-700' :
                      'bg-slate-100 text-slate-600'
                    }`}>
                      {p.source.replace(/_/g, ' ')}
                    </span>
                  </div>
                  <div className="flex items-center gap-4 text-sm">
                    {Object.entries(parsed).map(([key, val]) => (
                      <span key={key} className="text-slate-600">
                        <span className="text-slate-400 text-xs">{key}:</span> {val}
                      </span>
                    ))}
                    {metrics.sharpe != null && (
                      <span className="text-xs text-emerald-600 font-medium">Sharpe: {num(metrics.sharpe).toFixed(2)}</span>
                    )}
                  </div>
                </div>
              );
            })}
          </div>
        ) : (
          <p className="px-5 py-4 text-sm text-slate-500">No active parameters configured.</p>
        )}
      </div>

      {Object.entries(grouped).map(([strategyId, versions]) => {
        const chartData = versions
          .sort((a: any, b: any) => a.version - b.version)
          .map((v: any) => {
            let parsed: Record<string, number> = {};
            try { parsed = JSON.parse(v.params); } catch { /* empty */ }
            let metrics: any = {};
            try { metrics = JSON.parse(v.backtestMetrics); } catch { /* empty */ }
            return {
              version: `v${v.version}`,
              source: v.source,
              sharpe: num(metrics.sharpe),
              winRate: num(metrics.winRate),
              ...parsed,
            };
          });

        const paramKeys = Object.keys(chartData[0] || {}).filter(k => !['version', 'source', 'sharpe', 'winRate'].includes(k));

        return (
          <div key={strategyId} className="bg-white rounded-xl border border-slate-200 overflow-hidden">
            <div className="px-5 py-3 border-b border-slate-100">
              <h3 className="font-semibold text-slate-900 capitalize">{strategyId.replace(/[-_]/g, ' ')} — Parameter History</h3>
            </div>
            <div className="h-56 p-4">
              <ResponsiveContainer width="100%" height="100%">
                <LineChart data={chartData}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                  <XAxis dataKey="version" tick={{ fontSize: 10 }} />
                  <YAxis tick={{ fontSize: 10 }} />
                  <Tooltip />
                  {paramKeys.map((key, i) => (
                    <Line
                      key={key}
                      type="monotone"
                      dataKey={key}
                      stroke={['#8b5cf6', '#06b6d4', '#f59e0b', '#ef4444', '#10b981'][i % 5]}
                      strokeWidth={2}
                      dot={{ r: 4 }}
                    />
                  ))}
                </LineChart>
              </ResponsiveContainer>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function RegimePanel() {
  const [timeline, setTimeline] = useState<any[]>([]);
  const [insights, setInsights] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const [regimeRes, insightsRes] = await Promise.all([
          learningApi.getRegimeTimeline(60),
          learningApi.getInsights(30),
        ]);
        setTimeline(regimeRes.data?.data || []);
        setInsights(insightsRes.data?.data || []);
      } catch { /* empty */ }
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-fuchsia-500" /></div>;
  }

  if (timeline.length === 0 && insights.length === 0) {
    return <EmptyState message="No market regime data yet. The system will classify market regimes after the first nightly learning run." />;
  }

  const regimeCounts: Record<string, number> = {};
  for (const t of timeline) {
    regimeCounts[t.regime] = (regimeCounts[t.regime] || 0) + 1;
  }

  return (
    <div className="space-y-6">
      {timeline.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <h3 className="font-semibold text-slate-900">Market Regime Timeline</h3>
          </div>
          <div className="p-5">
            <div className="flex gap-1 flex-wrap">
              {timeline.map((day: any, i: number) => (
                <div
                  key={i}
                  className="w-10 h-10 rounded-lg flex flex-col items-center justify-center cursor-default"
                  style={{ backgroundColor: REGIME_COLORS[day.regime] || REGIME_COLORS.unknown }}
                  title={`${day.date}: ${REGIME_LABELS[day.regime] || day.regime}`}
                >
                  <span className="text-[9px] font-bold text-white">{new Date(day.date).getDate()}</span>
                  <span className="text-[7px] text-white/80">{new Date(day.date).toLocaleDateString('en', { month: 'short' })}</span>
                </div>
              ))}
            </div>
            <div className="flex items-center gap-4 mt-4 flex-wrap">
              {Object.entries(REGIME_COLORS).filter(([k]) => k !== 'unknown').map(([regime, color]) => (
                <span key={regime} className="flex items-center gap-1.5 text-xs text-slate-600">
                  <div className="w-3 h-3 rounded" style={{ backgroundColor: color }} />
                  {REGIME_LABELS[regime]} ({regimeCounts[regime] || 0}d)
                </span>
              ))}
            </div>
          </div>
        </div>
      )}

      {insights.length > 0 && (
        <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
          <div className="px-5 py-3 border-b border-slate-100">
            <h3 className="font-semibold text-slate-900">Daily Learning Insights</h3>
          </div>
          <div className="divide-y divide-slate-100 max-h-[600px] overflow-y-auto">
            {insights.map((insight: any) => {
              let winners: string[] = [];
              let losers: string[] = [];
              try { winners = JSON.parse(insight.topWinningStrategies); } catch { /* empty */ }
              try { losers = JSON.parse(insight.topLosingStrategies); } catch { /* empty */ }

              return (
                <div key={insight.id} className="px-5 py-4">
                  <div className="flex items-center gap-3 mb-2">
                    <span className="text-sm font-semibold text-slate-900">{new Date(insight.date).toLocaleDateString()}</span>
                    <span
                      className="px-2 py-0.5 rounded-full text-xs font-medium text-white"
                      style={{ backgroundColor: REGIME_COLORS[insight.marketRegime] || REGIME_COLORS.unknown }}
                    >
                      {REGIME_LABELS[insight.marketRegime] || insight.marketRegime}
                    </span>
                    {insight.appliedAt && (
                      <span className="text-xs text-emerald-500 flex items-center gap-1">
                        <ChevronRight className="w-3 h-3" /> Applied
                      </span>
                    )}
                  </div>
                  {winners.length > 0 && (
                    <div className="flex items-center gap-2 text-xs mb-1">
                      <TrendingUp className="w-3 h-3 text-emerald-500" />
                      <span className="text-slate-500">Winners:</span>
                      {winners.map((w: string) => (
                        <span key={w} className="px-1.5 py-0.5 bg-emerald-50 text-emerald-700 rounded text-xs">{w}</span>
                      ))}
                    </div>
                  )}
                  {losers.length > 0 && (
                    <div className="flex items-center gap-2 text-xs mb-2">
                      <TrendingDown className="w-3 h-3 text-red-500" />
                      <span className="text-slate-500">Losers:</span>
                      {losers.map((l: string) => (
                        <span key={l} className="px-1.5 py-0.5 bg-red-50 text-red-700 rounded text-xs">{l}</span>
                      ))}
                    </div>
                  )}
                  {insight.narrative && (
                    <p className="text-xs text-slate-600 leading-relaxed line-clamp-3">{insight.narrative}</p>
                  )}
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}

function CalibrationPanel() {
  const [data, setData] = useState<any[]>([]);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    (async () => {
      try {
        const res = await learningApi.getCalibration();
        setData(res.data?.data || []);
      } catch { /* empty */ }
      setLoading(false);
    })();
  }, []);

  if (loading) {
    return <div className="flex items-center justify-center h-64"><Loader2 className="w-6 h-6 animate-spin text-fuchsia-500" /></div>;
  }

  if (data.length === 0) {
    return <EmptyState message="No calibration data yet. Trade with AI signals to see how predicted confidence compares to actual outcomes." />;
  }

  return (
    <div className="space-y-6">
      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900">Confidence Calibration</h3>
          <p className="text-xs text-slate-500 mt-0.5">Predicted signal confidence vs actual win rate</p>
        </div>
        <div className="h-72 p-4">
          <ResponsiveContainer width="100%" height="100%">
            <ScatterChart>
              <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
              <XAxis
                dataKey="predicted"
                name="Predicted"
                tick={{ fontSize: 10 }}
                domain={[0, 1]}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                label={{ value: 'Predicted Confidence', position: 'bottom', fontSize: 11 }}
              />
              <YAxis
                dataKey="actual"
                name="Actual"
                tick={{ fontSize: 10 }}
                domain={[0, 1]}
                tickFormatter={(v: number) => `${(v * 100).toFixed(0)}%`}
                label={{ value: 'Actual Win Rate', angle: -90, position: 'left', fontSize: 11 }}
              />
              <ZAxis dataKey="count" range={[50, 400]} name="Trades" />
              <Tooltip
                formatter={(value: number | undefined, name: string | undefined) => {
                  const n = name ?? '';
                  if (n === 'Trades') return [value ?? 0, n];
                  return [`${((value ?? 0) * 100).toFixed(1)}%`, n];
                }}
              />
              <Scatter data={data} fill="#a855f7">
                {data.map((entry: any, idx: number) => {
                  const diff = Math.abs(entry.predicted - entry.actual);
                  const color = diff < 0.1 ? '#10b981' : diff < 0.2 ? '#f59e0b' : '#ef4444';
                  return <Cell key={idx} fill={color} />;
                })}
              </Scatter>
              <Line
                type="linear"
                dataKey="predicted"
                stroke="#94a3b8"
                strokeDasharray="5 5"
                strokeWidth={1}
                dot={false}
              />
            </ScatterChart>
          </ResponsiveContainer>
        </div>
        <div className="px-5 pb-4 flex items-center gap-4 text-xs text-slate-500">
          <span className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-emerald-500" /> Well calibrated (&lt;10% diff)</span>
          <span className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-amber-500" /> Moderate (&lt;20%)</span>
          <span className="flex items-center gap-1"><div className="w-3 h-3 rounded-full bg-red-500" /> Poorly calibrated (&gt;20%)</span>
        </div>
      </div>

      <div className="bg-white rounded-xl border border-slate-200 overflow-hidden">
        <div className="px-5 py-3 border-b border-slate-100">
          <h3 className="font-semibold text-slate-900">Calibration Details</h3>
        </div>
        <div className="overflow-x-auto">
          <table className="w-full text-sm">
            <thead>
              <tr className="bg-slate-50 text-slate-500 text-xs uppercase">
                <th className="text-left px-5 py-3 font-medium">Confidence Bucket</th>
                <th className="text-right px-5 py-3 font-medium">Actual Win Rate</th>
                <th className="text-right px-5 py-3 font-medium">Trades</th>
                <th className="text-right px-5 py-3 font-medium">Calibration Error</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {data.map((row: any, i: number) => {
                const error = Math.abs(row.predicted - row.actual);
                return (
                  <tr key={i} className="hover:bg-slate-50">
                    <td className="px-5 py-3 font-medium text-slate-900">{(row.predicted * 100).toFixed(0)}%</td>
                    <td className="px-5 py-3 text-right text-slate-600">{(row.actual * 100).toFixed(1)}%</td>
                    <td className="px-5 py-3 text-right text-slate-600">{row.count}</td>
                    <td className="px-5 py-3 text-right">
                      <span className={error < 0.1 ? 'text-emerald-600' : error < 0.2 ? 'text-amber-600' : 'text-red-500'}>
                        {(error * 100).toFixed(1)}%
                      </span>
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}

function StatCard({ icon, label, value, color }: { icon: React.ReactNode; label: string; value: string; color: string }) {
  return (
    <div className="bg-white rounded-xl border border-slate-200 p-5 flex items-center gap-4">
      <div className={`p-3 rounded-xl bg-gradient-to-br ${color} text-white`}>
        {icon}
      </div>
      <div>
        <p className="text-xs text-slate-500 font-medium">{label}</p>
        <p className="text-xl font-bold text-slate-900">{value}</p>
      </div>
    </div>
  );
}

function EmptyState({ message }: { message: string }) {
  return (
    <div className="text-center py-16 bg-white rounded-xl border border-slate-200">
      <GraduationCap className="w-12 h-12 text-slate-300 mx-auto mb-4" />
      <p className="text-sm text-slate-500 max-w-md mx-auto">{message}</p>
    </div>
  );
}
