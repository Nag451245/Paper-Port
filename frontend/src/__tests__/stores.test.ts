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

  it('loadUser signs out when the server rejects the session (401)', async () => {
    const { useAuthStore } = await import('../stores/auth');
    const { authApi } = await import('../services/api');

    localStorage.setItem('token', 'invalid-token');
    (authApi.me as any).mockRejectedValueOnce(Object.assign(new Error('Unauthorized'), { response: { status: 401 } }));

    await useAuthStore.getState().loadUser();

    const state = useAuthStore.getState();
    expect(state.isAuthenticated).toBe(false);
    expect(state.user).toBeNull();
    expect(localStorage.getItem('token')).toBeNull();
  });

  it('loadUser keeps the session through a network drop or server restart', async () => {
    vi.useFakeTimers();
    try {
      const { useAuthStore } = await import('../stores/auth');
      const { authApi } = await import('../services/api');

      localStorage.setItem('token', 'good-token');
      (authApi.me as any).mockRejectedValueOnce(new Error('Network Error'));

      await useAuthStore.getState().loadUser();

      expect(useAuthStore.getState().isAuthenticated).toBe(true);
      expect(useAuthStore.getState().isLoading).toBe(false);
      expect(localStorage.getItem('token')).toBe('good-token');
      // ...and quietly retries a few seconds later.
      (authApi.me as any).mockResolvedValueOnce({ data: { id: 'u1', email: 'a@b.c', fullName: 'A' } });
      await vi.advanceTimersByTimeAsync(5000);
      expect(useAuthStore.getState().user?.id).toBe('u1');
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('Portfolio Store', () => {
  it('initial state has empty portfolios', async () => {
    const { usePortfolioStore } = await import('../stores/portfolio');
    const state = usePortfolioStore.getState();
    expect(state.portfolios).toEqual([]);
  });
});
