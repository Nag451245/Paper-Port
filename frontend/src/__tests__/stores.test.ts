import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../services/api', () => ({
  default: {
    post: vi.fn(),
    get: vi.fn(),
    interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
  },
  authApi: {
    login: vi.fn().mockResolvedValue({ data: { access_token: 'test-token', user: { id: '1', email: 'test@test.com', full_name: 'Test', is_active: true } } }),
    register: vi.fn(),
    me: vi.fn(),
  },
  portfolioApi: {
    list: vi.fn().mockResolvedValue({ data: [] }),
    create: vi.fn(),
    summary: vi.fn(),
  },
  tradingApi: {
    listOrders: vi.fn().mockResolvedValue({ data: [] }),
    positions: vi.fn().mockResolvedValue({ data: [] }),
    listTrades: vi.fn().mockResolvedValue({ data: [] }),
  },
  botsApi: {
    list: vi.fn().mockResolvedValue({ data: [] }),
    create: vi.fn(),
  },
}));

describe('Auth Store', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('initial state has no user', async () => {
    const { useAuthStore } = await import('../stores/auth');
    const state = useAuthStore.getState();
    expect(state.user).toBeNull();
    expect(state.isAuthenticated).toBe(false);
  });

  it('logout clears state and local storage', async () => {
    const { useAuthStore } = await import('../stores/auth');
    localStorage.setItem('token', 'fake-token');
    useAuthStore.setState({ user: { id: '1' } as any, token: 'fake-token', isAuthenticated: true });

    useAuthStore.getState().logout();
    const state = useAuthStore.getState();

    expect(state.user).toBeNull();
    expect(state.token).toBeNull();
    expect(state.isAuthenticated).toBe(false);
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('loadUser hydrates state when token exists and api me() succeeds', async () => {
    const { useAuthStore } = await import('../stores/auth');
    const { authApi } = await import('../services/api');

    localStorage.setItem('token', 'valid-token');
    // We mocked me() to return something, let's configure it
    (authApi.me as any).mockResolvedValueOnce({ data: { id: '1', email: 'me@test.com' } });

    await useAuthStore.getState().loadUser();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(true);
    expect(state.user?.email).toBe('me@test.com');
  });

  it('loadUser clears state when token exists but api me() fails', async () => {
    const { useAuthStore } = await import('../stores/auth');
    const { authApi } = await import('../services/api');

    localStorage.setItem('token', 'invalid-token');
    (authApi.me as any).mockRejectedValueOnce(new Error('Invalid token'));

    await useAuthStore.getState().loadUser();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
  });
});

describe('Portfolio Store', () => {
  it('initial state has empty portfolios', async () => {
    const { usePortfolioStore } = await import('../stores/portfolio');
    const state = usePortfolioStore.getState();
    expect(state.portfolios).toEqual([]);
  });
});
