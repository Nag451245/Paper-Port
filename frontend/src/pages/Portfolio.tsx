import { useEffect, useState } from 'react';
import {
  LineChart,
  Line,
  BarChart,
  Bar,
  PieChart,
  Pie,
  Cell,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  ResponsiveContainer,
} from 'recharts';
import {
  TrendingUp,
  BarChart3,
  PieChart as PieChartIcon,
  Activity,
  Target,
  ArrowDown,
  Percent,
  Scale,
  RefreshCcw,
} from 'lucide-react';
import { usePortfolioStore } from '@/stores/portfolio';
import { portfolioApi, marketApi } from '@/services/api';
import type { RiskMetrics } from '@/types';

const SECTOR_COLORS = ['#4f46e5', '#22c55e', '#eab308', '#ef4444', '#a855f7', '#06b6d4', '#f97316', '#ec4899'];

function safeNum(val: unknown, fallback = 0): number {
  if (val === null || val === undefined || val === 'N/A' || val === '') return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

function formatINR(val: number): string {
  return val.toLocaleString('en-IN', { maximumFractionDigits: 0 });
}

export default function PortfolioPage() {
  const { positions, activePortfolio, fetchPortfolios } = usePortfolioStore();
  const [riskMetrics, setRiskMetrics] = useState<RiskMetrics | null>(null);
  const [equityCurve, setEquityCurve] = useState<{ date: string; value: number }[]>([]);
  const [dailyPnl, setDailyPnl] = useState<{ date: string; totalPnl: number }[]>([]);
  const [ltpMap, setLtpMap] = useState<Record<string, number>>({});
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setLoading(true);
    fetchPortfolios().finally(() => setLoading(false));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (!activePortfolio) return;
    const id = activePortfolio.id;

    portfolioApi.riskMetrics(id)
      .then(({ data }) => setRiskMetrics(data))
      .catch(() => {});

    portfolioApi.equityCurve(id)
      .then(({ data }) => {
        if (Array.isArray(data) && data.length > 0) {
          setEquityCurve(data.map((d: any) => ({
            date: new Date(d.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
            value: safeNum(d.value ?? d.nav),
          })));
        }
      })
      .catch(() => {});

    portfolioApi.pnlHistory(id, 30)
      .then(({ data }) => {
        if (Array.isArray(data) && data.length > 0) {
          setDailyPnl(data.map((d: any) => ({
            date: new Date(d.date).toLocaleDateString('en-IN', { month: 'short', day: 'numeric' }),
            totalPnl: safeNum(d.totalPnl ?? d.total_pnl),
          })));
        }
      })
      .catch(() => {});
  }, [activePortfolio]);

  useEffect(() => {
    if (positions.length === 0) return;
    const symbols = [...new Set(positions.map((p: any) => p.symbol))];
    symbols.forEach((sym) => {
      marketApi.quote(sym)
        .then(({ data }) => {
          const ltp = safeNum(data?.ltp ?? (data as any)?.last_price);
          if (ltp > 0) setLtpMap((prev) => ({ ...prev, [sym]: ltp }));
        })
        .catch(() => {});
    });
  }, [positions]);

  const sharpe = safeNum(riskMetrics?.sharpeRatio);
  const maxDDPct = safeNum(riskMetrics?.maxDrawdownPercent ?? (riskMetrics as any)?.max_drawdown_pct);
  const winRate = safeNum(riskMetrics?.winRate ?? (riskMetrics as any)?.win_rate);
  const profitFactor = safeNum(riskMetrics?.profitFactor ?? (riskMetrics as any)?.profit_factor);
  const beta = safeNum(riskMetrics?.beta);
  const alpha = safeNum(riskMetrics?.alpha);

  const sectorMap: Record<string, number> = {};
  positions.forEach((pos: any) => {
    const sector = pos.sector || pos.strategyTag || pos.strategy_tag || 'Other';
    const value = Math.abs(safeNum(pos.investedValue ?? pos.invested_value ?? pos.qty * safeNum(pos.avgEntryPrice ?? pos.avg_entry_price)));
    sectorMap[sector] = (sectorMap[sector] || 0) + value;
  });
  const totalInvested = Object.values(sectorMap).reduce((a, b) => a + b, 0);
  const sectors = Object.entries(sectorMap).map(([name, value]) => ({
    name,
    value: totalInvested > 0 ? Math.round((value / totalInvested) * 100) : 0,
  }));

  const nav = safeNum((activePortfolio as any)?.currentNav ?? activePortfolio?.currentValue ?? (activePortfolio as any)?.current_nav);
  const initCap = safeNum((activePortfolio as any)?.initialCapital ?? activePortfolio?.capital ?? (activePortfolio as any)?.initial_capital, 1000000);

  if (loading) {
    return (
      <div className="flex items-center justify-center h-[60vh]">
        <div className="flex flex-col items-center gap-3">
          <div className="w-8 h-8 border-2 border-indigo-500 border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-500">Loading portfolio...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">Portfolio Analytics</h1>
        <button onClick={() => fetchPortfolios()} className="p-2 hover:bg-slate-100 rounded-lg transition" title="Refresh">
          <RefreshCcw className="w-4 h-4 text-slate-500" />
        </button>
      </div>

      {/* NAV summary */}
      {activePortfolio && (
        <div className="bg-gradient-to-r from-indigo-500 to-purple-600 text-white rounded-xl p-5 shadow-lg">
          <div className="grid grid-cols-2 md:grid-cols-4 gap-4">
            <div>
              <p className="text-xs text-indigo-200 uppercase">Portfolio</p>
              <p className="text-lg font-bold">{(activePortfolio as any).name || 'Default'}</p>
            </div>
            <div>
              <p className="text-xs text-indigo-200 uppercase">Current NAV</p>
              <p className="text-lg font-bold font-mono">₹{formatINR(nav)}</p>
            </div>
            <div>
              <p className="text-xs text-indigo-200 uppercase">Initial Capital</p>
              <p className="text-lg font-bold font-mono">₹{formatINR(initCap)}</p>
            </div>
            <div>
              <p className="text-xs text-indigo-200 uppercase">Total P&L</p>
              <p className={`text-lg font-bold font-mono ${nav - initCap >= 0 ? '' : 'text-red-200'}`}>
                {nav - initCap >= 0 ? '+' : ''}₹{formatINR(nav - initCap)}
                <span className="text-xs ml-1">
                  ({initCap > 0 ? ((nav - initCap) / initCap * 100).toFixed(2) : '0.00'}%)
                </span>
              </p>
            </div>
          </div>
        </div>
      )}

      {/* Risk metric cards */}
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-6 gap-3">
        <MetricCard icon={Activity} label="Sharpe Ratio" value={sharpe.toFixed(2)} color={sharpe >= 1 ? 'text-emerald-600' : 'text-amber-600'} />
        <MetricCard icon={ArrowDown} label="Max Drawdown" value={`${maxDDPct.toFixed(1)}%`} color={maxDDPct > -10 ? 'text-emerald-600' : 'text-red-600'} />
        <MetricCard icon={Target} label="Win Rate" value={`${winRate.toFixed(1)}%`} color={winRate >= 55 ? 'text-emerald-600' : 'text-amber-600'} />
        <MetricCard icon={TrendingUp} label="Profit Factor" value={profitFactor.toFixed(2)} color={profitFactor >= 1.5 ? 'text-emerald-600' : 'text-amber-600'} />
        <MetricCard icon={Scale} label="Beta" value={beta.toFixed(2)} color="text-indigo-600" />
        <MetricCard icon={Percent} label="Alpha" value={`${alpha >= 0 ? '+' : ''}${alpha.toFixed(2)}%`} color={alpha >= 0 ? 'text-emerald-600' : 'text-red-600'} />
      </div>

      {/* Equity curve */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-center gap-2 mb-4">
          <TrendingUp className="w-4 h-4 text-indigo-500" />
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Equity Curve</h2>
        </div>
        <div className="h-[300px]">
          {equityCurve.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <LineChart data={equityCurve}>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="date" tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${(v / 100000).toFixed(1)}L`} />
                <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px' }} formatter={(value) => [`₹${formatINR(value as number)}`, 'NAV']} />
                <Line type="monotone" dataKey="value" stroke="#4f46e5" strokeWidth={2} dot={false} />
              </LineChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-slate-400 text-sm">
              No equity data yet. Place some trades to see your portfolio curve.
            </div>
          )}
        </div>
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Daily P&L bar chart */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <BarChart3 className="w-4 h-4 text-indigo-500" />
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Daily P&L</h2>
          </div>
          <div className="h-[250px]">
            {dailyPnl.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={dailyPnl}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis dataKey="date" tick={{ fontSize: 9, fill: '#94a3b8' }} tickLine={false} axisLine={false} />
                  <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }} tickLine={false} axisLine={false} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}K`} />
                  <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px' }} formatter={(value) => [`₹${formatINR(value as number)}`, 'P&L']} />
                  <Bar dataKey="totalPnl" radius={[3, 3, 0, 0]}>
                    {dailyPnl.map((entry, index) => (
                      <Cell key={index} fill={entry.totalPnl >= 0 ? '#22c55e' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-slate-400 text-sm">
                No P&L data yet. Complete some trades to see daily performance.
              </div>
            )}
          </div>
        </div>

        {/* Sector allocation */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <PieChartIcon className="w-4 h-4 text-indigo-500" />
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Sector / Strategy Allocation</h2>
          </div>
          <div className="h-[250px] flex items-center">
            {sectors.length > 0 ? (
              <>
                <ResponsiveContainer width="60%" height="100%">
                  <PieChart>
                    <Pie data={sectors} dataKey="value" nameKey="name" cx="50%" cy="50%" outerRadius={80} innerRadius={40}>
                      {sectors.map((_, index) => (
                        <Cell key={index} fill={SECTOR_COLORS[index % SECTOR_COLORS.length]} />
                      ))}
                    </Pie>
                    <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: '8px', fontSize: '12px' }} formatter={(value) => [`${value}%`, 'Allocation']} />
                  </PieChart>
                </ResponsiveContainer>
                <div className="flex-1 space-y-1.5 pl-4">
                  {sectors.map((sector, i) => (
                    <div key={sector.name} className="flex items-center gap-2 text-xs">
                      <div className="w-2.5 h-2.5 rounded-full" style={{ backgroundColor: SECTOR_COLORS[i % SECTOR_COLORS.length] }} />
                      <span className="text-slate-500 flex-1">{sector.name}</span>
                      <span className="text-slate-700 font-mono">{sector.value}%</span>
                    </div>
                  ))}
                </div>
              </>
            ) : (
              <div className="flex items-center justify-center w-full h-full text-slate-400 text-sm">
                No positions to show allocation.
              </div>
            )}
          </div>
        </div>
      </div>

      {/* Positions table */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">Open Positions</h2>
        <div className="overflow-x-auto">
          <table className="w-full text-xs">
            <thead>
              <tr className="text-slate-400 border-b border-slate-200">
                <th className="text-left pb-2 font-medium">Symbol</th>
                <th className="text-center pb-2 font-medium">Side</th>
                <th className="text-right pb-2 font-medium">Qty</th>
                <th className="text-right pb-2 font-medium">Avg Price</th>
                <th className="text-right pb-2 font-medium">LTP</th>
                <th className="text-right pb-2 font-medium">Unrealized P&L</th>
                <th className="text-right pb-2 font-medium">%</th>
                <th className="text-left pb-2 font-medium">Strategy</th>
              </tr>
            </thead>
            <tbody>
              {positions.map((pos: any) => {
                const uPnl = safeNum(pos.unrealizedPnl ?? pos.unrealized_pnl);
                const avgPrice = safeNum(pos.avgEntryPrice ?? pos.avg_entry_price);
                const qty = safeNum(pos.qty ?? pos.quantity);
                const ltp = ltpMap[pos.symbol] || 0;
                const pnlPct = avgPrice > 0 && ltp > 0 ? ((ltp - avgPrice) / avgPrice) * 100 : 0;
                const tag = pos.strategyTag ?? pos.strategy_tag ?? pos.strategy;
                return (
                  <tr key={pos.id} className="border-b border-slate-100 hover:bg-slate-50/50">
                    <td className="py-2.5 font-medium text-slate-800">{pos.symbol}</td>
                    <td className="py-2.5 text-center">
                      <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${pos.side === 'LONG' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>
                        {pos.side}
                      </span>
                    </td>
                    <td className="py-2.5 text-right font-mono text-slate-600">{qty}</td>
                    <td className="py-2.5 text-right font-mono text-slate-600">₹{avgPrice.toFixed(2)}</td>
                    <td className="py-2.5 text-right font-mono text-slate-800">{ltp > 0 ? `₹${ltp.toFixed(2)}` : '...'}</td>
                    <td className={`py-2.5 text-right font-mono font-semibold ${uPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {uPnl >= 0 ? '+' : ''}₹{formatINR(uPnl)}
                    </td>
                    <td className={`py-2.5 text-right font-mono text-xs ${pnlPct >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {ltp > 0 ? `${pnlPct >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%` : '...'}
                    </td>
                    <td className="py-2.5">
                      {tag && <span className="text-[10px] px-1.5 py-0.5 rounded bg-indigo-50 text-indigo-600">{tag}</span>}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
          {positions.length === 0 && (
            <p className="text-center text-slate-400 text-sm py-8">No open positions. Place trades in the Trading Terminal to see them here.</p>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, color }: { icon: React.ElementType; label: string; value: string; color: string }) {
  return (
    <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm card-hover">
      <div className="flex items-center gap-1.5 mb-2">
        <Icon className="w-3.5 h-3.5 text-slate-400" />
        <span className="text-[11px] text-slate-400 font-medium">{label}</span>
      </div>
      <p className={`text-xl font-bold font-mono ${color}`}>{value}</p>
    </div>
  );
}
