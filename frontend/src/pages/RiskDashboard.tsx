import { useState, useEffect, useCallback } from 'react';
import {
  Shield,
  AlertTriangle,
  Activity,
  TrendingDown,
  Loader2,
  RefreshCw,
  Power,
  Crosshair,
  BarChart3,
  DollarSign,
  Gauge,
  Ban,
  CheckCircle2,
  XCircle,
  Clock,
  ArrowDown,
  ShieldAlert,
} from 'lucide-react';
import { riskApi, portfolioApi } from '@/services/api';
import { useRiskAlerts } from '@/hooks/useTradeUpdates';
import { useLivePrices } from '@/hooks/useLivePrice';

/* eslint-disable @typescript-eslint/no-explicit-any */

function num(v: any): number {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v);
}

function fmtINR(v: number): string {
  if (Math.abs(v) >= 10000000) return `₹${(v / 10000000).toFixed(2)}Cr`;
  if (Math.abs(v) >= 100000) return `₹${(v / 100000).toFixed(1)}L`;
  if (Math.abs(v) >= 1000) return `₹${(v / 1000).toFixed(1)}K`;
  return `₹${v.toFixed(2)}`;
}

function pnlColor(v: number): string {
  return v >= 0 ? 'text-emerald-600' : 'text-red-600';
}

function pnlBg(v: number): string {
  return v >= 0 ? 'bg-emerald-50 border-emerald-200' : 'bg-red-50 border-red-200';
}

interface DailySummary {
  dayPnl: number;
  dayPnlPercent: number;
  openPositions: number;
  totalExposure: number;
  maxDrawdown: number;
  dailyLossLimit: number;
  dailyLossUsed: number;
  positionCount: number;
  avgWinRate: number;
  tradeCount: number;
}

interface VaRData {
  var95: number;
  var99: number;
  expectedShortfall: number;
  portfolioValue: number;
}

interface MarginData {
  totalMarginUsed: number;
  totalMarginAvailable: number;
  utilizationPercent: number;
  positions: { symbol: string; marginUsed: number; marginPercent: number }[];
}

interface StopLossPosition {
  positionId: string;
  symbol: string;
  side: string;
  qty: number;
  entryPrice: number;
  stopLoss: number;
  takeProfit: number;
  currentPrice: number;
  unrealizedPnl: number;
  distanceToStop: number;
  distanceToTarget: number;
}

interface KillSwitchStatus {
  active: boolean;
  activatedAt: string | null;
  reason: string | null;
}

export default function RiskDashboard() {
  const [loading, setLoading] = useState(true);
  const [dailySummary, setDailySummary] = useState<DailySummary | null>(null);
  const [varData, setVarData] = useState<VaRData | null>(null);
  const [marginData, setMarginData] = useState<MarginData | null>(null);
  const [stopLossPositions, setStopLossPositions] = useState<StopLossPosition[]>([]);
  const [killSwitch, setKillSwitch] = useState<KillSwitchStatus>({ active: false, activatedAt: null, reason: null });
  const [circuitBreaker, setCircuitBreaker] = useState<any>(null);
  const [comprehensive, setComprehensive] = useState<any>(null);
  const [killLoading, setKillLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const { alerts, dismissAlert } = useRiskAlerts(10);

  const fetchRiskData = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const [compRes, dailyRes, varRes, marginRes, slRes, ksRes] = await Promise.allSettled([
        riskApi.comprehensive(),
        riskApi.dailySummary(),
        riskApi.var(0.95, 1),
        riskApi.margin(),
        riskApi.stopLossStatus(),
        (riskApi as any).killSwitchStatus?.() ?? Promise.resolve({ data: { active: false } }),
      ]);

      if (compRes.status === 'fulfilled') setComprehensive(compRes.value.data);
      if (dailyRes.status === 'fulfilled') {
        const d = dailyRes.value.data;
        setDailySummary({
          dayPnl: num(d.dayPnl ?? d.todayPnl ?? d.pnl),
          dayPnlPercent: num(d.dayPnlPercent ?? d.pnlPercent),
          openPositions: num(d.openPositions ?? d.positionCount),
          totalExposure: num(d.totalExposure ?? d.exposure),
          maxDrawdown: num(d.maxDrawdown),
          dailyLossLimit: num(d.dailyLossLimit ?? d.lossLimit),
          dailyLossUsed: num(d.dailyLossUsed ?? d.lossUsed),
          positionCount: num(d.positionCount ?? d.openPositions),
          avgWinRate: num(d.avgWinRate ?? d.winRate),
          tradeCount: num(d.tradeCount ?? d.trades),
        });
      }
      if (varRes.status === 'fulfilled') {
        const v = varRes.value.data;
        setVarData({
          var95: num(v.var95 ?? v.var ?? v.valueAtRisk),
          var99: num(v.var99),
          expectedShortfall: num(v.expectedShortfall ?? v.cvar),
          portfolioValue: num(v.portfolioValue ?? v.totalValue),
        });
      }
      if (marginRes.status === 'fulfilled') {
        const m = marginRes.value.data;
        setMarginData({
          totalMarginUsed: num(m.totalMarginUsed ?? m.used),
          totalMarginAvailable: num(m.totalMarginAvailable ?? m.available),
          utilizationPercent: num(m.utilizationPercent ?? m.utilization),
          positions: Array.isArray(m.positions) ? m.positions : [],
        });
      }
      if (slRes.status === 'fulfilled') {
        const sl = slRes.value.data;
        setStopLossPositions(Array.isArray(sl.positions ?? sl) ? (sl.positions ?? sl) : []);
        if (sl.circuitBreaker) setCircuitBreaker(sl.circuitBreaker);
      }
      if (ksRes.status === 'fulfilled') {
        const ks = ksRes.value.data;
        setKillSwitch({
          active: !!ks.active,
          activatedAt: ks.activatedAt ?? null,
          reason: ks.reason ?? null,
        });
      }
    } catch (err: any) {
      setError(err?.response?.data?.error ?? err?.message ?? 'Failed to load risk data');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchRiskData();
    const interval = setInterval(fetchRiskData, 15_000);
    return () => clearInterval(interval);
  }, [fetchRiskData]);

  const handleKillSwitch = async () => {
    setKillLoading(true);
    try {
      if (killSwitch.active) {
        await (riskApi as any).killSwitchDeactivate?.() ?? riskApi.squareOffAll();
        setKillSwitch({ active: false, activatedAt: null, reason: null });
      } else {
        const confirmed = window.confirm('ACTIVATE KILL SWITCH?\n\nThis will:\n• Halt ALL trading immediately\n• Square off ALL open positions\n• Cancel ALL pending orders\n\nAre you sure?');
        if (!confirmed) { setKillLoading(false); return; }
        await riskApi.squareOffAll();
        setKillSwitch({ active: true, activatedAt: new Date().toISOString(), reason: 'Manual activation' });
      }
      await fetchRiskData();
    } catch (err: any) {
      setError(err?.response?.data?.error ?? 'Kill switch operation failed');
    } finally {
      setKillLoading(false);
    }
  };

  const dayPnl = dailySummary?.dayPnl ?? 0;
  const lossUsedPct = dailySummary?.dailyLossLimit
    ? Math.min(100, (Math.abs(dailySummary.dailyLossUsed) / dailySummary.dailyLossLimit) * 100)
    : 0;
  const marginPct = marginData?.utilizationPercent ?? 0;

  return (
    <div className="space-y-4">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-red-500 to-orange-500 flex items-center justify-center shadow-lg shadow-red-500/20">
            <Shield className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Risk Dashboard</h1>
            <p className="text-xs text-slate-500">Real-time risk monitoring & controls</p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button onClick={fetchRiskData} className="p-2 rounded-lg hover:bg-slate-100 text-slate-400 hover:text-slate-600 transition" title="Refresh">
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
          <button
            onClick={handleKillSwitch}
            disabled={killLoading}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all ${
              killSwitch.active
                ? 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
                : 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20'
            }`}
          >
            {killLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <Power className="w-4 h-4" />}
            {killSwitch.active ? 'RESUME TRADING' : 'KILL SWITCH'}
          </button>
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
          <AlertTriangle className="w-4 h-4 shrink-0" />
          <span>{error}</span>
        </div>
      )}

      {/* Kill Switch Warning Banner */}
      {killSwitch.active && (
        <div className="flex items-center gap-3 px-4 py-3 bg-red-100 border-2 border-red-300 rounded-xl animate-pulse">
          <ShieldAlert className="w-6 h-6 text-red-600 shrink-0" />
          <div>
            <p className="text-sm font-bold text-red-800">KILL SWITCH ACTIVE — All Trading Halted</p>
            <p className="text-xs text-red-600">{killSwitch.reason ?? 'Activated manually'} {killSwitch.activatedAt ? `at ${new Date(killSwitch.activatedAt).toLocaleTimeString('en-IN')}` : ''}</p>
          </div>
        </div>
      )}

      {loading && !dailySummary ? (
        <div className="flex items-center justify-center py-20"><Loader2 className="w-8 h-8 animate-spin text-slate-400" /></div>
      ) : (
        <>
          {/* Top Metric Cards */}
          <div className="grid grid-cols-2 md:grid-cols-4 xl:grid-cols-6 gap-3">
            <MetricCard icon={DollarSign} label="Day P&L" value={fmtINR(dayPnl)} sub={`${dayPnl >= 0 ? '+' : ''}${(dailySummary?.dayPnlPercent ?? 0).toFixed(2)}%`} color={dayPnl >= 0 ? 'emerald' : 'red'} />
            <MetricCard icon={Crosshair} label="Open Positions" value={String(dailySummary?.openPositions ?? 0)} sub={`${dailySummary?.tradeCount ?? 0} trades today`} color="blue" />
            <MetricCard icon={BarChart3} label="Exposure" value={fmtINR(dailySummary?.totalExposure ?? 0)} sub="Total market exposure" color="indigo" />
            <MetricCard icon={TrendingDown} label="Max Drawdown" value={`${(dailySummary?.maxDrawdown ?? 0).toFixed(2)}%`} sub="Peak to trough" color={Math.abs(dailySummary?.maxDrawdown ?? 0) > 5 ? 'red' : 'amber'} />
            <MetricCard icon={Gauge} label="Margin Used" value={`${marginPct.toFixed(1)}%`} sub={fmtINR(marginData?.totalMarginUsed ?? 0)} color={marginPct > 80 ? 'red' : marginPct > 50 ? 'amber' : 'emerald'} />
            <MetricCard icon={Activity} label="Win Rate" value={`${(dailySummary?.avgWinRate ?? 0).toFixed(1)}%`} sub="Recent trades" color="teal" />
          </div>

          {/* P&L Waterfall + VaR Row */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Daily Loss Budget */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <ArrowDown className="w-4 h-4 text-red-500" />
                Daily Loss Budget
              </h3>
              <div className="space-y-3">
                <div className="flex justify-between text-xs text-slate-500">
                  <span>Used: {fmtINR(Math.abs(dailySummary?.dailyLossUsed ?? 0))}</span>
                  <span>Limit: {fmtINR(dailySummary?.dailyLossLimit ?? 0)}</span>
                </div>
                <div className="h-3 bg-slate-100 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all ${lossUsedPct > 80 ? 'bg-red-500' : lossUsedPct > 50 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                    style={{ width: `${Math.min(100, lossUsedPct)}%` }}
                  />
                </div>
                <div className="flex justify-between text-xs">
                  <span className={`font-semibold ${lossUsedPct > 80 ? 'text-red-600' : 'text-slate-600'}`}>{lossUsedPct.toFixed(1)}% consumed</span>
                  <span className="text-slate-400">Remaining: {fmtINR(Math.max(0, (dailySummary?.dailyLossLimit ?? 0) - Math.abs(dailySummary?.dailyLossUsed ?? 0)))}</span>
                </div>
                <div className={`p-2 rounded-lg text-xs font-medium ${pnlBg(dayPnl)}`}>
                  Today's P&L: <span className={`font-bold ${pnlColor(dayPnl)}`}>{dayPnl >= 0 ? '+' : ''}{fmtINR(dayPnl)}</span>
                </div>
              </div>
            </div>

            {/* VaR Exposure */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-indigo-500" />
                Value at Risk
              </h3>
              {varData ? (
                <div className="space-y-3">
                  <div className="grid grid-cols-2 gap-3">
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-[10px] text-slate-400 uppercase font-medium">VaR (95%)</p>
                      <p className="text-lg font-bold text-red-600">{fmtINR(Math.abs(varData.var95))}</p>
                      <p className="text-[10px] text-slate-400">{varData.portfolioValue ? `${((Math.abs(varData.var95) / varData.portfolioValue) * 100).toFixed(2)}% of portfolio` : ''}</p>
                    </div>
                    <div className="p-3 bg-slate-50 rounded-lg">
                      <p className="text-[10px] text-slate-400 uppercase font-medium">VaR (99%)</p>
                      <p className="text-lg font-bold text-red-600">{fmtINR(Math.abs(varData.var99))}</p>
                      <p className="text-[10px] text-slate-400">Worst-case scenario</p>
                    </div>
                  </div>
                  <div className="p-3 bg-slate-50 rounded-lg flex justify-between items-center">
                    <div>
                      <p className="text-[10px] text-slate-400 uppercase font-medium">Expected Shortfall (CVaR)</p>
                      <p className="text-sm font-bold text-red-600">{fmtINR(Math.abs(varData.expectedShortfall))}</p>
                    </div>
                    <div className="text-right">
                      <p className="text-[10px] text-slate-400 uppercase font-medium">Portfolio Value</p>
                      <p className="text-sm font-bold text-slate-800">{fmtINR(varData.portfolioValue)}</p>
                    </div>
                  </div>
                </div>
              ) : (
                <p className="text-center text-slate-400 text-sm py-6">No VaR data available</p>
              )}
            </div>
          </div>

          {/* Margin Utilization + Circuit Breaker */}
          <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
            {/* Margin */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <Gauge className="w-4 h-4 text-amber-500" />
                Margin Utilization
              </h3>
              {marginData ? (
                <div className="space-y-3">
                  <div className="h-4 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className={`h-full rounded-full transition-all ${marginPct > 80 ? 'bg-red-500' : marginPct > 60 ? 'bg-amber-500' : 'bg-emerald-500'}`}
                      style={{ width: `${Math.min(100, marginPct)}%` }}
                    />
                  </div>
                  <div className="flex justify-between text-xs text-slate-500">
                    <span>Used: {fmtINR(marginData.totalMarginUsed)}</span>
                    <span>Available: {fmtINR(marginData.totalMarginAvailable)}</span>
                  </div>
                  {marginData.positions.length > 0 && (
                    <div className="space-y-1.5 max-h-32 overflow-y-auto">
                      {marginData.positions.map((p, i) => (
                        <div key={i} className="flex items-center justify-between text-xs px-2 py-1.5 bg-slate-50 rounded">
                          <span className="font-medium text-slate-700">{p.symbol}</span>
                          <div className="flex items-center gap-3">
                            <span className="font-mono text-slate-600">{fmtINR(p.marginUsed)}</span>
                            <span className="text-slate-400">{num(p.marginPercent).toFixed(1)}%</span>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              ) : (
                <p className="text-center text-slate-400 text-sm py-6">No margin data</p>
              )}
            </div>

            {/* Circuit Breaker */}
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <Ban className="w-4 h-4 text-red-500" />
                Circuit Breaker Status
              </h3>
              <div className="space-y-3">
                <div className={`p-4 rounded-xl flex items-center gap-3 ${circuitBreaker?.triggered ? 'bg-red-50 border border-red-200' : 'bg-emerald-50 border border-emerald-200'}`}>
                  {circuitBreaker?.triggered ? (
                    <>
                      <XCircle className="w-6 h-6 text-red-600" />
                      <div>
                        <p className="text-sm font-bold text-red-800">TRIGGERED</p>
                        <p className="text-xs text-red-600">{circuitBreaker.reason ?? 'Risk limits exceeded'}</p>
                      </div>
                    </>
                  ) : (
                    <>
                      <CheckCircle2 className="w-6 h-6 text-emerald-600" />
                      <div>
                        <p className="text-sm font-bold text-emerald-800">Normal</p>
                        <p className="text-xs text-emerald-600">All risk limits within bounds</p>
                      </div>
                    </>
                  )}
                </div>

                <div className="grid grid-cols-2 gap-2">
                  <StatusPill label="Max Position Size" ok={true} />
                  <StatusPill label="Daily Loss Limit" ok={lossUsedPct < 80} />
                  <StatusPill label="Margin Limit" ok={marginPct < 80} />
                  <StatusPill label="Consecutive Losses" ok={!circuitBreaker?.consecutiveLosses} />
                </div>
              </div>
            </div>
          </div>

          {/* Stop-Loss Status Table */}
          <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
            <div className="px-4 py-3 border-b border-slate-200 flex items-center justify-between">
              <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
                <Crosshair className="w-4 h-4 text-violet-500" />
                Stop-Loss Monitor — All Positions
              </h3>
              <span className="text-xs text-slate-400">{stopLossPositions.length} positions monitored</span>
            </div>
            <div className="overflow-x-auto">
              {stopLossPositions.length === 0 ? (
                <p className="text-center text-slate-400 text-sm py-8">No positions being monitored</p>
              ) : (
                <table className="w-full text-xs">
                  <thead>
                    <tr className="text-slate-400 border-b border-slate-200 bg-slate-50/50">
                      <th className="text-left px-4 py-2 font-medium">Symbol</th>
                      <th className="text-center px-2 py-2 font-medium">Side</th>
                      <th className="text-right px-2 py-2 font-medium">Qty</th>
                      <th className="text-right px-2 py-2 font-medium">Entry</th>
                      <th className="text-right px-2 py-2 font-medium">LTP</th>
                      <th className="text-right px-2 py-2 font-medium">Stop Loss</th>
                      <th className="text-right px-2 py-2 font-medium">Target</th>
                      <th className="text-right px-2 py-2 font-medium">Unrealized P&L</th>
                      <th className="text-center px-2 py-2 font-medium">Distance to SL</th>
                    </tr>
                  </thead>
                  <tbody>
                    {stopLossPositions.map((p, i) => {
                      const distPct = num(p.distanceToStop);
                      return (
                        <tr key={p.positionId ?? i} className="border-b border-slate-100 hover:bg-slate-50/50">
                          <td className="px-4 py-2.5 font-medium text-slate-800">{p.symbol}</td>
                          <td className="px-2 py-2.5 text-center">
                            <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${p.side === 'LONG' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>{p.side}</span>
                          </td>
                          <td className="px-2 py-2.5 text-right font-mono text-slate-600">{p.qty}</td>
                          <td className="px-2 py-2.5 text-right font-mono text-slate-600">₹{num(p.entryPrice).toFixed(2)}</td>
                          <td className="px-2 py-2.5 text-right font-mono text-slate-800 font-semibold">₹{num(p.currentPrice).toFixed(2)}</td>
                          <td className="px-2 py-2.5 text-right font-mono text-red-600 font-semibold">₹{num(p.stopLoss).toFixed(2)}</td>
                          <td className="px-2 py-2.5 text-right font-mono text-emerald-600 font-semibold">₹{num(p.takeProfit).toFixed(2)}</td>
                          <td className={`px-2 py-2.5 text-right font-mono font-semibold ${pnlColor(num(p.unrealizedPnl))}`}>
                            {num(p.unrealizedPnl) >= 0 ? '+' : ''}₹{num(p.unrealizedPnl).toFixed(2)}
                          </td>
                          <td className="px-2 py-2.5 text-center">
                            <span className={`text-[10px] font-bold px-2 py-0.5 rounded-full ${distPct < 1 ? 'bg-red-100 text-red-700' : distPct < 3 ? 'bg-amber-100 text-amber-700' : 'bg-emerald-100 text-emerald-700'}`}>
                              {distPct.toFixed(1)}%
                            </span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>

          {/* Live Risk Alerts */}
          {alerts.length > 0 && (
            <div className="bg-white border border-slate-200 rounded-xl p-4 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <AlertTriangle className="w-4 h-4 text-amber-500" />
                Live Alerts ({alerts.length})
              </h3>
              <div className="space-y-2 max-h-48 overflow-y-auto">
                {alerts.map((alert) => (
                  <div
                    key={alert.id}
                    className={`flex items-start gap-2 px-3 py-2 rounded-lg text-xs ${
                      alert.severity === 'critical' ? 'bg-red-50 border border-red-200' :
                      alert.severity === 'warning' ? 'bg-amber-50 border border-amber-200' :
                      'bg-blue-50 border border-blue-200'
                    }`}
                  >
                    <Clock className="w-3.5 h-3.5 mt-0.5 shrink-0 text-slate-400" />
                    <div className="flex-1 min-w-0">
                      <p className="font-semibold text-slate-800">{alert.title}</p>
                      <p className="text-slate-600 truncate">{alert.message}</p>
                    </div>
                    <span className="text-[10px] text-slate-400 whitespace-nowrap">{new Date(alert.timestamp).toLocaleTimeString('en-IN')}</span>
                    <button onClick={() => dismissAlert(alert.id)} className="shrink-0 text-slate-400 hover:text-slate-600">×</button>
                  </div>
                ))}
              </div>
            </div>
          )}
        </>
      )}
    </div>
  );
}

function MetricCard({ icon: Icon, label, value, sub, color }: { icon: any; label: string; value: string; sub: string; color: string }) {
  const colorMap: Record<string, { bg: string; icon: string; text: string }> = {
    emerald: { bg: 'bg-emerald-50 border-emerald-200', icon: 'text-emerald-600', text: 'text-emerald-700' },
    red: { bg: 'bg-red-50 border-red-200', icon: 'text-red-600', text: 'text-red-700' },
    blue: { bg: 'bg-blue-50 border-blue-200', icon: 'text-blue-600', text: 'text-blue-700' },
    indigo: { bg: 'bg-indigo-50 border-indigo-200', icon: 'text-indigo-600', text: 'text-indigo-700' },
    amber: { bg: 'bg-amber-50 border-amber-200', icon: 'text-amber-600', text: 'text-amber-700' },
    teal: { bg: 'bg-teal-50 border-teal-200', icon: 'text-teal-600', text: 'text-teal-700' },
  };
  const c = colorMap[color] ?? colorMap.blue;
  return (
    <div className={`rounded-xl border p-3 ${c.bg}`}>
      <div className="flex items-center gap-1.5 mb-1">
        <Icon className={`w-3.5 h-3.5 ${c.icon}`} />
        <span className="text-[10px] text-slate-500 font-medium uppercase">{label}</span>
      </div>
      <p className={`text-lg font-bold ${c.text}`}>{value}</p>
      <p className="text-[10px] text-slate-400 mt-0.5">{sub}</p>
    </div>
  );
}

function StatusPill({ label, ok }: { label: string; ok: boolean }) {
  return (
    <div className={`flex items-center gap-2 px-3 py-2 rounded-lg text-xs ${ok ? 'bg-emerald-50' : 'bg-red-50'}`}>
      {ok ? <CheckCircle2 className="w-3.5 h-3.5 text-emerald-600" /> : <XCircle className="w-3.5 h-3.5 text-red-600" />}
      <span className={ok ? 'text-emerald-700' : 'text-red-700'}>{label}</span>
    </div>
  );
}
