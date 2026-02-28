import { useEffect, useState, useCallback } from 'react';
import {
  Bot,
  Zap,
  MessageSquare,
  Eye,
  Power,
  Shield,
  CheckCircle,
  AlertTriangle,
  XCircle,
  TrendingUp,
  Radar,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import { useAIAgentStore } from '@/stores/ai-agent';
import { aiAgentApi } from '@/services/api';
import type { AIAgentMode } from '@/types';

const MODE_CARDS: { mode: AIAgentMode; icon: React.ElementType; title: string; description: string }[] = [
  { mode: 'AUTONOMOUS', icon: Zap, title: 'Autonomous', description: 'AI trades automatically based on signals and rules. Full auto-pilot.' },
  { mode: 'SIGNAL', icon: MessageSquare, title: 'Signal Only', description: 'AI generates signals but waits for your approval before executing.' },
  { mode: 'ADVISORY', icon: Eye, title: 'Advisory', description: 'AI provides analysis and recommendations. You decide and execute.' },
];

const GATE_LABELS: Record<string, string> = {
  g1_trend: 'G1 Trend',
  g2_momentum: 'G2 Momentum',
  g3_volatility: 'G3 Volatility',
  g4_volume: 'G4 Volume',
  g5_options_flow: 'G5 Options Flow',
  g6_global_macro: 'G6 Global Macro',
  g7_fii_dii: 'G7 FII/DII',
  g8_sentiment: 'G8 Sentiment',
  g9_risk: 'G9 Risk',
};

function scoreColor(score: number) {
  if (score >= 70) return 'bg-emerald-500';
  if (score >= 40) return 'bg-amber-500';
  return 'bg-red-500';
}

function scoreTextColor(score: number) {
  if (score >= 70) return 'text-emerald-600';
  if (score >= 40) return 'text-amber-600';
  return 'text-red-600';
}

export default function AIAgentPanel() {
  const {
    config,
    status,
    signals,
    strategies,
    capitalRules,
    fetchConfig,
    updateConfig,
    fetchStatus,
    startAgent,
    stopAgent,
    fetchSignals,
    fetchStrategies,
    fetchCapitalRules,
    isLoading,
  } = useAIAgentStore();

  const [selectedMode, setSelectedMode] = useState<AIAgentMode>('ADVISORY');
  const [scanResult, setScanResult] = useState<any>(null);
  const [scanning, setScanning] = useState(false);
  const [scanLoading, setScanLoading] = useState(false);

  const fetchScan = useCallback(async () => {
    try {
      const { data } = await aiAgentApi.getMarketScan();
      setScanning(data.scanning);
      if (data.result) setScanResult(data.result);
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    fetchConfig();
    fetchStatus();
    fetchSignals();
    fetchStrategies();
    fetchCapitalRules();
    fetchScan();

    const poll = setInterval(() => {
      fetchStatus();
      fetchSignals();
      fetchCapitalRules();
      fetchScan();
    }, 30_000);
    return () => clearInterval(poll);
  }, [fetchConfig, fetchStatus, fetchSignals, fetchStrategies, fetchCapitalRules, fetchScan]);

  useEffect(() => {
    if (config) setSelectedMode(config.mode);
  }, [config]);

  const handleModeChange = (mode: AIAgentMode) => {
    setSelectedMode(mode);
    updateConfig({ mode });
  };

  const handleToggleAgent = () => {
    if (status?.isActive) {
      stopAgent();
    } else {
      startAgent();
    }
  };

  const handleToggleScan = async () => {
    setScanLoading(true);
    try {
      if (scanning) {
        await aiAgentApi.stopMarketScan();
        setScanning(false);
      } else {
        await aiAgentApi.startMarketScan();
        setScanning(true);
      }
      setTimeout(fetchScan, 3000);
    } catch { /* ignore */ }
    finally { setScanLoading(false); }
  };

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900 flex items-center gap-3">
          <Bot className="w-7 h-7 text-indigo-500" />
          AI Agent Control
        </h1>
        <button
          onClick={handleToggleAgent}
          disabled={isLoading}
          className={`flex items-center gap-2 px-5 py-2.5 rounded-lg text-sm font-bold transition-all ${
            status?.isActive
              ? 'bg-red-600 hover:bg-red-500 text-white shadow-lg shadow-red-600/20'
              : 'bg-emerald-600 hover:bg-emerald-500 text-white shadow-lg shadow-emerald-600/20'
          } disabled:opacity-50`}
        >
          <Power className="w-4 h-4" />
          {status?.isActive ? 'Stop Agent' : 'Start Agent'}
        </button>
      </div>

      {/* Status bar */}
      {status && (
        <div className={`flex items-center gap-6 px-5 py-3 rounded-xl border ${
          status.isActive
            ? 'bg-emerald-50 border-emerald-200'
            : 'bg-slate-50 border-slate-200'
        }`}>
          <div className="flex items-center gap-2">
            <span className={`w-2.5 h-2.5 rounded-full ${status.isActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
            <span className="text-sm font-medium text-slate-700">
              {status.isActive ? 'Agent Active' : 'Agent Stopped'}
            </span>
          </div>
          <div className="text-xs text-slate-500">
            Mode: <span className="font-semibold text-slate-700">{status.mode}</span>
          </div>
          <div className="text-xs text-slate-500">
            Signals today: <span className="font-semibold text-slate-700">{status.todaySignals ?? 0}</span>
          </div>
          <div className="text-xs text-slate-500">
            Trades today: <span className="font-semibold text-slate-700">{status.todayTrades ?? 0}</span>
          </div>
          {status.uptime > 0 && (
            <div className="text-xs text-slate-500">
              Uptime: <span className="font-semibold text-slate-700">
                {Math.floor(status.uptime / 60000)}m
              </span>
            </div>
          )}
        </div>
      )}

      {/* Mode selector */}
      <div className="grid grid-cols-1 md:grid-cols-3 gap-4">
        {MODE_CARDS.map(({ mode, icon: Icon, title, description }) => (
          <button
            key={mode}
            onClick={() => handleModeChange(mode)}
            className={`p-5 rounded-xl border text-left transition-all ${
              selectedMode === mode
                ? 'bg-indigo-50 border-indigo-300 ring-1 ring-indigo-300'
                : 'bg-white border-slate-200 hover:border-slate-300 shadow-sm'
            }`}
          >
            <div className="flex items-center gap-3 mb-2">
              <div
                className={`w-9 h-9 rounded-lg flex items-center justify-center ${
                  selectedMode === mode ? 'bg-indigo-100' : 'bg-slate-100'
                }`}
              >
                <Icon className={`w-5 h-5 ${selectedMode === mode ? 'text-indigo-600' : 'text-slate-400'}`} />
              </div>
              <h3 className={`font-semibold ${selectedMode === mode ? 'text-indigo-700' : 'text-slate-800'}`}>
                {title}
              </h3>
            </div>
            <p className="text-xs text-slate-400">{description}</p>
          </button>
        ))}
      </div>

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
        {/* Active Strategies */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">
            Active Strategies
          </h3>
          <div className="space-y-2">
            {strategies.length > 0 ? (
              strategies.map((s) => (
                <div key={s.id} className="flex items-center justify-between py-2 border-b border-slate-100 last:border-0">
                  <div>
                    <p className="text-sm font-medium text-slate-800">{s.name}</p>
                    <p className="text-xs text-slate-400">{s.description}</p>
                  </div>
                  <label className="relative inline-flex items-center cursor-pointer">
                    <input
                      type="checkbox"
                      checked={s.isActive}
                      readOnly
                      className="sr-only peer"
                    />
                    <div className="w-9 h-5 bg-slate-200 rounded-full peer peer-checked:bg-indigo-600 transition-colors after:content-[''] after:absolute after:top-[2px] after:left-[2px] after:bg-white after:rounded-full after:h-4 after:w-4 after:transition-all peer-checked:after:translate-x-full" />
                  </label>
                </div>
              ))
            ) : (
              <p className="text-sm text-slate-400 text-center py-4">
                No strategies configured. Configure strategies in Settings.
              </p>
            )}
          </div>
        </div>

        {/* Gate Scores */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide mb-4">
            Signal Gate Scores
          </h3>
          {signals.length > 0 && signals[0].gateScores && Object.keys(signals[0].gateScores).some(k => k.startsWith('g')) ? (
            <div className="space-y-3">
              {Object.entries(signals[0].gateScores)
                .filter(([k]) => k.startsWith('g'))
                .map(([key, value]) => {
                  const v = Number(value) || 0;
                  return (
                    <div key={key}>
                      <div className="flex items-center justify-between mb-1">
                        <span className="text-xs text-slate-500">{GATE_LABELS[key] || key}</span>
                        <span className={`text-xs font-mono font-semibold ${scoreTextColor(v)}`}>
                          {v.toFixed(0)}/100
                        </span>
                      </div>
                      <div className="w-full h-2 bg-slate-100 rounded-full overflow-hidden">
                        <div
                          className={`h-full rounded-full transition-all ${scoreColor(v)}`}
                          style={{ width: `${v}%` }}
                        />
                      </div>
                    </div>
                  );
                })}
            </div>
          ) : (
            <div className="space-y-3">
              {Object.entries(GATE_LABELS).map(([key, label]) => (
                <div key={key}>
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs text-slate-500">{label}</span>
                    <span className="text-xs font-mono text-slate-300">—</span>
                  </div>
                  <div className="w-full h-2 bg-slate-100 rounded-full" />
                </div>
              ))}
            </div>
          )}
        </div>

        {/* Capital Preservation Rules */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <Shield className="w-4 h-4 text-amber-500" />
            <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">
              Capital Preservation Rules
            </h3>
          </div>
          <div className="space-y-2">
            {capitalRules.length > 0 ? (
              capitalRules.map((rule) => (
                <div key={rule.id} className="flex items-center gap-3 py-2 border-b border-slate-100 last:border-0">
                  {rule.status === 'green' && <CheckCircle className="w-4 h-4 text-emerald-500 flex-shrink-0" />}
                  {rule.status === 'amber' && <AlertTriangle className="w-4 h-4 text-amber-500 flex-shrink-0" />}
                  {rule.status === 'red' && <XCircle className="w-4 h-4 text-red-500 flex-shrink-0" />}
                  <div className="flex-1 min-w-0">
                    <p className="text-sm text-slate-800 truncate">{rule.name}</p>
                    <p className="text-xs text-slate-400 truncate">{rule.detail}</p>
                  </div>
                </div>
              ))
            ) : (
              <div className="text-center py-4">
                <p className="text-sm text-slate-400">No capital rules data available.</p>
              </div>
            )}
          </div>
        </div>

        {/* Recent Signals */}
        <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
          <div className="flex items-center gap-2 mb-4">
            <TrendingUp className="w-4 h-4 text-indigo-500" />
            <h3 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">
              Recent Signals
            </h3>
          </div>
          <div className="space-y-3 max-h-[400px] overflow-y-auto">
            {signals.length > 0 ? (
              signals.slice(0, 10).map((signal) => {
                const dir = signal.signalType || (signal as any).action || 'HOLD';
                const score = Number(signal.compositeScore ?? 0);
                const scorePct = score <= 1 ? score * 100 : score;
                const strat = signal.strategyId || (signal as any).strategy || '';
                const timeStr = signal.createdAt ? new Date(signal.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' }) : '';
                return (
                  <div
                    key={signal.id}
                    className="p-3 rounded-lg bg-slate-50 border border-slate-200 space-y-2"
                  >
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2">
                        <span className="font-medium text-sm text-slate-800">{signal.symbol}</span>
                        <span
                          className={`text-[10px] font-bold px-1.5 py-0.5 rounded ${
                            dir === 'BUY'
                              ? 'bg-emerald-50 text-emerald-600'
                              : dir === 'SELL'
                              ? 'bg-red-50 text-red-600'
                              : 'bg-slate-100 text-slate-500'
                          }`}
                        >
                          {dir}
                        </span>
                        <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                          signal.status === 'EXECUTED' ? 'bg-emerald-50 text-emerald-600'
                            : signal.status === 'REJECTED' ? 'bg-red-50 text-red-600'
                            : 'bg-amber-50 text-amber-600'
                        }`}>
                          {signal.status}
                        </span>
                      </div>
                      <span className={`text-sm font-mono font-bold ${scoreTextColor(scorePct)}`}>
                        {scorePct.toFixed(0)}%
                      </span>
                    </div>
                    <p className="text-xs text-slate-500 line-clamp-2">{signal.rationale}</p>
                    <div className="flex items-center justify-between">
                      <div className="flex items-center gap-2 text-xs text-slate-400">
                        {strat && <span className="px-1.5 py-0.5 bg-indigo-50 text-indigo-600 rounded">{strat}</span>}
                        {timeStr && <span>{timeStr}</span>}
                      </div>
                      {signal.status === 'PENDING' && (
                        <div className="flex gap-1">
                          <button
                            onClick={() => { aiAgentApi.executeSignal(signal.id).then(() => fetchSignals()); }}
                            className="text-[10px] px-2 py-1 bg-emerald-600 text-white rounded hover:bg-emerald-500"
                          >
                            Execute
                          </button>
                          <button
                            onClick={() => { aiAgentApi.rejectSignal(signal.id).then(() => fetchSignals()); }}
                            className="text-[10px] px-2 py-1 bg-red-600 text-white rounded hover:bg-red-500"
                          >
                            Reject
                          </button>
                        </div>
                      )}
                    </div>
                  </div>
                );
              })
            ) : (
              <p className="text-sm text-slate-400 text-center py-4">
                {status?.isActive
                  ? 'Agent is running — signals will appear shortly...'
                  : 'Start the agent to generate signals.'}
              </p>
            )}
          </div>
        </div>
      </div>

      {/* ---- Market Scanner ---- */}
      <div className="bg-white border border-slate-200 rounded-xl p-5 shadow-sm">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <Radar className="w-5 h-5 text-violet-500" />
            <h3 className="text-lg font-bold text-slate-800">Market Scanner</h3>
            <span className="text-xs text-slate-400 ml-2">
              Scans NSE, MCX & CDS markets via Rust engine every 5 min
            </span>
          </div>
          <button
            onClick={handleToggleScan}
            disabled={scanLoading}
            className={`flex items-center gap-2 px-4 py-2 rounded-lg text-sm font-bold transition-all ${
              scanning
                ? 'bg-red-600 hover:bg-red-500 text-white'
                : 'bg-violet-600 hover:bg-violet-500 text-white'
            } disabled:opacity-50`}
          >
            <Radar className="w-4 h-4" />
            {scanning ? 'Stop Scanner' : 'Start Scanner'}
          </button>
        </div>

        {scanning && (
          <div className="flex items-center gap-2 mb-4 px-3 py-2 bg-violet-50 border border-violet-200 rounded-lg">
            <span className="w-2 h-2 rounded-full bg-violet-500 animate-pulse" />
            <span className="text-xs text-violet-700 font-medium">
              Scanner is active — scanning equities, commodities & forex markets
            </span>
            {scanResult && (
              <span className="text-xs text-violet-500 ml-auto">
                Last scan: {new Date(scanResult.timestamp).toLocaleTimeString('en-IN')} | {scanResult.scannedCount} stocks | {scanResult.scanDurationMs ? `${(scanResult.scanDurationMs / 1000).toFixed(1)}s` : ''}
              </span>
            )}
          </div>
        )}

        {scanResult && (
          <div className="space-y-4">
            {/* Scan Signals */}
            {scanResult.signals && scanResult.signals.length > 0 && (
              <div>
                <h4 className="text-sm font-semibold text-slate-600 mb-3">
                  Rust Engine Signals ({scanResult.signals.length})
                </h4>
                <div className="overflow-x-auto">
                  <table className="w-full text-sm">
                    <thead>
                      <tr className="text-xs text-slate-400 uppercase border-b border-slate-100">
                        <th className="text-left py-2 px-2">Symbol</th>
                        <th className="text-left py-2 px-2">Signal</th>
                        <th className="text-right py-2 px-2">Confidence</th>
                        <th className="text-right py-2 px-2">LTP</th>
                        <th className="text-right py-2 px-2">Change</th>
                        <th className="text-right py-2 px-2">Entry</th>
                        <th className="text-right py-2 px-2">Stop Loss</th>
                        <th className="text-right py-2 px-2">Target</th>
                        <th className="text-center py-2 px-2">Type</th>
                      </tr>
                    </thead>
                    <tbody>
                      {scanResult.signals.map((sig: any, i: number) => {
                        const confPct = (sig.confidence * 100).toFixed(0);
                        return (
                          <tr key={i} className="border-b border-slate-50 hover:bg-slate-50">
                            <td className="py-2 px-2 font-medium text-slate-800">{sig.symbol}</td>
                            <td className="py-2 px-2">
                              <span className={`text-xs font-bold px-2 py-0.5 rounded ${
                                sig.direction === 'BUY' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
                              }`}>
                                {sig.direction}
                              </span>
                            </td>
                            <td className="py-2 px-2 text-right">
                              <span className={`font-mono font-bold ${
                                Number(confPct) >= 80 ? 'text-emerald-600' : Number(confPct) >= 60 ? 'text-amber-600' : 'text-red-600'
                              }`}>
                                {confPct}%
                              </span>
                            </td>
                            <td className="py-2 px-2 text-right font-mono text-slate-700">
                              {sig.ltp > 0 ? `₹${sig.ltp.toFixed(2)}` : '—'}
                            </td>
                            <td className={`py-2 px-2 text-right font-mono ${sig.changePercent >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                              {sig.changePercent >= 0 ? '+' : ''}{sig.changePercent.toFixed(1)}%
                            </td>
                            <td className="py-2 px-2 text-right font-mono text-slate-600">₹{sig.entry.toFixed(2)}</td>
                            <td className="py-2 px-2 text-right font-mono text-red-500">₹{sig.stopLoss.toFixed(2)}</td>
                            <td className="py-2 px-2 text-right font-mono text-emerald-500">₹{sig.target.toFixed(2)}</td>
                            <td className="py-2 px-2 text-center">
                              <span className={`text-[10px] px-1.5 py-0.5 rounded ${
                                sig.moverType === 'gainer' ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
                              }`}>
                                {sig.moverType}
                              </span>
                            </td>
                          </tr>
                        );
                      })}
                    </tbody>
                  </table>
                </div>
              </div>
            )}

            {scanResult.signals && scanResult.signals.length === 0 && (
              <div className="text-center py-6 text-slate-400">
                <Radar className="w-8 h-8 mx-auto mb-2 opacity-50" />
                <p className="text-sm">No high-confidence signals found in current scan.</p>
                <p className="text-xs mt-1">The Rust engine requires strong indicator convergence to generate signals.</p>
              </div>
            )}

            {/* Top Gainers & Losers */}
            <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
              {/* Top Gainers */}
              <div>
                <h4 className="text-sm font-semibold text-emerald-600 mb-2 flex items-center gap-1">
                  <ArrowUpRight className="w-4 h-4" />
                  Top Gainers ({scanResult.topGainers?.length ?? 0})
                </h4>
                <div className="space-y-1 max-h-[300px] overflow-y-auto">
                  {(scanResult.topGainers ?? []).map((m: any, i: number) => (
                    <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded bg-emerald-50/50 border border-emerald-100">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-slate-400 w-4">{i + 1}</span>
                        <span className="text-sm font-medium text-slate-800">{m.symbol}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono text-slate-600">₹{m.ltp?.toFixed(2) ?? 0}</span>
                        <span className="text-xs font-mono font-bold text-emerald-600">
                          +{m.changePercent?.toFixed(1) ?? 0}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Top Losers */}
              <div>
                <h4 className="text-sm font-semibold text-red-600 mb-2 flex items-center gap-1">
                  <ArrowDownRight className="w-4 h-4" />
                  Top Losers ({scanResult.topLosers?.length ?? 0})
                </h4>
                <div className="space-y-1 max-h-[300px] overflow-y-auto">
                  {(scanResult.topLosers ?? []).map((m: any, i: number) => (
                    <div key={i} className="flex items-center justify-between py-1.5 px-2 rounded bg-red-50/50 border border-red-100">
                      <div className="flex items-center gap-2">
                        <span className="text-xs font-mono text-slate-400 w-4">{i + 1}</span>
                        <span className="text-sm font-medium text-slate-800">{m.symbol}</span>
                      </div>
                      <div className="flex items-center gap-3">
                        <span className="text-xs font-mono text-slate-600">₹{m.ltp?.toFixed(2) ?? 0}</span>
                        <span className="text-xs font-mono font-bold text-red-600">
                          {m.changePercent?.toFixed(1) ?? 0}%
                        </span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>
            </div>
          </div>
        )}

        {!scanResult && !scanning && (
          <div className="text-center py-8 text-slate-400">
            <Radar className="w-10 h-10 mx-auto mb-3 opacity-30" />
            <p className="text-sm font-medium">Market Scanner is off</p>
            <p className="text-xs mt-1">Click "Start Scanner" to scan NSE, MCX & CDS markets for top movers and generate Rust engine signals with confidence scores.</p>
          </div>
        )}
      </div>
    </div>
  );
}
