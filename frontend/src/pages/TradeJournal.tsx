import { useState, useEffect, useCallback } from 'react';
import { ChevronDown, ChevronUp, Filter, Search, RefreshCcw, Loader2, Calendar } from 'lucide-react';
import type { Trade } from '@/types';
import { formatINR } from '@/types';
import { tradingApi } from '@/services/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

type FilterState = {
  strategy: string;
  result: 'all' | 'profit' | 'loss';
  search: string;
  fromDate: string;
  toDate: string;
};

export default function TradeJournal() {
  const [trades, setTrades] = useState<Trade[]>([]);
  const [loading, setLoading] = useState(true);
  const [expandedId, setExpandedId] = useState<string | null>(null);
  const [filters, setFilters] = useState<FilterState>({
    strategy: 'all',
    result: 'all',
    search: '',
    fromDate: '',
    toDate: '',
  });

  const fetchTrades = useCallback(async () => {
    setLoading(true);
    try {
      const params: Record<string, any> = { limit: 100 };
      if (filters.fromDate) params.from_date = filters.fromDate;
      if (filters.toDate) params.to_date = filters.toDate;
      if (filters.search) params.symbol = filters.search.toUpperCase();

      const { data } = await tradingApi.listTrades(params);
      const raw = Array.isArray(data) ? data : (data as any)?.trades ?? (data as any)?.items ?? [];

      const mapped: Trade[] = raw.map((t: any) => ({
        id: t.id ?? String(Math.random()),
        symbol: t.symbol ?? '',
        exchange: t.exchange ?? 'NSE',
        side: t.side ?? t.direction ?? 'BUY',
        quantity: Number(t.qty ?? t.quantity ?? 0),
        price: Number(t.entryPrice ?? t.entry_price ?? t.price ?? 0),
        pnl: Number(t.netPnl ?? t.net_pnl ?? t.pnl ?? t.realizedPnl ?? 0),
        strategy: t.strategyTag ?? t.strategy_tag ?? t.strategy ?? '',
        executedAt: t.entryTime ?? t.entry_time ?? t.executedAt ?? t.createdAt ?? '',
        time: t.exitTime ?? t.exit_time ?? t.entryTime ?? t.entry_time ?? '',
        aiBriefing: t.aiBriefing ?? t.ai_briefing ?? '',
      }));

      setTrades(mapped);
    } catch {
      setTrades([]);
    } finally {
      setLoading(false);
    }
  }, [filters.fromDate, filters.toDate, filters.search]);

  useEffect(() => {
    fetchTrades();
  }, [fetchTrades]);

  const strategies = ['all', ...Array.from(new Set(trades.map((t) => t.strategy).filter(Boolean)))];

  const filteredTrades = trades.filter((t) => {
    if (filters.strategy !== 'all' && t.strategy !== filters.strategy) return false;
    if (filters.result === 'profit' && (t.pnl ?? 0) < 0) return false;
    if (filters.result === 'loss' && (t.pnl ?? 0) >= 0) return false;
    if (filters.search && !t.symbol.toLowerCase().includes(filters.search.toLowerCase())) return false;
    return true;
  });

  const totalPnL = filteredTrades.reduce((sum, t) => sum + (t.pnl ?? 0), 0);
  const winners = filteredTrades.filter((t) => (t.pnl ?? 0) >= 0).length;
  const losers = filteredTrades.filter((t) => (t.pnl ?? 0) < 0).length;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <h1 className="text-xl font-bold text-slate-900">Trade Journal</h1>
        <div className="flex items-center gap-3 text-sm">
          {loading ? (
            <Loader2 className="w-4 h-4 animate-spin text-slate-400" />
          ) : (
            <>
              <span className="text-slate-400">
                {filteredTrades.length} trades
              </span>
              <span className="text-emerald-600">{winners}W</span>
              <span className="text-slate-300">/</span>
              <span className="text-red-600">{losers}L</span>
              <span className={`font-semibold ${totalPnL >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                {formatINR(totalPnL)}
              </span>
            </>
          )}
          <button onClick={fetchTrades} className="p-1.5 rounded-md hover:bg-slate-100 text-slate-400" title="Refresh">
            <RefreshCcw className="w-4 h-4" />
          </button>
        </div>
      </div>

      {/* Filters */}
      <div className="flex flex-wrap items-center gap-3 rounded-xl border border-slate-200 bg-white p-4 shadow-sm">
        <Filter className="h-4 w-4 text-slate-400" />

        <div className="relative">
          <Search className="absolute left-3 top-1/2 h-3.5 w-3.5 -translate-y-1/2 text-slate-400" />
          <input
            type="text"
            placeholder="Search symbol..."
            value={filters.search}
            onChange={(e) => setFilters((f) => ({ ...f, search: e.target.value }))}
            className="rounded-lg border border-slate-200 bg-slate-50 py-1.5 pl-9 pr-3 text-sm text-slate-800 outline-none focus:border-indigo-500"
          />
        </div>

        <select
          value={filters.strategy}
          onChange={(e) => setFilters((f) => ({ ...f, strategy: e.target.value }))}
          className="rounded-lg border border-slate-200 bg-slate-50 px-3 py-1.5 text-sm text-slate-800 outline-none focus:border-indigo-500"
        >
          {strategies.map((s) => (
            <option key={s} value={s}>{s === 'all' ? 'All Strategies' : s}</option>
          ))}
        </select>

        <div className="flex gap-1 rounded-lg bg-slate-100 p-0.5">
          {(['all', 'profit', 'loss'] as const).map((opt) => (
            <button
              key={opt}
              onClick={() => setFilters((f) => ({ ...f, result: opt }))}
              className={`rounded-md px-3 py-1 text-xs font-medium transition-colors ${
                filters.result === opt
                  ? 'bg-white text-slate-900 shadow-sm'
                  : 'text-slate-400 hover:text-slate-600'
              }`}
            >
              {opt === 'all' ? 'All' : opt === 'profit' ? 'Profits' : 'Losses'}
            </button>
          ))}
        </div>

        <div className="flex items-center gap-2 ml-auto">
          <Calendar className="h-3.5 w-3.5 text-slate-400" />
          <input
            type="date"
            value={filters.fromDate}
            onChange={(e) => setFilters((f) => ({ ...f, fromDate: e.target.value }))}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-800 outline-none focus:border-indigo-500"
          />
          <span className="text-xs text-slate-400">to</span>
          <input
            type="date"
            value={filters.toDate}
            onChange={(e) => setFilters((f) => ({ ...f, toDate: e.target.value }))}
            className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-xs text-slate-800 outline-none focus:border-indigo-500"
          />
        </div>
      </div>

      {/* Trade cards */}
      {loading ? (
        <div className="flex items-center justify-center py-16">
          <Loader2 className="w-6 h-6 animate-spin text-slate-400" />
        </div>
      ) : (
        <div className="space-y-3">
          {filteredTrades.map((trade) => {
            const expanded = expandedId === trade.id;
            const isBuy = trade.side === 'BUY';
            const pnlPositive = (trade.pnl ?? 0) >= 0;

            return (
              <div
                key={trade.id}
                className="rounded-xl border border-slate-200 bg-white shadow-sm transition-colors hover:border-slate-300"
              >
                <button
                  className="flex w-full items-center gap-4 p-4 text-left"
                  onClick={() => setExpandedId(expanded ? null : trade.id)}
                >
                  <div className="flex-1">
                    <div className="flex items-center gap-2">
                      <span className="font-medium text-slate-900">{trade.symbol}</span>
                      <span
                        className={`rounded px-1.5 py-0.5 text-[10px] font-bold ${
                          isBuy ? 'bg-emerald-50 text-emerald-600' : 'bg-red-50 text-red-600'
                        }`}
                      >
                        {trade.side}
                      </span>
                      {trade.strategy && (
                        <span className="rounded bg-slate-100 px-1.5 py-0.5 text-[10px] text-slate-500">
                          {trade.strategy}
                        </span>
                      )}
                    </div>
                    <div className="mt-1 flex items-center gap-4 text-xs text-slate-400">
                      <span>Qty: {trade.quantity}</span>
                      <span>@ {formatINR(trade.price)}</span>
                      <span>
                        {trade.time || trade.executedAt
                          ? `${new Date(trade.time ?? trade.executedAt).toLocaleDateString('en-IN')} ${new Date(trade.time ?? trade.executedAt).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit' })}`
                          : '—'}
                      </span>
                    </div>
                  </div>

                  <span className={`text-lg font-semibold ${pnlPositive ? 'text-emerald-600' : 'text-red-600'}`}>
                    {formatINR(trade.pnl)}
                  </span>

                  {expanded ? (
                    <ChevronUp className="h-4 w-4 text-slate-400" />
                  ) : (
                    <ChevronDown className="h-4 w-4 text-slate-400" />
                  )}
                </button>

                {expanded && trade.aiBriefing && (
                  <div className="border-t border-slate-200 px-4 pb-4 pt-3">
                    <p className="mb-1 text-xs font-medium text-slate-400">AI Briefing</p>
                    <p className="text-sm leading-relaxed text-slate-600">{trade.aiBriefing}</p>
                  </div>
                )}
              </div>
            );
          })}

          {filteredTrades.length === 0 && !loading && (
            <div className="flex h-[200px] items-center justify-center rounded-xl border border-dashed border-slate-300 bg-white">
              <p className="text-sm text-slate-400">
                {trades.length === 0 ? 'No trades yet. Place trades in the Trading Terminal.' : 'No trades match the current filters'}
              </p>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
