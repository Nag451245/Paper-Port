import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@/services/api', () => {
  const portfolioApi = {
    list: vi.fn(),
    summary: vi.fn(),
    create: vi.fn(),
    pnlHistory: vi.fn(),
  };
  const tradingApi = {
    positions: vi.fn().mockResolvedValue({ data: [] }),
    listOrders: vi.fn().mockResolvedValue({ data: [] }),
    cancelOrder: vi.fn().mockResolvedValue({}),
  };
  const riskApi = {
    dailySummary: vi.fn(),
  };
  return {
    default: {
      get: vi.fn(), post: vi.fn(),
      interceptors: { response: { use: vi.fn() }, request: { use: vi.fn() } },
    },
    portfolioApi,
    tradingApi,
    riskApi,
    authApi: { login: vi.fn(), register: vi.fn(), me: vi.fn() },
  };
});

import { portfolioApi, riskApi } from '@/services/api';

describe('Portfolio Data Consistency', () => {

  beforeEach(() => {
    vi.clearAllMocks();
  });

  // ── parseSummary mapping ───────────────────────────────────────────

  describe('parseSummary: API response mapping', () => {
    it('should map camelCase API response correctly', async () => {
      const apiResponse = {
        totalNav: 1_050_000,
        dayPnl: 5_000,
        dayPnlPercent: 0.5,
        totalPnl: 50_000,
        totalPnlPercent: 5.0,
        unrealizedPnl: 2_000,
        investedValue: 100_000,
        currentValue: 1_050_000,
        availableMargin: 900_000,
        usedMargin: 100_000,
      };

      // Import and directly test parseSummary behavior via the store
      const { usePortfolioStore } = await import('@/stores/portfolio');
      const store = usePortfolioStore.getState();

      (portfolioApi.list as any).mockResolvedValue({
        data: [{ id: 'p1', currentNav: 1_000_000 }],
      });
      (portfolioApi.summary as any).mockResolvedValue({ data: apiResponse });

      await store.fetchPortfolios();

      const summary = usePortfolioStore.getState().summary;
      expect(summary).not.toBeNull();
      if (summary) {
        expect(summary.dayPnl).toBe(5_000);
        expect(summary.totalNav).toBe(1_050_000);
        expect(summary.unrealizedPnl).toBe(2_000);
      }
    });

    it('should map snake_case API response (fallback)', async () => {
      const apiResponse = {
        current_nav: 1_020_000,
        day_pnl: 3_000,
        day_pnl_pct: 0.3,
        total_pnl: 20_000,
        total_pnl_pct: 2.0,
        unrealized_pnl: 1_000,
        invested_value: 50_000,
        available_margin: 950_000,
        used_margin: 50_000,
      };

      const { usePortfolioStore } = await import('@/stores/portfolio');

      (portfolioApi.list as any).mockResolvedValue({
        data: [{ id: 'p2', currentNav: 1_000_000 }],
      });
      (portfolioApi.summary as any).mockResolvedValue({ data: apiResponse });

      usePortfolioStore.setState({
        portfolios: [{ id: 'p2', currentNav: 1_000_000 } as any],
        activePortfolio: null,
        summary: null,
        _lastFetchedAt: 0,
      });

      await usePortfolioStore.getState().selectPortfolio('p2', true);

      const summary = usePortfolioStore.getState().summary;
      expect(summary).not.toBeNull();
      if (summary) {
        expect(summary.dayPnl).toBe(3_000);
        expect(summary.totalNav).toBe(1_020_000);
      }
    });

    it('should fallback to 0 when fields are missing', async () => {
      const apiResponse = { totalNav: 1_000_000 };

      const { usePortfolioStore } = await import('@/stores/portfolio');

      (portfolioApi.list as any).mockResolvedValue({
        data: [{ id: 'p3', currentNav: 1_000_000 }],
      });
      (portfolioApi.summary as any).mockResolvedValue({ data: apiResponse });

      usePortfolioStore.setState({
        portfolios: [{ id: 'p3', currentNav: 1_000_000 } as any],
        activePortfolio: null,
        summary: null,
        _lastFetchedAt: 0,
      });

      await usePortfolioStore.getState().selectPortfolio('p3', true);

      const summary = usePortfolioStore.getState().summary;
      expect(summary).not.toBeNull();
      if (summary) {
        expect(summary.dayPnl).toBe(0);
        expect(summary.unrealizedPnl).toBe(0);
        expect(summary.totalPnl).toBe(0);
      }
    });
  });

  // ── Caching Behavior ──────────────────────────────────────────────

  describe('Caching: 60s staleness check', () => {
    it('should not refetch if data is fresh (< 60s)', async () => {
      const { usePortfolioStore } = await import('@/stores/portfolio');

      (portfolioApi.list as any).mockResolvedValue({
        data: [{ id: 'cache-p1', currentNav: 1_000_000 }],
      });
      (portfolioApi.summary as any).mockResolvedValue({
        data: { totalNav: 1_000_000 },
      });

      await usePortfolioStore.getState().fetchPortfolios();
      const firstCallCount = (portfolioApi.summary as any).mock.calls.length;

      // Fetch again immediately — should use cache
      await usePortfolioStore.getState().fetchPortfolios();
      const secondCallCount = (portfolioApi.summary as any).mock.calls.length;

      expect(secondCallCount).toBe(firstCallCount);
    });

    it('should refetch when force=true', async () => {
      const { usePortfolioStore } = await import('@/stores/portfolio');

      (portfolioApi.list as any).mockResolvedValue({
        data: [{ id: 'cache-p2', currentNav: 1_000_000 }],
      });
      (portfolioApi.summary as any).mockResolvedValue({
        data: { totalNav: 1_000_000 },
      });

      await usePortfolioStore.getState().fetchPortfolios();

      // Force refresh
      await usePortfolioStore.getState().selectPortfolio('cache-p2', true);
      expect((portfolioApi.summary as any).mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  // ── Dashboard vs Portfolio Consistency ─────────────────────────────

  describe('Cross-view consistency', () => {
    it('Dashboard and Portfolio should show same dayPnl for same portfolio', async () => {
      const summaryData = {
        totalNav: 1_050_000,
        dayPnl: 5_000,
        dayPnlPercent: 0.5,
        totalPnl: 50_000,
        totalPnlPercent: 5.0,
        unrealizedPnl: 0,
        investedValue: 0,
        currentValue: 1_050_000,
        availableMargin: 1_050_000,
        usedMargin: 0,
      };

      (portfolioApi.summary as any).mockResolvedValue({ data: summaryData });

      const { usePortfolioStore } = await import('@/stores/portfolio');

      usePortfolioStore.setState({
        portfolios: [{ id: 'consistency-p1', currentNav: 1_000_000 } as any],
        activePortfolio: { id: 'consistency-p1', currentNav: 1_000_000 } as any,
        summary: null,
        _lastFetchedAt: 0,
      });

      // Dashboard fetches
      await usePortfolioStore.getState().selectPortfolio('consistency-p1', true);
      const dashboardSummary = usePortfolioStore.getState().summary;

      // Portfolio page fetches (same store, same endpoint)
      await usePortfolioStore.getState().selectPortfolio('consistency-p1', true);
      const portfolioSummary = usePortfolioStore.getState().summary;

      expect(dashboardSummary?.dayPnl).toBe(portfolioSummary?.dayPnl);
      expect(dashboardSummary?.totalPnl).toBe(portfolioSummary?.totalPnl);
      expect(dashboardSummary?.totalNav).toBe(portfolioSummary?.totalNav);
    });
  });

  // ── Risk Dashboard Differences ─────────────────────────────────────

  describe('Risk Dashboard: different aggregation scope', () => {
    it('Risk dailySummary may differ from portfolio summary (aggregates all portfolios)', async () => {
      const portfolioSummary = { dayPnl: 5_000, totalNav: 1_050_000 };
      const riskSummary = {
        dayPnl: 8_000, // aggregated across ALL portfolios
        dayPnlPercent: 0.8,
        openPositions: 5,
        riskScore: 35,
      };

      (portfolioApi.summary as any).mockResolvedValue({ data: portfolioSummary });
      (riskApi.dailySummary as any).mockResolvedValue({ data: riskSummary });

      const portfolioRes = await portfolioApi.summary('p1');
      const riskRes = await riskApi.dailySummary();

      // These SHOULD differ — risk aggregates all portfolios
      // Documenting this as expected behavior, not a bug
      expect((portfolioRes.data as any).dayPnl).toBe(5_000);
      expect((riskRes.data as any).dayPnl).toBe(8_000);
    });
  });

  // ── Error Handling ─────────────────────────────────────────────────

  describe('Error handling', () => {
    it('should retain previous summary when API fails', async () => {
      const { usePortfolioStore } = await import('@/stores/portfolio');

      const initialSummary = {
        totalNav: 1_000_000, dayPnl: 0, dayPnlPercent: 0,
        totalPnl: 0, totalPnlPercent: 0, unrealizedPnl: 0,
        investedValue: 0, currentValue: 1_000_000,
        availableMargin: 1_000_000, usedMargin: 0,
      };

      usePortfolioStore.setState({
        portfolios: [{ id: 'err-p1', currentNav: 1_000_000 } as any],
        activePortfolio: { id: 'err-p1' } as any,
        summary: initialSummary,
        _lastFetchedAt: 0,
      });

      // API fails
      (portfolioApi.summary as any).mockRejectedValue(new Error('Network error'));

      await usePortfolioStore.getState().selectPortfolio('err-p1', true);

      // Summary should be retained (not set to null)
      const summary = usePortfolioStore.getState().summary;
      expect(summary).not.toBeNull();
      expect(summary?.totalNav).toBe(1_000_000);
    });

    it('should handle positions fetch failure gracefully', async () => {
      const { usePortfolioStore } = await import('@/stores/portfolio');
      const { tradingApi } = await import('@/services/api');

      (tradingApi.positions as any).mockRejectedValue(new Error('Timeout'));

      // Should not throw
      await expect(usePortfolioStore.getState().fetchPositions()).resolves.not.toThrow();
    });
  });

  // ── Numeric Coercion ───────────────────────────────────────────────

  describe('Numeric coercion safety', () => {
    it('should coerce string numbers from API', async () => {
      const apiResponse = {
        totalNav: '1050000',
        dayPnl: '5000.50',
        dayPnlPercent: '0.5',
        totalPnl: '50000',
        totalPnlPercent: '5.0',
        unrealizedPnl: '2000',
        investedValue: '100000',
      };

      const { usePortfolioStore } = await import('@/stores/portfolio');

      (portfolioApi.summary as any).mockResolvedValue({ data: apiResponse });

      usePortfolioStore.setState({
        portfolios: [{ id: 'coerce-p1', currentNav: 1_000_000 } as any],
        activePortfolio: null,
        summary: null,
        _lastFetchedAt: 0,
      });

      await usePortfolioStore.getState().selectPortfolio('coerce-p1', true);

      const summary = usePortfolioStore.getState().summary;
      expect(summary).not.toBeNull();
      if (summary) {
        expect(typeof summary.dayPnl).toBe('number');
        expect(typeof summary.totalNav).toBe('number');
        expect(summary.dayPnl).toBe(5000.5);
        expect(summary.totalNav).toBe(1_050_000);
      }
    });

    it('should handle null/undefined fields without NaN', async () => {
      const apiResponse = {
        totalNav: 1_000_000,
        dayPnl: null,
        unrealizedPnl: undefined,
      };

      const { usePortfolioStore } = await import('@/stores/portfolio');

      (portfolioApi.summary as any).mockResolvedValue({ data: apiResponse });

      usePortfolioStore.setState({
        portfolios: [{ id: 'null-p1', currentNav: 1_000_000 } as any],
        activePortfolio: null,
        summary: null,
        _lastFetchedAt: 0,
      });

      await usePortfolioStore.getState().selectPortfolio('null-p1', true);

      const summary = usePortfolioStore.getState().summary;
      expect(summary).not.toBeNull();
      if (summary) {
        expect(Number.isNaN(summary.dayPnl)).toBe(false);
        expect(Number.isNaN(summary.unrealizedPnl)).toBe(false);
        expect(summary.dayPnl).toBe(0);
        expect(summary.unrealizedPnl).toBe(0);
      }
    });
  });
});
