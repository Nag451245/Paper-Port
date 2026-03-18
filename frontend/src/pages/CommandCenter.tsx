import { useState, useEffect, useRef, useCallback } from 'react';
import { commandApi } from '@/services/api';
import { useBotActivity, type TimelineItem } from '@/hooks/useBotActivity';

interface ChatMessage {
  id: string;
  role: 'user' | 'assistant';
  content: string;
  createdAt: string;
  intent?: string;
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

type UnifiedItem =
  | { kind: 'chat'; data: ChatMessage }
  | { kind: 'activity'; data: TimelineItem };

const ACTIVITY_ICONS: Record<TimelineItem['type'], { icon: string; color: string; bg: string }> = {
  bot_scan: { icon: '📡', color: 'text-violet-400', bg: 'border-violet-500/30 bg-violet-500/5' },
  bot_decision: { icon: '🧠', color: 'text-blue-400', bg: 'border-blue-500/30 bg-blue-500/5' },
  signal: { icon: '⚡', color: 'text-amber-400', bg: 'border-amber-500/30 bg-amber-500/5' },
  trade: { icon: '💹', color: 'text-emerald-400', bg: 'border-emerald-500/30 bg-emerald-500/5' },
  risk_alert: { icon: '🛡️', color: 'text-red-400', bg: 'border-red-500/30 bg-red-500/5' },
  system: { icon: '⚙️', color: 'text-slate-400', bg: 'border-slate-600/30 bg-slate-600/5' },
};

function formatTime(iso: string) {
  return new Date(iso).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' });
}

const pnlColor = (v: number) => v >= 0 ? 'text-green-400' : 'text-red-400';

function ActivityCard({ item }: { item: TimelineItem }) {
  const [expanded, setExpanded] = useState(false);
  const config = ACTIVITY_ICONS[item.type];

  return (
    <div
      className={`rounded-lg border px-3 py-2 cursor-pointer transition-colors ${config.bg} hover:brightness-110`}
      onClick={() => setExpanded(!expanded)}
    >
      <div className="flex items-start gap-2">
        <span className="text-base mt-0.5 shrink-0">{config.icon}</span>
        <div className="flex-1 min-w-0">
          <div className="flex items-center gap-2 text-xs mb-0.5">
            <span className={`font-semibold ${config.color}`}>{item.botName}</span>
            <span className="text-slate-500">{formatTime(item.timestamp)}</span>
          </div>
          <p className="text-sm text-slate-300 leading-snug">{item.summary}</p>
          {expanded && item.details && (
            <pre className="mt-2 text-[10px] text-slate-500 bg-slate-800/50 rounded p-2 overflow-x-auto">
              {JSON.stringify(item.details, null, 2)}
            </pre>
          )}
        </div>
      </div>
    </div>
  );
}

const SUGGESTIONS = [
  'What\'s the status?',
  'How are the bots doing?',
  'Show pending signals',
  'Scan RELIANCE',
  'Options NIFTY',
  'Rust engine status',
  'Start scanning',
  'Make 2% daily on 10 lakh',
];

export default function CommandCenter() {
  const [chatMessages, setChatMessages] = useState<ChatMessage[]>([]);
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [scanSymbol, setScanSymbol] = useState('');
  const [dashboard, setDashboard] = useState<DashboardData | null>(null);
  const [loading, setLoading] = useState(true);
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);
  const chatEndRef = useRef<HTMLDivElement>(null);
  const timelineRef = useRef<HTMLDivElement>(null);
  const [autoScroll, setAutoScroll] = useState(true);

  const { items: botActivityItems } = useBotActivity();

  const loadDashboard = useCallback(async () => {
    try {
      const res = await commandApi.getDashboard();
      setDashboard(res.data);
    } catch { /* ignore */ }
  }, []);

  const loadMessages = useCallback(async () => {
    try {
      const res = await commandApi.getMessages(50);
      setChatMessages(
        (res.data as ChatMessage[])
          .reverse()
          .map(m => ({ ...m, intent: m.intent ?? (typeof (m as any).metadata === 'string' ? JSON.parse((m as any).metadata)?.intent : undefined) }))
      );
    } catch { /* ignore */ }
  }, []);

  useEffect(() => {
    Promise.all([loadDashboard(), loadMessages()]).finally(() => setLoading(false));
    const interval = setInterval(loadDashboard, 30000);
    return () => clearInterval(interval);
  }, [loadDashboard, loadMessages]);

  useEffect(() => {
    if (autoScroll) {
      chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
    }
  }, [chatMessages, botActivityItems, autoScroll]);

  const handleScroll = useCallback(() => {
    const el = timelineRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 80;
    setAutoScroll(atBottom);
  }, []);

  const sendMessage = async () => {
    const msg = input.trim();
    if (!msg || sending) return;

    const tempMsg: ChatMessage = { id: `temp-${Date.now()}`, role: 'user', content: msg, createdAt: new Date().toISOString() };
    setChatMessages(prev => [...prev, tempMsg]);
    setInput('');
    setSending(true);

    try {
      const res = await commandApi.chat(msg);
      setChatMessages(prev => [...prev, {
        id: `resp-${Date.now()}`,
        role: 'assistant',
        content: res.data.content,
        createdAt: new Date().toISOString(),
        intent: res.data.intent,
      }]);
      await loadDashboard();
    } catch (err: any) {
      setChatMessages(prev => [...prev, {
        id: `err-${Date.now()}`,
        role: 'assistant',
        content: `Error: ${err?.response?.data?.error || err?.message || 'Something went wrong'}`,
        createdAt: new Date().toISOString(),
      }]);
    } finally {
      setSending(false);
    }
  };

  const unified: UnifiedItem[] = [];
  const chatCopy = [...chatMessages];
  const actCopy = [...botActivityItems].reverse();
  let ci = 0, ai = 0;

  while (ci < chatCopy.length || ai < actCopy.length) {
    const cTime = ci < chatCopy.length ? new Date(chatCopy[ci].createdAt).getTime() : Infinity;
    const aTime = ai < actCopy.length ? new Date(actCopy[ai].timestamp).getTime() : Infinity;
    if (cTime <= aTime && ci < chatCopy.length) {
      unified.push({ kind: 'chat', data: chatCopy[ci++] });
    } else if (ai < actCopy.length) {
      unified.push({ kind: 'activity', data: actCopy[ai++] });
    } else {
      break;
    }
  }

  const target = dashboard?.target;
  const risk = dashboard?.risk;

  if (loading) {
    return (
      <div className="flex items-center justify-center h-full">
        <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
      </div>
    );
  }

  return (
    <div className="h-[calc(100vh-4rem)] flex gap-3 p-3">
      {/* ── Left: Unified Timeline ── */}
      <div className="flex-1 flex flex-col bg-slate-900 rounded-xl border border-slate-700/50 overflow-hidden">
        <div className="px-4 py-3 border-b border-slate-700/50 bg-slate-800/50 flex items-center justify-between">
          <div>
            <h2 className="text-sm font-bold text-white tracking-wide">Mission Control</h2>
            <p className="text-[10px] text-slate-500 mt-0.5">
              Chat + real-time bot activity
              {botActivityItems.length > 0 && <span className="ml-2 text-violet-400">{botActivityItems.length} live events</span>}
            </p>
          </div>
          <button
            onClick={() => setSidebarCollapsed(!sidebarCollapsed)}
            className="lg:hidden text-xs text-slate-400 hover:text-white px-2 py-1 rounded border border-slate-700"
          >
            {sidebarCollapsed ? 'Show Panel' : 'Hide Panel'}
          </button>
        </div>

        {/* Timeline */}
        <div
          ref={timelineRef}
          className="flex-1 overflow-y-auto p-4 space-y-2.5"
          onScroll={handleScroll}
        >
          {unified.length === 0 && (
            <div className="text-center py-16">
              <div className="w-16 h-16 rounded-full bg-slate-800 flex items-center justify-center mx-auto mb-4">
                <span className="text-3xl">🎯</span>
              </div>
              <p className="text-slate-400 text-sm mb-1 font-medium">Welcome to Mission Control</p>
              <p className="text-slate-500 text-xs mb-6">Chat with your AI trading system. Bot activity will appear here in real-time.</p>
              <div className="flex flex-wrap gap-2 justify-center max-w-lg mx-auto">
                {SUGGESTIONS.map(s => (
                  <button
                    key={s}
                    onClick={() => setInput(s)}
                    className="px-3 py-1.5 text-xs rounded-full bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700/50 transition-colors"
                  >
                    {s}
                  </button>
                ))}
              </div>
            </div>
          )}

          {unified.map((item, idx) => {
            if (item.kind === 'chat') {
              const msg = item.data;
              const isUser = msg.role === 'user';
              return (
                <div key={msg.id ?? idx} className={`flex ${isUser ? 'justify-end' : 'justify-start'}`}>
                  <div className={`max-w-[80%] rounded-xl px-3.5 py-2.5 text-sm ${
                    isUser
                      ? 'bg-teal-600/20 text-teal-100 border border-teal-500/20 rounded-br-sm'
                      : 'bg-slate-800 text-slate-200 border border-slate-700/50 rounded-bl-sm'
                  }`}>
                    <pre className="whitespace-pre-wrap font-sans text-sm leading-relaxed">{msg.content}</pre>
                    <div className="flex items-center gap-2 mt-1.5">
                      <span className="text-[10px] text-slate-500">{formatTime(msg.createdAt)}</span>
                      {!isUser && msg.intent && msg.intent !== 'general_chat' && (
                        <span className="text-[9px] px-1.5 py-0.5 rounded bg-slate-700/50 text-slate-400 font-mono">
                          {msg.intent}
                        </span>
                      )}
                    </div>
                  </div>
                </div>
              );
            } else {
              return <ActivityCard key={item.data.id ?? idx} item={item.data} />;
            }
          })}

          {!autoScroll && (
            <button
              onClick={() => {
                setAutoScroll(true);
                chatEndRef.current?.scrollIntoView({ behavior: 'smooth' });
              }}
              className="fixed bottom-24 left-1/2 -translate-x-1/2 px-4 py-1.5 text-xs bg-teal-600 text-white rounded-full shadow-lg hover:bg-teal-500 z-10"
            >
              New messages
            </button>
          )}
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
              placeholder="Ask about bots, signals, targets... or give commands"
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-3.5 py-2.5 text-sm text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-teal-500 focus:border-teal-500"
              disabled={sending}
            />
            <button
              onClick={sendMessage}
              disabled={sending || !input.trim()}
              className="px-5 py-2.5 bg-teal-600 hover:bg-teal-500 disabled:bg-slate-700 disabled:text-slate-500 text-white text-sm font-medium rounded-lg transition-colors"
            >
              {sending ? (
                <span className="inline-block w-4 h-4 border-2 border-white/30 border-t-white rounded-full animate-spin" />
              ) : 'Send'}
            </button>
          </div>
        </div>
      </div>

      {/* ── Right: Context Sidebar ── */}
      <div className={`w-[360px] flex flex-col gap-3 overflow-y-auto shrink-0 transition-all ${sidebarCollapsed ? 'hidden lg:flex' : 'flex'}`}>

        {/* Target Progress */}
        <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Target Progress</h3>
          {target ? (
            <>
              <div className="flex items-center justify-between mb-2">
                <span className={`text-lg font-bold font-mono ${pnlColor(target.currentPnl)}`}>
                  {target.currentPnl >= 0 ? '+' : ''}₹{target.currentPnl.toFixed(0)}
                </span>
                <span className={`text-xs px-2 py-0.5 rounded border ${
                  target.status === 'ACTIVE' ? 'bg-green-500/10 text-green-400 border-green-500/20'
                    : target.status === 'TARGET_HIT' ? 'bg-teal-500/10 text-teal-400 border-teal-500/20'
                    : target.status === 'LOSS_LIMIT' ? 'bg-red-500/10 text-red-400 border-red-500/20'
                    : 'bg-yellow-500/10 text-yellow-400 border-yellow-500/20'
                }`}>{target.status.replace(/_/g, ' ')}</span>
              </div>
              <div className="flex justify-between text-[10px] text-slate-500 mb-1">
                <span>₹0</span>
                <span>Target: ₹{target.profitTargetAbs.toFixed(0)}</span>
              </div>
              <div className="h-2 bg-slate-700 rounded-full overflow-hidden mb-2">
                <div
                  className={`h-full rounded-full transition-all duration-500 ${target.currentPnl >= 0 ? 'bg-green-500' : 'bg-red-500'}`}
                  style={{ width: `${Math.min(Math.abs(target.progressPct), 100)}%` }}
                />
              </div>
              <div className="flex items-center justify-between text-[10px] text-slate-500">
                <span>Max Loss: -₹{target.maxLossAbs.toFixed(0)}</span>
                <span>{target.instruments}</span>
              </div>
            </>
          ) : (
            <p className="text-xs text-slate-500">No active target. Say "Make 2% daily on 10L" to set one.</p>
          )}
        </div>

        {/* Risk Meter */}
        {risk && (
          <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Risk</h3>
            <div className="grid grid-cols-2 gap-3">
              <div>
                <p className="text-[10px] text-slate-500">Score</p>
                <p className={`text-lg font-bold ${risk.riskScore > 70 ? 'text-red-400' : risk.riskScore > 40 ? 'text-yellow-400' : 'text-green-400'}`}>
                  {risk.riskScore}<span className="text-xs text-slate-500">/100</span>
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">Day P&L</p>
                <p className={`text-lg font-bold font-mono ${pnlColor(risk.dayPnl)}`}>
                  {risk.dayPnl >= 0 ? '+' : ''}{risk.dayPnl.toFixed(0)}
                </p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">Positions</p>
                <p className="text-sm font-medium text-white">{risk.openPositions}</p>
              </div>
              <div>
                <p className="text-[10px] text-slate-500">Drawdown</p>
                <p className="text-sm font-medium text-white">{risk.dayDrawdownPct.toFixed(1)}%</p>
              </div>
            </div>
            {risk.circuitBreakerActive && (
              <div className="mt-2 px-2 py-1 bg-red-500/10 border border-red-500/20 rounded text-[10px] text-red-400 font-medium">
                Circuit breaker active
              </div>
            )}
          </div>
        )}

        {/* Bot Fleet */}
        {dashboard?.bots && dashboard.bots.length > 0 && (
          <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              Bot Fleet ({dashboard.bots.length})
            </h3>
            <div className="space-y-2">
              {dashboard.bots.map(bot => (
                <div key={bot.id} className="flex items-center gap-2 py-1.5 border-b border-slate-800 last:border-0">
                  <span className="w-2 h-2 rounded-full bg-green-500 animate-pulse shrink-0" />
                  <div className="flex-1 min-w-0">
                    <div className="flex items-center justify-between">
                      <p className="text-xs font-medium text-white truncate">{bot.name}</p>
                      <span className={`text-xs font-bold font-mono ${pnlColor(Number(bot.totalPnl))}`}>
                        {Number(bot.totalPnl) >= 0 ? '+' : ''}{Number(bot.totalPnl).toFixed(0)}
                      </span>
                    </div>
                    <p className="text-[10px] text-slate-500 truncate">{bot.lastAction || 'Idle'}</p>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Today's Signals */}
        {dashboard?.todaySignals && dashboard.todaySignals.length > 0 && (
          <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">
              Signals ({dashboard.todaySignals.length})
            </h3>
            <div className="space-y-1.5 max-h-48 overflow-y-auto">
              {dashboard.todaySignals.slice(0, 8).map(sig => (
                <div key={sig.id} className="flex items-center justify-between py-1 text-xs">
                  <div className="flex items-center gap-1.5">
                    <span className={`font-bold ${sig.signalType === 'BUY' ? 'text-green-400' : 'text-red-400'}`}>
                      {sig.signalType}
                    </span>
                    <span className="text-white">{sig.symbol}</span>
                  </div>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-400 font-mono">{(sig.compositeScore * 100).toFixed(0)}%</span>
                    <span className={`text-[10px] px-1 py-0.5 rounded ${
                      sig.status === 'EXECUTED' ? 'bg-green-500/10 text-green-400'
                        : sig.status === 'REJECTED' ? 'bg-red-500/10 text-red-400'
                        : 'bg-amber-500/10 text-amber-400'
                    }`}>{sig.status}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Quick Scan */}
        <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Quick Scan</h3>
          <div className="flex gap-2 mb-3">
            <input
              type="text"
              value={scanSymbol}
              onChange={e => setScanSymbol(e.target.value.toUpperCase())}
              onKeyDown={e => {
                if (e.key === 'Enter' && scanSymbol.trim()) {
                  setInput(`Scan ${scanSymbol.trim()}`);
                  setScanSymbol('');
                }
              }}
              placeholder="RELIANCE, NIFTY..."
              className="flex-1 bg-slate-800 border border-slate-700 rounded-lg px-2.5 py-1.5 text-xs text-white placeholder-slate-500 focus:outline-none focus:ring-1 focus:ring-teal-500"
            />
            <button
              onClick={() => { if (scanSymbol.trim()) { setInput(`Scan ${scanSymbol.trim()}`); setScanSymbol(''); } }}
              className="px-3 py-1.5 text-[10px] font-medium rounded-lg bg-teal-600 text-white hover:bg-teal-500 transition-colors"
            >
              Scan
            </button>
          </div>
          <div className="grid grid-cols-3 gap-1.5">
            {['RELIANCE', 'NIFTY', 'BANKNIFTY', 'TCS', 'INFY', 'HDFCBANK'].map(sym => (
              <button
                key={sym}
                onClick={() => setInput(`Scan ${sym}`)}
                className="px-2 py-1 text-[10px] font-medium rounded bg-slate-800 text-slate-400 hover:bg-slate-700 hover:text-white border border-slate-700/50 transition-colors"
              >
                {sym}
              </button>
            ))}
          </div>
        </div>

        {/* Rust Engine Actions */}
        <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
          <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">Engine & Controls</h3>
          <div className="grid grid-cols-2 gap-2">
            {[
              { label: 'Engine Status', cmd: 'Rust engine status', icon: '🦀' },
              { label: 'Options NIFTY', cmd: 'Options NIFTY', icon: '📊' },
              { label: 'Options BANKNIFTY', cmd: 'Options BANKNIFTY', icon: '📊' },
              { label: 'Start Scanner', cmd: 'Start scanning', icon: '📡' },
              { label: 'Stop Scanner', cmd: 'Stop the scanner', icon: '🛑' },
              { label: 'Start Agent', cmd: 'Start the AI agent', icon: '🤖' },
              { label: 'Stop Agent', cmd: 'Stop the agent', icon: '⏹️' },
              { label: 'Check Progress', cmd: 'How are we doing?', icon: '📈' },
              { label: 'Pending Signals', cmd: 'Show pending signals', icon: '⚡' },
              { label: 'Pause Trading', cmd: 'Stop all trading', icon: '⏸️' },
            ].map(a => (
              <button
                key={a.cmd}
                onClick={() => setInput(a.cmd)}
                className="flex items-center gap-1.5 px-2 py-1.5 text-[10px] font-medium rounded-lg bg-slate-800 text-slate-300 hover:bg-slate-700 hover:text-white border border-slate-700/50 transition-colors"
              >
                <span>{a.icon}</span>
                {a.label}
              </button>
            ))}
          </div>
        </div>

        {/* P&L History */}
        {dashboard?.recentPnl && dashboard.recentPnl.length > 0 && (
          <div className="bg-slate-900 rounded-xl border border-slate-700/50 p-4">
            <h3 className="text-xs font-semibold text-slate-400 uppercase tracking-wider mb-3">P&L History</h3>
            <div className="space-y-1">
              {dashboard.recentPnl.map((day, i) => (
                <div key={i} className="flex items-center justify-between text-xs py-1 border-b border-slate-800 last:border-0">
                  <span className="text-slate-500">{new Date(day.date).toLocaleDateString('en-IN', { day: 'numeric', month: 'short' })}</span>
                  <div className="flex items-center gap-2">
                    <span className="text-slate-600 text-[10px]">{day.winCount}W/{day.lossCount}L</span>
                    <span className={`font-bold font-mono ${pnlColor(day.netPnl)}`}>
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
