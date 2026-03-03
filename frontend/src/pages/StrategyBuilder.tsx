import { useState, useEffect, useCallback, useRef, useMemo } from 'react';
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
  Calendar,
  Search,
  Wifi,
  ChevronDown,
  Star,
  ArrowUpRight,
  ArrowDownRight,
} from 'lucide-react';
import api, { marketApi, optionsApi } from '@/services/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

// ─── Types ───────────────────────────────────────────────────────────────────

interface Strike {
  strike: number;
  callOI: number;
  callOIChange: number;
  callVolume: number;
  callIV: number;
  callLTP: number;
  callNetChange: number;
  callDelta: number;
  callGamma: number;
  callTheta: number;
  callVega: number;
  callBuildup: string;
  putOI: number;
  putOIChange: number;
  putVolume: number;
  putIV: number;
  putLTP: number;
  putNetChange: number;
  putDelta: number;
  putGamma: number;
  putTheta: number;
  putVega: number;
  putBuildup: string;
}

interface StrategyLeg {
  type: 'CE' | 'PE';
  strike: number;
  action: 'BUY' | 'SELL';
  qty: number;
  premium: number;
  iv?: number;
  expiry?: string;
  expiryDays?: number;
}

interface PayoffPoint { spot: number; pnl: number }
interface Greeks { delta: number; gamma: number; theta: number; vega: number }
interface PayoffResult {
  payoffCurve: PayoffPoint[];
  greeks: Greeks;
  maxProfit: number;
  maxLoss: number;
  breakevens: number[];
  netPremium: number;
  probabilityOfProfit?: number;
  riskRewardRatio?: number;
  capitalRequired?: number;
  source?: string;
  strategyName?: string;
}
interface ScenarioResult { label: string; pnl: number; spotPrice: number }
interface OptimizedStrategy {
  name: string;
  category: string;
  legs: StrategyLeg[];
  maxProfit: number;
  maxLoss: number;
  breakevens: number[];
  netPremium: number;
  riskReward: number;
  pop: number;
  score: number;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const SYMBOLS = ['NIFTY', 'BANKNIFTY', 'FINNIFTY', 'MIDCPNIFTY', 'NIFTYNXT50'];

const CATEGORY_META: Record<string, { icon: typeof TrendingUp; gradient: string; text: string }> = {
  Bullish: { icon: TrendingUp, gradient: 'from-emerald-500 to-teal-500', text: 'text-emerald-700' },
  bullish: { icon: TrendingUp, gradient: 'from-emerald-500 to-teal-500', text: 'text-emerald-700' },
  Bearish: { icon: TrendingDown, gradient: 'from-red-500 to-rose-500', text: 'text-red-700' },
  bearish: { icon: TrendingDown, gradient: 'from-red-500 to-rose-500', text: 'text-red-700' },
  Neutral: { icon: Activity, gradient: 'from-amber-500 to-orange-500', text: 'text-amber-700' },
  neutral: { icon: Activity, gradient: 'from-amber-500 to-orange-500', text: 'text-amber-700' },
  Volatile: { icon: Zap, gradient: 'from-purple-500 to-indigo-500', text: 'text-purple-700' },
  volatile: { icon: Zap, gradient: 'from-purple-500 to-indigo-500', text: 'text-purple-700' },
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

const QUICK_STRATEGIES = [
  { id: 'straddle', label: 'Straddle', build: (atm: number, qty: number, chain: Strike[]) => buildStraddle(atm, qty, chain) },
  { id: 'strangle', label: 'Strangle', build: (atm: number, qty: number, chain: Strike[]) => buildStrangle(atm, qty, chain) },
  { id: 'bull-spread', label: 'Bull Spread', build: (atm: number, qty: number, chain: Strike[]) => buildBullSpread(atm, qty, chain) },
  { id: 'bear-spread', label: 'Bear Spread', build: (atm: number, qty: number, chain: Strike[]) => buildBearSpread(atm, qty, chain) },
  { id: 'iron-condor', label: 'Iron Condor', build: (atm: number, qty: number, chain: Strike[]) => buildIronCondor(atm, qty, chain) },
  { id: 'butterfly', label: 'Butterfly', build: (atm: number, qty: number, chain: Strike[]) => buildButterfly(atm, qty, chain) },
];

// ─── Helpers ─────────────────────────────────────────────────────────────────

function isMarketOpen(): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  if (day === 0 || day === 6) return false;
  const minutes = ist.getHours() * 60 + ist.getMinutes();
  return minutes >= 9 * 60 + 15 && minutes <= 15 * 60 + 30;
}

function formatNum(val: number | undefined | null): string {
  if (val == null || isNaN(val)) return '—';
  if (Math.abs(val) >= 10000000) return (val / 10000000).toFixed(2) + 'Cr';
  if (Math.abs(val) >= 100000) return (val / 100000).toFixed(1) + 'L';
  if (Math.abs(val) >= 1000) return (val / 1000).toFixed(1) + 'K';
  return val.toLocaleString('en-IN');
}

function dte(expiry: string): number {
  if (!expiry) return 0;
  return Math.max(0, Math.ceil((new Date(expiry).getTime() - Date.now()) / 86400000));
}

function fmtDate(d: string): string {
  if (!d) return '';
  const dt = new Date(d);
  return dt.toLocaleDateString('en-IN', { day: '2-digit', month: 'short' });
}

function findATM(strikes: Strike[], spot: number): number {
  if (strikes.length === 0) return spot;
  let closest = strikes[0].strike;
  let minDiff = Math.abs(spot - closest);
  for (const s of strikes) {
    const diff = Math.abs(spot - s.strike);
    if (diff < minDiff) { minDiff = diff; closest = s.strike; }
  }
  return closest;
}

function getStrikeStep(strikes: Strike[]): number {
  if (strikes.length < 2) return 50;
  const sorted = strikes.map(s => s.strike).sort((a, b) => a - b);
  return sorted[1] - sorted[0] || 50;
}

function findStrike(chain: Strike[], target: number): Strike | undefined {
  let best: Strike | undefined;
  let minDiff = Infinity;
  for (const s of chain) {
    const diff = Math.abs(s.strike - target);
    if (diff < minDiff) { minDiff = diff; best = s; }
  }
  return best;
}

function buildStraddle(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const s = findStrike(chain, atm);
  if (!s) return [];
  return [
    { type: 'CE', strike: s.strike, action: 'SELL', qty, premium: s.callLTP, iv: s.callIV },
    { type: 'PE', strike: s.strike, action: 'SELL', qty, premium: s.putLTP, iv: s.putIV },
  ];
}

function buildStrangle(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const ce = findStrike(chain, atm + step * 2);
  const pe = findStrike(chain, atm - step * 2);
  if (!ce || !pe) return [];
  return [
    { type: 'CE', strike: ce.strike, action: 'SELL', qty, premium: ce.callLTP, iv: ce.callIV },
    { type: 'PE', strike: pe.strike, action: 'SELL', qty, premium: pe.putLTP, iv: pe.putIV },
  ];
}

function buildBullSpread(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const buy = findStrike(chain, atm);
  const sell = findStrike(chain, atm + step * 2);
  if (!buy || !sell) return [];
  return [
    { type: 'CE', strike: buy.strike, action: 'BUY', qty, premium: buy.callLTP, iv: buy.callIV },
    { type: 'CE', strike: sell.strike, action: 'SELL', qty, premium: sell.callLTP, iv: sell.callIV },
  ];
}

function buildBearSpread(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const buy = findStrike(chain, atm);
  const sell = findStrike(chain, atm - step * 2);
  if (!buy || !sell) return [];
  return [
    { type: 'PE', strike: buy.strike, action: 'BUY', qty, premium: buy.putLTP, iv: buy.putIV },
    { type: 'PE', strike: sell.strike, action: 'SELL', qty, premium: sell.putLTP, iv: sell.putIV },
  ];
}

function buildIronCondor(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const s1 = findStrike(chain, atm - step * 3);
  const s2 = findStrike(chain, atm - step);
  const s3 = findStrike(chain, atm + step);
  const s4 = findStrike(chain, atm + step * 3);
  if (!s1 || !s2 || !s3 || !s4) return [];
  return [
    { type: 'PE', strike: s1.strike, action: 'BUY', qty, premium: s1.putLTP, iv: s1.putIV },
    { type: 'PE', strike: s2.strike, action: 'SELL', qty, premium: s2.putLTP, iv: s2.putIV },
    { type: 'CE', strike: s3.strike, action: 'SELL', qty, premium: s3.callLTP, iv: s3.callIV },
    { type: 'CE', strike: s4.strike, action: 'BUY', qty, premium: s4.callLTP, iv: s4.callIV },
  ];
}

function buildButterfly(atm: number, qty: number, chain: Strike[]): StrategyLeg[] {
  const step = getStrikeStep(chain);
  const lower = findStrike(chain, atm - step * 2);
  const mid = findStrike(chain, atm);
  const upper = findStrike(chain, atm + step * 2);
  if (!lower || !mid || !upper) return [];
  return [
    { type: 'CE', strike: lower.strike, action: 'BUY', qty, premium: lower.callLTP, iv: lower.callIV },
    { type: 'CE', strike: mid.strike, action: 'SELL', qty: qty * 2, premium: mid.callLTP, iv: mid.callIV },
    { type: 'CE', strike: upper.strike, action: 'BUY', qty, premium: upper.callLTP, iv: upper.callIV },
  ];
}

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
      const intrinsic = leg.type === 'CE' ? Math.max(s - leg.strike, 0) : Math.max(leg.strike - s, 0);
      pnl += (leg.action === 'BUY' ? intrinsic - leg.premium : leg.premium - intrinsic) * leg.qty;
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
  for (const leg of legs) netPremium += leg.action === 'SELL' ? leg.premium * leg.qty : -leg.premium * leg.qty;
  const totalQty = legs.reduce((s, l) => s + l.qty, 0) || 1;
  return {
    payoffCurve: curve,
    greeks: {
      delta: +(legs.reduce((a, l) => a + (l.type === 'CE' ? 0.5 : -0.5) * (l.action === 'BUY' ? 1 : -1) * l.qty, 0) / totalQty).toFixed(4),
      gamma: +(0.002 * legs.length).toFixed(4),
      theta: +(legs.reduce((a, l) => a + (l.action === 'SELL' ? 1 : -1) * l.premium * 0.03 * l.qty, 0)).toFixed(2),
      vega: +(legs.reduce((a, l) => a + (l.action === 'BUY' ? 1 : -1) * 12 * l.qty, 0)).toFixed(2),
    },
    maxProfit, maxLoss, breakevens, netPremium: Math.round(netPremium), source: 'local',
  };
}

// ─── Main Component ──────────────────────────────────────────────────────────

export default function StrategyBuilder() {
  // Symbol & expiry state
  const [symbol, setSymbol] = useState('NIFTY');
  const [searchInput, setSearchInput] = useState('');
  const [showSearch, setShowSearch] = useState(false);
  const [expiries, setExpiries] = useState<string[]>([]);
  const [selectedExpiry, setSelectedExpiry] = useState('');
  const [spotPrice, setSpotPrice] = useState(0);

  // Option chain
  const [chain, setChain] = useState<Strike[]>([]);
  const [chainLoading, setChainLoading] = useState(false);
  const [showGreeks, setShowGreeks] = useState(false);

  // Legs & payoff
  const [legs, setLegs] = useState<StrategyLeg[]>([]);
  const [payoff, setPayoff] = useState<PayoffResult | null>(null);
  const [loadingPayoff, setLoadingPayoff] = useState(false);
  const [lotSize] = useState(25);

  // Scenarios & explanation
  const [scenarioResults, setScenarioResults] = useState<ScenarioResult[]>([]);
  const [loadingScenarios, setLoadingScenarios] = useState(false);
  const [explanation, setExplanation] = useState('');
  const [loadingExplain, setLoadingExplain] = useState(false);

  // Optimizer
  const [optimizedStrategies, setOptimizedStrategies] = useState<OptimizedStrategy[]>([]);
  const [loadingOptimize, setLoadingOptimize] = useState(false);
  const [optimizerView, setOptimizerView] = useState<string>('');

  // Auto-refresh & meta
  const [lastUpdated, setLastUpdated] = useState<Date | null>(null);
  const timerRef = useRef<ReturnType<typeof setTimeout>>(undefined);

  // ATM strike
  const atmStrike = useMemo(() => findATM(chain, spotPrice), [chain, spotPrice]);

  // ── Fetch expiries on symbol change ─────────────────────────────────────
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const { data } = await marketApi.optionsExpiries(symbol);
        if (!cancelled && data?.expiries?.length > 0) {
          setExpiries(data.expiries);
          setSelectedExpiry(data.expiries[0]);
        }
      } catch {
        const fallback: string[] = [];
        const now = new Date();
        let d = new Date(now);
        for (let i = 0; i < 8; i++) {
          const daysUntilThurs = (4 - d.getDay() + 7) % 7 || 7;
          d = new Date(d.getTime() + daysUntilThurs * 86400000);
          fallback.push(d.toISOString().split('T')[0]);
        }
        if (!cancelled) { setExpiries(fallback); setSelectedExpiry(fallback[0]); }
      }
    })();
    return () => { cancelled = true; };
  }, [symbol]);

  // ── Fetch chain + spot on symbol/expiry change ──────────────────────────
  const fetchChain = useCallback(async (silent = false) => {
    if (!symbol) return;
    if (!silent) setChainLoading(true);
    try {
      const [chainRes, quoteRes] = await Promise.allSettled([
        marketApi.optionsChain(symbol, selectedExpiry || undefined),
        marketApi.quote(symbol),
      ]);
      if (chainRes.status === 'fulfilled') {
        const d = chainRes.value.data as any;
        const strikes: Strike[] = (d?.strikes ?? []).map((r: any) => ({
          strike: Number(r.strike) || 0,
          callOI: Number(r.callOI) || 0, callOIChange: Number(r.callOIChange) || 0,
          callVolume: Number(r.callVolume) || 0, callIV: Number(r.callIV) || 0,
          callLTP: Number(r.callLTP) || 0, callNetChange: Number(r.callNetChange) || 0,
          callDelta: Number(r.callDelta) || 0, callGamma: Number(r.callGamma) || 0,
          callTheta: Number(r.callTheta) || 0, callVega: Number(r.callVega) || 0,
          callBuildup: r.callBuildup ?? '',
          putOI: Number(r.putOI) || 0, putOIChange: Number(r.putOIChange) || 0,
          putVolume: Number(r.putVolume) || 0, putIV: Number(r.putIV) || 0,
          putLTP: Number(r.putLTP) || 0, putNetChange: Number(r.putNetChange) || 0,
          putDelta: Number(r.putDelta) || 0, putGamma: Number(r.putGamma) || 0,
          putTheta: Number(r.putTheta) || 0, putVega: Number(r.putVega) || 0,
          putBuildup: r.putBuildup ?? '',
        }));
        setChain(strikes);
        const sp = Number(d?.spotPrice ?? d?.underlyingValue) || 0;
        if (sp > 0) setSpotPrice(sp);
      }
      if (quoteRes.status === 'fulfilled') {
        const q = quoteRes.value.data as any;
        const ltp = Number(q?.lastPrice ?? q?.ltp ?? q?.close) || 0;
        if (ltp > 0 && spotPrice === 0) setSpotPrice(ltp);
      }
      setLastUpdated(new Date());
    } catch { /* silent */ }
    if (!silent) setChainLoading(false);
  }, [symbol, selectedExpiry, spotPrice]);

  useEffect(() => { fetchChain(); }, [fetchChain]);

  // ── Auto-refresh ────────────────────────────────────────────────────────
  useEffect(() => {
    const schedule = () => {
      const interval = isMarketOpen() ? 2000 : 5 * 60_000;
      timerRef.current = setTimeout(() => { fetchChain(true); schedule(); }, interval);
    };
    schedule();
    return () => { if (timerRef.current) clearTimeout(timerRef.current); };
  }, [fetchChain]);

  // ── Calculate payoff (Rust engine with JS fallback) ─────────────────────
  const calculatePayoff = useCallback(async (currentLegs: StrategyLeg[], spot: number) => {
    if (currentLegs.length === 0 || spot <= 0) return;
    setLoadingPayoff(true);
    try {
      const engineLegs = currentLegs.map(l => ({
        type: l.type,
        strike: l.strike,
        action: l.action,
        qty: l.qty,
        premium: l.premium,
        iv: l.iv,
        expiryDays: l.expiryDays ?? dte(l.expiry ?? selectedExpiry),
      }));
      const { data } = await optionsApi.payoffEngine(engineLegs, spot);
      if (data?.payoffCurve?.length > 0) {
        setPayoff({
          payoffCurve: data.payoffCurve,
          greeks: {
            delta: data.greeks?.net_delta ?? data.greeks?.delta ?? 0,
            gamma: data.greeks?.net_gamma ?? data.greeks?.gamma ?? 0,
            theta: data.greeks?.net_theta ?? data.greeks?.theta ?? 0,
            vega: data.greeks?.net_vega ?? data.greeks?.vega ?? 0,
          },
          maxProfit: data.maxProfit ?? 0,
          maxLoss: data.maxLoss ?? 0,
          breakevens: data.breakevens ?? [],
          netPremium: data.netPremium ?? 0,
          probabilityOfProfit: data.probabilityOfProfit,
          riskRewardRatio: data.riskRewardRatio,
          capitalRequired: data.capitalRequired,
          source: data.source ?? 'rust',
          strategyName: data.strategyName,
        });
        setLoadingPayoff(false);
        return;
      }
    } catch { /* fallback */ }
    setPayoff(computeLocalPayoff(currentLegs, spot));
    setLoadingPayoff(false);
  }, [selectedExpiry]);

  useEffect(() => {
    if (legs.length > 0 && spotPrice > 0) {
      const timer = setTimeout(() => calculatePayoff(legs, spotPrice), 300);
      return () => clearTimeout(timer);
    }
  }, [legs, spotPrice, calculatePayoff]);

  // ── Add leg from chain click ────────────────────────────────────────────
  const addLegFromChain = (strike: Strike, type: 'CE' | 'PE', action: 'BUY' | 'SELL') => {
    const premium = type === 'CE' ? strike.callLTP : strike.putLTP;
    const iv = type === 'CE' ? strike.callIV : strike.putIV;
    setLegs(prev => [...prev, {
      type, strike: strike.strike, action, qty: lotSize, premium, iv,
      expiry: selectedExpiry, expiryDays: dte(selectedExpiry),
    }]);
  };

  const addLeg = () => {
    setLegs(prev => [...prev, {
      type: 'CE', strike: atmStrike, action: 'BUY', qty: lotSize, premium: 0,
      expiry: selectedExpiry, expiryDays: dte(selectedExpiry),
    }]);
  };

  const removeLeg = (i: number) => setLegs(prev => prev.filter((_, idx) => idx !== i));

  const updateLeg = <K extends keyof StrategyLeg>(i: number, field: K, value: StrategyLeg[K]) => {
    setLegs(prev => { const u = [...prev]; u[i] = { ...u[i], [field]: value }; return u; });
  };

  // ── Quick build from chain ──────────────────────────────────────────────
  const quickBuild = (buildFn: (atm: number, qty: number, chain: Strike[]) => StrategyLeg[]) => {
    if (chain.length === 0) return;
    const built = buildFn(atmStrike, lotSize, chain);
    if (built.length > 0) {
      setLegs(built.map(l => ({ ...l, expiry: selectedExpiry, expiryDays: dte(selectedExpiry) })));
    }
  };

  // ── Optimizer ───────────────────────────────────────────────────────────
  const runOptimizer = async () => {
    setLoadingOptimize(true);
    try {
      const { data } = await optionsApi.optimize(symbol, selectedExpiry, optimizerView || undefined);
      const strats: OptimizedStrategy[] = (data?.strategies ?? []).map((s: any) => ({
        name: s.name ?? 'Unknown',
        category: s.category ?? 'neutral',
        legs: (s.legs ?? []).map((l: any) => ({
          type: l.type, strike: l.strike, action: l.action,
          qty: l.qty, premium: l.premium, iv: l.iv,
        })),
        maxProfit: s.maxProfit ?? 0,
        maxLoss: s.maxLoss ?? 0,
        breakevens: s.breakevens ?? [],
        netPremium: s.netPremium ?? 0,
        riskReward: s.riskReward ?? 0,
        pop: s.pop ?? 0,
        score: s.score ?? 0,
      }));
      setOptimizedStrategies(strats);
    } catch { setOptimizedStrategies([]); }
    setLoadingOptimize(false);
  };

  const loadOptimizedStrategy = (strat: OptimizedStrategy) => {
    setLegs(strat.legs.map(l => ({ ...l, expiry: selectedExpiry, expiryDays: dte(selectedExpiry) })));
  };

  // ── Scenarios ───────────────────────────────────────────────────────────
  const runScenarios = async () => {
    setLoadingScenarios(true);
    try {
      const { data } = await api.post('/options/scenario', { legs, spotPrice, scenarios: SCENARIOS });
      setScenarioResults(Array.isArray(data) ? data : data.results || []);
    } catch {
      setScenarioResults(SCENARIOS.map(sc => {
        const adjSpot = spotPrice * (1 + sc.spotDelta);
        let pnl = 0;
        for (const leg of legs) {
          const intr = leg.type === 'CE' ? Math.max(adjSpot - leg.strike, 0) : Math.max(leg.strike - adjSpot, 0);
          pnl += (leg.action === 'BUY' ? intr - leg.premium : leg.premium - intr) * leg.qty;
        }
        return { label: sc.label, pnl: Math.round(pnl), spotPrice: Math.round(adjSpot) };
      }));
    }
    setLoadingScenarios(false);
  };

  // ── Explain ─────────────────────────────────────────────────────────────
  const fetchExplanation = async () => {
    setLoadingExplain(true);
    try {
      const name = payoff?.strategyName || 'Custom Strategy';
      const { data } = await api.post('/options/explain', { strategyName: name, legs, spotPrice });
      setExplanation(data.explanation || data.text || JSON.stringify(data));
    } catch {
      setExplanation('Unable to generate explanation. Please ensure you have legs configured.');
    }
    setLoadingExplain(false);
  };

  // ── Chain display: filter near ATM ──────────────────────────────────────
  const displayChain = useMemo(() => {
    if (chain.length === 0) return [];
    const step = getStrikeStep(chain);
    const range = step * 12;
    return chain.filter(s => Math.abs(s.strike - atmStrike) <= range);
  }, [chain, atmStrike]);

  // ── Searched symbols ────────────────────────────────────────────────────
  const filteredSymbols = useMemo(() => {
    if (!searchInput) return SYMBOLS;
    return SYMBOLS.filter(s => s.toLowerCase().includes(searchInput.toLowerCase()));
  }, [searchInput]);

  // ────────────────────────────────────────────────────────────────────────
  //  RENDER
  // ────────────────────────────────────────────────────────────────────────

  return (
    <div className="space-y-4">
      {/* ── Header ─────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between flex-wrap gap-3">
        <div>
          <h1 className="text-2xl font-bold text-slate-900">Options Strategy Builder</h1>
          <p className="text-sm text-slate-500 mt-0.5">Live multi-expiry option chain with Rust-powered analytics</p>
        </div>
        <div className="flex items-center gap-3">
          {lastUpdated && (
            <span className="flex items-center gap-1.5 text-xs text-slate-400">
              {isMarketOpen() && <Wifi className="w-3 h-3 text-emerald-500" />}
              {isMarketOpen() ? (
                <span className="text-emerald-600 font-semibold">LIVE</span>
              ) : (
                <span>Off-market</span>
              )}
              <span>{Math.round((Date.now() - lastUpdated.getTime()) / 1000)}s ago</span>
            </span>
          )}
          <button
            onClick={() => fetchChain()}
            className="flex items-center gap-2 px-4 py-2 bg-indigo-600 text-white text-sm font-medium rounded-lg hover:bg-indigo-500 transition"
          >
            {chainLoading ? <Loader2 className="w-4 h-4 animate-spin" /> : <RefreshCcw className="w-4 h-4" />}
            Refresh
          </button>
        </div>
      </div>

      {/* ── Symbol + Expiry Bar ─────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-4">
        <div className="flex items-center gap-4 flex-wrap">
          {/* Symbol picker */}
          <div className="relative">
            <button
              onClick={() => setShowSearch(!showSearch)}
              className="flex items-center gap-2 px-4 py-2 bg-slate-50 border border-slate-200 rounded-lg text-sm font-semibold text-slate-800 hover:bg-slate-100 transition"
            >
              <Search className="w-4 h-4 text-slate-400" />
              {symbol}
              <ChevronDown className="w-3 h-3 text-slate-400" />
            </button>
            {showSearch && (
              <div className="absolute top-full left-0 mt-1 z-50 bg-white border border-slate-200 rounded-xl shadow-lg p-2 w-52">
                <input
                  type="text"
                  value={searchInput}
                  onChange={e => setSearchInput(e.target.value)}
                  placeholder="Search symbol..."
                  className="w-full px-3 py-2 text-sm border border-slate-200 rounded-lg mb-2 focus:outline-none focus:ring-2 focus:ring-indigo-300"
                  autoFocus
                />
                {filteredSymbols.map(s => (
                  <button
                    key={s}
                    onClick={() => { setSymbol(s); setShowSearch(false); setSearchInput(''); setLegs([]); }}
                    className={`w-full text-left px-3 py-2 text-sm rounded-lg transition ${s === symbol ? 'bg-indigo-50 text-indigo-700 font-semibold' : 'hover:bg-slate-50 text-slate-700'}`}
                  >
                    {s}
                  </button>
                ))}
              </div>
            )}
          </div>

          {/* Spot price */}
          <div className="flex items-center gap-2 px-3 py-2 bg-slate-50 rounded-lg border border-slate-200">
            <span className="text-xs text-slate-400">Spot</span>
            <span className="text-sm font-bold font-mono text-slate-800">
              {spotPrice > 0 ? spotPrice.toLocaleString('en-IN') : '—'}
            </span>
          </div>

          {/* Expiry tabs */}
          <div className="flex items-center gap-1 overflow-x-auto flex-1">
            <Calendar className="w-4 h-4 text-slate-400 flex-shrink-0" />
            {expiries.slice(0, 8).map(exp => (
              <button
                key={exp}
                onClick={() => setSelectedExpiry(exp)}
                className={`flex-shrink-0 px-3 py-1.5 rounded-lg text-xs font-medium transition whitespace-nowrap ${
                  selectedExpiry === exp
                    ? 'bg-indigo-100 text-indigo-700 ring-1 ring-indigo-200'
                    : 'text-slate-500 hover:bg-slate-100'
                }`}
              >
                {fmtDate(exp)}
                <span className={`ml-1 px-1.5 py-0.5 rounded text-[10px] font-bold ${
                  selectedExpiry === exp ? 'bg-indigo-200 text-indigo-800' : 'bg-slate-200 text-slate-600'
                }`}>
                  {dte(exp)}d
                </span>
              </button>
            ))}
          </div>
        </div>
      </div>

      {/* ── Quick Build + Option Chain + Legs ───────────────────────────── */}
      <div className="grid grid-cols-1 xl:grid-cols-12 gap-4">

        {/* Option Chain Panel */}
        <div className="xl:col-span-7 bg-white rounded-2xl border border-slate-200/60 shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-teal-500 to-emerald-500 flex items-center justify-center">
                <Layers className="w-3.5 h-3.5 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Option Chain</h2>
              <span className="text-[10px] text-slate-400 font-mono">
                {selectedExpiry && `Exp: ${fmtDate(selectedExpiry)} (${dte(selectedExpiry)}d)`}
              </span>
            </div>
            <div className="flex items-center gap-2">
              <label className="flex items-center gap-1.5 text-[10px] text-slate-500">
                <input type="checkbox" checked={showGreeks} onChange={e => setShowGreeks(e.target.checked)} className="rounded" />
                Greeks
              </label>
            </div>
          </div>

          {/* Quick Build */}
          <div className="flex items-center gap-1.5 mb-3 flex-wrap">
            <span className="text-[10px] font-semibold text-slate-400 uppercase">Quick:</span>
            {QUICK_STRATEGIES.map(qs => (
              <button
                key={qs.id}
                onClick={() => quickBuild(qs.build)}
                disabled={chain.length === 0}
                className="px-2.5 py-1 text-[10px] font-semibold bg-indigo-50 text-indigo-600 rounded-md hover:bg-indigo-100 disabled:opacity-40 transition"
              >
                {qs.label}
              </button>
            ))}
          </div>

          {/* Chain Table */}
          <div className="overflow-x-auto max-h-[420px] overflow-y-auto">
            {chainLoading && chain.length === 0 ? (
              <div className="flex items-center justify-center py-16">
                <Loader2 className="w-6 h-6 text-indigo-400 animate-spin" />
                <span className="ml-2 text-sm text-slate-400">Loading chain...</span>
              </div>
            ) : displayChain.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-16">No chain data available</div>
            ) : (
              <table className="w-full text-[11px]">
                <thead className="sticky top-0 bg-white z-10">
                  <tr className="border-b border-slate-200">
                    <th className="py-1.5 px-1 text-right text-emerald-600">OI</th>
                    <th className="py-1.5 px-1 text-right text-emerald-600">IV</th>
                    <th className="py-1.5 px-1 text-right text-emerald-600">LTP</th>
                    {showGreeks && <th className="py-1.5 px-1 text-right text-emerald-600">Δ</th>}
                    <th className="py-1.5 px-1 text-center font-bold text-slate-800 bg-slate-50">Strike</th>
                    {showGreeks && <th className="py-1.5 px-1 text-left text-red-600">Δ</th>}
                    <th className="py-1.5 px-1 text-left text-red-600">LTP</th>
                    <th className="py-1.5 px-1 text-left text-red-600">IV</th>
                    <th className="py-1.5 px-1 text-left text-red-600">OI</th>
                  </tr>
                </thead>
                <tbody>
                  {displayChain.map(s => {
                    const isATM = s.strike === atmStrike;
                    const isITMCall = s.strike < spotPrice;
                    const isITMPut = s.strike > spotPrice;
                    return (
                      <tr key={s.strike} className={`border-b border-slate-50 ${isATM ? 'bg-indigo-50/60 font-semibold' : ''}`}>
                        <td className={`py-1 px-1 text-right font-mono ${isITMCall ? 'bg-emerald-50/40' : ''}`}>
                          {formatNum(s.callOI)}
                        </td>
                        <td className={`py-1 px-1 text-right font-mono ${isITMCall ? 'bg-emerald-50/40' : ''}`}>
                          {s.callIV > 0 ? s.callIV.toFixed(1) : '—'}
                        </td>
                        <td className={`py-1 px-1 text-right font-mono ${isITMCall ? 'bg-emerald-50/40' : ''}`}>
                          <button
                            onClick={() => addLegFromChain(s, 'CE', 'BUY')}
                            onContextMenu={e => { e.preventDefault(); addLegFromChain(s, 'CE', 'SELL'); }}
                            className="hover:bg-emerald-100 px-1 py-0.5 rounded transition text-emerald-700 font-semibold"
                            title="Click=BUY, Right-click=SELL"
                          >
                            {s.callLTP > 0 ? s.callLTP.toFixed(2) : '—'}
                          </button>
                        </td>
                        {showGreeks && (
                          <td className={`py-1 px-1 text-right font-mono text-[10px] text-slate-500 ${isITMCall ? 'bg-emerald-50/40' : ''}`}>
                            {s.callDelta ? s.callDelta.toFixed(3) : ''}
                          </td>
                        )}
                        <td className={`py-1 px-1 text-center font-bold font-mono ${isATM ? 'text-indigo-700 bg-indigo-100/60' : 'text-slate-700 bg-slate-50'}`}>
                          {s.strike.toLocaleString('en-IN')}
                          {isATM && <span className="ml-1 text-[8px] text-indigo-500">ATM</span>}
                        </td>
                        {showGreeks && (
                          <td className={`py-1 px-1 text-left font-mono text-[10px] text-slate-500 ${isITMPut ? 'bg-red-50/40' : ''}`}>
                            {s.putDelta ? s.putDelta.toFixed(3) : ''}
                          </td>
                        )}
                        <td className={`py-1 px-1 text-left font-mono ${isITMPut ? 'bg-red-50/40' : ''}`}>
                          <button
                            onClick={() => addLegFromChain(s, 'PE', 'BUY')}
                            onContextMenu={e => { e.preventDefault(); addLegFromChain(s, 'PE', 'SELL'); }}
                            className="hover:bg-red-100 px-1 py-0.5 rounded transition text-red-700 font-semibold"
                            title="Click=BUY, Right-click=SELL"
                          >
                            {s.putLTP > 0 ? s.putLTP.toFixed(2) : '—'}
                          </button>
                        </td>
                        <td className={`py-1 px-1 text-left font-mono ${isITMPut ? 'bg-red-50/40' : ''}`}>
                          {s.putIV > 0 ? s.putIV.toFixed(1) : '—'}
                        </td>
                        <td className={`py-1 px-1 text-left font-mono ${isITMPut ? 'bg-red-50/40' : ''}`}>
                          {formatNum(s.putOI)}
                        </td>
                      </tr>
                    );
                  })}
                </tbody>
              </table>
            )}
          </div>
          <p className="text-[10px] text-slate-400 mt-2">Click LTP to BUY, right-click to SELL</p>
        </div>

        {/* Legs + Metrics Panel */}
        <div className="xl:col-span-5 space-y-4">
          {/* Strategy Legs */}
          <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-4">
            <div className="flex items-center justify-between mb-3">
              <div className="flex items-center gap-2">
                <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-purple-500 flex items-center justify-center">
                  <BarChart3 className="w-3.5 h-3.5 text-white" />
                </div>
                <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Strategy Legs</h2>
                {payoff?.strategyName && payoff.strategyName !== 'Custom' && (
                  <span className="px-2 py-0.5 bg-indigo-100 text-indigo-700 text-[10px] font-bold rounded-full">
                    {payoff.strategyName}
                  </span>
                )}
              </div>
              <button onClick={addLeg} className="flex items-center gap-1 text-xs font-medium text-indigo-600 hover:text-indigo-500 transition">
                <Plus className="w-3.5 h-3.5" /> Add Leg
              </button>
            </div>

            {legs.length === 0 ? (
              <div className="text-sm text-slate-400 text-center py-8">
                Click strikes from the option chain or use Quick Build to add legs
              </div>
            ) : (
              <div className="overflow-x-auto">
                <table className="w-full text-[11px]">
                  <thead>
                    <tr className="border-b border-slate-100">
                      <th className="text-left py-1.5 px-1 font-semibold text-slate-500">Type</th>
                      <th className="text-left py-1.5 px-1 font-semibold text-slate-500">Strike</th>
                      <th className="text-left py-1.5 px-1 font-semibold text-slate-500">B/S</th>
                      <th className="text-left py-1.5 px-1 font-semibold text-slate-500">Qty</th>
                      <th className="text-left py-1.5 px-1 font-semibold text-slate-500">Prem</th>
                      <th className="text-left py-1.5 px-1 font-semibold text-slate-500">Exp</th>
                      <th className="py-1.5 px-1"></th>
                    </tr>
                  </thead>
                  <tbody>
                    {legs.map((leg, i) => (
                      <tr key={i} className="border-b border-slate-50 hover:bg-slate-50/50">
                        <td className="py-1.5 px-1">
                          <select value={leg.type} onChange={e => updateLeg(i, 'type', e.target.value as 'CE' | 'PE')}
                            className="px-1.5 py-1 border border-slate-200 rounded bg-white text-[11px] focus:outline-none">
                            <option value="CE">CE</option>
                            <option value="PE">PE</option>
                          </select>
                        </td>
                        <td className="py-1.5 px-1">
                          <input type="number" value={leg.strike} onChange={e => updateLeg(i, 'strike', Number(e.target.value))}
                            className="w-[70px] px-1.5 py-1 border border-slate-200 rounded font-mono text-[11px] focus:outline-none" step={50} />
                        </td>
                        <td className="py-1.5 px-1">
                          <select value={leg.action} onChange={e => updateLeg(i, 'action', e.target.value as 'BUY' | 'SELL')}
                            className={`px-1.5 py-1 border rounded text-[11px] font-bold focus:outline-none ${
                              leg.action === 'BUY' ? 'border-emerald-200 bg-emerald-50 text-emerald-700' : 'border-red-200 bg-red-50 text-red-700'
                            }`}>
                            <option value="BUY">BUY</option>
                            <option value="SELL">SELL</option>
                          </select>
                        </td>
                        <td className="py-1.5 px-1">
                          <input type="number" value={leg.qty} onChange={e => updateLeg(i, 'qty', Number(e.target.value))}
                            className="w-[50px] px-1.5 py-1 border border-slate-200 rounded font-mono text-[11px] focus:outline-none" min={1} />
                        </td>
                        <td className="py-1.5 px-1">
                          <input type="number" value={leg.premium} onChange={e => updateLeg(i, 'premium', Number(e.target.value))}
                            className="w-[65px] px-1.5 py-1 border border-slate-200 rounded font-mono text-[11px] focus:outline-none" step={0.5} />
                        </td>
                        <td className="py-1.5 px-1 text-[10px] text-slate-400 font-mono">{leg.expiry ? fmtDate(leg.expiry) : '—'}</td>
                        <td className="py-1.5 px-1">
                          <button onClick={() => removeLeg(i)} className="p-0.5 text-slate-400 hover:text-red-500 transition">
                            <Trash2 className="w-3 h-3" />
                          </button>
                        </td>
                      </tr>
                    ))}
                  </tbody>
                </table>
              </div>
            )}

            {/* Summary metrics */}
            {payoff && legs.length > 0 && (
              <div className="mt-3 grid grid-cols-3 gap-2">
                <MetricCard label="Net Premium" value={payoff.netPremium} format="inr" color={payoff.netPremium >= 0 ? 'emerald' : 'red'} />
                <MetricCard label="Max Profit" value={payoff.maxProfit} format="inr" color="emerald" unlimited={payoff.maxProfit >= 1e9} />
                <MetricCard label="Max Loss" value={payoff.maxLoss} format="inr" color="red" unlimited={payoff.maxLoss <= -1e9} />
                {payoff.breakevens?.length > 0 && (
                  <div className="bg-slate-50 rounded-lg p-2 text-center col-span-3">
                    <p className="text-[9px] font-semibold text-slate-400 uppercase">Breakevens</p>
                    <p className="text-xs font-bold font-mono text-slate-700">
                      {payoff.breakevens.map(b => b.toLocaleString('en-IN')).join(' | ')}
                    </p>
                  </div>
                )}
                {payoff.probabilityOfProfit != null && payoff.probabilityOfProfit > 0 && (
                  <MetricCard label="Prob of Profit" value={payoff.probabilityOfProfit} format="pct" color="indigo" />
                )}
                {payoff.riskRewardRatio != null && payoff.riskRewardRatio > 0 && (
                  <MetricCard label="Risk/Reward" value={payoff.riskRewardRatio} format="ratio" color="amber" />
                )}
                {payoff.capitalRequired != null && payoff.capitalRequired > 0 && (
                  <MetricCard label="Capital Req." value={payoff.capitalRequired} format="inr" color="slate" />
                )}
              </div>
            )}
          </div>

          {/* Greeks */}
          <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-4">
            <div className="flex items-center gap-2 mb-3">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-amber-500 to-orange-500 flex items-center justify-center">
                <Target className="w-3.5 h-3.5 text-white" />
              </div>
              <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Net Greeks</h2>
              {loadingPayoff && <Loader2 className="w-3.5 h-3.5 text-indigo-400 animate-spin" />}
              {payoff?.source && (
                <span className={`text-[9px] font-bold px-1.5 py-0.5 rounded ${payoff.source === 'rust' ? 'bg-emerald-100 text-emerald-700' : 'bg-slate-100 text-slate-500'}`}>
                  {payoff.source === 'rust' ? 'Rust Engine' : 'JS'}
                </span>
              )}
            </div>
            {payoff ? (
              <div className="grid grid-cols-4 gap-2">
                <GreekCard label="Delta" symbol="Δ" value={payoff.greeks.delta} color={payoff.greeks.delta >= 0 ? 'emerald' : 'red'} />
                <GreekCard label="Gamma" symbol="Γ" value={payoff.greeks.gamma} color="indigo" />
                <GreekCard label="Theta" symbol="Θ" value={payoff.greeks.theta} color={payoff.greeks.theta >= 0 ? 'emerald' : 'amber'} />
                <GreekCard label="Vega" symbol="ν" value={payoff.greeks.vega} color={payoff.greeks.vega >= 0 ? 'purple' : 'red'} />
              </div>
            ) : (
              <div className="text-xs text-slate-400 text-center py-4">Add legs to see Greeks</div>
            )}
          </div>
        </div>
      </div>

      {/* ── Payoff Chart ───────────────────────────────────────────────── */}
      <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-5">
        <div className="flex items-center gap-2 mb-4">
          <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-indigo-500 to-blue-500 flex items-center justify-center">
            <Activity className="w-3.5 h-3.5 text-white" />
          </div>
          <h2 className="text-sm font-semibold text-slate-500 uppercase tracking-wide">Payoff Diagram</h2>
          {loadingPayoff && <Loader2 className="w-4 h-4 text-indigo-400 animate-spin" />}
        </div>
        <div className="h-72">
          {payoff && payoff.payoffCurve?.length > 0 ? (
            <ResponsiveContainer width="100%" height="100%">
              <AreaChart data={payoff.payoffCurve} margin={{ top: 10, right: 10, left: 0, bottom: 0 }}>
                <defs>
                  <linearGradient id="profitGrad" x1="0" y1="0" x2="0" y2="1">
                    <stop offset="0%" stopColor="#10b981" stopOpacity={0.3} />
                    <stop offset="100%" stopColor="#10b981" stopOpacity={0} />
                  </linearGradient>
                </defs>
                <CartesianGrid strokeDasharray="3 3" stroke="#e2e8f0" />
                <XAxis dataKey="spot" tick={{ fontSize: 10, fill: '#94a3b8' }}
                  tickFormatter={(v: number) => v.toLocaleString('en-IN')} interval="preserveStartEnd" />
                <YAxis tick={{ fontSize: 10, fill: '#94a3b8' }}
                  tickFormatter={(v: number) => `₹${formatNum(v)}`} />
                <Tooltip
                  contentStyle={{ fontSize: 12, borderRadius: 8, border: '1px solid #e2e8f0' }}
                  formatter={(value: number | undefined) => [`₹${formatNum(value ?? 0)}`, 'P&L']}
                  labelFormatter={(label: any) => `Spot: ${Number(label).toLocaleString('en-IN')}`} />
                <ReferenceLine y={0} stroke="#64748b" strokeDasharray="4 4" strokeWidth={1.5} />
                <ReferenceLine x={spotPrice} stroke="#6366f1" strokeDasharray="4 4" label={{ value: 'Spot', fontSize: 10, fill: '#6366f1' }} />
                {(payoff.breakevens ?? []).map((be, idx) => (
                  <ReferenceLine key={idx} x={be} stroke="#f59e0b" strokeDasharray="3 3"
                    label={{ value: `BE ${be.toLocaleString('en-IN')}`, fontSize: 9, fill: '#d97706' }} />
                ))}
                <Area type="monotone" dataKey="pnl" stroke="#6366f1" strokeWidth={2}
                  fill="url(#profitGrad)" dot={false} activeDot={{ r: 4, fill: '#6366f1' }} />
              </AreaChart>
            </ResponsiveContainer>
          ) : (
            <div className="flex items-center justify-center h-full text-sm text-slate-400">
              Add legs to see the payoff diagram
            </div>
          )}
        </div>
      </div>

      {/* ── Bottom Grid: Scenarios + Explain + Optimizer ─────────────── */}
      <div className="grid grid-cols-1 lg:grid-cols-3 gap-4">
        {/* Scenario Simulator */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-cyan-500 to-teal-500 flex items-center justify-center">
                <Shield className="w-3.5 h-3.5 text-white" />
              </div>
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Scenarios</h2>
            </div>
            <button onClick={runScenarios} disabled={loadingScenarios || legs.length === 0}
              className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium bg-teal-50 text-teal-600 rounded-lg hover:bg-teal-100 disabled:opacity-50 transition">
              {loadingScenarios ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
              Run
            </button>
          </div>
          {scenarioResults.length > 0 ? (
            <div className="grid grid-cols-2 gap-1.5">
              {scenarioResults.map((sc, i) => (
                <div key={i} className={`rounded-lg p-2 text-center border ${sc.pnl >= 0 ? 'bg-emerald-50/50 border-emerald-100' : 'bg-red-50/50 border-red-100'}`}>
                  <p className="text-[9px] font-semibold text-slate-500 uppercase">{sc.label}</p>
                  <p className={`text-xs font-bold font-mono ${sc.pnl >= 0 ? 'text-emerald-600' : 'text-red-600'}`}>
                    {sc.pnl >= 0 ? '+' : ''}₹{formatNum(sc.pnl)}
                  </p>
                </div>
              ))}
            </div>
          ) : (
            <div className="text-xs text-slate-400 text-center py-8">Run scenarios to simulate market conditions</div>
          )}
        </div>

        {/* AI Explanation */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-violet-500 to-purple-500 flex items-center justify-center">
                <Lightbulb className="w-3.5 h-3.5 text-white" />
              </div>
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Why This Works</h2>
            </div>
            <button onClick={fetchExplanation} disabled={loadingExplain || legs.length === 0}
              className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium bg-violet-50 text-violet-600 rounded-lg hover:bg-violet-100 disabled:opacity-50 transition">
              {loadingExplain ? <Loader2 className="w-3 h-3 animate-spin" /> : <Lightbulb className="w-3 h-3" />}
              Explain
            </button>
          </div>
          {explanation ? (
            <div className="text-xs text-slate-700 leading-relaxed bg-violet-50/50 rounded-xl p-3 border border-violet-100 max-h-48 overflow-y-auto">
              {explanation.split('**').map((part, i) =>
                i % 2 === 1 ? <strong key={i} className="text-violet-800">{part}</strong> : <span key={i}>{part}</span>
              )}
            </div>
          ) : (
            <div className="text-xs text-slate-400 text-center py-8">Click Explain for strategy breakdown</div>
          )}
        </div>

        {/* Strategy Optimizer */}
        <div className="bg-white rounded-2xl border border-slate-200/60 shadow-sm p-4">
          <div className="flex items-center justify-between mb-3">
            <div className="flex items-center gap-2">
              <div className="w-7 h-7 rounded-lg bg-gradient-to-br from-rose-500 to-pink-500 flex items-center justify-center">
                <Star className="w-3.5 h-3.5 text-white" />
              </div>
              <h2 className="text-xs font-semibold text-slate-500 uppercase tracking-wide">Optimizer</h2>
            </div>
            <button onClick={runOptimizer} disabled={loadingOptimize || chain.length === 0}
              className="flex items-center gap-1 px-2.5 py-1 text-[10px] font-medium bg-rose-50 text-rose-600 rounded-lg hover:bg-rose-100 disabled:opacity-50 transition">
              {loadingOptimize ? <Loader2 className="w-3 h-3 animate-spin" /> : <Zap className="w-3 h-3" />}
              Optimize
            </button>
          </div>

          <div className="flex gap-1 mb-3">
            {['', 'bullish', 'bearish', 'neutral', 'volatile'].map(v => (
              <button key={v} onClick={() => setOptimizerView(v)}
                className={`px-2 py-0.5 text-[10px] font-medium rounded-full transition ${
                  optimizerView === v ? 'bg-indigo-100 text-indigo-700' : 'text-slate-400 hover:bg-slate-100'
                }`}>
                {v || 'All'}
              </button>
            ))}
          </div>

          {optimizedStrategies.length > 0 ? (
            <div className="space-y-2 max-h-52 overflow-y-auto">
              {optimizedStrategies.map((strat, i) => {
                const meta = CATEGORY_META[strat.category] || CATEGORY_META.neutral;
                const Icon = meta.icon;
                return (
                  <button key={i} onClick={() => loadOptimizedStrategy(strat)}
                    className="w-full text-left p-2.5 rounded-xl border border-slate-200 hover:border-indigo-300 hover:bg-indigo-50/30 transition">
                    <div className="flex items-center justify-between mb-1">
                      <div className="flex items-center gap-1.5">
                        <Icon className="w-3 h-3 text-slate-500" />
                        <span className="text-[11px] font-semibold text-slate-800">{strat.name}</span>
                      </div>
                      <span className="text-[9px] font-bold text-indigo-600">{strat.score.toFixed(0)}pts</span>
                    </div>
                    <div className="flex items-center gap-3 text-[10px] text-slate-500">
                      <span className="text-emerald-600 flex items-center gap-0.5">
                        <ArrowUpRight className="w-2.5 h-2.5" />₹{formatNum(strat.maxProfit)}
                      </span>
                      <span className="text-red-600 flex items-center gap-0.5">
                        <ArrowDownRight className="w-2.5 h-2.5" />₹{formatNum(strat.maxLoss)}
                      </span>
                      {strat.pop > 0 && <span>PoP: {strat.pop.toFixed(0)}%</span>}
                      {strat.riskReward > 0 && <span>RR: {strat.riskReward.toFixed(2)}</span>}
                    </div>
                  </button>
                );
              })}
            </div>
          ) : (
            <div className="text-xs text-slate-400 text-center py-6">
              Click Optimize to find the best strategies for current market conditions
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ─── Sub-components ──────────────────────────────────────────────────────────

function MetricCard({ label, value, format, color, unlimited }: {
  label: string; value: number; format: 'inr' | 'pct' | 'ratio'; color: string; unlimited?: boolean;
}) {
  let display: string;
  if (unlimited) display = 'Unlimited';
  else if (format === 'pct') display = `${value.toFixed(1)}%`;
  else if (format === 'ratio') display = value.toFixed(2);
  else display = `₹${formatNum(value)}`;
  const colorClasses: Record<string, string> = {
    emerald: 'bg-emerald-50 text-emerald-600 border-emerald-100',
    red: 'bg-red-50 text-red-600 border-red-100',
    indigo: 'bg-indigo-50 text-indigo-600 border-indigo-100',
    amber: 'bg-amber-50 text-amber-600 border-amber-100',
    slate: 'bg-slate-50 text-slate-600 border-slate-100',
    purple: 'bg-purple-50 text-purple-600 border-purple-100',
  };
  return (
    <div className={`rounded-lg p-2 text-center border ${colorClasses[color] || colorClasses.slate}`}>
      <p className="text-[9px] font-semibold uppercase opacity-70">{label}</p>
      <p className="text-xs font-bold font-mono">{display}</p>
    </div>
  );
}

function GreekCard({ label, symbol: sym, value, color }: {
  label: string; symbol: string; value: number; color: string;
}) {
  const colorClasses: Record<string, string> = {
    emerald: 'bg-emerald-50 border-emerald-100 text-emerald-600',
    red: 'bg-red-50 border-red-100 text-red-600',
    indigo: 'bg-indigo-50 border-indigo-100 text-indigo-600',
    amber: 'bg-amber-50 border-amber-100 text-amber-600',
    purple: 'bg-purple-50 border-purple-100 text-purple-600',
  };
  return (
    <div className={`rounded-xl border p-2.5 text-center ${colorClasses[color] || colorClasses.indigo}`}>
      <p className="text-[10px] font-semibold opacity-70">{label} ({sym})</p>
      <p className="text-sm font-bold font-mono mt-0.5">{value >= 0 ? '+' : ''}{typeof value === 'number' ? value.toFixed(4) : value}</p>
    </div>
  );
}
