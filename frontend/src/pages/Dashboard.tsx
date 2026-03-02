import { useEffect, useState } from 'react';
import {
  TrendingUp,
  Bot,
  Newspaper,
  Activity,
  Globe,
  Eye,
  ArrowUpRight,
  ArrowDownRight,
  Briefcase,
  RefreshCcw,
} from 'lucide-react';
import { usePortfolioStore } from '@/stores/portfolio';
import { useAIAgentStore } from '@/stores/ai-agent';
import { useMarketDataStore } from '@/stores/market-data';
import { tradingApi } from '@/services/api';

export default function Dashboard() {
  const { portfolios, summary, isLoading: portfolioLoading, fetchPortfolios } = usePortfolioStore();
  const { status, briefing, fetchStatus, fetchBriefing } = useAIAgentStore();
  const { vix, indices, watchlists, fetchWatchlists, fetchVIX, fetchIndices } = useMarketDataStore();
  const [todayTrades, setTodayTrades] = useState<any[]>([]);

  useEffect(() => {
    fetchPortfolios();
    fetchStatus();
    fetchBriefing();
    fetchWatchlists();
    fetchVIX();
    fetchIndices();

    const today = new Date().toISOString().slice(0, 10);
    tradingApi.listTrades({ from_date: today, to_date: today, limit: 20 })
      .then(({ data }) => {
        const trades = Array.isArray(data) ? data : (data as any)?.trades ?? (data as any)?.items ?? [];
        setTodayTrades(trades);
      })
      .catch(() => {});
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const hasPortfolios = portfolios && portfolios.length > 0;
  const watchlistItems = watchlists?.[0]?.items;
  const hasWatchlistItems = Array.isArray(watchlistItems) && watchlistItems.length > 0;

  const indicesData = indices.length > 0
    ? indices.map((idx: any) => ({
        name: idx.name ?? idx.index ?? 'Unknown',
        value: Number(idx.value ?? idx.last ?? idx.ltp ?? 0),
        change: Number(idx.changePercent ?? idx.change_pct ?? idx.percentChange ?? 0),
      }))
    : [];

  const hasVix = vix && vix.value > 0;

  return (
    <div className="space-y-6">
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Dashboard</h1>
          <p className="text-sm text-slate-400 mt-0.5">Your trading overview at a glance</p>
        </div>
        <button
          onClick={() => {
            fetchIndices(); fetchVIX(); fetchPortfolios();
            const today = new Date().toISOString().slice(0, 10);
            tradingApi.listTrades({ from_date: today, to_date: today, limit: 20 })
              .then(({ data }) => {
                const trades = Array.isArray(data) ? data : (data as any)?.trades ?? (data as any)?.items ?? [];
                setTodayTrades(trades);
              })
              .catch(() => {});
          }}
          className="p-2.5 hover:bg-teal-50 rounded-xl transition group"
          title="Refresh"
        >
          <RefreshCcw className="w-4 h-4 text-slate-400 group-hover:text-teal-600 transition-colors" />
        </button>
      </div>

      {/* Global indices strip */}
      <div className="flex gap-3 overflow-x-auto pb-1 scrollbar-hide">
        {indicesData.length > 0 ? (
          indicesData.map((idx) => (
            <div
              key={idx.name}
              className="flex-shrink-0 flex items-center gap-2 px-3.5 py-2 bg-white border border-slate-200/60 rounded-xl text-xs shadow-sm card-hover"
            >
              <Globe className="w-3.5 h-3.5 text-teal-400" />
              <span className="text-slate-500 font-medium">{idx.name}</span>
              <span className="font-mono font-semibold text-slate-800">
                {idx.value.toLocaleString('en-IN')}
              </span>
              <span className={`font-mono font-semibold px-1.5 py-0.5 rounded-md text-[11px] ${
                idx.change >= 0
                  ? 'text-emerald-700 bg-emerald-50'
                  : 'text-red-700 bg-red-50'
              }`}>
                {idx.change >= 0 ? '+' : ''}{idx.change.toFixed(2)}%
              </span>
            </div>
          ))
        ) : (
          <div className="flex items-center gap-2 px-3 py-2 bg-white border border-slate-200 rounded-xl text-xs shadow-sm">
            <Globe className="w-3.5 h-3.5 text-slate-400" />
            <span className="text-slate-400">Loading indices...</span>
          </div>
        )}
      </div>

      {/* Main grid */}
      <div className="grid grid-cols-1 md:grid-cols-2 xl:grid-cols-3 gap-4">
        {/* Portfolio Summary */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm card-hover p-5 animate-slide-up" style={{ animationDelay: '0ms' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Portfolio Summary</h2>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-yellow-500 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
          </div>
          {portfolioLoading ? (
            <div className="flex items-center justify-center py-8">
              <div className="w-6 h-6 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
            </div>
          ) : !hasPortfolios ? (
            <div className="text-center py-6">
              <Briefcase className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-500">No portfolios yet.</p>
              <p className="text-xs text-slate-400 mt-1">Create a portfolio to start tracking your investments.</p>
            </div>
          ) : (
            <div className="space-y-3">
              <div>
                <p className="text-xs text-slate-500">Net Asset Value</p>
                <p className="text-2xl font-bold font-mono text-slate-900">₹{(summary?.totalNav ?? 0).toLocaleString('en-IN')}</p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="bg-slate-50 rounded-xl p-2.5">
                  <p className="text-xs text-slate-500">Day P&L</p>
                  <p className={`text-lg font-semibold font-mono ${(summary?.dayPnl ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {(summary?.dayPnl ?? 0) >= 0 ? '+' : ''}₹{(summary?.dayPnl ?? 0).toLocaleString('en-IN')}
                  </p>
                  <p className={`text-xs font-mono ${(summary?.dayPnlPercent ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {(summary?.dayPnlPercent ?? 0) >= 0 ? '+' : ''}{(summary?.dayPnlPercent ?? 0).toFixed(2)}%
                  </p>
                </div>
                <div className="bg-slate-50 rounded-xl p-2.5">
                  <p className="text-xs text-slate-500">Total P&L</p>
                  <p className={`text-lg font-semibold font-mono ${(summary?.totalPnl ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {(summary?.totalPnl ?? 0) >= 0 ? '+' : ''}₹{(summary?.totalPnl ?? 0).toLocaleString('en-IN')}
                  </p>
                  <p className={`text-xs font-mono ${(summary?.totalPnlPercent ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {(summary?.totalPnlPercent ?? 0) >= 0 ? '+' : ''}{(summary?.totalPnlPercent ?? 0).toFixed(2)}%
                  </p>
                </div>
              </div>
            </div>
          )}
        </div>

        {/* AI Agent Status */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm card-hover p-5 animate-slide-up" style={{ animationDelay: '80ms' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">AI Agent</h2>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-emerald-500 to-teal-500 flex items-center justify-center">
              <Bot className="w-4 h-4 text-white" />
            </div>
          </div>
          <div className="space-y-3">
            <div className="flex items-center gap-2">
              <div className={`w-2.5 h-2.5 rounded-full ${status?.isActive ? 'bg-emerald-500 animate-pulse' : 'bg-slate-300'}`} />
              <span className={`text-sm font-medium ${status?.isActive ? 'text-emerald-600' : 'text-slate-400'}`}>
                {status?.isActive ? 'Active' : 'Inactive'}
              </span>
            </div>
            <div className="bg-slate-50 rounded-xl p-2.5">
              <p className="text-xs text-slate-500">Mode</p>
              <p className="text-base font-semibold capitalize text-slate-900">{status?.mode ?? 'Advisory'}</p>
            </div>
            <div className="bg-slate-50 rounded-xl p-2.5">
              <p className="text-xs text-slate-500">Uptime</p>
              <p className="text-sm font-mono text-slate-600">
                {status?.uptime ? `${Math.floor(status.uptime / 3600)}h ${Math.floor((status.uptime % 3600) / 60)}m` : '—'}
              </p>
            </div>
          </div>
        </div>

        {/* Pre-Market Briefing */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm card-hover p-5 animate-slide-up" style={{ animationDelay: '160ms' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Pre-Market Briefing</h2>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-blue-500 to-cyan-500 flex items-center justify-center">
              <Newspaper className="w-4 h-4 text-white" />
            </div>
          </div>
          {briefing ? (
            <div className="space-y-3">
              <span
                className={`inline-block px-2.5 py-0.5 rounded-full text-xs font-semibold ${
                  briefing.stance === 'bullish'
                    ? 'bg-emerald-50 text-emerald-700 border border-emerald-200'
                    : briefing.stance === 'bearish'
                    ? 'bg-red-50 text-red-700 border border-red-200'
                    : 'bg-amber-50 text-amber-700 border border-amber-200'
                }`}
              >
                {briefing.stance?.toUpperCase() ?? 'NEUTRAL'}
              </span>
              <ul className="space-y-1.5">
                {(briefing.keyPoints ?? []).slice(0, 3).map((point, i) => (
                  <li key={i} className="text-xs text-slate-600 flex gap-2">
                    <span className="text-teal-500 mt-0.5">•</span>
                    {point}
                  </li>
                ))}
              </ul>
            </div>
          ) : (
            <p className="text-sm text-slate-400">No briefing available yet.</p>
          )}
        </div>

        {/* India VIX */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm card-hover p-5 animate-slide-up" style={{ animationDelay: '240ms' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">India VIX</h2>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
              <Activity className="w-4 h-4 text-white" />
            </div>
          </div>
          {hasVix ? (
            <>
              <div className="flex items-end gap-3">
                <p className={`text-3xl font-bold font-mono ${vix.value > 20 ? 'text-red-600' : 'text-emerald-600'}`}>
                  {vix.value.toFixed(2)}
                </p>
                <div className="flex items-center gap-1 pb-1">
                  {vix.change >= 0 ? (
                    <ArrowUpRight className="w-4 h-4 text-red-500" />
                  ) : (
                    <ArrowDownRight className="w-4 h-4 text-emerald-500" />
                  )}
                  <span className={`text-sm font-mono ${vix.change >= 0 ? 'text-red-600' : 'text-emerald-600'}`}>
                    {vix.changePercent.toFixed(2)}%
                  </span>
                </div>
              </div>
              <div className={`mt-3 px-3 py-2 rounded-xl text-xs font-medium ${
                vix.value > 20 ? 'bg-red-50 text-red-700' : 'bg-emerald-50 text-emerald-700'
              }`}>
                {vix.value > 20 ? 'High volatility — hedge positions' : 'Low volatility — favorable for selling'}
              </div>
            </>
          ) : (
            <div className="text-center py-4">
              <p className="text-sm text-slate-400">VIX data unavailable</p>
              <p className="text-xs text-slate-300 mt-1">Market may be closed or API is loading.</p>
            </div>
          )}
        </div>

        {/* Watchlist */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm card-hover p-5 md:col-span-2 animate-slide-up" style={{ animationDelay: '320ms' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Watchlist</h2>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-pink-500 to-rose-500 flex items-center justify-center">
              <Eye className="w-4 h-4 text-white" />
            </div>
          </div>
          {hasWatchlistItems ? (
            <div className="overflow-x-auto">
              <table className="w-full text-xs">
                <thead>
                  <tr className="text-slate-400 border-b border-slate-200">
                    <th className="text-left pb-2 font-medium">Symbol</th>
                    <th className="text-right pb-2 font-medium">LTP</th>
                    <th className="text-right pb-2 font-medium">Change</th>
                    <th className="text-right pb-2 font-medium">%</th>
                    <th className="text-right pb-2 font-medium hidden sm:table-cell">Volume</th>
                  </tr>
                </thead>
                <tbody>
                  {watchlistItems.map((item) => (
                    <tr key={item.symbol} className="border-b border-slate-100 hover:bg-teal-50/30 transition-colors">
                      <td className="py-2.5 font-medium text-slate-800">{item.symbol}</td>
                      <td className="py-2.5 text-right font-mono text-slate-800">{(item.ltp ?? 0).toFixed(2)}</td>
                      <td className={`py-2.5 text-right font-mono ${(item.change ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {(item.change ?? 0) >= 0 ? '+' : ''}{(item.change ?? 0).toFixed(2)}
                      </td>
                      <td className={`py-2.5 text-right font-mono ${(item.changePercent ?? 0) >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {(item.changePercent ?? 0) >= 0 ? '+' : ''}{(item.changePercent ?? 0).toFixed(2)}%
                      </td>
                      <td className="py-2.5 text-right font-mono text-slate-400 hidden sm:table-cell">
                        {((item.volume ?? 0) / 1000).toFixed(0)}K
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : (
            <div className="text-center py-8">
              <Eye className="w-8 h-8 text-slate-300 mx-auto mb-2" />
              <p className="text-sm text-slate-400">No watchlist items yet. Add symbols from the Trading Terminal.</p>
            </div>
          )}
        </div>

        {/* Today's Trades */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm card-hover p-5 animate-slide-up" style={{ animationDelay: '400ms' }}>
          <div className="flex items-center justify-between mb-4">
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Today's Trades</h2>
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-red-500 to-rose-500 flex items-center justify-center">
              <TrendingUp className="w-4 h-4 text-white" />
            </div>
          </div>
          {todayTrades.length > 0 ? (
            <div className="space-y-2 max-h-[240px] overflow-y-auto">
              {todayTrades.map((trade: any, i: number) => {
                const pnl = Number(trade.netPnl ?? trade.pnl ?? trade.realizedPnl ?? 0);
                return (
                  <div key={trade.id ?? i} className="flex items-center justify-between text-xs border-b border-slate-100 pb-2">
                    <div>
                      <p className="font-medium text-slate-800">{trade.symbol}</p>
                      <p className="text-slate-400">
                        {trade.side ?? trade.direction} · {trade.qty ?? trade.quantity} @ ₹{Number(trade.entryPrice ?? trade.price ?? 0).toFixed(2)}
                      </p>
                    </div>
                    <div className="text-right">
                      <p className={`font-mono font-semibold ${pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                        {pnl >= 0 ? '+' : ''}₹{pnl.toFixed(0)}
                      </p>
                      <p className="text-slate-400">{trade.status ?? 'EXECUTED'}</p>
                    </div>
                  </div>
                );
              })}
            </div>
          ) : (
            <div className="text-center py-6">
              <p className="text-sm text-slate-400">No trades today yet.</p>
              <p className="text-xs text-slate-300 mt-1">Trades will appear here as they execute.</p>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
