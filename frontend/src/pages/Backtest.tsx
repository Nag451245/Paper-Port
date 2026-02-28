import { useState, useEffect, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import {
  LineChart,
  Line,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
} from 'recharts';
import { Play, Settings, History, Loader2, AlertCircle } from 'lucide-react';
import type {
  StrategyConfig,
  StrategyParameter,
  BacktestResult,
} from '@/types';
import { formatINR } from '@/types';
import { backtestApi } from '@/services/api';

class BacktestErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean; error: string }> {
  constructor(props: { children: ReactNode }) {
    super(props);
    this.state = { hasError: false, error: '' };
  }
  static getDerivedStateFromError(error: Error) {
    return { hasError: true, error: error.message };
  }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Backtest error:', error, info);
  }
  render() {
    if (this.state.hasError) {
      return (
        <div className="flex items-center justify-center h-[60vh]">
          <div className="text-center max-w-md">
            <AlertCircle className="mx-auto mb-3 h-10 w-10 text-red-400" />
            <h2 className="text-lg font-bold text-slate-900 mb-2">Something went wrong</h2>
            <p className="text-sm text-slate-500 mb-4">{this.state.error}</p>
            <button onClick={() => { this.setState({ hasError: false, error: '' }); window.location.reload(); }} className="px-4 py-2 bg-indigo-600 text-white text-sm rounded-lg hover:bg-indigo-500">
              Reload Page
            </button>
          </div>
        </div>
      );
    }
    return this.props.children;
  }
}

function normalizeResult(r: any): BacktestResult {
  let equityCurve = r.equityCurve;
  if (typeof equityCurve === 'string') {
    try { equityCurve = JSON.parse(equityCurve); } catch { equityCurve = []; }
  }
  if (!Array.isArray(equityCurve)) equityCurve = [];

  let trades = r.trades ?? r.tradeLog;
  if (typeof trades === 'string') {
    try { trades = JSON.parse(trades); } catch { trades = []; }
  }
  if (!Array.isArray(trades)) trades = [];

  return {
    ...r,
    cagr: Number(r.cagr) || 0,
    sharpeRatio: Number(r.sharpeRatio ?? r.sharpe_ratio) || 0,
    sortinoRatio: Number(r.sortinoRatio ?? r.sortino_ratio) || 0,
    maxDrawdown: Number(r.maxDrawdown ?? r.max_drawdown) || 0,
    winRate: Number(r.winRate ?? r.win_rate) || 0,
    profitFactor: Number(r.profitFactor ?? r.profit_factor) || 0,
    totalTrades: Number(r.totalTrades ?? r.total_trades) || 0,
    equityCurve,
    trades,
  };
}

const SAMPLE_STRATEGIES: StrategyConfig[] = [
  {
    id: 'orb',
    name: 'Opening Range Breakout',
    parameters: [
      { key: 'rangePeriod', label: 'Range Period (bars)', type: 'number', defaultValue: 15, min: 5, max: 60, step: 5 },
      { key: 'targetPercent', label: 'Target %', type: 'number', defaultValue: 1.5, min: 0.5, max: 5, step: 0.1 },
      { key: 'stopLoss', label: 'Stop Loss %', type: 'number', defaultValue: 0.75, min: 0.25, max: 3, step: 0.25 },
    ],
  },
  {
    id: 'sma_crossover',
    name: 'SMA Crossover',
    parameters: [
      { key: 'shortPeriod', label: 'Short SMA Period', type: 'number', defaultValue: 10, min: 5, max: 30, step: 1 },
      { key: 'longPeriod', label: 'Long SMA Period', type: 'number', defaultValue: 30, min: 15, max: 100, step: 5 },
    ],
  },
  {
    id: 'momentum',
    name: 'Momentum',
    parameters: [
      { key: 'lookback', label: 'Lookback Days', type: 'number', defaultValue: 20, min: 5, max: 50, step: 1 },
      { key: 'holdDays', label: 'Hold Days', type: 'number', defaultValue: 10, min: 3, max: 30, step: 1 },
    ],
  },
  {
    id: 'mean_reversion',
    name: 'Mean Reversion',
    parameters: [
      { key: 'period', label: 'Bollinger Period', type: 'number', defaultValue: 20, min: 10, max: 50, step: 1 },
      { key: 'threshold', label: 'Z-Score Threshold', type: 'number', defaultValue: 2, min: 1, max: 3, step: 0.5 },
    ],
  },
  {
    id: 'rsi_reversal',
    name: 'RSI Reversal',
    parameters: [
      { key: 'period', label: 'RSI Period', type: 'number', defaultValue: 14, min: 7, max: 21, step: 1 },
      { key: 'oversold', label: 'Oversold Level', type: 'number', defaultValue: 30, min: 15, max: 40, step: 5 },
      { key: 'overbought', label: 'Overbought Level', type: 'number', defaultValue: 70, min: 60, max: 85, step: 5 },
    ],
  },
];

function BacktestInner() {
  const [selectedStrategy, setSelectedStrategy] = useState(SAMPLE_STRATEGIES[0]);
  const [params, setParams] = useState<Record<string, number | string | boolean>>(() =>
    Object.fromEntries(selectedStrategy.parameters.map((p) => [p.key, p.defaultValue])),
  );
  const [symbol, setSymbol] = useState('NIFTY');
  const [startDate, setStartDate] = useState('2025-01-01');
  const [endDate, setEndDate] = useState('2025-12-31');
  const [initialCapital, setInitialCapital] = useState(1000000);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [pastResults, setPastResults] = useState<BacktestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleStrategyChange = (id: string) => {
    const strat = SAMPLE_STRATEGIES.find((s) => s.id === id)!;
    setSelectedStrategy(strat);
    setParams(Object.fromEntries(strat.parameters.map((p) => [p.key, p.defaultValue])));
    setResult(null);
    setError(null);
  };

  useEffect(() => {
    backtestApi.results()
      .then(({ data }) => {
        const results = Array.isArray(data) ? data : [];
        setPastResults(results.map(normalizeResult));
      })
      .catch(() => { });
  }, []);

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const { data } = await backtestApi.run({
        strategyId: selectedStrategy.id,
        symbol,
        startDate,
        endDate,
        initialCapital,
        parameters: params,
      });
      const normalized = normalizeResult(data);
      setResult(normalized);
      setPastResults((prev) => [normalized, ...prev]);
    } catch (err: any) {
      let errorMsg = 'Backtest failed';
      const detail = err?.response?.data?.detail;
      if (detail) {
        if (typeof detail === 'string') errorMsg = detail;
        else if (Array.isArray(detail)) errorMsg = detail.map((e: any) => e.msg).join(', ');
        else errorMsg = JSON.stringify(detail);
      } else if (err?.response?.data?.error) {
        errorMsg = typeof err.response.data.error === 'string' ? err.response.data.error : JSON.stringify(err.response.data.error);
      } else if (err?.message) {
        errorMsg = err.message;
      }
      setError(errorMsg);
    } finally {
      setRunning(false);
    }
  };

  return (
    <div className="space-y-6">
      <h1 className="text-xl font-bold text-slate-900">Backtesting Engine</h1>

      <div className="grid grid-cols-1 gap-6 lg:grid-cols-3">
        {/* Config panel */}
        <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="mb-4 flex items-center gap-2">
            <Settings className="h-4 w-4 text-slate-400" />
            <h2 className="text-sm font-medium text-slate-500">Configuration</h2>
          </div>

          <label className="mb-1 block text-xs text-slate-500">Strategy</label>
          <select
            value={selectedStrategy.id}
            onChange={(e) => handleStrategyChange(e.target.value)}
            className="mb-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
          >
            {SAMPLE_STRATEGIES.map((s) => (
              <option key={s.id} value={s.id}>{s.name}</option>
            ))}
          </select>

          <label className="mb-1 block text-xs text-slate-500">Symbol</label>
          <input
            type="text"
            value={symbol}
            onChange={(e) => setSymbol(e.target.value.toUpperCase())}
            placeholder="e.g. NIFTY, RELIANCE, GOLD, USDINR"
            className="mb-4 w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
          />

          {selectedStrategy.parameters.map((p) => (
            <ParamInput
              key={p.key}
              param={p}
              value={params[p.key]}
              onChange={(v) => setParams((prev) => ({ ...prev, [p.key]: v }))}
            />
          ))}

          <div className="mt-4 grid grid-cols-2 gap-3">
            <div>
              <label className="mb-1 block text-xs text-slate-500">Start Date</label>
              <input
                type="date"
                value={startDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
              />
            </div>
            <div>
              <label className="mb-1 block text-xs text-slate-500">End Date</label>
              <input
                type="date"
                value={endDate}
                onChange={(e) => setEndDate(e.target.value)}
                className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
              />
            </div>
          </div>

          <div className="mt-4">
            <label className="mb-1 block text-xs text-slate-500">Initial Capital (₹)</label>
            <input
              type="number"
              value={initialCapital}
              onChange={(e) => setInitialCapital(Number(e.target.value))}
              min={100000}
              step={100000}
              className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
            />
          </div>

          {error && (
            <div className="mt-3 flex items-center gap-2 rounded-lg bg-red-50 border border-red-200 px-3 py-2 text-xs text-red-600">
              <AlertCircle className="h-3.5 w-3.5 shrink-0" />
              <span>{error}</span>
            </div>
          )}

          <button
            onClick={handleRun}
            disabled={running || !symbol.trim()}
            className="mt-5 flex w-full items-center justify-center gap-2 rounded-lg bg-indigo-600 py-2.5 text-sm font-semibold text-white transition-colors hover:bg-indigo-500 disabled:opacity-50"
          >
            {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
            {running ? 'Running...' : 'Run Backtest'}
          </button>
        </div>

        {/* Results */}
        <div className="space-y-4 lg:col-span-2">
          {result ? (
            <>
              <div className="grid grid-cols-3 gap-3 sm:grid-cols-6">
                <MetricBox label="CAGR" value={`${result.cagr.toFixed(1)}%`} positive={result.cagr > 0} />
                <MetricBox label="Max DD" value={`${result.maxDrawdown.toFixed(1)}%`} positive={Math.abs(result.maxDrawdown) < 15} />
                <MetricBox label="Sharpe" value={result.sharpeRatio.toFixed(2)} positive={result.sharpeRatio > 1} />
                <MetricBox label="Sortino" value={result.sortinoRatio.toFixed(2)} positive={result.sortinoRatio > 1.5} />
                <MetricBox label="Win Rate" value={`${result.winRate.toFixed(1)}%`} positive={result.winRate > 50} />
                <MetricBox label="PF" value={result.profitFactor.toFixed(2)} positive={result.profitFactor > 1.5} />
              </div>

              {/* Equity curve */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="mb-3 text-sm font-medium text-slate-500">Equity Curve</h3>
                <div className="h-[280px]">
                  <ResponsiveContainer width="100%" height="100%">
                    <LineChart data={result.equityCurve.map((p) => ({ ...p, val: p.nav ?? p.value ?? 0 }))} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                      <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                      <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#cbd5e1' }} />
                      <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={{ stroke: '#cbd5e1' }} tickFormatter={(v) => `₹${(Number(v) / 100000).toFixed(1)}L`} />
                      <Tooltip
                        contentStyle={{ backgroundColor: '#ffffff', border: '1px solid #e2e8f0', borderRadius: 8, fontSize: 12 }}
                        formatter={(value) => [formatINR(value as number), 'NAV']}
                      />
                      <Line type="monotone" dataKey="val" stroke="#10b981" strokeWidth={2} dot={false} />
                    </LineChart>
                  </ResponsiveContainer>
                </div>
              </div>

              {/* Trade log */}
              <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
                <h3 className="mb-3 text-sm font-medium text-slate-500">
                  Trade Log ({result.totalTrades} trades)
                </h3>
                {result.trades && result.trades.length > 0 ? (
                  <div className="overflow-x-auto max-h-[300px] overflow-y-auto">
                    <table className="w-full text-xs">
                      <thead>
                        <tr className="text-slate-400 border-b border-slate-200">
                          <th className="text-left pb-2 font-medium">Entry</th>
                          <th className="text-left pb-2 font-medium">Exit</th>
                          <th className="text-center pb-2 font-medium">Side</th>
                          <th className="text-right pb-2 font-medium">Qty</th>
                          <th className="text-right pb-2 font-medium">Entry ₹</th>
                          <th className="text-right pb-2 font-medium">Exit ₹</th>
                          <th className="text-right pb-2 font-medium">P&L</th>
                          <th className="text-right pb-2 font-medium">%</th>
                        </tr>
                      </thead>
                      <tbody>
                        {result.trades.slice(0, 50).map((t: any, idx: number) => {
                          const pnl = Number(t.pnl ?? 0);
                          return (
                            <tr key={idx} className="border-b border-slate-100 hover:bg-slate-50/50">
                              <td className="py-1.5 text-slate-600">{t.entryDate ?? t.entry_date ?? ''}</td>
                              <td className="py-1.5 text-slate-600">{t.exitDate ?? t.exit_date ?? ''}</td>
                              <td className="py-1.5 text-center">
                                <span className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${t.side === 'LONG' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'}`}>{t.side}</span>
                              </td>
                              <td className="py-1.5 text-right font-mono text-slate-600">{t.qty}</td>
                              <td className="py-1.5 text-right font-mono text-slate-600">₹{Number(t.entryPrice ?? t.entry_price ?? 0).toFixed(2)}</td>
                              <td className="py-1.5 text-right font-mono text-slate-600">₹{Number(t.exitPrice ?? t.exit_price ?? 0).toFixed(2)}</td>
                              <td className={`py-1.5 text-right font-mono font-semibold ${pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                {pnl >= 0 ? '+' : ''}₹{pnl.toFixed(0)}
                              </td>
                              <td className={`py-1.5 text-right font-mono ${Number(t.pnlPercent ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                                {Number(t.pnlPercent ?? 0).toFixed(2)}%
                              </td>
                            </tr>
                          );
                        })}
                      </tbody>
                    </table>
                    {result.trades.length > 50 && (
                      <p className="text-xs text-slate-400 mt-2 text-center">Showing first 50 of {result.trades.length} trades</p>
                    )}
                  </div>
                ) : (
                  <div className="flex h-[100px] items-center justify-center rounded-lg border border-dashed border-slate-300 bg-slate-50">
                    <p className="text-sm text-slate-400">No trades generated for this backtest</p>
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="flex h-[400px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white">
              <div className="text-center">
                <Play className="mx-auto mb-3 h-8 w-8 text-slate-300" />
                <p className="text-sm text-slate-400">Configure parameters and run a backtest</p>
                <p className="mt-1 text-xs text-slate-300">Results will appear here</p>
              </div>
            </div>
          )}

          {pastResults.length > 0 && (
            <div className="rounded-xl border border-slate-200 bg-white p-5 shadow-sm">
              <div className="flex items-center gap-2 mb-3">
                <History className="h-4 w-4 text-slate-400" />
                <h3 className="text-sm font-medium text-slate-500">Past Results ({pastResults.length})</h3>
              </div>
              <div className="space-y-2 max-h-[200px] overflow-y-auto">
                {pastResults.slice(0, 10).map((r, i) => (
                  <button
                    key={r.id ?? i}
                    onClick={() => setResult(r)}
                    className="w-full flex items-center justify-between px-3 py-2 rounded-lg bg-slate-50 hover:bg-slate-100 text-left transition-colors"
                  >
                    <div>
                      <span className="text-xs font-medium text-slate-700">{r.strategyId ?? 'Strategy'}</span>
                      <span className="text-[10px] text-slate-400 ml-2">{r.symbol ?? ''}</span>
                    </div>
                    <div className="flex items-center gap-3 text-xs">
                      <span className={`font-mono ${r.cagr >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{r.cagr.toFixed(1)}%</span>
                      <span className="text-slate-400">{r.totalTrades} trades</span>
                    </div>
                  </button>
                ))}
              </div>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

export default function Backtest() {
  return (
    <BacktestErrorBoundary>
      <BacktestInner />
    </BacktestErrorBoundary>
  );
}

function ParamInput({
  param,
  value,
  onChange,
}: {
  param: StrategyParameter;
  value: number | string | boolean;
  onChange: (v: number | string | boolean) => void;
}) {
  if (param.type === 'boolean') {
    return (
      <label className="mb-3 flex items-center gap-2">
        <input
          type="checkbox"
          checked={value as boolean}
          onChange={(e) => onChange(e.target.checked)}
          className="rounded border-slate-300 bg-white"
        />
        <span className="text-sm text-slate-700">{param.label}</span>
      </label>
    );
  }

  return (
    <div className="mb-3">
      <label className="mb-1 block text-xs text-slate-500">{param.label}</label>
      <input
        type={param.type === 'number' ? 'number' : 'text'}
        value={value as string | number}
        min={param.min}
        max={param.max}
        step={param.step}
        onChange={(e) =>
          onChange(param.type === 'number' ? +e.target.value : e.target.value)
        }
        className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500"
      />
    </div>
  );
}

function MetricBox({ label, value, positive }: { label: string; value: string; positive: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3 text-center shadow-sm">
      <p className="mb-1 text-[10px] text-slate-400">{label}</p>
      <p className={`text-base font-bold ${positive ? 'text-emerald-600' : 'text-red-600'}`}>{value}</p>
    </div>
  );
}
