import { useState, useEffect, useRef, useCallback } from 'react';
import { commandApi } from '@/services/api';

interface Message {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  metadata?: string;
}

interface DashboardData {
  target: {
    targetId: string;
    type: string;
    capitalBase: number;
    profitTargetPct: number;
    maxLossPct: number;
    profitTargetAbs: number;
    maxLossAbs: number;
    currentPnl: number;
    progressPct: number;
    status: string;
    consecutiveLossDays: number;
    instruments: string;
    aggression: string;
    tradingAllowed: boolean;
    reason?: string;
  } | null;
  risk: {
    dayPnl: number;
    dayDrawdownPct: number;
    openPositions: number;
    circuitBreakerActive: boolean;
    riskScore: number;
  };
  bots: Array<{
    id: string;
    name: string;
    role: string;
    lastAction: string | null;
    lastActionAt: string | null;
    totalPnl: number;
    winRate: number;
  }>;
  recentPnl: Array<{
    date: string;
    netPnl: number;
    tradeCount: number;
    winCount: number;
    lossCount: number;
    status: string;
  }>;
  todaySignals: Array<{
    id: string;
    symbol: string;
    signalType: string;
    compositeScore: number;
    status: string;
    rationale: string;
    createdAt: string;
  }>;
}

function StatusBadge({ status }: { status: string }) {
  const colors: Record<string, string> = {
    ACTIVE: 'bg-green-500/10 text-green-400 border-green-500/20',
    TARGET_HIT: 'bg-teal-500/10 text-teal-400 border-teal-500/20',
    LOSS_LIMIT: 'bg-red-500/10 text-red-400 border-red-500/20',
    PAUSED: 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20',
    REVIEW_REQUIRED: 'bg-orange-500/10 text-orange-400 border-orange-500/20',
  };
  return (
    <span className={`px-2 py-0.5 text-xs font-medium rounded border ${colors[status] || 'bg-slate-700 text-slate-300'}`}>
      {status.replace(/_/g, ' ')}
    </span>
  );
}

function AggressionIndicator({ level }: { level: string }) {
  const config: Record<string, { color: string; label: string }> = {
    high: { color: 'text-red-400', label: 'HIGH' },
    medium: { color: 'text-yellow-400', label: 'MEDIUM' },
    low: { color: 'text-green-400', label: 'LOW' },
    none: { color: 'text-slate-400', label: 'NONE' },
  };
  const c = config[level] || config.none;
  return <span className={`text-xs font-bold ${c.color}`}>{c.label}</span>;
}

export default function CommandCenter() {
  const [messages, setMessages] = useState<Message[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const chatEndRef = useRef<HTMLDivElement>(null);

  const loadDashboard = useCallback(async () => {
    try {
      const res = await commandApi.getDashboard();
      setDashboard(res.data);
    } catch { /* ignore */ }
  }, []);

  const loadMessages = useCallback(async () => {
    try {
      const res = await commandApi.getMessages(50);
      setMessages((res.data as Message[]).reverse());
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    Promise.all([loadDashboard(), loadMessages()]).finally(() => setLoading(false));
    const interval = setInterval(loadDashboard, 30000);
    return () => clearInterval(interval);
  }, [loadDashboard, loadMessages]);

  useEffect(() => {
    chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages]);

  const sendMessage = async () => {
    const msg = input.trim();
    if (!msg || sending) return;

    setMessages(prev => [...prev, { id: `temp-${Date.now()}`, role: 'user', content: msg, createdAt: new Date().toISOString() }]);
    setInput('');
    setSending(true);

    try {
      const res = await commandApi.chat(msg);
      setMessages(prev => [...prev, {
        id: `resp-${Date.now()}`,
        role: 'assistant',
        content: res.data.content,
        createdAt: new Date().toISOString(),
        metadata: JSON.stringify({ intent: res.data.intent }),
      }]);
      await loadDashboard();
    } catch (err: any) {
      setMessages(prev => [...prev, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `Error: ${err?.response?.data?.error || err?.message || 'Something went wrong'}`,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setSending(false);
    }
  };

  const target = dashboard?.target;
  const risk = dashboard?.risk;
  const pnlColor = (v: number) => v >= 0 ? 'text-green-400' : 'text-red-400';

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex gap-4 p-4">
      {/* Left: Chat Panel */}
      <div className="flex-1 flex flex-col bg-slate-900 rounded-xl border border-slate-700/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700/50 bg-slate-800/50">
          <h2 className="text-sm font-semibold text-white">Command Center</h2>
          <p className="text-xs text-slate-400">Set targets, check progress, and control your trading bots</p>
        </div>

        {/* Messages */}
        <div className="flex-1 overflow-y-auto p-4 space-y-3">
          {messages.length === 0 && (
            <div className="text-center py-12">
              <p className="text-slate-400 text-sm mb-4">Start by telling me your trading goals</p>
              <div className="flex flex-wrap gap-2 justify-center">
                {[
                  'Make 2% daily on 10 lakh capital',
                  'How are bots doing today?',
                  'Show today\'s report',
                  'What\'s the status?',
                ].map(suggestion => (
                  <button
                    key={suggestion}
                    onClick={() => { setInput(suggestion); }}
                    className="px-3 py-1.5 text-xs rounded-full bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700/50 transition-colors"
                  >
                    {suggestion}
                  </button>
                ))}
              </div>
            </div>
          )}

          {messages.map(msg => (
            <div key={msg.id} className={`flex ${msg.role === 'user' ? 'justify-end' : 'justify-start'}`}>
              <div className={`max-w-[80%] rounded-lg px-3 py-2 text-sm whitespace-pre-wrap ${
                msg.role === 'user'
                  ? 'bg-teal-600/20 text-teal-100 border border-teal-500/20'
                  : 'bg-slate-800 text-slate-200 border border-slate-700/50'
              }`}>
                {msg.content}
                <div className="text-[10px] text-slate-500 mt-1">
                  {new Date(msg.createdAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}
                </div>
              </div>
            </div>
          ))}
          <div ref={chatEndRef} />
        </div>

        {/* Input */}
        <div className="p-3 border-t border-slate-700/50 bg-slate-800/30">
          <div className="flex gap-2">
            <input
              type="text"
              value={input}
              onChange={e => setInput(e.target.value)}
              onKeyDown={e => e.key === 'Enter' && !e.shiftKey && sendMessage()}
              placeholder="Set targets, check progress, control bots..."
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3 py-2 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-teal-500 focus:border-teal-500"
              disabled={sending}
            />
            <button
              onClick={sendMessage}
              disabled={sending || !input.trim()}
              className="px-4 py-2 bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {sending ? '...' : 'Send'}
            </button>
          </div>
        </div>
      </div>

      {/* Right: Dashboard Panels */}
      <div className="w-[400px] flex flex-col gap-4 overflow-y-auto">
        {/* Target Progress */}
        <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
          <div className="flex items-center justify-between mb-3">
            <h3 className="text-sm font-semibold text-white">Target Progress</h3>
            {target && <StatusBadge status={target.status} />}
          </div>

          {target ? (
            <>
              <div className="grid grid-cols-3 gap-2 mb-3">
                <div className="text-center">
                  <p className="text-[10px] text-slate-500 uppercase">Capital</p>
                  <p className="text-sm font-bold text-white">{(target.capitalBase / 100000).toFixed(1)}L</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-slate-500 uppercase">Target</p>
                  <p className="text-sm font-bold text-green-400">+{target.profitTargetAbs.toFixed(0)}</p>
                </div>
                <div className="text-center">
                  <p className="text-[10px] text-slate-500 uppercase">Max Loss</p>
                  <p className="text-sm font-bold text-red-400">-{target.maxLossAbs.toFixed(0)}</p>
                </div>
              </div>

              {/* Progress Bar */}
              <div className="mb-3">
                <div className="flex justify-between text-xs mb-1">
                  <span className={pnlColor(target.currentPnl)}>
                    {target.currentPnl >= 0 ? '+' : ''}{target.currentPnl.toFixed(0)}
                  </span>
                  <span className="text-slate-500">{target.progressPct.toFixed(0)}%</span>
                </div>
                <div className="h-2 bg-slate-700 rounded-full overflow-hidden">
                  <div
                    className={`h-full rounded-full transition-all duration-500 ${
                      target.currentPnl >= 0 ? 'bg-green-500' : 'bg-red-500'
                    }`}
                    style={{ width: `${Math.min(Math.abs(target.progressPct), 100)}%` }}
                  />
                </div>
              </div>

              <div className="flex items-center justify-between text-xs">
                <span className="text-slate-400">Aggression: <AggressionIndicator level={target.aggression} /></span>
                <span className="text-slate-400">{target.instruments}</span>
              </div>

              {target.consecutiveLossDays > 0 && (
                <div className="mt-2 px-2 py-1 bg-orange-500/10 border border-orange-500/20 rounded text-xs text-orange-400">
                  {target.consecutiveLossDays} consecutive loss day{target.consecutiveLossDays > 1 ? 's' : ''}
                </div>
              )}

              {!target.tradingAllowed && target.reason && (
                <div className="mt-2 px-2 py-1 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                  {target.reason}
                </div>
              )}
            </>
          ) : (
            <p className="text-xs text-slate-500">No active target. Use the chat to set one.</p>
          )}
        </div>

        {/* Risk Meter */}
        {risk && (
          <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
            <h3 className="text-sm font-semibold text-white mb-3">Risk Status</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] text-slate-500 uppercase">Risk Score</p>
                <p className={`text-lg font-bold ${risk.riskScore > 70 ? 'text-red-400' : risk.riskScore > 40 ? 'text-yellow-400' : 'text-green-400'}`}>
                  {risk.riskScore}/100
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 uppercase">Day P&L</p>
                <p className={`text-lg font-bold ${pnlColor(risk.dayPnl)}`}>
                  {risk.dayPnl >= 0 ? '+' : ''}{risk.dayPnl.toFixed(0)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 uppercase">Positions</p>
                <p className="text-sm font-medium text-white">{risk.openPositions}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500 uppercase">Drawdown</p>
                <p className="text-sm font-medium text-white">{risk.dayDrawdownPct.toFixed(1)}%</p>
              </div>
            </div>
            {risk.circuitBreakerActive && (
              <div className="mt-2 px-2 py-1 bg-red-500/10 border border-red-500/20 rounded text-xs text-red-400">
                Circuit breaker active
              </div>
            )}
          </div>
        )}

        {/* Active Bots */}
        {dashboard?.bots && dashboard.bots.length > 0 && (
          <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
            <h3 className="text-sm font-semibold text-white mb-3">Active Bots ({dashboard.bots.length})</h3>
            <div className="space-y-2">
              {dashboard.bots.map(bot => (
                <div key={bot.id} className="flex items-center justify-between py-1.5 border-b border-slate-800 last:border-0">
                  <div>
                    <p className="text-xs font-medium text-white">{bot.name}</p>
                    <p className="text-[10px] text-slate-500">{bot.lastAction || 'Idle'}</p>
                  </div>
                  <span className={`text-xs font-bold ${pnlColor(Number(bot.totalPnl))}`}>
                    {Number(bot.totalPnl) >= 0 ? '+' : ''}{Number(bot.totalPnl).toFixed(0)}
                  </span>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent Signals */}
        {dashboard?.todaySignals && dashboard.todaySignals.length > 0 && (
          <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
            <h3 className="text-sm font-semibold text-white mb-3">Today's Signals ({dashboard.todaySignals.length})</h3>
            <div className="space-y-2 max-h-60 overflow-y-auto">
              {dashboard.todaySignals.slice(0, 10).map(sig => (
                <div key={sig.id} className="flex items-center justify-between py-1.5 border-b border-slate-800 last:border-0">
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center gap-1.5">
                      <span className={`text-xs font-bold ${sig.signalType === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                        {sig.signalType}
                      </span>
                      <span className="text-xs text-white">{sig.symbol}</span>
                    </div>
                    <p className="text-[10px] text-slate-500 truncate">{sig.rationale}</p>
                  </div>
                  <div className="text-right ml-2 shrink-0">
                    <p className="text-xs font-medium text-slate-300">{(sig.compositeScore * 100).toFixed(0)}%</p>
                    <p className={`text-[10px] ${sig.status === 'EXECUTED' ? 'text-green-400' : 'text-slate-500'}`}>{sig.status}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Recent P&L History */}
        {dashboard?.recentPnl && dashboard.recentPnl.length > 0 && (
          <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
            <h3 className="text-sm font-semibold text-white mb-3">P&L History</h3>
            <div className="space-y-1.5">
              {dashboard.recentPnl.map((day, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-slate-800 last:border-0">
                  <span className="text-slate-400">{new Date(day.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                  <div className="flex items-center gap-3">
                    <span className="text-slate-500">{day.winCount}W/{day.lossCount}L</span>
                    <span className={`font-bold ${pnlColor(day.netPnl)}`}>
                      {day.netPnl >= 0 ? '+' : ''}{day.netPnl.toFixed(0)}
                    </span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
