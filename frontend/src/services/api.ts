import axios from 'axios';
import type {
  User,
  BreezeCredentialStatus,
  Portfolio,
  PortfolioSummary,
  RiskMetrics,
  Order,
  PnLSummary,
  Watchlist,
  MarketQuote,
  HistoricalData,
  OptionsChain,
  MarketDepth,
  IndexData,
  FIIDIIData,
  AIAgentConfig,
  AISignal,
  PreMarketBriefing,
  PostTradeBriefing,
  BacktestRequest,
  BacktestResult,
} from '@/types';

const api = axios.create({
  baseURL: import.meta.env.VITE_API_BASE_URL || 'http://localhost:8000/api',
  headers: { 'Content-Type': 'application/json' },
  timeout: 15_000,
});

api.interceptors.request.use((config) => {
  const token = localStorage.getItem('token');
  if (token) {
    config.headers.Authorization = `Bearer ${token}`;
  }
  return config;
});

api.interceptors.response.use(
  (response) => response,
  (error) => {
    if (error.response?.status === 401) {
      const url = error.config?.url || '';
      const isAuthEndpoint = url.includes('/auth/login') || url.includes('/auth/register');
      if (!isAuthEndpoint) {
        localStorage.removeItem('token');
      }
    }
    return Promise.reject(error);
  }
);

// ─── Auth ─────────────────────────────────────────────────────────
export const authApi = {
  login: (email: string, password: string) =>
    api.post<{ user: User; access_token: string; token_type: string }>('/auth/login', { email, password }),

  register: (data: { fullName: string; email: string; password: string; riskAppetite: string; virtualCapital: number }) =>
    api.post<{ user: User; access_token: string; token_type: string }>('/auth/register', data),

  me: () => api.get<User>('/auth/me'),

  updateProfile: (data: Partial<User>) =>
    api.put<User>('/auth/me', data),
};

// ─── Portfolio ────────────────────────────────────────────────────
export const portfolioApi = {
  list: () => api.get<Portfolio[]>('/portfolio'),

  get: (id: string) => api.get<Portfolio>(`/portfolio/${id}`),

  summary: (id: string) =>
    api.get<PortfolioSummary>(`/portfolio/${id}/summary`),

  riskMetrics: (id: string) =>
    api.get<RiskMetrics>(`/portfolio/${id}/risk-metrics`),

  pnlHistory: (id: string, days?: number) =>
    api.get<PnLSummary[]>(`/portfolio/${id}/pnl-history`, { params: { days } }),

  equityCurve: (id: string) =>
    api.get<{ date: string; value: number }[]>(`/portfolio/${id}/equity-curve`),

  updateCapital: (id: string, virtualCapital: number) =>
    api.put(`/portfolio/${id}/capital`, { virtual_capital: virtualCapital }),
};

// ─── Orders & Trades ─────────────────────────────────────────────
export const tradingApi = {
  placeOrder: (order: {
    portfolio_id: string;
    symbol: string;
    side: 'BUY' | 'SELL';
    order_type: string;
    qty: number;
    price?: number;
    trigger_price?: number;
    instrument_token: string;
    exchange?: string;
    strategy_tag?: string;
  }) =>
    api.post('/trades/orders', order),

  cancelOrder: (id: string) =>
    api.delete<void>(`/trades/orders/${id}`),

  listOrders: (params?: { status?: string; page?: number; limit?: number }) =>
    api.get('/trades/orders', { params }),

  positions: () =>
    api.get('/trades/positions'),

  listTrades: (params?: { page?: number; limit?: number; from_date?: string; to_date?: string; symbol?: string }) =>
    api.get('/trades/trades', { params }),
};

// ─── Watchlist ────────────────────────────────────────────────────
export const watchlistApi = {
  list: () => api.get<Watchlist[]>('/watchlist'),

  create: (name: string) =>
    api.post<Watchlist>('/watchlist', { name }),

  addItem: (id: string, symbol: string, exchange: string) =>
    api.post<void>(`/watchlist/${id}/items`, { symbol, exchange }),

  removeItem: (id: string, itemId: string) =>
    api.delete<void>(`/watchlist/${id}/items/${itemId}`),

  delete: (id: string) =>
    api.delete<void>(`/watchlist/${id}`),
};

// ─── Market Data ──────────────────────────────────────────────────
export const marketApi = {
  quote: (symbol: string, exchange?: string) =>
    api.get<MarketQuote>(`/market/quote/${encodeURIComponent(symbol)}`, { params: { exchange } }),

  historical: (symbol: string, interval: string, from: string, to: string, exchange?: string) =>
    api.get<HistoricalData[]>(`/market/history/${encodeURIComponent(symbol)}`, { params: { interval, from_date: from, to_date: to, exchange } }),

  optionsChain: (symbol: string, expiry?: string) =>
    api.get<OptionsChain>(`/market/options-chain/${encodeURIComponent(symbol)}`, { params: { expiry } }),

  marketDepth: (symbol: string, exchange?: string) =>
    api.get<MarketDepth>(`/market/market-depth/${encodeURIComponent(symbol)}`, { params: { exchange } }),

  indices: (exchange?: string) => api.get<IndexData[]>('/market/indices', { params: exchange ? { exchange } : undefined }),

  vix: () => api.get<{ value: number; change: number; changePercent: number }>('/market/vix'),

  fiiDii: () => api.get<FIIDIIData>('/market/fii-dii'),

  search: (query: string, exchange?: string) =>
    api.get<{ symbol: string; name: string; exchange: string; segment?: string }[]>('/market/search', { params: { q: query, exchange } }),
};

// ─── AI Agent ─────────────────────────────────────────────────────
export const aiAgentApi = {
  getConfig: () => api.get<AIAgentConfig>('/ai/config'),

  updateConfig: (config: Partial<AIAgentConfig>) =>
    api.put<AIAgentConfig>('/ai/config', config),

  start: () => api.post<{ status: string }>('/ai/start'),

  stop: () => api.post<{ status: string }>('/ai/stop'),

  status: () => api.get<{ isActive: boolean; mode: string; uptime: number }>('/ai/status'),

  signals: (params?: { page?: number; limit?: number; status?: string }) =>
    api.get<AISignal[]>('/ai/signals', { params }),

  executeSignal: (signalId: string) =>
    api.post<Order>(`/ai/signals/${signalId}/execute`),

  rejectSignal: (signalId: string) =>
    api.post<void>(`/ai/signals/${signalId}/reject`),

  preMarketBriefing: () =>
    api.get<PreMarketBriefing>('/ai/briefing/pre-market'),

  postTradeBriefing: () =>
    api.get<PostTradeBriefing>('/ai/briefing/post-trade'),

  strategies: () =>
    api.get<{ id: string; name: string; description: string; isActive: boolean }[]>('/ai/strategies'),

  capitalRules: () =>
    api.get<{ id: string; name: string; status: 'green' | 'amber' | 'red'; detail: string }[]>('/ai/capital-rules'),

  getMarketScan: () =>
    api.get<{ scanning: boolean; result: any }>('/ai/market-scan'),

  startMarketScan: () =>
    api.post<{ scanning: boolean; message: string }>('/ai/market-scan/start'),

  stopMarketScan: () =>
    api.post<{ scanning: boolean; message: string }>('/ai/market-scan/stop'),
};

// ─── Intelligence ─────────────────────────────────────────────────
export const intelligenceApi = {
  fiiDii: () => api.get('/intelligence/fii-dii'),
  fiiDiiTrend: (days = 30) => api.get('/intelligence/fii-dii/trend', { params: { days } }),

  pcr: (symbol: string) => api.get(`/intelligence/options/pcr/${encodeURIComponent(symbol)}`),
  oiHeatmap: (symbol: string) => api.get(`/intelligence/options/oi-heatmap/${encodeURIComponent(symbol)}`),
  maxPain: (symbol: string) => api.get(`/intelligence/options/max-pain/${encodeURIComponent(symbol)}`),
  ivPercentile: (symbol: string) => api.get(`/intelligence/options/iv-percentile/${encodeURIComponent(symbol)}`),

  sectorPerformance: () => api.get('/intelligence/sectors/performance'),
  sectorHeatmap: () => api.get('/intelligence/sectors/heatmap'),
  sectorRRG: () => api.get('/intelligence/sectors/rrg'),

  globalIndices: () => api.get('/intelligence/global/indices'),
  fxRates: () => api.get('/intelligence/global/fx'),
  commodities: () => api.get('/intelligence/global/commodities'),

  earningsCalendar: () => api.get('/intelligence/earnings/calendar'),
  macroEvents: () => api.get('/intelligence/earnings/macro-events'),

  blockDeals: () => api.get('/intelligence/block-deals'),
  insiderTransactions: () => api.get('/intelligence/insider-transactions'),
};

// ─── Backtest ─────────────────────────────────────────────────────
export const backtestApi = {
  run: (request: BacktestRequest) =>
    api.post<BacktestResult>('/backtest/run', {
      strategyId: request.strategyId,
      symbol: request.symbol,
      startDate: request.startDate,
      endDate: request.endDate,
      initialCapital: request.initialCapital,
      parameters: request.parameters,
    }),

  results: () =>
    api.get<BacktestResult[]>('/backtest/results'),

  result: (id: string) =>
    api.get<BacktestResult>(`/backtest/results/${id}`),
};

// ─── Breeze API Credentials ──────────────────────────────────────
export const breezeApi = {
  status: () =>
    api.get<{
      configured: boolean; has_totp: boolean; has_session: boolean;
      has_login_credentials: boolean; can_auto_login: boolean;
      session_expiry: string | null; last_auto_login_at: string | null;
      auto_login_error: string | null; updated_at: string | null;
    }>('/auth/breeze-credentials/status')
      .then(res => ({
        ...res,
        data: {
          isConnected: res.data.configured,
          hasSession: res.data.has_session,
          hasLoginCredentials: res.data.has_login_credentials,
          canAutoLogin: res.data.can_auto_login,
          sessionExpiry: res.data.session_expiry,
          lastConnected: res.data.updated_at,
          lastAutoLoginAt: res.data.last_auto_login_at,
          autoLoginError: res.data.auto_login_error,
        } as BreezeCredentialStatus,
      })),

  connect: (
    apiKey: string, secretKey: string,
    totpSecret?: string, sessionToken?: string,
    loginId?: string, loginPassword?: string,
  ) =>
    api.post<{ configured: boolean; has_totp: boolean; has_session: boolean; has_login_credentials: boolean; updated_at: string | null }>('/auth/breeze-credentials', {
      api_key: apiKey,
      secret_key: secretKey,
      ...(totpSecret ? { totp_secret: totpSecret } : {}),
      ...(sessionToken ? { session_token: sessionToken } : {}),
      ...(loginId ? { login_id: loginId } : {}),
      ...(loginPassword ? { login_password: loginPassword } : {}),
    })
      .then(res => ({
        ...res,
        data: {
          isConnected: res.data.configured,
          hasSession: res.data.has_session,
          hasLoginCredentials: res.data.has_login_credentials,
          lastConnected: res.data.updated_at,
        } as BreezeCredentialStatus,
      })),

  saveSession: (sessionToken: string) =>
    api.post<{ success: boolean }>('/auth/breeze-session', { session_token: sessionToken }),

  autoSession: () =>
    api.post<{ success: boolean; sessionExpiry: string; method: string }>('/auth/breeze-session/auto', {}),

  loginUrl: () =>
    api.get<{ login_url: string; callback_url: string }>('/auth/breeze-session/login-url'),

  disconnect: () => api.post<void>('/breeze/disconnect'),
};

// ─── Bots ─────────────────────────────────────────────────────────
export const botsApi = {
  list: () => api.get('/bots/'),
  create: (data: { name: string; role: string; avatarEmoji: string; description: string; maxCapital: number; assignedSymbols?: string; assignedStrategy?: string }) =>
    api.post('/bots/', data),
  get: (id: string) => api.get(`/bots/${id}`),
  update: (id: string, data: Record<string, unknown>) =>
    api.put(`/bots/${id}`, data),
  delete: (id: string) => api.delete(`/bots/${id}`),
  start: (id: string) => api.post(`/bots/${id}/start`),
  stop: (id: string) => api.post(`/bots/${id}/stop`),
  assignTask: (botId: string, data: { taskType: string; description: string; parameters?: Record<string, unknown> }) => api.post(`/bots/${botId}/tasks`, data),
  listTasks: (botId: string) => api.get(`/bots/${botId}/tasks`),
  sendMessage: (botId: string, data: { content: string; toBotId?: string; messageType?: string }) => api.post(`/bots/${botId}/messages`, data),
  listMessages: (botId: string) => api.get(`/bots/${botId}/messages`),
  allMessages: () => api.get('/bots/messages/all'),
};

export default api;
