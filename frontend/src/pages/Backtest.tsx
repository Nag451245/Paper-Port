import { useState, useEffect, useMemo, Component } from 'react';
import type { ReactNode, ErrorInfo } from 'react';
import {
  LineChart, Line, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid,
  BarChart, Bar, Cell, PieChart, Pie,
} from 'recharts';
import {
  Play, Loader2, AlertCircle, TrendingUp, BarChart3,
  ChevronRight, ChevronDown, Info, Target, Shield, Zap,
  ArrowUpRight, ArrowDownRight, Clock, DollarSign, Percent, Award,
  History, RotateCcw, HelpCircle, Lightbulb,
} from 'lucide-react';
import type { StrategyConfig, BacktestResult } from '@/types';
import { formatINR } from '@/types';
import { backtestApi } from '@/services/api';

// ─── Error boundary ──────────────────────────────────────────────

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

// ─── Helpers ─────────────────────────────────────────────────────

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

type Segment = 'indices' | 'stocks' | 'fno';
type RiskLevel = 'conservative' | 'moderate' | 'aggressive';

interface StrategyInfo extends StrategyConfig {
  description: string;
  howItWorks: string;
  bestFor: string;
  riskLevel: RiskLevel;
  segments: Segment[];
  icon: typeof TrendingUp;
}

const STRATEGIES: StrategyInfo[] = [
  {
    id: 'orb', name: 'Opening Range Breakout',
    description: 'Trades the breakout of the first 15-minute price range. If price breaks above the high, go long; below the low, go short.',
    howItWorks: 'Captures the momentum that builds after the market opens. Works best on volatile days when a clear direction emerges.',
    bestFor: 'Intraday traders who want quick entries based on morning momentum',
    riskLevel: 'aggressive',
    segments: ['indices', 'stocks', 'fno'],
    icon: Zap,
    parameters: [
      { key: 'rangePeriod', label: 'Opening Range (minutes)', type: 'number', defaultValue: 15, min: 5, max: 60, step: 5 },
      { key: 'targetPercent', label: 'Profit Target %', type: 'number', defaultValue: 1.5, min: 0.5, max: 5, step: 0.1 },
      { key: 'stopLoss', label: 'Stop Loss %', type: 'number', defaultValue: 0.75, min: 0.25, max: 3, step: 0.25 },
    ],
  },
  {
    id: 'sma_crossover', name: 'Moving Average Crossover',
    description: 'Buys when a short-term average crosses above a long-term average (golden cross) and sells on the reverse (death cross).',
    howItWorks: 'Follows trends by comparing two moving averages. When the faster one crosses above the slower one, it signals an uptrend.',
    bestFor: 'Swing traders who want to ride medium-term trends with clear signals',
    riskLevel: 'moderate',
    segments: ['indices', 'stocks'],
    icon: TrendingUp,
    parameters: [
      { key: 'shortPeriod', label: 'Fast MA Period (days)', type: 'number', defaultValue: 10, min: 5, max: 30, step: 1 },
      { key: 'longPeriod', label: 'Slow MA Period (days)', type: 'number', defaultValue: 30, min: 15, max: 100, step: 5 },
    ],
  },
  {
    id: 'momentum', name: 'Momentum',
    description: 'Buys stocks that have been going up recently, betting that the trend continues. Sells when momentum fades.',
    howItWorks: 'Measures how much a stock has risen over a lookback period. Stocks with strong momentum tend to keep rising in the short term.',
    bestFor: 'Traders who believe "the trend is your friend" and want to ride strong moves',
    riskLevel: 'aggressive',
    segments: ['indices', 'stocks', 'fno'],
    icon: ArrowUpRight,
    parameters: [
      { key: 'lookback', label: 'Lookback Period (days)', type: 'number', defaultValue: 20, min: 5, max: 50, step: 1 },
      { key: 'holdDays', label: 'Hold Period (days)', type: 'number', defaultValue: 10, min: 3, max: 30, step: 1 },
    ],
  },
  {
    id: 'mean_reversion', name: 'Mean Reversion',
    description: 'Buys when price drops unusually far below average (oversold) and sells when it rises too far above (overbought).',
    howItWorks: 'Uses Bollinger Bands to detect extremes. When price is 2 standard deviations below the mean, it buys expecting a bounce back.',
    bestFor: 'Range-bound markets where prices oscillate around a mean',
    riskLevel: 'moderate',
    segments: ['indices', 'stocks'],
    icon: RotateCcw,
    parameters: [
      { key: 'period', label: 'Lookback Period (days)', type: 'number', defaultValue: 20, min: 10, max: 50, step: 1 },
      { key: 'threshold', label: 'Deviation Threshold', type: 'number', defaultValue: 2, min: 1, max: 3, step: 0.5 },
    ],
  },
  {
    id: 'rsi_reversal', name: 'RSI Reversal',
    description: 'Buys when RSI drops below 30 (oversold) and sells when it rises above 70 (overbought). A classic indicator-based strategy.',
    howItWorks: 'RSI measures the speed of price changes on a 0-100 scale. Below 30 means the stock is oversold and may bounce; above 70 means overbought.',
    bestFor: 'Beginners who want a simple, well-known indicator-based strategy',
    riskLevel: 'conservative',
    segments: ['indices', 'stocks', 'fno'],
    icon: Target,
    parameters: [
      { key: 'period', label: 'RSI Period (days)', type: 'number', defaultValue: 14, min: 7, max: 21, step: 1 },
      { key: 'oversold', label: 'Buy when RSI below', type: 'number', defaultValue: 30, min: 15, max: 40, step: 5 },
      { key: 'overbought', label: 'Sell when RSI above', type: 'number', defaultValue: 70, min: 60, max: 85, step: 5 },
    ],
  },
];

const POPULAR_SYMBOLS: Record<Segment, { label: string; value: string }[]> = {
  indices: [
    { label: 'Nifty 50', value: 'NIFTY' },
    { label: 'Bank Nifty', value: 'BANKNIFTY' },
    { label: 'Fin Nifty', value: 'FINNIFTY' },
    { label: 'Sensex', value: 'SENSEX' },
  ],
  stocks: [
    { label: 'Reliance', value: 'RELIANCE' },
    { label: 'TCS', value: 'TCS' },
    { label: 'HDFC Bank', value: 'HDFCBANK' },
    { label: 'Infosys', value: 'INFY' },
    { label: 'ICICI Bank', value: 'ICICIBANK' },
    { label: 'SBI', value: 'SBIN' },
    { label: 'Bharti Airtel', value: 'BHARTIARTL' },
    { label: 'ITC', value: 'ITC' },
  ],
  fno: [
    { label: 'Nifty Options', value: 'NIFTY' },
    { label: 'Bank Nifty Options', value: 'BANKNIFTY' },
    { label: 'Reliance F&O', value: 'RELIANCE' },
    { label: 'TCS F&O', value: 'TCS' },
    { label: 'HDFC Bank F&O', value: 'HDFCBANK' },
    { label: 'Infosys F&O', value: 'INFY' },
  ],
};

const RISK_COLORS: Record<RiskLevel, { bg: string; text: string; dot: string; label: string }> = {
  conservative: { bg: 'bg-emerald-50', text: 'text-emerald-700', dot: 'bg-emerald-500', label: 'Low Risk' },
  moderate: { bg: 'bg-amber-50', text: 'text-amber-700', dot: 'bg-amber-500', label: 'Medium Risk' },
  aggressive: { bg: 'bg-red-50', text: 'text-red-700', dot: 'bg-red-500', label: 'High Risk' },
};

const SEGMENT_LABELS: Record<Segment, string> = { indices: 'Indices', stocks: 'Stocks', fno: 'F&O' };

const CAPITAL_PRESETS = [100000, 500000, 1000000, 2500000, 5000000];

// ─── Main Component ──────────────────────────────────────────────

function BacktestInner() {
  const [step, setStep] = useState(1);
  const [segment, setSegment] = useState<Segment>('indices');
  const [selectedStrategy, setSelectedStrategy] = useState<StrategyInfo>(STRATEGIES[4]);
  const [params, setParams] = useState<Record<string, number | string | boolean>>(() =>
    Object.fromEntries(selectedStrategy.parameters.map((p) => [p.key, p.defaultValue])),
  );
  const [symbol, setSymbol] = useState('NIFTY');
  const [customSymbol, setCustomSymbol] = useState('');
  const [startDate, setStartDate] = useState('2025-01-01');
  const [endDate, setEndDate] = useState('2025-12-31');
  const [initialCapital, setInitialCapital] = useState(1000000);
  const [result, setResult] = useState<BacktestResult | null>(null);
  const [pastResults, setPastResults] = useState<BacktestResult[]>([]);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showExplainer, setShowExplainer] = useState<string | null>(null);
  const [showPast, setShowPast] = useState(false);

  const filteredStrategies = useMemo(() =>
    STRATEGIES.filter(s => s.segments.includes(segment)),
  [segment]);

  useEffect(() => {
    backtestApi.results()
      .then(({ data }) => {
        const results = Array.isArray(data) ? data : [];
        setPastResults(results.map(normalizeResult));
      })
      .catch(() => {});
  }, []);

  const handleStrategySelect = (strat: StrategyInfo) => {
    setSelectedStrategy(strat);
    setParams(Object.fromEntries(strat.parameters.map((p) => [p.key, p.defaultValue])));
    setResult(null);
    setError(null);
  };

  const handleSegmentChange = (seg: Segment) => {
    setSegment(seg);
    const available = STRATEGIES.filter(s => s.segments.includes(seg));
    if (!available.find(s => s.id === selectedStrategy.id)) {
      handleStrategySelect(available[0]);
    }
    setSymbol(POPULAR_SYMBOLS[seg][0].value);
  };

  const handleRun = async () => {
    setRunning(true);
    setError(null);
    try {
      const { data } = await backtestApi.run({
        strategyId: selectedStrategy.id,
        symbol: customSymbol || symbol,
        startDate,
        endDate,
        initialCapital,
        parameters: params,
      });
      const normalized = normalizeResult(data);
      setResult(normalized);
      setPastResults((prev) => [normalized, ...prev]);
      setStep(3);
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

  const totalReturn = result ? ((result.equityCurve.at(-1)?.nav ?? result.equityCurve.at(-1)?.value ?? initialCapital) - initialCapital) : 0;
  const totalReturnPct = result ? (totalReturn / initialCapital * 100) : 0;
  const winCount = result ? result.trades.filter((t: any) => (Number(t.pnl) || 0) > 0).length : 0;
  const lossCount = result ? result.trades.filter((t: any) => (Number(t.pnl) || 0) < 0).length : 0;

  return (
    <div className="space-y-6 max-w-6xl mx-auto">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Backtest Lab</h1>
          <p className="text-sm text-slate-500 mt-0.5">Test trading strategies on historical data before risking real money</p>
        </div>
        {pastResults.length > 0 && (
          <button onClick={() => setShowPast(!showPast)} className="flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-xs font-medium text-slate-600 bg-slate-100 hover:bg-slate-200 transition-colors">
            <History className="h-3.5 w-3.5" />
            Past Results ({pastResults.length})
          </button>
        )}
      </div>

      {/* Step indicator */}
      <div className="flex items-center gap-2">
        {[
          { n: 1, label: 'Choose Strategy' },
          { n: 2, label: 'Configure & Run' },
          { n: 3, label: 'View Results' },
        ].map(({ n, label }) => (
          <button key={n} onClick={() => (n <= 2 || result) && setStep(n)} className={`flex items-center gap-2 px-4 py-2 rounded-full text-xs font-semibold transition-all ${
            step === n ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200' : step > n ? 'bg-emerald-50 text-emerald-700 cursor-pointer' : 'bg-slate-100 text-slate-400'
          }`}>
            <span className={`w-5 h-5 flex items-center justify-center rounded-full text-[10px] font-bold ${
              step === n ? 'bg-white/20' : step > n ? 'bg-emerald-200 text-emerald-700' : 'bg-slate-200'
            }`}>{step > n ? '✓' : n}</span>
            {label}
          </button>
        ))}
      </div>

      {/* ─── STEP 1: Choose Strategy ─── */}
      {step === 1 && (
        <div className="space-y-5">
          {/* Segment selector */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
              <BarChart3 className="w-4 h-4 text-indigo-500" />
              What do you want to backtest?
            </h2>
            <div className="grid grid-cols-3 gap-3">
              {(['indices', 'stocks', 'fno'] as Segment[]).map(seg => (
                <button key={seg} onClick={() => handleSegmentChange(seg)} className={`p-4 rounded-xl border-2 text-left transition-all ${
                  segment === seg
                    ? 'border-indigo-500 bg-indigo-50 shadow-sm'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}>
                  <p className={`text-sm font-semibold ${segment === seg ? 'text-indigo-700' : 'text-slate-700'}`}>
                    {SEGMENT_LABELS[seg]}
                  </p>
                  <p className="text-xs text-slate-400 mt-0.5">
                    {seg === 'indices' && 'Nifty, Bank Nifty, Sensex'}
                    {seg === 'stocks' && 'Individual company stocks'}
                    {seg === 'fno' && 'Futures & Options strategies'}
                  </p>
                </button>
              ))}
            </div>
          </div>

          {/* Strategy cards */}
          <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
            <h2 className="text-sm font-semibold text-slate-700 mb-4 flex items-center gap-2">
              <Lightbulb className="w-4 h-4 text-amber-500" />
              Pick a strategy
              <span className="text-xs font-normal text-slate-400 ml-1">({filteredStrategies.length} available)</span>
            </h2>
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-3">
              {filteredStrategies.map(strat => {
                const Icon = strat.icon;
                const risk = RISK_COLORS[strat.riskLevel];
                const isSelected = selectedStrategy.id === strat.id;
                return (
                  <button key={strat.id} onClick={() => handleStrategySelect(strat)} className={`p-4 rounded-xl border-2 text-left transition-all group ${
                    isSelected
                      ? 'border-indigo-500 bg-indigo-50/50 shadow-md shadow-indigo-100'
                      : 'border-slate-200 hover:border-indigo-300 hover:shadow-sm bg-white'
                  }`}>
                    <div className="flex items-start justify-between mb-2">
                      <div className={`w-8 h-8 rounded-lg flex items-center justify-center ${
                        isSelected ? 'bg-indigo-100' : 'bg-slate-100 group-hover:bg-indigo-50'
                      }`}>
                        <Icon className={`w-4 h-4 ${isSelected ? 'text-indigo-600' : 'text-slate-500 group-hover:text-indigo-500'}`} />
                      </div>
                      <span className={`inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-medium ${risk.bg} ${risk.text}`}>
                        <span className={`w-1.5 h-1.5 rounded-full ${risk.dot}`} />
                        {risk.label}
                      </span>
                    </div>
                    <p className={`text-sm font-semibold mb-1 ${isSelected ? 'text-indigo-700' : 'text-slate-800'}`}>{strat.name}</p>
                    <p className="text-xs text-slate-500 leading-relaxed line-clamp-2">{strat.description}</p>

                    {isSelected && (
                      <div className="mt-3 pt-3 border-t border-indigo-200/50">
                        <button onClick={(e) => { e.stopPropagation(); setShowExplainer(showExplainer === strat.id ? null : strat.id); }}
                          className="flex items-center gap-1 text-[10px] text-indigo-600 font-medium hover:text-indigo-700">
                          <HelpCircle className="w-3 h-3" />
                          {showExplainer === strat.id ? 'Hide details' : 'How does this work?'}
                        </button>
                        {showExplainer === strat.id && (
                          <div className="mt-2 p-3 rounded-lg bg-indigo-100/50 text-xs text-indigo-800 space-y-2">
                            <p><strong>How it works:</strong> {strat.howItWorks}</p>
                            <p><strong>Best for:</strong> {strat.bestFor}</p>
                          </div>
                        )}
                      </div>
                    )}
                  </button>
                );
              })}
            </div>
          </div>

          <button onClick={() => setStep(2)} className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-500 transition-colors shadow-md shadow-indigo-200">
            Continue to Configuration <ChevronRight className="w-4 h-4" />
          </button>
        </div>
      )}

      {/* ─── STEP 2: Configure & Run ─── */}
      {step === 2 && (
        <div className="grid grid-cols-1 lg:grid-cols-5 gap-5">
          {/* Left: Config */}
          <div className="lg:col-span-2 space-y-4">
            {/* Strategy summary */}
            <div className="rounded-2xl border border-indigo-200 bg-indigo-50/30 p-4">
              <div className="flex items-center gap-3 mb-2">
                <div className="w-9 h-9 rounded-lg bg-indigo-100 flex items-center justify-center">
                  <selectedStrategy.icon className="w-4.5 h-4.5 text-indigo-600" />
                </div>
                <div>
                  <p className="text-sm font-semibold text-indigo-800">{selectedStrategy.name}</p>
                  <span className={`inline-flex items-center gap-1 text-[10px] font-medium ${RISK_COLORS[selectedStrategy.riskLevel].text}`}>
                    <span className={`w-1.5 h-1.5 rounded-full ${RISK_COLORS[selectedStrategy.riskLevel].dot}`} />
                    {RISK_COLORS[selectedStrategy.riskLevel].label}
                  </span>
                </div>
              </div>
              <p className="text-xs text-indigo-700/70 leading-relaxed">{selectedStrategy.description}</p>
              <button onClick={() => setStep(1)} className="mt-2 text-[10px] font-medium text-indigo-600 hover:text-indigo-700 underline underline-offset-2">
                Change strategy
              </button>
            </div>

            {/* Symbol */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <label className="text-xs font-semibold text-slate-700 mb-2 block">Choose Symbol</label>
              <div className="flex flex-wrap gap-1.5 mb-3">
                {POPULAR_SYMBOLS[segment].map(s => (
                  <button key={s.value} onClick={() => { setSymbol(s.value); setCustomSymbol(''); }}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      symbol === s.value && !customSymbol
                        ? 'bg-indigo-600 text-white shadow-sm'
                        : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}>
                    {s.label}
                  </button>
                ))}
              </div>
              <div className="relative">
                <input
                  type="text"
                  value={customSymbol}
                  onChange={(e) => { setCustomSymbol(e.target.value.toUpperCase()); setSymbol(''); }}
                  placeholder="Or type any symbol (e.g. TATAMOTORS)"
                  className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm text-slate-800 outline-none focus:border-indigo-500 placeholder:text-slate-300"
                />
              </div>
            </div>

            {/* Parameters */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <div className="flex items-center justify-between mb-3">
                <label className="text-xs font-semibold text-slate-700">Strategy Settings</label>
                <button onClick={() => setParams(Object.fromEntries(selectedStrategy.parameters.map(p => [p.key, p.defaultValue])))}
                  className="text-[10px] text-indigo-600 hover:text-indigo-700 font-medium">
                  Reset to defaults
                </button>
              </div>
              {selectedStrategy.parameters.map(p => (
                <div key={p.key} className="mb-3">
                  <div className="flex items-center justify-between mb-1">
                    <label className="text-xs text-slate-500">{p.label}</label>
                    <span className="text-xs font-mono font-semibold text-slate-700">{params[p.key]}</span>
                  </div>
                  {p.type === 'number' && p.min != null && p.max != null ? (
                    <input type="range" min={p.min} max={p.max} step={p.step}
                      value={params[p.key] as number}
                      onChange={(e) => setParams(prev => ({ ...prev, [p.key]: +e.target.value }))}
                      className="w-full h-1.5 rounded-full appearance-none bg-slate-200 accent-indigo-600 cursor-pointer"
                    />
                  ) : (
                    <input type={p.type === 'number' ? 'number' : 'text'} value={params[p.key] as any}
                      onChange={(e) => setParams(prev => ({ ...prev, [p.key]: p.type === 'number' ? +e.target.value : e.target.value }))}
                      className="w-full rounded-lg border border-slate-200 bg-slate-50 px-3 py-2 text-sm outline-none focus:border-indigo-500" />
                  )}
                </div>
              ))}
            </div>

            {/* Date & Capital */}
            <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
              <label className="text-xs font-semibold text-slate-700 mb-3 block">Test Period & Capital</label>
              <div className="grid grid-cols-2 gap-3 mb-3">
                <div>
                  <label className="text-[10px] text-slate-400 mb-0.5 block">From</label>
                  <input type="date" value={startDate} onChange={(e) => setStartDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-indigo-500" />
                </div>
                <div>
                  <label className="text-[10px] text-slate-400 mb-0.5 block">To</label>
                  <input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)}
                    className="w-full rounded-lg border border-slate-200 bg-slate-50 px-2.5 py-2 text-xs text-slate-800 outline-none focus:border-indigo-500" />
                </div>
              </div>
              <label className="text-[10px] text-slate-400 mb-1.5 block">Starting Capital (₹)</label>
              <div className="flex flex-wrap gap-1.5">
                {CAPITAL_PRESETS.map(c => (
                  <button key={c} onClick={() => setInitialCapital(c)}
                    className={`px-3 py-1.5 rounded-lg text-xs font-medium transition-all ${
                      initialCapital === c ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'
                    }`}>
                    ₹{(c / 100000).toFixed(c >= 1000000 ? 0 : 1)}L
                  </button>
                ))}
              </div>
            </div>

            {error && (
              <div className="flex items-center gap-2 rounded-xl bg-red-50 border border-red-200 px-4 py-3 text-xs text-red-600">
                <AlertCircle className="h-4 w-4 shrink-0" />
                <span>{error}</span>
              </div>
            )}

            <button onClick={handleRun} disabled={running || !(symbol || customSymbol).trim()}
              className="w-full flex items-center justify-center gap-2 py-3 rounded-xl bg-indigo-600 text-white text-sm font-semibold hover:bg-indigo-500 disabled:opacity-50 transition-colors shadow-md shadow-indigo-200">
              {running ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />}
              {running ? 'Running Backtest...' : 'Run Backtest'}
            </button>
          </div>

          {/* Right: Preview */}
          <div className="lg:col-span-3">
            <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 h-full flex flex-col items-center justify-center text-center">
              <div className="w-16 h-16 rounded-2xl bg-indigo-50 flex items-center justify-center mb-4">
                <Play className="w-7 h-7 text-indigo-400" />
              </div>
              <h3 className="text-lg font-semibold text-slate-700 mb-2">Ready to test</h3>
              <p className="text-sm text-slate-400 max-w-sm mb-6">
                Click "Run Backtest" to see how <strong className="text-slate-600">{selectedStrategy.name}</strong> would have performed
                on <strong className="text-slate-600">{customSymbol || symbol}</strong> with ₹{(initialCapital / 100000).toFixed(initialCapital >= 1000000 ? 0 : 1)}L capital
              </p>

              <div className="rounded-xl bg-slate-50 border border-slate-200 p-4 w-full max-w-sm text-left">
                <p className="text-[10px] font-semibold text-slate-500 uppercase tracking-wider mb-2">What you'll see</p>
                <ul className="space-y-2 text-xs text-slate-600">
                  <li className="flex items-center gap-2"><TrendingUp className="w-3.5 h-3.5 text-emerald-500 shrink-0" /> How your capital would have grown or shrunk</li>
                  <li className="flex items-center gap-2"><Target className="w-3.5 h-3.5 text-indigo-500 shrink-0" /> Win rate, return %, and risk metrics</li>
                  <li className="flex items-center gap-2"><Clock className="w-3.5 h-3.5 text-amber-500 shrink-0" /> Complete log of every trade the strategy made</li>
                  <li className="flex items-center gap-2"><Shield className="w-3.5 h-3.5 text-violet-500 shrink-0" /> Maximum drawdown — the worst peak-to-trough drop</li>
                </ul>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* ─── STEP 3: Results ─── */}
      {step === 3 && result && (
        <div className="space-y-5">
          {/* Headline result */}
          <div className={`rounded-2xl p-6 ${totalReturn >= 0 ? 'bg-gradient-to-r from-emerald-50 to-emerald-100/30 border border-emerald-200' : 'bg-gradient-to-r from-red-50 to-red-100/30 border border-red-200'}`}>
            <div className="flex items-center justify-between">
              <div>
                <p className="text-xs font-medium text-slate-500 mb-1">
                  {selectedStrategy.name} on {customSymbol || symbol || result.symbol} &middot; {startDate} to {endDate}
                </p>
                <div className="flex items-baseline gap-3">
                  <p className={`text-3xl font-bold ${totalReturn >= 0 ? 'text-emerald-700' : 'text-red-700'}`}>
                    {totalReturn >= 0 ? '+' : ''}{formatINR(totalReturn)}
                  </p>
                  <span className={`text-lg font-semibold ${totalReturn >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    ({totalReturnPct >= 0 ? '+' : ''}{totalReturnPct.toFixed(1)}%)
                  </span>
                </div>
                <p className="text-xs text-slate-500 mt-1">
                  Starting ₹{(initialCapital / 100000).toFixed(1)}L → Final {formatINR(initialCapital + totalReturn)}
                </p>
              </div>
              <div className={`w-14 h-14 rounded-2xl flex items-center justify-center ${totalReturn >= 0 ? 'bg-emerald-200/50' : 'bg-red-200/50'}`}>
                {totalReturn >= 0 ? <ArrowUpRight className="w-7 h-7 text-emerald-600" /> : <ArrowDownRight className="w-7 h-7 text-red-600" />}
              </div>
            </div>
          </div>

          {/* Key metrics */}
          <div className="grid grid-cols-2 sm:grid-cols-3 lg:grid-cols-6 gap-3">
            <MetricCard icon={Percent} label="CAGR" value={`${result.cagr.toFixed(1)}%`}
              hint="Compound Annual Growth Rate — yearly return if compounded"
              positive={result.cagr > 0} />
            <MetricCard icon={Shield} label="Max Drawdown" value={`${result.maxDrawdown.toFixed(1)}%`}
              hint="Worst peak-to-trough fall — lower is safer"
              positive={Math.abs(result.maxDrawdown) < 15} />
            <MetricCard icon={Award} label="Win Rate" value={`${result.winRate.toFixed(0)}%`}
              hint="Percentage of profitable trades out of total"
              positive={result.winRate > 50} />
            <MetricCard icon={TrendingUp} label="Sharpe" value={result.sharpeRatio.toFixed(2)}
              hint="Risk-adjusted return — above 1.0 is good, above 2.0 is excellent"
              positive={result.sharpeRatio > 1} />
            <MetricCard icon={DollarSign} label="Profit Factor" value={result.profitFactor.toFixed(2)}
              hint="Total profits ÷ total losses — above 1.5 is strong"
              positive={result.profitFactor > 1.5} />
            <MetricCard icon={BarChart3} label="Total Trades" value={String(result.totalTrades)}
              hint="Number of trades the strategy executed" positive />
          </div>

          {/* Equity curve + Win/Loss */}
          <div className="grid grid-cols-1 lg:grid-cols-4 gap-5">
            <div className="lg:col-span-3 rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <TrendingUp className="w-4 h-4 text-emerald-500" />
                Portfolio Growth
              </h3>
              <div className="h-[300px]">
                <ResponsiveContainer width="100%" height="100%">
                  <LineChart data={result.equityCurve.map(p => ({ ...p, val: p.nav ?? p.value ?? 0 }))} margin={{ top: 5, right: 10, left: 10, bottom: 5 }}>
                    <defs>
                      <linearGradient id="eqGrad" x1="0" y1="0" x2="0" y2="1">
                        <stop offset="0%" stopColor="#10b981" stopOpacity={0.15} />
                        <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                      </linearGradient>
                    </defs>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="date" tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 10 }} tickLine={false} axisLine={false}
                      tickFormatter={v => `₹${(Number(v) / 100000).toFixed(1)}L`} />
                    <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, fontSize: 12, boxShadow: '0 4px 12px rgba(0,0,0,0.08)' }}
                      formatter={value => [formatINR(value as number), 'Portfolio Value']} />
                    <Line type="monotone" dataKey="val" stroke="#10b981" strokeWidth={2.5} dot={false} fill="url(#eqGrad)" />
                  </LineChart>
                </ResponsiveContainer>
              </div>
            </div>

            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm flex flex-col justify-between">
              <div>
                <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                  <Target className="w-4 h-4 text-indigo-500" /> Trade Breakdown
                </h3>
                <div className="flex justify-center mb-4">
                  <PieChart width={140} height={140}>
                    <Pie data={[{ name: 'Wins', value: winCount || 1 }, { name: 'Losses', value: lossCount || 1 }]}
                      cx="50%" cy="50%" innerRadius={40} outerRadius={60} paddingAngle={4} dataKey="value" strokeWidth={0}>
                      <Cell fill="#10b981" />
                      <Cell fill="#ef4444" />
                    </Pie>
                  </PieChart>
                </div>
              </div>
              <div className="space-y-2">
                <div className="flex items-center justify-between p-2 rounded-lg bg-emerald-50">
                  <span className="text-xs font-medium text-emerald-700">Winning Trades</span>
                  <span className="text-sm font-bold text-emerald-700">{winCount}</span>
                </div>
                <div className="flex items-center justify-between p-2 rounded-lg bg-red-50">
                  <span className="text-xs font-medium text-red-700">Losing Trades</span>
                  <span className="text-sm font-bold text-red-700">{lossCount}</span>
                </div>
                <div className="flex items-center justify-between p-2 rounded-lg bg-slate-50">
                  <span className="text-xs font-medium text-slate-600">Sortino Ratio</span>
                  <span className="text-sm font-bold text-slate-700">{result.sortinoRatio.toFixed(2)}</span>
                </div>
              </div>
            </div>
          </div>

          {/* Trade P&L bar chart */}
          {result.trades.length > 0 && (
            <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
              <h3 className="text-sm font-semibold text-slate-700 mb-3 flex items-center gap-2">
                <BarChart3 className="w-4 h-4 text-violet-500" /> Trade-by-Trade P&L
              </h3>
              <div className="h-[160px]">
                <ResponsiveContainer width="100%" height="100%">
                  <BarChart data={result.trades.slice(0, 50).map((t: any, i: number) => ({
                    idx: i + 1,
                    pnl: Number(t.pnl ?? 0),
                  }))}>
                    <CartesianGrid strokeDasharray="3 3" stroke="#f1f5f9" />
                    <XAxis dataKey="idx" tick={{ fill: '#94a3b8', fontSize: 9 }} tickLine={false} axisLine={false} />
                    <YAxis tick={{ fill: '#94a3b8', fontSize: 9 }} tickLine={false} axisLine={false}
                      tickFormatter={v => `₹${(Number(v) / 1000).toFixed(0)}K`} />
                    <Tooltip contentStyle={{ backgroundColor: '#fff', border: '1px solid #e2e8f0', borderRadius: 12, fontSize: 11 }}
                      formatter={value => [formatINR(value as number), 'P&L']}
                      labelFormatter={l => `Trade #${l}`} />
                    <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                      {result.trades.slice(0, 50).map((_: any, i: number) => (
                        <Cell key={i} fill={Number(result.trades[i]?.pnl ?? 0) >= 0 ? '#10b981' : '#ef4444'} />
                      ))}
                    </Bar>
                  </BarChart>
                </ResponsiveContainer>
              </div>
            </div>
          )}

          {/* Trade log */}
          <TradeLog trades={result.trades} totalTrades={result.totalTrades} />

          {/* Run again */}
          <div className="flex gap-3">
            <button onClick={() => setStep(1)} className="flex-1 py-3 rounded-xl border-2 border-slate-200 text-sm font-semibold text-slate-600 hover:bg-slate-50 transition-colors">
              Try Another Strategy
            </button>
            <button onClick={() => { setResult(null); setStep(2); }} className="flex-1 py-3 rounded-xl border-2 border-indigo-200 text-sm font-semibold text-indigo-600 hover:bg-indigo-50 transition-colors">
              Tweak Parameters & Re-run
            </button>
          </div>
        </div>
      )}

      {/* Past results drawer */}
      {showPast && pastResults.length > 0 && (
        <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
              <History className="w-4 h-4 text-slate-400" /> Past Backtests
            </h3>
            <button onClick={() => setShowPast(false)} className="text-xs text-slate-400 hover:text-slate-600">Close</button>
          </div>
          <div className="space-y-2 max-h-[250px] overflow-y-auto">
            {pastResults.slice(0, 10).map((r, i) => (
              <button key={r.id ?? i} onClick={() => { setResult(r); setStep(3); setShowPast(false); }}
                className="w-full flex items-center justify-between px-4 py-3 rounded-xl bg-slate-50 hover:bg-slate-100 text-left transition-colors">
                <div>
                  <span className="text-xs font-semibold text-slate-700">{r.strategyId ?? 'Strategy'}</span>
                  <span className="text-[10px] text-slate-400 ml-2">{r.symbol}</span>
                </div>
                <div className="flex items-center gap-4 text-xs">
                  <span className={`font-mono font-semibold ${r.cagr >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>{r.cagr >= 0 ? '+' : ''}{r.cagr.toFixed(1)}%</span>
                  <span className="text-slate-400">{r.totalTrades} trades</span>
                  <span className="text-slate-400">Win {r.winRate.toFixed(0)}%</span>
                </div>
              </button>
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────

function MetricCard({ icon: Icon, label, value, hint, positive }: {
  icon: typeof TrendingUp; label: string; value: string; hint: string; positive: boolean;
}) {
  const [showHint, setShowHint] = useState(false);
  return (
    <div className="relative rounded-xl border border-slate-200 bg-white p-3.5 shadow-sm group">
      <div className="flex items-center justify-between mb-1.5">
        <div className="flex items-center gap-1.5">
          <Icon className="w-3.5 h-3.5 text-slate-400" />
          <p className="text-[10px] font-medium text-slate-400 uppercase tracking-wider">{label}</p>
        </div>
        <button onClick={() => setShowHint(!showHint)} className="opacity-0 group-hover:opacity-100 transition-opacity">
          <Info className="w-3 h-3 text-slate-300 hover:text-slate-500" />
        </button>
      </div>
      <p className={`text-xl font-bold ${positive ? 'text-emerald-600' : 'text-red-600'}`}>{value}</p>
      {showHint && (
        <div className="absolute z-10 top-full left-0 right-0 mt-1 p-2.5 rounded-lg bg-slate-800 text-[10px] text-white shadow-lg">
          {hint}
        </div>
      )}
    </div>
  );
}

function TradeLog({ trades, totalTrades }: { trades: any[]; totalTrades: number }) {
  const [expanded, setExpanded] = useState(false);
  if (!trades || trades.length === 0) return null;

  const shown = expanded ? trades.slice(0, 100) : trades.slice(0, 10);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <button onClick={() => setExpanded(!expanded)} className="w-full flex items-center justify-between mb-3">
        <h3 className="text-sm font-semibold text-slate-700 flex items-center gap-2">
          <Clock className="w-4 h-4 text-amber-500" /> Trade Log ({totalTrades} trades)
        </h3>
        {trades.length > 10 && (
          <span className="flex items-center gap-1 text-xs text-indigo-600 font-medium">
            {expanded ? 'Show less' : 'Show all'}
            <ChevronDown className={`w-3.5 h-3.5 transition-transform ${expanded ? 'rotate-180' : ''}`} />
          </span>
        )}
      </button>
      <div className="overflow-x-auto">
        <table className="w-full text-xs">
          <thead>
            <tr className="text-slate-400 border-b border-slate-100">
              <th className="text-left pb-2 font-medium">#</th>
              <th className="text-left pb-2 font-medium">Entry Date</th>
              <th className="text-left pb-2 font-medium">Exit Date</th>
              <th className="text-center pb-2 font-medium">Side</th>
              <th className="text-right pb-2 font-medium">Qty</th>
              <th className="text-right pb-2 font-medium">Entry ₹</th>
              <th className="text-right pb-2 font-medium">Exit ₹</th>
              <th className="text-right pb-2 font-medium">P&L</th>
              <th className="text-right pb-2 font-medium">Return</th>
            </tr>
          </thead>
          <tbody>
            {shown.map((t: any, idx: number) => {
              const pnl = Number(t.pnl ?? 0);
              return (
                <tr key={idx} className="border-b border-slate-50 hover:bg-slate-50/50">
                  <td className="py-2 text-slate-400 font-mono">{idx + 1}</td>
                  <td className="py-2 text-slate-600">{t.entryDate ?? t.entry_date ?? ''}</td>
                  <td className="py-2 text-slate-600">{t.exitDate ?? t.exit_date ?? ''}</td>
                  <td className="py-2 text-center">
                    <span className={`inline-flex items-center gap-1 text-[10px] font-bold px-2 py-0.5 rounded-full ${
                      t.side === 'LONG' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
                    }`}>
                      {t.side === 'LONG' ? <ArrowUpRight className="w-2.5 h-2.5" /> : <ArrowDownRight className="w-2.5 h-2.5" />}
                      {t.side}
                    </span>
                  </td>
                  <td className="py-2 text-right font-mono text-slate-600">{t.qty}</td>
                  <td className="py-2 text-right font-mono text-slate-600">₹{Number(t.entryPrice ?? t.entry_price ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className="py-2 text-right font-mono text-slate-600">₹{Number(t.exitPrice ?? t.exit_price ?? 0).toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</td>
                  <td className={`py-2 text-right font-mono font-semibold ${pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {pnl >= 0 ? '+' : ''}₹{pnl.toLocaleString('en-IN', { maximumFractionDigits: 0 })}
                  </td>
                  <td className={`py-2 text-right font-mono ${Number(t.pnlPercent ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {Number(t.pnlPercent ?? 0).toFixed(2)}%
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      {trades.length > shown.length && (
        <p className="text-[10px] text-slate-400 mt-2 text-center">Showing {shown.length} of {trades.length} trades</p>
      )}
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
