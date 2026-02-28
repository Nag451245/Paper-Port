// ─── Auth & User ─────────────────────────────────────────────────
export interface User {
  id: string;
  email: string;
  fullName: string;
  avatarUrl?: string;
  riskAppetite: 'conservative' | 'moderate' | 'aggressive';
  virtualCapital: number;
  isOnboarded: boolean;
  createdAt: string;
}

export interface BreezeCredentialStatus {
  isConnected: boolean;
  apiKey?: string;
  sessionToken?: string;
  hasSession?: boolean;
  hasLoginCredentials?: boolean;
  canAutoLogin?: boolean;
  sessionExpiry?: string | null;
  lastConnected?: string;
  lastAutoLoginAt?: string | null;
  autoLoginError?: string | null;
  error?: string;
}

// ─── Portfolio ────────────────────────────────────────────────────
export interface Portfolio {
  id: string;
  name: string;
  type: 'virtual' | 'live';
  capital: number;
  currentValue: number;
  createdAt: string;
}

export interface PortfolioSummary {
  totalNav: number;
  dayPnl: number;
  dayPnlPercent: number;
  totalPnl: number;
  totalPnlPercent: number;
  investedValue: number;
  currentValue: number;
  availableMargin: number;
  usedMargin: number;
}

export interface RiskMetrics {
  sharpeRatio: number;
  maxDrawdown: number;
  maxDrawdownPercent: number;
  winRate: number;
  profitFactor: number;
  beta: number;
  alpha: number;
  sortinoRatio: number;
  calmarRatio: number;
  avgWin: number;
  avgLoss: number;
  totalTrades: number;
}

// ─── Order Entry ─────────────────────────────────────────────────
export type OrderSide = 'BUY' | 'SELL';

export type OrderType = 'MARKET' | 'LIMIT' | 'SL' | 'SL-M' | 'BRACKET' | 'COVER';

export interface OrderCostBreakdown {
  brokerage: number;
  stt: number;
  exchangeCharges: number;
  gst: number;
  sebiCharges: number;
  stampDuty: number;
  total: number;
}

// ─── Positions, Orders & Trades ──────────────────────────────────
export type ExchangeType = 'NSE' | 'BSE' | 'NFO' | 'BFO' | 'MCX' | 'CDS';
export type SegmentType = 'EQ' | 'FUT' | 'OPT' | 'COMMODITY' | 'CURRENCY';

export interface Position {
  id: string;
  symbol: string;
  exchange: ExchangeType;
  segment: SegmentType;
  side: 'LONG' | 'SHORT';
  quantity: number;
  avgPrice: number;
  ltp: number;
  unrealizedPnl: number;
  unrealizedPnlPercent: number;
  dayPnl: number;
  strategy?: string;
}

export interface Order {
  id: string;
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  type: 'MARKET' | 'LIMIT' | 'SL' | 'SL-M';
  quantity: number;
  price?: number;
  triggerPrice?: number;
  status: 'PENDING' | 'OPEN' | 'EXECUTED' | 'CANCELLED' | 'REJECTED';
  filledQty: number;
  avgFilledPrice?: number;
  strategy?: string;
  placedAt: string;
  updatedAt: string;
}

export interface Trade {
  id: string;
  symbol: string;
  exchange: string;
  side: 'BUY' | 'SELL';
  quantity: number;
  price: number;
  pnl?: number;
  strategy?: string;
  executedAt: string;
  time?: string;
  aiBriefing?: string;
  tags?: string[];
}

export interface PnLSummary {
  date: string;
  realizedPnl: number;
  unrealizedPnl: number;
  totalPnl: number;
  tradeCount: number;
}

// ─── Watchlist ────────────────────────────────────────────────────
export interface Watchlist {
  id: string;
  name: string;
  items: WatchlistItem[];
}

export interface WatchlistItem {
  symbol: string;
  exchange: string;
  ltp: number;
  change: number;
  changePercent: number;
  volume: number;
  high: number;
  low: number;
  open: number;
  close: number;
}

// ─── AI Agent ─────────────────────────────────────────────────────
export type AIAgentMode = 'AUTONOMOUS' | 'SIGNAL' | 'ADVISORY';

export interface AIAgentConfig {
  mode: AIAgentMode;
  isActive: boolean;
  maxCapitalPerTrade: number;
  maxDailyLoss: number;
  maxOpenPositions: number;
  enabledStrategies: string[];
  riskLevel: 'conservative' | 'moderate' | 'aggressive';
}

export interface AISignal {
  id: string;
  symbol: string;
  signalType: 'BUY' | 'SELL' | 'HOLD';
  compositeScore: number;
  gateScores: GateScores;
  strategyId: string | null;
  rationale: string | null;
  status: 'PENDING' | 'EXECUTED' | 'EXPIRED' | 'REJECTED';
  createdAt: string;
  executedAt: string | null;
  expiresAt: string | null;
}

export interface GateScores {
  g1_trend: number;
  g2_momentum: number;
  g3_volatility: number;
  g4_volume: number;
  g5_options_flow: number;
  g6_global_macro: number;
  g7_fii_dii: number;
  g8_sentiment: number;
  g9_risk: number;
}

// ─── Market Data ──────────────────────────────────────────────────
export interface MarketQuote {
  symbol: string;
  exchange: string;
  ltp: number;
  change: number;
  changePercent: number;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
  bidPrice: number;
  askPrice: number;
  bidQty: number;
  askQty: number;
  timestamp: string;
}

export interface HistoricalData {
  timestamp: string;
  open: number;
  high: number;
  low: number;
  close: number;
  volume: number;
}

export interface OptionsChain {
  symbol: string;
  expiry: string;
  strikes: OptionStrike[];
}

export interface OptionStrike {
  strikePrice: number;
  callOI: number;
  callOIChange: number;
  callLTP: number;
  callIV: number;
  putOI: number;
  putOIChange: number;
  putLTP: number;
  putIV: number;
}

export interface MarketDepth {
  symbol: string;
  bids: DepthLevel[];
  asks: DepthLevel[];
}

export interface DepthLevel {
  price: number;
  quantity: number;
  orders: number;
}

export interface IndexData {
  name: string;
  value: number;
  change: number;
  changePercent: number;
}

export interface FIIDIIData {
  date: string;
  fiiBuy: number;
  fiiSell: number;
  fiiNet: number;
  diiBuy: number;
  diiSell: number;
  diiNet: number;
}

// ─── Briefings ────────────────────────────────────────────────────
export interface PreMarketBriefing {
  date: string;
  stance: 'bullish' | 'bearish' | 'neutral';
  keyPoints: string[];
  globalCues: string[];
  sectorOutlook: Record<string, string>;
  supportLevels: number[];
  resistanceLevels: number[];
  keyEvents: string[];
}

export interface PostTradeBriefing {
  date: string;
  summary: string;
  pnlSummary: PnLSummary;
  topWinners: Trade[];
  topLosers: Trade[];
  lessonsLearned: string[];
  tomorrowOutlook: string;
}

// ─── Backtest ─────────────────────────────────────────────────────
export interface BacktestRequest {
  strategyId: string;
  symbol: string;
  startDate: string;
  endDate: string;
  initialCapital: number;
  parameters: Record<string, number | string | boolean>;
}

export interface BacktestResult {
  id?: string;
  strategyId?: string;
  symbol?: string;
  period?: { start: string; end: string };
  totalReturn?: number;
  totalReturnPercent?: number;
  cagr: number;
  sharpeRatio: number;
  sortinoRatio: number;
  maxDrawdown: number;
  winRate: number;
  profitFactor: number;
  totalTrades: number;
  equityCurve: { date: string; nav: number; value?: number }[];
  trades: Trade[];
  monthlyReturns?: { month: string; return: number }[];
}

// ─── AI Agent Additional Types ───────────────────────────────────
export type CPRuleStatus = 'Active' | 'Triggered' | 'Warning';

export interface CPRule {
  id: string;
  name: string;
  description: string;
  status: CPRuleStatus;
}

export interface SignalScores {
  compositeScore: number;
  gates: { key: string; label: string; score: number; weight: number }[];
}

export interface AIAgentStatus {
  mode: string;
  isRunning: boolean;
  lastAction: string;
  activeStrategies: number;
  todayTrades: number;
  todaySignals: number;
  uptime: string;
}

export interface GlobalIndex {
  name: string;
  symbol: string;
  value: number;
  change: number;
  changePercent: number;
}

// ─── Strategy Configuration ──────────────────────────────────────
export interface StrategyParameter {
  key: string;
  label: string;
  type: 'number' | 'text' | 'boolean';
  defaultValue: number | string | boolean;
  min?: number;
  max?: number;
  step?: number;
}

export interface StrategyConfig {
  id: string;
  name: string;
  parameters: StrategyParameter[];
}

// ─── Chart Data ──────────────────────────────────────────────────
export interface DailyPnLPoint {
  date: string;
  pnl: number;
  cumulative: number;
}

export interface EquityCurvePoint {
  date: string;
  nav: number;
}

export interface VIXData {
  current: number;
  change: number;
  changePercent: number;
}

// ─── Helpers ─────────────────────────────────────────────────────
export function formatINR(value: number | undefined | null): string {
  if (value == null) return '₹0';
  const abs = Math.abs(value);
  const sign = value < 0 ? '-' : '';
  if (abs >= 10000000) return `${sign}₹${(abs / 10000000).toFixed(2)} Cr`;
  if (abs >= 100000) return `${sign}₹${(abs / 100000).toFixed(2)} L`;
  return `${sign}₹${abs.toLocaleString('en-IN', { maximumFractionDigits: 2 })}`;
}

export function formatPercent(value: number): string {
  const sign = value >= 0 ? '+' : '';
  return `${sign}${value.toFixed(2)}%`;
}

export function formatVolume(value: number): string {
  if (value >= 10000000) return `${(value / 10000000).toFixed(2)} Cr`;
  if (value >= 100000) return `${(value / 100000).toFixed(2)} L`;
  if (value >= 1000) return `${(value / 1000).toFixed(1)} K`;
  return value.toString();
}
