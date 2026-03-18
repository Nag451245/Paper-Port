import { useState, useEffect, useCallback } from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  Cell,
} from 'recharts';
import {
  RefreshCw,
  Loader2,
  Grid3X3,
  TrendingUp,
  Sigma,
  AlertTriangle,
  Droplets,
  Link2,
} from 'lucide-react';
import api from '@/services/api';
import { usePortfolioStore } from '@/stores/portfolio';
import { formatINRCompact } from '@/lib/utils';

/* eslint-disable @typescript-eslint/no-explicit-any */

function safeNum(val: unknown, fallback = 0): number {
  if (val === null || val === undefined || val === '') return fallback;
  const n = Number(val);
  return isNaN(n) ? fallback : n;
}

// ─── Mock data fallbacks ─────────────────────────────────────────
const MOCK_SECTOR_EXPOSURE = [
  { sector: 'Technology', exposure: 28, value: 280000 },
  { sector: 'Financials', exposure: 22, value: 220000 },
  { sector: 'Healthcare', exposure: 18, value: 180000 },
  { sector: 'Consumer', exposure: 15, value: 150000 },
  { sector: 'Energy', exposure: 10, value: 100000 },
  { sector: 'Industrials', exposure: 7, value: 70000 },
];

const MOCK_BETA_BY_POSITION = [
  { symbol: 'RELIANCE', beta: 1.12, exposure: 85000 },
  { symbol: 'TCS', beta: 0.98, exposure: 120000 },
  { symbol: 'HDFCBANK', beta: 1.05, exposure: 95000 },
  { symbol: 'INFY', beta: 0.92, exposure: 78000 },
  { symbol: 'ICICIBANK', beta: 1.18, exposure: 65000 },
  { symbol: 'SBIN', beta: 1.25, exposure: 55000 },
];

const MOCK_GREEKS = {
  delta: 0.42,
  gamma: 0.08,
  theta: -125.5,
  vega: 1850,
};

const MOCK_PNL_WATERFALL = [
  { symbol: 'RELIANCE', pnl: 2450, cumulative: 2450 },
  { symbol: 'TCS', pnl: -1200, cumulative: 1250 },
  { symbol: 'HDFCBANK', pnl: 890, cumulative: 2140 },
  { symbol: 'INFY', pnl: 1560, cumulative: 3700 },
  { symbol: 'ICICIBANK', pnl: -450, cumulative: 3250 },
  { symbol: 'SBIN', pnl: 720, cumulative: 3970 },
];

const MOCK_CORRELATION = [
  ['', 'RELIANCE', 'TCS', 'HDFCBANK', 'INFY', 'ICICIBANK', 'SBIN'],
  ['RELIANCE', 1, 0.45, 0.62, 0.38, 0.71, 0.58],
  ['TCS', 0.45, 1, 0.52, 0.78, 0.41, 0.35],
  ['HDFCBANK', 0.62, 0.52, 1, 0.48, 0.85, 0.72],
  ['INFY', 0.38, 0.78, 0.48, 1, 0.42, 0.31],
  ['ICICIBANK', 0.71, 0.41, 0.85, 0.42, 1, 0.68],
  ['SBIN', 0.58, 0.35, 0.72, 0.31, 0.68, 1],
];

interface HeatMapResponse {
  sectorExposure?: { sector: string; exposure: number; value: number }[];
  beta?: { portfolioBeta: number; totalMarketExposure: number; byPosition?: { symbol: string; beta: number; exposure: number }[] };
  greeks?: { delta: number; gamma: number; theta: number; vega: number };
  varDrawdown?: { var95: number; maxDrawdownPct: number; portfolioValue: number };
  pnlWaterfall?: { symbol: string; pnl: number; cumulative: number }[];
  correlation?: string[][];
}

export default function PortfolioHeatMap() {
  const { activePortfolio } = usePortfolioStore();
  const [loading, setLoading] = useState(true);
  const [sectorExposure, setSectorExposure] = useState(MOCK_SECTOR_EXPOSURE);
  const [betaData, setBetaData] = useState<{
    portfolioBeta: number;
    totalMarketExposure: number;
    byPosition: { symbol: string; beta: number; exposure: number }[];
  }>({
    portfolioBeta: 1.08,
    totalMarketExposure: 543000,
    byPosition: MOCK_BETA_BY_POSITION,
  });
  const [greeks, setGreeks] = useState(MOCK_GREEKS);
  const [varDrawdown, setVarDrawdown] = useState({
    var95: 12500,
    maxDrawdownPct: -4.2,
    portfolioValue: 1000000,
  });
  const [pnlWaterfall, setPnlWaterfall] = useState(MOCK_PNL_WATERFALL);
  const [correlation, setCorrelation] = useState<string[][]>(MOCK_CORRELATION);

  const fetchData = useCallback(async () => {
    setLoading(true);
    try {
      const portfolioId = activePortfolio?.id;
      const res = await api.get<HeatMapResponse>(
        portfolioId ? `/portfolio/${portfolioId}/heatmap` : '/portfolio/heatmap'
      );
      const d = res.data;

      if (d?.sectorExposure?.length) setSectorExposure(d.sectorExposure);
      if (d?.beta) {
        setBetaData({
          portfolioBeta: safeNum(d.beta.portfolioBeta, 1.08),
          totalMarketExposure: safeNum(d.beta.totalMarketExposure, 543000),
          byPosition: d.beta.byPosition ?? MOCK_BETA_BY_POSITION,
        });
      }
      if (d?.greeks) setGreeks(d.greeks);
      if (d?.varDrawdown) setVarDrawdown(d.varDrawdown);
      if (d?.pnlWaterfall?.length) setPnlWaterfall(d.pnlWaterfall);
      if (d?.correlation?.length) setCorrelation(d.correlation);
    } catch {
      // Use mock data (already set as initial state)
    } finally {
      setLoading(false);
    }
  }, [activePortfolio?.id]);

  useEffect(() => {
    fetchData();
  }, [fetchData]);

  const getExposureColor = (pct: number) => {
    if (pct >= 25) return 'bg-red-500/80';
    if (pct >= 15) return 'bg-amber-500/80';
    return 'bg-emerald-500/80';
  };

  const getCorrelationColor = (val: number) => {
    if (val >= 0.8) return 'bg-red-600';
    if (val >= 0.5) return 'bg-amber-600';
    if (val >= 0.2) return 'bg-emerald-600/70';
    if (val >= -0.2) return 'bg-slate-600';
    return 'bg-slate-700';
  };

  return (
    <div className="min-h-screen bg-gray-900 text-white p-4 md:p-6 space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div className="flex items-center gap-3">
          <div className="w-10 h-10 rounded-xl bg-gradient-to-br from-amber-500 to-orange-600 flex items-center justify-center shadow-lg">
            <Grid3X3 className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold">Portfolio Heat Map</h1>
            <p className="text-xs text-gray-400">Sector exposure, beta, greeks & risk visualization</p>
          </div>
        </div>
        <button
          onClick={fetchData}
          disabled={loading}
          className="flex items-center gap-2 px-4 py-2 rounded-lg bg-gray-700 hover:bg-gray-600 text-sm font-medium transition disabled:opacity-50"
        >
          {loading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCw className="w-4 h-4" />}
          Refresh
        </button>
      </div>

      {loading && !sectorExposure.length ? (
        <div className="flex items-center justify-center py-20">
          <Loader2 className="w-10 h-10 animate-spin text-amber-500" />
        </div>
      ) : (
        <div className="grid grid-cols-1 xl:grid-cols-2 gap-6">
          {/* 1. Sector Exposure Heat Map */}
          <SectionCard icon={Grid3X3} title="Sector Exposure Heat Map">
            <div className="grid grid-cols-2 sm:grid-cols-3 gap-3">
              {sectorExposure.map(({ sector, exposure }) => (
                <div
                  key={sector}
                  className={`rounded-lg p-4 ${getExposureColor(exposure)} transition-all hover:scale-[1.02]`}
                >
                  <p className="text-xs font-medium text-white/90 uppercase tracking-wide">{sector}</p>
                  <p className="text-xl font-bold mt-1">{exposure}%</p>
                  <p className="text-xs text-white/70 mt-0.5">
                    {exposure >= 25 ? 'Over-concentrated' : exposure >= 15 ? 'Concentrated' : 'Moderate'}
                  </p>
                </div>
              ))}
            </div>
            <div className="flex gap-4 mt-4 text-xs text-gray-400">
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-emerald-500/80" /> Moderate (&lt;15%)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-amber-500/80" /> Concentrated (15–25%)
              </span>
              <span className="flex items-center gap-1.5">
                <span className="w-3 h-3 rounded bg-red-500/80" /> Over-concentrated (&gt;25%)
              </span>
            </div>
          </SectionCard>

          {/* 2. Beta-Adjusted Exposure */}
          <SectionCard icon={TrendingUp} title="Beta-Adjusted Exposure">
            <div className="grid grid-cols-2 gap-4 mb-4">
              <div className="p-3 rounded-lg bg-gray-800">
                <p className="text-xs text-gray-400 uppercase">Portfolio Beta</p>
                <p className="text-2xl font-bold text-amber-400">{betaData.portfolioBeta.toFixed(2)}</p>
              </div>
              <div className="p-3 rounded-lg bg-gray-800">
                <p className="text-xs text-gray-400 uppercase">Total Market Exposure</p>
                <p className="text-lg font-bold font-mono">{formatINRCompact(betaData.totalMarketExposure)}</p>
              </div>
            </div>
            <div className="h-[220px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={betaData.byPosition} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="symbol" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={(v) => v.toFixed(2)} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
                    formatter={(value: number) => [value.toFixed(2), 'Beta']}
                  />
                  <Bar dataKey="beta" radius={[3, 3, 0, 0]}>
                    {betaData.byPosition.map((_, i) => (
                      <Cell key={i} fill={i % 2 === 0 ? '#f59e0b' : '#d97706'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
          </SectionCard>

          {/* 3. Greeks Exposure */}
          <SectionCard icon={Sigma} title="Greeks Exposure (Options)">
            <div className="overflow-x-auto">
              <table className="w-full text-sm">
                <thead>
                  <tr className="text-gray-400 border-b border-gray-700">
                    <th className="text-left py-2 font-medium">Greek</th>
                    <th className="text-right py-2 font-medium">Value</th>
                    <th className="text-left py-2 font-medium">Meaning</th>
                  </tr>
                </thead>
                <tbody>
                  <tr className="border-b border-gray-800">
                    <td className="py-2.5 font-mono">Delta</td>
                    <td className="text-right font-bold text-amber-400">{greeks.delta.toFixed(2)}</td>
                    <td className="text-gray-400 text-xs">Directional exposure</td>
                  </tr>
                  <tr className="border-b border-gray-800">
                    <td className="py-2.5 font-mono">Gamma</td>
                    <td className="text-right font-bold text-amber-400">{greeks.gamma.toFixed(2)}</td>
                    <td className="text-gray-400 text-xs">Delta sensitivity</td>
                  </tr>
                  <tr className="border-b border-gray-800">
                    <td className="py-2.5 font-mono">Theta</td>
                    <td className="text-right font-bold text-red-400">{greeks.theta.toFixed(1)}</td>
                    <td className="text-gray-400 text-xs">Time decay / day</td>
                  </tr>
                  <tr>
                    <td className="py-2.5 font-mono">Vega</td>
                    <td className="text-right font-bold text-amber-400">{greeks.vega.toFixed(0)}</td>
                    <td className="text-gray-400 text-xs">IV sensitivity</td>
                  </tr>
                </tbody>
              </table>
            </div>
          </SectionCard>

          {/* 4. Max Portfolio Drawdown Scenario */}
          <SectionCard icon={AlertTriangle} title="Max Portfolio Drawdown Scenario">
            <div className="space-y-4">
              <div className="p-4 rounded-lg bg-red-900/30 border border-red-800/50">
                <p className="text-xs text-red-300 uppercase font-medium">VaR (95%, 1-day)</p>
                <p className="text-2xl font-bold text-red-400">{formatINRCompact(Math.abs(varDrawdown.var95))}</p>
                <p className="text-xs text-gray-400 mt-1">
                  Worst-case loss at 95% confidence
                </p>
              </div>
              <div className="grid grid-cols-2 gap-3">
                <div className="p-3 rounded-lg bg-gray-800">
                  <p className="text-xs text-gray-400">Max Drawdown</p>
                  <p className="text-lg font-bold text-red-400">{varDrawdown.maxDrawdownPct.toFixed(1)}%</p>
                </div>
                <div className="p-3 rounded-lg bg-gray-800">
                  <p className="text-xs text-gray-400">Portfolio Value</p>
                  <p className="text-lg font-bold font-mono">{formatINRCompact(varDrawdown.portfolioValue)}</p>
                </div>
              </div>
            </div>
          </SectionCard>

          {/* 5. Intraday P&L Waterfall */}
          <SectionCard icon={Droplets} title="Intraday P&L Waterfall">
            <div className="h-[240px]">
              <ResponsiveContainer width="100%" height="100%">
                <BarChart data={pnlWaterfall} margin={{ top: 5, right: 10, left: 0, bottom: 5 }}>
                  <CartesianGrid strokeDasharray="3 3" stroke="#374151" />
                  <XAxis dataKey="symbol" tick={{ fill: '#9ca3af', fontSize: 10 }} />
                  <YAxis tick={{ fill: '#9ca3af', fontSize: 10 }} tickFormatter={(v) => `₹${(v / 1000).toFixed(0)}K`} />
                  <Tooltip
                    contentStyle={{ backgroundColor: '#1f2937', border: '1px solid #374151', borderRadius: 8 }}
                    formatter={(value: number) => [formatINRCompact(value), 'P&L']}
                  />
                  <Bar dataKey="pnl" radius={[3, 3, 0, 0]}>
                    {pnlWaterfall.map((entry, i) => (
                      <Cell key={i} fill={entry.pnl >= 0 ? '#10b981' : '#ef4444'} />
                    ))}
                  </Bar>
                </BarChart>
              </ResponsiveContainer>
            </div>
            <p className="text-xs text-gray-400 mt-2">
              Total: {formatINRCompact(pnlWaterfall[pnlWaterfall.length - 1]?.cumulative ?? 0)}
            </p>
          </SectionCard>

          {/* 6. Correlation Matrix */}
          <SectionCard icon={Link2} title="Correlation Matrix" className="xl:col-span-2">
            <div className="overflow-x-auto">
              <table className="w-full text-xs border-collapse">
                <thead>
                  <tr>
                    {correlation[0]?.map((h, i) => (
                      <th
                        key={i}
                        className={`px-2 py-2 font-medium ${i === 0 ? 'bg-transparent text-gray-400' : 'bg-gray-800 text-gray-300'}`}
                      >
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {correlation.slice(1).map((row, ri) => (
                    <tr key={ri}>
                      {row.map((cell, ci) => {
                        const numVal = ci === 0 ? null : parseFloat(cell);
                        const isDiag = ci > 0 && ci === ri + 1;
                        return (
                          <td
                            key={ci}
                            className={`px-2 py-1.5 text-center ${
                              ci === 0
                                ? 'bg-gray-800 font-medium text-gray-300'
                                : isDiag
                                  ? 'bg-amber-600/50 font-bold'
                                  : typeof numVal === 'number'
                                    ? `${getCorrelationColor(numVal)} text-white`
                                    : 'bg-gray-800'
                            }`}
                          >
                            {cell}
                          </td>
                        );
                      })}
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          </SectionCard>
        </div>
      )}
    </div>
  );
}

function SectionCard({
  icon: Icon,
  title,
  children,
  className = '',
}: {
  icon: React.ElementType;
  title: string;
  children: React.ReactNode;
  className?: string;
}) {
  return (
    <div className={`rounded-xl border border-gray-700 bg-gray-800/50 p-4 md:p-5 ${className}`}>
      <div className="flex items-center gap-2 mb-4">
        <Icon className="w-4 h-4 text-amber-500" />
        <h2 className="text-sm font-semibold text-gray-200 uppercase tracking-wide">{title}</h2>
      </div>
      {children}
    </div>
  );
}
