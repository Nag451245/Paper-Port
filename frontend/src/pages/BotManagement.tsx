import { useState, useEffect, useCallback } from 'react';
import {
  Bot,
  Plus,
  Play,
  Square,
  Pencil,
  Trash2,
  ClipboardList,
  X,
  Loader2,
  AlertCircle,
  CheckCircle2,
  TrendingUp,
  Activity,
  Users,
  MessageSquare,
} from 'lucide-react';
import { botsApi } from '@/services/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const ROLE_COLORS: Record<string, string> = {
  SCANNER: 'bg-blue-50 text-blue-700 border-blue-200',
  ANALYST: 'bg-indigo-50 text-indigo-700 border-indigo-200',
  EXECUTOR: 'bg-emerald-50 text-emerald-700 border-emerald-200',
  RISK_MANAGER: 'bg-amber-50 text-amber-700 border-amber-200',
  STRATEGIST: 'bg-violet-50 text-violet-700 border-violet-200',
  MONITOR: 'bg-slate-100 text-slate-700 border-slate-200',
  FNO_STRATEGIST: 'bg-orange-50 text-orange-700 border-orange-200',
};

const ROLES = [
  { value: 'SCANNER', label: 'Scanner' },
  { value: 'ANALYST', label: 'Analyst' },
  { value: 'EXECUTOR', label: 'Executor' },
  { value: 'RISK_MANAGER', label: 'Risk Manager' },
  { value: 'STRATEGIST', label: 'Strategist' },
  { value: 'MONITOR', label: 'Monitor' },
  { value: 'FNO_STRATEGIST', label: 'F&O Strategist', description: 'Analyzes options chain data, generates multi-leg F&O strategies' },
];
const EMOJIS = ['🤖', '🧠', '🎯', '📊', '🔍', '⚡', '🛡️', '🏹', '🦅', '🐂', '🐻', '🔬', '📈'];
const TASK_TYPES = ['scan', 'analyze', 'trade', 'monitor', 'report'];

const MSG_COLORS: Record<string, string> = {
  info: 'border-l-blue-400 bg-blue-50/60',
  signal: 'border-l-emerald-400 bg-emerald-50/60',
  alert: 'border-l-amber-400 bg-amber-50/60',
  trade_request: 'border-l-indigo-400 bg-indigo-50/60',
  approval: 'border-l-emerald-500 bg-emerald-50/60',
};

interface BotForm {
  name: string;
  avatarEmoji: string;
  role: string;
  description: string;
  maxCapital: number;
  assignedSymbols: string;
  assignedStrategy: string;
}

const emptyForm: BotForm = {
  name: '',
  avatarEmoji: '🤖',
  role: 'SCANNER',
  description: '',
  maxCapital: 100000,
  assignedSymbols: '',
  assignedStrategy: '',
};

function num(v: any): number {
  if (v == null) return 0;
  return typeof v === 'string' ? parseFloat(v) || 0 : Number(v);
}

function fmtTime(iso: string | null | undefined): string {
  if (!iso) return '—';
  try {
    return new Date(iso).toLocaleString('en-IN', {
      day: '2-digit',
      month: 'short',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return String(iso);
  }
}

export default function BotManagement() {
  const [bots, setBots] = useState<any[]>([]);
  const [messages, setMessages] = useState<any[]>([]);
  const [isLoading, setIsLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [success, setSuccess] = useState<string | null>(null);

  const [showCreateModal, setShowCreateModal] = useState(false);
  const [editingBot, setEditingBot] = useState<any | null>(null);
  const [form, setForm] = useState<BotForm>(emptyForm);
  const [isSaving, setIsSaving] = useState(false);

  const [taskBot, setTaskBot] = useState<any | null>(null);
  const [taskType, setTaskType] = useState('scan');
  const [taskDesc, setTaskDesc] = useState('');
  const [isAssigning, setIsAssigning] = useState(false);

  const fetchAll = useCallback(async () => {
    setIsLoading(true);
    try {
      const [botsRes, msgsRes] = await Promise.all([
        botsApi.list().catch(() => ({ data: [] })),
        botsApi.allMessages().catch(() => ({ data: [] })),
      ]);
      setBots(Array.isArray(botsRes.data) ? botsRes.data : []);
      setMessages(Array.isArray(msgsRes.data) ? msgsRes.data : []);
    } finally {
      setIsLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchAll();
    const poll = setInterval(fetchAll, 30_000);
    return () => clearInterval(poll);
  }, [fetchAll]);

  useEffect(() => {
    if (!success && !error) return;
    const t = setTimeout(() => { setSuccess(null); setError(null); }, 4000);
    return () => clearTimeout(t);
  }, [success, error]);

  const openCreate = () => {
    setEditingBot(null);
    setForm(emptyForm);
    setShowCreateModal(true);
  };

  const openEdit = (bot: any) => {
    setEditingBot(bot);
    setForm({
      name: bot.name || '',
      avatarEmoji: bot.avatarEmoji || '🤖',
      role: bot.role || 'SCANNER',
      description: bot.description || '',
      maxCapital: num(bot.maxCapital),
      assignedSymbols: bot.assignedSymbols || '',
      assignedStrategy: bot.assignedStrategy || '',
    });
    setShowCreateModal(true);
  };

  const handleSave = async () => {
    if (!form.name.trim()) { setError('Bot name is required'); return; }
    setIsSaving(true);
    try {
      if (editingBot) {
        await botsApi.update(editingBot.id, { ...form });
        setSuccess(`${form.name} updated`);
      } else {
        await botsApi.create({
          name: form.name,
          role: form.role,
          avatarEmoji: form.avatarEmoji,
          description: form.description,
          maxCapital: form.maxCapital,
          assignedSymbols: form.assignedSymbols || undefined,
          assignedStrategy: form.assignedStrategy || undefined,
        });
        setSuccess(`${form.name} created`);
      }
      setShowCreateModal(false);
      await fetchAll();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || err?.message || 'Failed to save bot');
    } finally {
      setIsSaving(false);
    }
  };

  const handleDelete = async (bot: any) => {
    if (!confirm(`Delete "${bot.name}"?`)) return;
    try {
      await botsApi.delete(bot.id);
      setSuccess(`${bot.name} deleted`);
      await fetchAll();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || 'Delete failed');
    }
  };

  const handleToggle = async (bot: any) => {
    try {
      if (bot.status === 'RUNNING') {
        await botsApi.stop(bot.id);
        setSuccess(`${bot.name} stopped`);
      } else {
        await botsApi.start(bot.id);
        setSuccess(`${bot.name} started`);
      }
      await fetchAll();
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || 'Toggle failed');
    }
  };

  const handleAssignTask = async () => {
    if (!taskBot || !taskDesc.trim()) return;
    setIsAssigning(true);
    try {
      await botsApi.assignTask(taskBot.id, { taskType, description: taskDesc });
      setSuccess(`Task assigned to ${taskBot.name}`);
      setTaskBot(null);
      setTaskDesc('');
    } catch (err: any) {
      setError(err?.response?.data?.error || err?.response?.data?.detail || 'Task assignment failed');
    } finally {
      setIsAssigning(false);
    }
  };

  const totalPnl = bots.reduce((s, b) => s + num(b.totalPnl), 0);
  const runningCount = bots.filter((b) => b.status === 'RUNNING').length;

  return (
    <div className="space-y-6">
      {/* Alerts */}
      {error && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-red-50 border border-red-200 rounded-lg text-sm text-red-600">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span className="flex-1">{error}</span>
          <button onClick={() => setError(null)}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}
      {success && (
        <div className="flex items-center gap-2 px-4 py-2.5 bg-emerald-50 border border-emerald-200 rounded-lg text-sm text-emerald-600">
          <CheckCircle2 className="w-4 h-4 shrink-0" />
          <span className="flex-1">{success}</span>
          <button onClick={() => setSuccess(null)}><X className="w-3.5 h-3.5" /></button>
        </div>
      )}

      {/* Header */}
      <div className="flex flex-col sm:flex-row sm:items-center sm:justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-indigo-500 to-violet-500 flex items-center justify-center shadow-lg shadow-indigo-500/20">
            <Bot className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-slate-900">Trading Bot Team</h1>
            <p className="text-sm text-slate-500">Manage your AI trading squad</p>
          </div>
        </div>
        <button
          onClick={openCreate}
          className="inline-flex items-center gap-2 px-5 py-2.5 bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-sm font-semibold rounded-lg shadow-lg shadow-indigo-500/20 hover:shadow-indigo-500/30 transition-all hover:brightness-110"
        >
          <Plus className="w-4 h-4" />
          Create Bot
        </button>
      </div>

      {/* Stats bar */}
      <div className="grid grid-cols-3 gap-4">
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1">
            <Users className="w-3.5 h-3.5" /> Total Bots
          </div>
          <p className="text-2xl font-bold text-slate-900">{bots.length}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1">
            <Activity className="w-3.5 h-3.5" /> Running
          </div>
          <p className="text-2xl font-bold text-emerald-600">{runningCount}</p>
        </div>
        <div className="bg-white border border-slate-200 rounded-xl px-4 py-3 shadow-sm">
          <div className="flex items-center gap-2 text-slate-400 text-xs font-medium mb-1">
            <TrendingUp className="w-3.5 h-3.5" /> Total P&L
          </div>
          <p className={`text-2xl font-bold ${totalPnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
            {totalPnl >= 0 ? '+' : ''}₹{totalPnl.toLocaleString('en-IN', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
          </p>
        </div>
      </div>

      {/* Bot Grid */}
      {isLoading && bots.length === 0 ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : bots.length === 0 ? (
        <div className="bg-white border border-slate-200 rounded-xl p-12 text-center shadow-sm">
          <div className="w-16 h-16 mx-auto mb-4 rounded-2xl bg-slate-100 flex items-center justify-center">
            <Bot className="w-8 h-8 text-slate-400" />
          </div>
          <h3 className="text-lg font-semibold text-slate-900 mb-1">No bots yet</h3>
          <p className="text-sm text-slate-500 mb-4">Create your first trading bot to get started.</p>
          <button
            onClick={openCreate}
            className="inline-flex items-center gap-2 px-4 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-sm font-semibold rounded-lg"
          >
            <Plus className="w-4 h-4" /> Create Bot
          </button>
        </div>
      ) : (
        <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
          {bots.map((bot: any) => {
            const isRunning = bot.status === 'RUNNING';
            const isError = bot.status === 'ERROR';
            const pnl = num(bot.totalPnl);
            const capitalUsed = num(bot.usedCapital);
            const maxCapital = num(bot.maxCapital) || 1;
            const capitalPct = Math.min((capitalUsed / maxCapital) * 100, 100);
            const winRate = num(bot.winRate);
            const symbols = (bot.assignedSymbols || '').split(',').map((s: string) => s.trim()).filter(Boolean);

            return (
              <div
                key={bot.id}
                className={`bg-white border rounded-xl shadow-sm p-5 transition-all ${
                  isRunning
                    ? 'border-emerald-200 ring-2 ring-emerald-200 shadow-emerald-100'
                    : isError
                    ? 'border-red-200'
                    : 'border-slate-200'
                }`}
              >
                {/* Top row: avatar + name + status */}
                <div className="flex items-start justify-between mb-3">
                  <div className="flex items-center gap-3">
                    <span className="text-3xl">{bot.avatarEmoji || '🤖'}</span>
                    <div>
                      <h3 className="font-semibold text-slate-900 leading-tight">{bot.name}</h3>
                      <span className={`inline-block mt-0.5 text-[10px] font-semibold px-2 py-0.5 rounded-full border ${ROLE_COLORS[bot.role] || ROLE_COLORS.MONITOR}`}>
                        {ROLES.find(r => r.value === bot.role)?.label ?? bot.role}
                      </span>
                    </div>
                  </div>
                  <div className="flex items-center gap-1.5">
                    <span
                      className={`w-2.5 h-2.5 rounded-full ${
                        isRunning ? 'bg-emerald-500 animate-pulse' : isError ? 'bg-red-500' : 'bg-slate-300'
                      }`}
                    />
                    <span className={`text-xs font-medium ${isRunning ? 'text-emerald-600' : isError ? 'text-red-600' : 'text-slate-400'}`}>
                      {(bot.status || 'IDLE').toLowerCase()}
                    </span>
                  </div>
                </div>

                {/* Symbols */}
                {symbols.length > 0 && (
                  <div className="flex flex-wrap gap-1 mb-3">
                    {symbols.map((s: string) => (
                      <span key={s} className="px-2 py-0.5 bg-slate-100 text-slate-600 text-[10px] font-medium rounded-full">
                        {s}
                      </span>
                    ))}
                  </div>
                )}

                {/* Capital bar */}
                <div className="mb-3">
                  <div className="flex items-center justify-between text-[11px] text-slate-500 mb-1">
                    <span>Capital</span>
                    <span>₹{capitalUsed.toLocaleString('en-IN')} / ₹{maxCapital.toLocaleString('en-IN')}</span>
                  </div>
                  <div className="w-full h-1.5 bg-slate-100 rounded-full overflow-hidden">
                    <div
                      className="h-full bg-indigo-500 rounded-full transition-all"
                      style={{ width: `${capitalPct}%` }}
                    />
                  </div>
                </div>

                {/* Stats row */}
                <div className="grid grid-cols-3 gap-2 mb-3">
                  <div className="text-center">
                    <p className="text-[10px] text-slate-400 uppercase">Trades</p>
                    <p className="text-sm font-bold text-slate-800">{bot.totalTrades ?? 0}</p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-slate-400 uppercase">P&L</p>
                    <p className={`text-sm font-bold ${pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                      {pnl >= 0 ? '+' : ''}₹{pnl.toFixed(0)}
                    </p>
                  </div>
                  <div className="text-center">
                    <p className="text-[10px] text-slate-400 uppercase">Win Rate</p>
                    <p className="text-sm font-bold text-slate-800">{winRate.toFixed(0)}%</p>
                  </div>
                </div>

                {/* Last action */}
                {bot.lastAction && (
                  <p className="text-xs text-slate-400 mb-3 truncate">
                    {bot.lastAction}{' '}
                    <span className="text-slate-300">· {fmtTime(bot.lastActionAt)}</span>
                  </p>
                )}

                {/* Actions */}
                <div className="flex items-center gap-1.5 pt-3 border-t border-slate-100">
                  <button
                    onClick={() => handleToggle(bot)}
                    className={`flex items-center gap-1 px-3 py-1.5 text-xs font-semibold rounded-lg transition-colors ${
                      isRunning
                        ? 'bg-slate-200 text-slate-700 hover:bg-slate-300'
                        : 'bg-emerald-500 text-white hover:bg-emerald-600'
                    }`}
                  >
                    {isRunning ? <Square className="w-3 h-3" /> : <Play className="w-3 h-3" />}
                    {isRunning ? 'Stop' : 'Start'}
                  </button>
                  <button
                    onClick={() => openEdit(bot)}
                    className="p-1.5 rounded-lg text-slate-400 hover:bg-slate-100 hover:text-slate-600 transition-colors"
                    title="Edit"
                  >
                    <Pencil className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => handleDelete(bot)}
                    className="p-1.5 rounded-lg text-red-400 hover:bg-red-50 hover:text-red-600 transition-colors"
                    title="Delete"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                  <button
                    onClick={() => { setTaskBot(bot); setTaskType('scan'); setTaskDesc(''); }}
                    className="ml-auto flex items-center gap-1 px-2.5 py-1.5 text-xs text-indigo-600 bg-indigo-50 rounded-lg hover:bg-indigo-100 transition-colors font-medium"
                    title="Assign Task"
                  >
                    <ClipboardList className="w-3 h-3" />
                    Task
                  </button>
                </div>
              </div>
            );
          })}
        </div>
      )}

      {/* Bot Communication Feed */}
      <div className="bg-white border border-slate-200 rounded-xl shadow-sm overflow-hidden">
        <div className="flex items-center gap-2 px-5 py-3 border-b border-slate-200">
          <MessageSquare className="w-4 h-4 text-slate-400" />
          <h2 className="text-sm font-semibold text-slate-700">Bot Communications</h2>
          <span className="ml-auto text-[10px] text-slate-400 font-medium">{messages.length} messages</span>
        </div>
        <div className="max-h-[320px] overflow-y-auto divide-y divide-slate-100">
          {messages.length === 0 ? (
            <p className="text-sm text-slate-400 text-center py-10">No bot messages yet</p>
          ) : (
            messages.slice(-30).reverse().map((msg: any, i: number) => {
              const fromBot = bots.find((b) => b.id === msg.fromBotId || b.id === msg.botId);
              const toBot = msg.toBotId ? bots.find((b) => b.id === msg.toBotId) : null;
              const colorClass = MSG_COLORS[msg.messageType] || MSG_COLORS.info;

              return (
                <div key={msg.id || i} className={`px-5 py-3 border-l-4 ${colorClass}`}>
                  <div className="flex items-center gap-2 mb-1">
                    <span className="text-base">{fromBot?.avatarEmoji || '🤖'}</span>
                    <span className="text-xs font-semibold text-slate-700">{fromBot?.name || 'Unknown'}</span>
                    {toBot && (
                      <>
                        <span className="text-[10px] text-slate-400">→</span>
                        <span className="text-base">{toBot.avatarEmoji || '🤖'}</span>
                        <span className="text-xs font-semibold text-slate-700">{toBot.name}</span>
                      </>
                    )}
                    <span className="ml-auto text-[10px] text-slate-400">{fmtTime(msg.createdAt || msg.timestamp)}</span>
                  </div>
                  <p className="text-sm text-slate-600 leading-relaxed">{msg.content}</p>
                </div>
              );
            })
          )}
        </div>
      </div>

      {/* Create / Edit Modal */}
      {showCreateModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-lg max-h-[90vh] overflow-y-auto">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <h2 className="text-lg font-bold text-slate-900">
                {editingBot ? 'Edit Bot' : 'Create New Bot'}
              </h2>
              <button onClick={() => setShowCreateModal(false)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              {/* Name */}
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Bot Name</label>
                <input
                  value={form.name}
                  onChange={(e) => setForm({ ...form, name: e.target.value })}
                  placeholder="e.g. Alpha Scanner"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>

              {/* Emoji picker */}
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Avatar Emoji</label>
                <div className="flex flex-wrap gap-1.5">
                  {EMOJIS.map((e) => (
                    <button
                      key={e}
                      type="button"
                      onClick={() => setForm({ ...form, avatarEmoji: e })}
                      className={`w-10 h-10 text-xl rounded-lg border-2 transition-all flex items-center justify-center ${
                        form.avatarEmoji === e
                          ? 'border-indigo-500 bg-indigo-50 shadow-sm'
                          : 'border-slate-200 bg-white hover:border-slate-300'
                      }`}
                    >
                      {e}
                    </button>
                  ))}
                </div>
              </div>

              {/* Role */}
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Role</label>
                <select
                  value={form.role}
                  onChange={(e) => setForm({ ...form, role: e.target.value })}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                >
                  {ROLES.map((r) => <option key={r.value} value={r.value}>{r.label}</option>)}
                </select>
              </div>

              {/* Description */}
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Description</label>
                <textarea
                  value={form.description}
                  onChange={(e) => setForm({ ...form, description: e.target.value })}
                  placeholder="What does this bot do?"
                  rows={3}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 resize-none"
                />
              </div>

              {/* Max Capital */}
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Max Capital (₹)</label>
                <input
                  type="number"
                  value={form.maxCapital}
                  onChange={(e) => setForm({ ...form, maxCapital: Number(e.target.value) })}
                  min={0}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>

              {/* Assigned symbols */}
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Assigned Symbols (comma-separated)</label>
                <input
                  value={form.assignedSymbols}
                  onChange={(e) => setForm({ ...form, assignedSymbols: e.target.value })}
                  placeholder="RELIANCE, TCS, GOLD, USDINR"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>

              {/* Strategy */}
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Strategy</label>
                <input
                  value={form.assignedStrategy}
                  onChange={(e) => setForm({ ...form, assignedStrategy: e.target.value })}
                  placeholder="e.g. Mean Reversion, Momentum"
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                />
              </div>
            </div>

            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200">
              <button
                onClick={() => setShowCreateModal(false)}
                className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors"
              >
                Cancel
              </button>
              <button
                onClick={handleSave}
                disabled={isSaving}
                className="px-5 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-sm font-semibold rounded-lg shadow-lg shadow-indigo-500/20 hover:brightness-110 transition-all disabled:opacity-50"
              >
                {isSaving && <Loader2 className="w-4 h-4 inline animate-spin mr-1.5" />}
                {editingBot ? 'Save Changes' : 'Create Bot'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Task Assignment Modal */}
      {taskBot && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 backdrop-blur-sm p-4">
          <div className="bg-white rounded-2xl shadow-2xl w-full max-w-md">
            <div className="flex items-center justify-between px-6 py-4 border-b border-slate-200">
              <div className="flex items-center gap-2">
                <span className="text-xl">{taskBot.avatarEmoji}</span>
                <h2 className="text-lg font-bold text-slate-900">Assign Task to {taskBot.name}</h2>
              </div>
              <button onClick={() => setTaskBot(null)} className="p-1 rounded-lg hover:bg-slate-100 text-slate-400">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="p-6 space-y-4">
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Task Type</label>
                <select
                  value={taskType}
                  onChange={(e) => setTaskType(e.target.value)}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 focus:outline-none focus:ring-2 focus:ring-indigo-500/40"
                >
                  {TASK_TYPES.map((t) => <option key={t} value={t}>{t.charAt(0).toUpperCase() + t.slice(1)}</option>)}
                </select>
              </div>
              <div>
                <label className="text-xs font-medium text-slate-500 mb-1 block">Description</label>
                <textarea
                  value={taskDesc}
                  onChange={(e) => setTaskDesc(e.target.value)}
                  placeholder="Describe the task..."
                  rows={4}
                  className="w-full px-3 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm text-slate-800 placeholder:text-slate-400 focus:outline-none focus:ring-2 focus:ring-indigo-500/40 resize-none"
                />
              </div>
            </div>
            <div className="flex items-center justify-end gap-3 px-6 py-4 border-t border-slate-200">
              <button onClick={() => setTaskBot(null)} className="px-4 py-2 text-sm text-slate-600 hover:bg-slate-100 rounded-lg transition-colors">
                Cancel
              </button>
              <button
                onClick={handleAssignTask}
                disabled={isAssigning || !taskDesc.trim()}
                className="px-5 py-2 bg-gradient-to-r from-indigo-600 to-violet-600 text-white text-sm font-semibold rounded-lg shadow-lg shadow-indigo-500/20 hover:brightness-110 transition-all disabled:opacity-50"
              >
                {isAssigning && <Loader2 className="w-4 h-4 inline animate-spin mr-1.5" />}
                Assign Task
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
