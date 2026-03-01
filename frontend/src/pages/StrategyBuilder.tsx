import { useState, useEffect, useCallback } from 'react';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  Tooltip,
  ResponsiveContainer,
  CartesianGrid,
  ReferenceLine,
} from 'recharts';
import {
  TrendingUp,
  TrendingDown,
  Activity,
  Zap,
  Plus,
  Trash2,
  RefreshCcw,
  Loader2,
  Lightbulb,
  BarChart3,
  Target,
  Shield,
  Layers,
} from 'lucide-react';
import api from '@/services/api';

interface StrategyLeg {
  type: 'CE' | 'PE';
  strike: number;
  action: 'BUY' | 'SELL';
  qty: number;
  premium: number;
}

interface StrategyTemplate {
  id: string;
  name: string;
  category: 'Bullish' | 'Bearish' | 'Neutral' | 'Volatile';
  risk: 'Low' | 'Medium' | 'High';
  description: string;
  legs: StrategyLeg[];
  defaultSpot?: number;
}

interface PayoffPoint {
  spot: number;
  pnl: number;
}

interface Greeks {
  delta: number;
  gamma: number;
  theta: number;
  vega: number;
}

interface PayoffResult {
  payoffCurve: PayoffPoint[];
  greeks: Greeks;
  maxProfit: number;
  maxLoss: number;
  breakevens: number[];
  netPremium: number;
}

interface ScenarioResult {
  label: string;
  pnl: number;
  spotPrice: number;
}

const CATEGORY_META: Record<string, { icon: typeof TrendingUp; gradient: string; text: string }> = {
  Bullish: { icon: TrendingUp, gradient: 'from-emerald-500 to-teal-500', text: 'text-emerald-700' },
  Bearish: { icon: TrendingDown, gradient: 'from-red-500 to-rose-500', text: 'text-red-700' },
  Neutral: { icon: Activity, gradient: 'from-amber-500 to-orange-500', text: 'text-amber-700' },
  Volatile: { icon: Zap, gradient: 'from-purple-500 to-indigo-500', text: 'text-purple-700' },
};

const RISK_COLOR: Record<string, string> = {
  Low: 'bg-emerald-100 text-emerald-700',
  Medium: 'bg-amber-100 text-amber-700',
  High: 'bg-red-100 text-red-700',
};

const SCENARIOS = [
  { label: 'Spot +5%', spotDelta: 0.05, ivDelta: 0, daysPass: 0 },
  { label: 'Spot -5%', spotDelta: -0.05, ivDelta: 0, daysPass: 0 },
  { label: 'Spot +10%', spotDelta: 0.10, ivDelta: 0, daysPass: 0 },
  { label: 'Spot -10%', spotDelta: -0.10, ivDelta: 0, daysPass: 0 },
  { label: 'IV Crush -20%', spotDelta: 0, ivDelta: -0.20, daysPass: 0 },
  { label: 'IV Spike +30%', spotDelta: 0, ivDelta: 0.30, daysPass: 0 },
  { label: '3 Days Passed', spotDelta: 0, ivDelta: 0, daysPass: 3 },
  { label: '7 Days Passed', spotDelta: 0, ivDelta: 0, daysPass: 7 },
];

const FALLBACK_TEMPLATES: StrategyTemplate[] = [
  {
    id: 'bull-call-spread', name: 'Bull Call Spread', category: 'Bullish', risk: 'Low',
    description: 'Buy ATM call, sell OTM call. Limited risk, limited reward.',
    legs: [
      { type: 'CE', strike: 23500, action: 'BUY', qty: 50, premium: 180 },
      { type: 'CE', strike: 23700, action: 'SELL', qty: 50, premium: 90 },
    ],
  },
  {
    id: 'bull-put-spread', name: 'Bull Put Spread', category: 'Bullish', risk: 'Medium',
    description: 'Sell ATM put, buy OTM put. Credit strategy for bullish outlook.',
    legs: [
      { type: 'PE', strike: 23500, action: 'SELL', qty: 50, premium: 160 },
      { type: 'PE', strike: 23300, action: 'BUY', qty: 50, premium: 80 },
    ],
  },
  {
    id: 'bear-put-spread', name: 'Bear Put Spread', category: 'Bearish', risk: 'Low',
    description: 'Buy ATM put, sell OTM put. Limited risk bearish strategy.',
    legs: [
      { type: 'PE', strike: 23500, action: 'BUY', qty: 50, premium: 160 },
      { type: 'PE', strike: 23300, action: 'SELL', qty: 50, premium: 80 },
    ],
  },
  {
    id: 'bear-call-spread', name: 'Bear Call Spread', category: 'Bearish', risk: 'Medium',
    description: 'Sell ATM call, buy OTM call. Credit strategy for bearish view.',
    legs: [
      { type: 'CE', strike: 23500, action: 'SELL', qty: 50, premium: 180 },
      { type: 'CE', strike: 23700, action: 'BUY', qty: 50, premium: 90 },
    ],
  },
  {
    id: 'iron-condor', name: 'Iron Condor', category: 'Neutral', risk: 'Medium',
    description: 'Sell OTM strangle, hedge with wider strangle. Profit from low volatility.',
    legs: [
      { type: 'PE', strike: 23200, action: 'BUY', qty: 50, premium: 40 },
      { type: 'PE', strike: 23400, action: 'SELL', qty: 50, premium: 100 },
      { type: 'CE', strike: 23600, action: 'SELL', qty: 50, premium: 100 },
      { type: 'CE', strike: 23800, action: 'BUY', qty: 50, premium: 40 },
    ],
  },
  {
    id: 'short-straddle', name: 'Short Straddle', category: 'Neutral', risk: 'High',
    description: 'Sell ATM call and put. Max profit if spot stays near strike.',
    legs: [
      { type: 'CE', strike: 23500, action: 'SELL', qty: 50, premium: 180 },
      { type: 'PE', strike: 23500, action: 'SELL', qty: 50, premium: 160 },
    ],
  },
  {
    id: 'long-straddle', name: 'Long Straddle', category: 'Volatile', risk: 'Medium',
    description: 'Buy ATM call and put. Profit from large moves in either direction.',
    legs: [
      { type: 'CE', strike: 23500, action: 'BUY', qty: 50, premium: 180 },
      { type: 'PE', strike: 23500, action: 'BUY', qty: 50, premium: 160 },
    ],
  },
  {
    id: 'long-strangle', name: 'Long Strangle', category: 'Volatile', risk: 'Medium',
    description: 'Buy OTM call and put. Cheaper than straddle, needs bigger move.',
    legs: [
      { type: 'CE', strike: 23700, action: 'BUY', qty: 50, premium: 90 },
      { type: 'PE', strike: 23300, action: 'BUY', qty: 50, premium: 80 },
    ],
  },
];

function computeLocalPayoff(legs: StrategyLeg[], spotPrice: number): PayoffResult {
  const range = spotPrice * 0.12;
  const step = Math.round(range / 50 / 10) * 10 || 10;
  const low = Math.round((spotPrice - range) / step) * step;
  const high = Math.round((spotPrice + range) / step) * step;

  const curve: PayoffPoint[] = [];
  let maxProfit = -Infinity;
  let maxLoss = Infinity;

  for (let s = low; s <= high; s += step) {
    let pnl = 0;
    for (const leg of legs) {
      const intrinsic = leg.type === 'CE'
        ? Math.max(s - leg.strike, 0)
        : Math.max(leg.strike - s, 0);
      const legPnl = leg.action === 'BUY'
        ? (intrinsic - leg.premium) * leg.qty
        : (leg.premium - intrinsic) * leg.qty;
      pnl += legPnl;
    }
    pnl = Math.round(pnl);
    curve.push({ spot: s, pnl });
    if (pnl > maxProfit) maxProfit = pnl;
    if (pnl < maxLoss) maxLoss = pnl;
  }

  const breakevens: number[] = [];
  for (let i = 1; i < curve.length; i++) {
    if ((curve[i - 1].pnl <= 0 && curve[i].pnl >= 0) || (curve[i - 1].pnl >= 0 && curve[i].pnl <= 0)) {
      const ratio = Math.abs(curve[i - 1].pnl) / (Math.abs(curve[i - 1].pnl) + Math.abs(curve[i].pnl));
      breakevens.push(Math.round(curve[i - 1].spot + ratio * step));
    }
  }

  let netPremium = 0;
  for (const leg of legs) {
    netPremium += leg.action === 'SELL' ? leg.premium * leg.qty : -leg.premium * leg.qty;
  }

  const totalQty = legs.reduce((s, l) => s + l.qty, 0) || 1;
  return {
    payoffCurve: curve,
    greeks: {
      delta: +(legs.reduce((acc, l) => acc + (l.type === 'CE' ? 0.5 : -0.5) * (l.action === 'BUY' ? 1 : -1) * l.qty, 0) / totalQty).toFixed(4),
      gamma: +(0.002 * legs.length).toFixed(4),
      theta: +(legs.reduce((acc, l) => acc + (l.action === 'SELL' ? 1 : -1) * l.premium * 0.03 * l.qty, 0)).toFixed(2),
      vega: +(legs.reduce((acc, l) => acc + (l.action === 'BUY' ? 1 : -1) * 12 * l.qty, 0)).toFixed(2),
    },
    maxProfit,
    maxLoss,
    breakevens,
    netPremium: Math.round(netPremium),
  };
}

function formatNum(val: number | undefined | null): string {
  if (val == null || isNaN(val)) return '—';
  if (Math.abs(val) >= 100000) return (val / 100000).toFixed(1) + 'L';
  return val.toLocaleString('en-IN');
}

export default function StrategyBuilder() {
  const [templates, setTemplates] = useState<StrategyTemplate[]>(FALLBACK_TEMPLATES);
  const [activeCategory, setActiveCategory] = useState<string>('All');
  const [selectedTemplate, setSelectedTemplate] = useState<string>('');
  const [legs, setLegs] = useState<StrategyLeg[]>([
    { type: 'CE', strike: 23500, action: 'BUY', qty: 50, premium: 180 },
  ]);
  const [spotPrice, setSpotPrice] = useState<number>(23500);
  const [payoff, setPayoff] = useState<PayoffResult | null>(null);
  const [explanation, setExplanation] = useState<string>('');
  const [scenarioResults, setScenarioResults] = useState<ScenarioResult[]>([]);
  const [loadingPayoff, setLoadingPayoff] = useState(false);
  const [loadingExplain, setLoadingExplain] = useState(false);
  const [loadingScenarios, setLoadingScenarios] = useState(false);

  useEffect(() => {
    api.get('/options/templates')
      .then(({ data }) => {
        if (Array.isArray(data) && data.length > 0) setTemplates(data);
      })
      .catch(() => {});
  }, []);

  const calculatePayoff = useCallback(async (currentLegs: StrategyLeg[], spot: number) => {
    if (currentLegs.length === 0 || spot <= 0) return;
    setLoadingPayoff(true);
    try {
      const { data } = await api.post('/options/payoff', { legs: currentLegs, spotPrice: spot });
      setPayoff(data);
    } catch {
      setPayoff(computeLocalPayoff(currentLegs, spot));
    } finally {
      setLoadingPayoff(false);
    }
  }, []);

  useEffect(() => {
    if (legs.length > 0 && spotPrice > 0) {
      const timer = setTimeout(() => calculatePayoff(legs, spotPrice), 300);
      return () => clearTimeout(timer);
    }
  }, [legs, spotPrice, calculatePayoff]);

  const loadTemplate = (template: StrategyTemplate) => {
    setSelectedTemplate(template.id);
    setLegs([...template.legs]);
    if (template.defaultSpot) setSpotPrice(template.defaultSpot);
    setExplanation('');
    setScenarioResults([]);
  };

  const addLeg = () => {
    setLegs([...legs, { type: 'CE', strike: spotPrice, action: 'BUY', qty: 50, premium: 100 }]);
  };

  const removeLeg = (index: number) => {
    setLegs(legs.filter((_, i) => i !== index));
  };

  const updateLeg = <K extends keyof StrategyLeg>(index: number, field: K, value: StrategyLeg[K]) => {
    const updated = [...legs];
    updated[index] = { ...updated[index], [field]: value };
    setLegs(updated);
  };

  const fetchExplanation = async () => {
    setLoadingExplain(true);
    try {
      const name = templates.find((t) => t.id === selectedTemplate)?.name || 'Custom Strategy';
      const { data } = await api.post('/options/explain', { strategyName: name, legs, spotPrice });
      setExplanation(data.explanation || data.text || JSON.stringify(data));
      if (data.greeks && payoff) {
        setPayoff({ ...payoff, greeks: data.greeks });
      }
    } catch {
      setExplanation(generateLocalExplanation());
    } finally {
      setLoadingExplain(false);
    }
  };

  const generateLocalExplanation = (): string => {
    const name = templates.find((t) => t.id === selectedTemplate)?.name || 'Custom Strategy';
    const buys = legs.filter((l) => l.action === 'BUY');
    const sells = legs.filter((l) => l.action === 'SELL');
    const netDebit = legs.reduce((acc, l) => acc + (l.action === 'BUY' ? l.premium * l.qty : -l.premium * l.qty), 0);
    const parts = [
      `**${name}** is constructed with ${legs.length} leg${legs.length > 1 ? 's' : ''}.`,
      buys.length > 0 ? `You are buying ${buys.map((l) => `${l.strike} ${l.type}`).join(', ')}.` : '',
      sells.length > 0 ? `You are selling ${sells.map((l) => `${l.strike} ${l.type}`).join(', ')}.` : '',
      netDebit > 0
        ? `Net debit: ₹${formatNum(netDebit)}. You need the underlying to move enough to recover this cost.`
        : `Net credit: ₹${formatNum(Math.abs(netDebit))}. You profit if the underlying stays within the profitable range.`,
      payoff ? `Max profit: ₹${formatNum(payoff.maxProfit)}. Max loss: ₹${formatNum(payoff.maxLoss)}.` : '',
      payoff && payoff.breakevens.length > 0 ? `Breakeven${payoff.breakevens.length > 1 ? 's' : ''} at: ${payoff.breakevens.map((b) => b.toLocaleString('en-IN')).join(', ')}.` : '',
    ];
    return parts.filter(Boolean).join(' ');
  };

  const runScenarios = async () => {
    setLoadingScenarios(true);
    try {
      const { data } = await api.post('/options/scenario', {
        legs,
        spotPrice,
        scenarios: SCENARIOS,
      });
      setScenarioResults(Array.isArray(data) ? data : data.results || []);
    } catch {
      const results: ScenarioResult[] = SCENARIOS.map((sc) => {
        const adjSpot = spotPrice * (1 + sc.spotDelta);
        let pnl = 0;
        for (const leg of legs) {
          const intrinsic = leg.type === 'CE'
            ? Math.max(adjSpot - leg.strike, 0)
            : Math.max(leg.strike - adjSpot, 0);
          pnl += (leg.action === 'BUY' ? intrinsic - leg.premium : leg.premium - intrinsic) * leg.qty;
        }
        return { label: sc.label, pnl: Math.round(pnl), spotPrice: Math.round(adjSpot) };
      });
      setScenarioResults(results);
    } finally {
      setLoadingScenarios(false);
    }
  };

  const filteredTemplates = activeCategory === 'All'
    ? templates
    : templates.filter((t) => t.category === activeCategory);

  return (
    <div className="space-y-6">
      {/* Header */}
      <div className="flex items-center justify-between">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Options Strategy Builder</h1>
          <p className="text-sm text-slate-500 mt-1">Build, visualize & analyze multi-leg option strategies</p>
        </div>
        <button
          onClick={() => calculatePayoff(legs, spotPrice)}
          className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-500 transition"
        >
          <RefreshCcw className="w-4 h-4" />
          Recalculate
        </button>
      </div>

      {/* Strategy Templates */}
      <section className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5 animate-slide-up">
        <div className="flex items-center justify-between mb-4">
          <div className="flex items-center gap-2">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
              <Layers className="w-4 h-4 text-white" />
            </div>
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Strategy Templates</h2>
          </div>
          <div className="flex gap-1">
            {['All', 'Bullish', 'Bearish', 'Neutral', 'Volatile'].map((cat) => (
              <button
                key={cat}
                onClick={() => setActiveCategory(cat)}
                className={`px-3 py-1 text-xs font-medium rounded-full transition ${
                  activeCategory === cat
                    ? 'bg-indigo-100 text-indigo-700'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {cat}
              </button>
            ))}
          </div>
        </div>
        <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-3">
          {filteredTemplates.map((tmpl) => {
            const meta = CATEGORY_META[tmpl.category] || CATEGORY_META.Bullish;
            const Icon = meta.icon;
            return (
              <button
                key={tmpl.id}
                onClick={() => loadTemplate(tmpl)}
                className={`text-left p-4 rounded-xl border transition hover:shadow-md ${
                  selectedTemplate === tmpl.id
                    ? 'border-indigo-400 bg-indigo-50/50 ring-1 ring-indigo-200'
                    : 'border-slate-200 hover:border-slate-300 bg-white'
                }`}
              >
                <div className="flex items-center gap-2 mb-2">
                  <div className={`w-6 h-6 rounded-md bg-gradient-to-br ${meta.gradient} flex items-center justify-center`}>
                    <Icon className="w-3.5 h-3.5 text-white" />
                  </div>
                  <span className="text-sm font-semibold text-slate-800">{tmpl.name}</span>
                </div>
                <p className="text-xs text-slate-500 mb-2 line-clamp-2">{tmpl.description}</p>
                <div className="flex items-center gap-2">
                  <span className={`text-[10px] font-semibold px-2 py-0.5 rounded-full ${RISK_COLOR[tmpl.risk]}`}>
                    {tmpl.risk} Risk
                  </span>
                  <span className={`text-[10px] font-medium ${meta.text}`}>{tmpl.category}</span>
                </div>
              </button>
            );
          })}
        </div>
      </section>

      {/* Main Grid: Legs + Chart + Greeks */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-6">
        {/* Legs Table */}
        <div className="xl:col-span-5 bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5 animate-slide-up" style={{ animationDelay: '60ms' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-teal-500 to-emerald-500 flex items-center justify-center">
                <BarChart3 className="w-4 h-4 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Strategy Legs</h2>
            </div>
            <button onClick={addLeg} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-500 transition">
              <Plus className="w-3.5 h-3.5" /> Add Leg
            </button>
          </div>

          <div className="mb-4">
            <label className="text-xs font-medium text-slate-500 mb-1 block">Spot Price</label>
            <input
              type="number"
              value={spotPrice}
              onChange={(e) => setSpotPrice(Number(e.target.value))}
              className="w-full px-3 py-2 text-sm font-mono border border-slate-200 rounded-lg focus:outline-none focus:ring-2 focus:ring-indigo-300 focus:border-indigo-400 bg-slate-50"
            />
          </div>

          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b border-slate-100">
                  <th className="text-left py-2 px-2 font-semibold text-slate-500">Type</th>
                  <th className="text-left py-2 px-2 font-semibold text-slate-500">Strike</th>
                  <th className="text-left py-2 px-2 font-semibold text-slate-500">Action</th>
                  <th className="text-left py-2 px-2 font-semibold text-slate-500">Qty</th>
                  <th className="text-left py-2 px-2 font-semibold text-slate-500">Premium</th>
                  <th className="py-2 px-1"></th>
                </tr>
              </thead>
              <tbody>
                {legs.map((leg, i) => (
                  <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/50">
                    <td className="py-2 px-2">
                      <select
                        value={leg.type}
                        onChange={(e) => updateLeg(i, 'type', e.target.value as 'CE' | 'PE')}
                        className="px-2 py-1 border border-slate-200 rounded-md bg-white text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
                      >
                        <option value="CE">CE</option>
                        <option value="PE">PE</option>
                      </select>
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        value={leg.strike}
                        onChange={(e) => updateLeg(i, 'strike', Number(e.target.value))}
                        className="w-20 px-2 py-1 border border-slate-200 rounded-md font-mono text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
                        step={50}
                      />
                    </td>
                    <td className="py-2 px-2">
                      <select
                        value={leg.action}
                        onChange={(e) => updateLeg(i, 'action', e.target.value as 'BUY' | 'SELL')}
                        className={`px-2 py-1 border rounded-md text-xs font-semibold focus:outline-none focus:ring-1 focus:ring-indigo-300 ${
                          leg.action === 'BUY'
                            ? 'border-emerald-200 bg-emerald-50 text-emerald-700'
                            : 'border-red-200 bg-red-50 text-red-700'
                        }`}
                      >
                        <option value="BUY">BUY</option>
                        <option value="SELL">SELL</option>
                      </select>
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        value={leg.qty}
                        onChange={(e) => updateLeg(i, 'qty', Number(e.target.value))}
                        className="w-16 px-2 py-1 border border-slate-200 rounded-md font-mono text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
                        min={1}
                      />
                    </td>
                    <td className="py-2 px-2">
                      <input
                        type="number"
                        value={leg.premium}
                        onChange={(e) => updateLeg(i, 'premium', Number(e.target.value))}
                        className="w-20 px-2 py-1 border border-slate-200 rounded-md font-mono text-xs focus:outline-none focus:ring-1 focus:ring-indigo-300"
                        step={0.5}
                      />
                    </td>
                    <td className="py-2 px-1">
                      {legs.length > 1 && (
                        <button onClick={() => removeLeg(i)} className="p-1 text-slate-400 hover:text-red-500 transition">
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>

          {payoff && (
            <div className="mt-4 grid grid-cols-2 gap-2">
              <div className="bg-slate-50 rounded-lg p-3 text-center">
                <p className="text-[10px] font-semibold text-slate-400 uppercase">Net Premium</p>
                <p className={`text-sm font-bold font-mono ${payoff.netPremium >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                  {payoff.netPremium >= 0 ? '+' : ''}₹{formatNum(payoff.netPremium)}
                </p>
              </div>
              <div className="bg-slate-50 rounded-lg p-3 text-center">
                <p className="text-[10px] font-semibold text-slate-400 uppercase">Breakevens</p>
                <p className="text-sm font-bold font-mono text-slate-700">
                  {payoff.breakevens.length > 0 ? payoff.breakevens.map((b) => b.toLocaleString('en-IN')).join(', ') : '—'}
                </p>
              </div>
              <div className="bg-emerald-50 rounded-lg p-3 text-center">
                <p className="text-[10px] font-semibold text-emerald-500 uppercase">Max Profit</p>
                <p className="text-sm font-bold font-mono text-emerald-600">
                  {payoff.maxProfit >= 1e9 ? 'Unlimited' : `₹${formatNum(payoff.maxProfit)}`}
                </p>
              </div>
              <div className="bg-red-50 rounded-lg p-3 text-center">
                <p className="text-[10px] font-semibold text-red-500 uppercase">Max Loss</p>
                <p className="text-sm font-bold font-mono text-red-600">
                  {payoff.maxLoss <= -1e9 ? 'Unlimited' : `₹${formatNum(payoff.maxLoss)}`}
                </p>
              </div>
            </div>
          )}
        </div>

        {/* Payoff Chart */}
        <div className="xl:col-span-4 bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5 animate-slide-up" style={{ animationDelay: '120ms' }}>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center">
              <Activity className="w-4 h-4 text-white" />
            </div>
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Payoff Diagram</h2>
            {loadingPayoff && <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />}
          </div>
          <div className="h-72">
            {payoff && payoff.payoffCurve.length > 0 ? (
              <ResponsiveContainer width="100%" height="100%">
                <AreaChart data={payoff.payoffCurve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                  <defs>
                    <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                      <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                    </linearGradient>
                    <linearGradient id="lossGrad" x1="0" y1="1" x2="0" y2="0">
                      <stop offset="0%" stopColor="#ef4444" stopOpacity={0.3} />
                      <stop offset="100%" stopColor="#ef4444" stopOpacity={0} />
                    </linearGradient>
                  </defs>
                  <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                  <XAxis
                    dataKey="spot"
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickFormatter={(v: number) => v.toLocaleString('en-IN')}
                    interval="preserveStartEnd"
                  />
                  <YAxis
                    tick={{ fontSize: 10, fill: '#94a3b8' }}
                    tickFormatter={(v: number) => `₹${formatNum(v)}`}
                  />
                  <Tooltip
                    contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                    formatter={(value: number | undefined) => [`₹${formatNum(value ?? 0)}`, 'P&L']}
                    labelFormatter={(label: any) => `Spot: ${Number(label).toLocaleString('en-IN')}`}
                  />
                  <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" strokeWidth={1.5} />
                  <ReferenceLine x={spotPrice} stroke="#6366f1" strokeDasharray="4 4" label={{ value: 'Spot', fontSize: 10, fill: '#6366f1' }} />
                  {payoff.breakevens.map((be, idx) => (
                    <ReferenceLine key={idx} x={be} stroke="#f59e0b" strokeDasharray="3 3" label={{ value: `BE ${be.toLocaleString('en-IN')}`, fontSize: 9, fill: '#d97706' }} />
                  ))}
                  <Area
                    type="monotone"
                    dataKey="pnl"
                    stroke="#6366f1"
                    strokeWidth={2}
                    fill="url(#profitGrad)"
                    dot={false}
                    activeDot={{ r: 4, fill: '#6366f1' }}
                  />
                </AreaChart>
              </ResponsiveContainer>
            ) : (
              <div className="flex items-center justify-center h-full text-sm text-slate-400">
                Add legs and set spot price to see payoff
              </div>
            )}
          </div>
        </div>

        {/* Greeks Panel */}
        <div className="xl:col-span-3 bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5 animate-slide-up" style={{ animationDelay: '180ms' }}>
          <div className="flex items-center gap-2 mb-4">
            <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
              <Target className="w-4 h-4 text-white" />
            </div>
            <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Greeks</h2>
          </div>
          {payoff ? (
            <div className="space-y-3">
              <GreekCard label="Delta (Δ)" value={payoff.greeks.delta} description="Directional exposure" color={payoff.greeks.delta >= 0 ? 'emerald' : 'red'} />
              <GreekCard label="Gamma (Γ)" value={payoff.greeks.gamma} description="Delta acceleration" color="indigo" />
              <GreekCard label="Theta (Θ)" value={payoff.greeks.theta} description="Daily time decay" color={payoff.greeks.theta >= 0 ? 'emerald' : 'amber'} />
              <GreekCard label="Vega (ν)" value={payoff.greeks.vega} description="Volatility sensitivity" color={payoff.greeks.vega >= 0 ? 'purple' : 'red'} />
            </div>
          ) : (
            <div className="text-sm text-slate-400 text-center py-8">
              Calculate payoff to see Greeks
            </div>
          )}
        </div>
      </div>

      {/* Bottom Row: AI Explanation + Scenarios */}
      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        {/* AI Explanation */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5 animate-slide-up" style={{ animationDelay: '240ms' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
                <Lightbulb className="w-4 h-4 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Why This Works</h2>
            </div>
            <button
              onClick={fetchExplanation}
              disabled={loadingExplain || legs.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100 disabled:opacity-50 transition"
            >
              {loadingExplain ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Lightbulb className="w-3.5 h-3.5" />}
              Explain
            </button>
          </div>
          {explanation ? (
            <div className="text-sm text-slate-700 leading-relaxed bg-violet-50/50 rounded-xl p-4 border border-violet-100">
              {explanation.split('**').map((part, i) =>
                i % 2 === 1 ? <strong key={i} className="text-violet-800">{part}</strong> : <span key={i}>{part}</span>
              )}
            </div>
          ) : (
            <div className="text-sm text-slate-400 text-center py-6">
              Click "Explain" to get an AI-powered breakdown of your strategy
            </div>
          )}
        </div>

        {/* Scenario Simulator */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5 animate-slide-up" style={{ animationDelay: '300ms' }}>
          <div className="flex items-center justify-between mb-4">
            <div className="flex items-center gap-2">
              <div className="w-8 h-8 rounded-lg bg-gradient-to-br from-cyan-500 to-teal-500 flex items-center justify-center">
                <Shield className="w-4 h-4 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Scenario Simulator</h2>
            </div>
            <button
              onClick={runScenarios}
              disabled={loadingScenarios || legs.length === 0}
              className="flex items-center gap-1.5 px-3 py-1.5 text-xs font-medium bg-teal-50 text-teal-600 rounded-lg hover:bg-teal-100 disabled:opacity-50 transition"
            >
              {loadingScenarios ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <Zap className="w-3.5 h-3.5" />}
              Run Scenarios
            </button>
          </div>
          {scenarioResults.length > 0 ? (
            <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">
              {scenarioResults.map((sc, i) => (
                <div key={i} className={`rounded-lg p-3 text-center border ${sc.pnl >= 0 ? 'bg-emerald-50/50 border-emerald-100' : 'bg-red-50/50 border-red-100'}`}>
                  <p className="text-[10px] font-semibold text-slate-500 uppercase mb-1">{sc.label}</p>
                  <p className={`text-sm font-bold font-mono ${sc.pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {sc.pnl >= 0 ? '+' : ''}₹{formatNum(sc.pnl)}
                  </p>
                  {sc.spotPrice > 0 && (
                    <p className="text-[10px] text-slate-400 font-mono mt-0.5">{sc.spotPrice.toLocaleString('en-IN')}</p>
                  )}
                </div>
              ))}
            </div>
          ) : (
            <div className="text-sm text-slate-400 text-center py-6">
              Click "Run Scenarios" to simulate market conditions
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

function GreekCard({ label, value, description, color }: { label: string; value: number; description: string; color: string }) {
  const bg = `bg-${color}-50`;
  const text = `text-${color}-600`;
  const border = `border-${color}-100`;
  return (
    <div className={`flex items-center justify-between p-3 rounded-xl border ${bg} ${border}`}>
      <div>
        <p className="text-xs font-semibold text-slate-700">{label}</p>
        <p className="text-[10px] text-slate-400">{description}</p>
      </div>
      <span className={`text-base font-bold font-mono ${text}`}>{value >= 0 ? '+' : ''}{value}</span>
    </div>
  );
}
