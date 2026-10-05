import { describe, it, expect, vi, beforeEach } from 'vitest';

const list = vi.fn();
const summary = vi.fn();
vi.mock('../services/api', () => ({
  default: { get: vi.fn(), post: vi.fn(), interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } } },
  authApi: { login: vi.fn(), register: vi.fn(), me: vi.fn() },
  portfolioApi: { list: (...a: unknown[]) => list(...a), summary: (...a: unknown[]) => summary(...a) },
  tradingApi: { positions: vi.fn().mockResolvedValue({ data: [] }) },
  aiAgentApi: {}, botsApi: {}, guardianApi: {},
}));

import { useAuthStore } from '../stores/auth';
import { usePortfolioStore } from '../stores/portfolio';
import { installAccountStateReset } from '../lib/session-state';

const admin = { id: 'pf-admin', name: 'Default', initialCapital: 1_000_000, currentNav: 1_048_815 };
const other = { id: 'pf-other', name: 'Default', initialCapital: 10_000_000, currentNav: 10_000_000 };

describe('signing in as someone else', () => {
  beforeEach(() => {
    list.mockReset(); summary.mockReset();
    usePortfolioStore.setState(usePortfolioStore.getInitialState(), true);
    useAuthStore.setState({ token: 'token-admin', isAuthenticated: true });
    installAccountStateReset();
  });

  it('forgets the previous account\u2019s portfolio the moment the session changes', async () => {
    list.mockResolvedValue({ data: [admin] });
    summary.mockResolvedValue({ data: { totalNav: 1_048_815, capital: 1_000_000 } });
    await usePortfolioStore.getState().fetchPortfolios();
    expect(usePortfolioStore.getState().summary?.totalNav).toBe(1_048_815);

    useAuthStore.setState({ token: null, isAuthenticated: false });            // sign out
    expect(usePortfolioStore.getState().summary).toBeNull();
    expect(usePortfolioStore.getState().activePortfolio).toBeNull();

    useAuthStore.setState({ token: 'token-other', isAuthenticated: true });    // someone else signs in
    list.mockResolvedValue({ data: [other] });
    summary.mockResolvedValue({ data: { totalNav: 10_000_000, capital: 10_000_000 } });
    await usePortfolioStore.getState().fetchPortfolios();
    expect(usePortfolioStore.getState().activePortfolio?.id).toBe('pf-other');
    expect(usePortfolioStore.getState().summary?.totalNav).toBe(10_000_000);
    expect(summary).toHaveBeenLastCalledWith('pf-other');
  });

  it('never keeps a selected portfolio that is not in the account\u2019s own list', async () => {
    // Even without the reset: a leftover selection must not survive a new list.
    usePortfolioStore.setState({ activePortfolio: admin as never, summary: { totalNav: 1_048_815 } as never, _lastFetchedAt: 0 } as never);
    list.mockResolvedValue({ data: [other] });
    summary.mockResolvedValue({ data: { totalNav: 10_000_000, capital: 10_000_000 } });
    await usePortfolioStore.getState().fetchPortfolios();
    expect(usePortfolioStore.getState().activePortfolio?.id).toBe('pf-other');
    expect(usePortfolioStore.getState().summary?.totalNav).toBe(10_000_000);

    list.mockResolvedValue({ data: [] });
    usePortfolioStore.setState({ _lastFetchedAt: 0 } as never);
    await usePortfolioStore.getState().fetchPortfolios();
    expect(usePortfolioStore.getState().summary).toBeNull();
  });
});
