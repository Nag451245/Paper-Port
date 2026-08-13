import { create } from 'zustand';
import type { Portfolio, PortfolioSummary } from '@/types';
import { portfolioApi, tradingApi } from '@/services/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

const STALE_MS = 60_000;

interface PortfolioState {
  portfolios: Portfolio[];
  activePortfolio: Portfolio | null;
  positions: any[];
  orders: any[];
  summary: PortfolioSummary | null;
  isLoading: boolean;
  _lastFetchedAt: number;

  fetchPortfolios: () => Promise<void>;
  selectPortfolio: (id: string, force?: boolean) => Promise<void>;
  refreshActivePortfolio: () => Promise<void>;
  fetchPositions: () => Promise<void>;
  fetchOrders: () => Promise<void>;
  cancelOrder: (id: string) => Promise<void>;
}

function parseSummary(raw: any, fallbackNav: number): PortfolioSummary {
  return {
    totalNav: Number(raw.totalNav ?? raw.current_nav ?? fallbackNav),
    dayPnl: Number(raw.dayPnl ?? raw.day_pnl ?? 0),
    dayPnlPercent: Number(raw.dayPnlPercent ?? raw.day_pnl_pct ?? 0),
    totalPnl: Number(raw.totalPnl ?? raw.total_pnl ?? 0),
    totalPnlPercent: Number(raw.totalPnlPercent ?? raw.total_pnl_pct ?? 0),
    unrealizedPnl: Number(raw.unrealizedPnl ?? raw.unrealized_pnl ?? 0),
    investedValue: Number(raw.investedValue ?? raw.invested_value ?? 0),
    currentValue: Number(raw.currentValue ?? raw.totalNav ?? fallbackNav),
    availableMargin: Number(raw.availableMargin ?? raw.available_margin ?? fallbackNav),
    usedMargin: Number(raw.usedMargin ?? raw.used_margin ?? 0),
  };
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  portfolios: [],
  activePortfolio: null,
  positions: [],
  orders: [],
  summary: null,
  isLoading: false,
  _lastFetchedAt: 0,

  fetchPortfolios: async () => {
    const state = get();
    const isFresh = state.summary && (Date.now() - state._lastFetchedAt < STALE_MS);
    if (isFresh && state.activePortfolio) {
      return;
    }

    set({ isLoading: true });
    try {
      const { data } = await portfolioApi.list();
      set({ portfolios: data });
      const current = state.activePortfolio;
      if (data.length > 0) {
        const targetId = current ? current.id : data[0].id;
        await get().selectPortfolio(targetId, true);
      } else {
        set({ isLoading: false });
      }
    } catch {
      set({ isLoading: false });
    }
  },

  selectPortfolio: async (id, force = false) => {
    const state = get();
    const isFresh = state.summary
      && state.activePortfolio?.id === id
      && (Date.now() - state._lastFetchedAt < STALE_MS);

    if (!force && isFresh) {
      return;
    }

    const portfolio = state.portfolios.find((p) => p.id === id);
    if (!portfolio) return;

    set({ activePortfolio: portfolio, isLoading: true });
    try {
      const [summaryRes, positionsRes] = await Promise.all([
        portfolioApi.summary(id).catch(() => ({ data: null })),
        tradingApi.positions().catch(() => ({ data: [] })),
      ]);
      const raw = summaryRes.data as any;

      let summary: PortfolioSummary | null = null;
      if (raw && (raw.totalNav !== undefined || raw.current_nav !== undefined)) {
        const p = portfolio as any;
        const fallbackNav = Number(p.currentNav ?? p.current_nav ?? p.nav ?? p.initialCapital ?? p.capital ?? 0);
        summary = parseSummary(raw, fallbackNav);
      }

      const allPositions = (positionsRes.data ?? []) as any[];
      const filtered = allPositions.filter(
        (p: any) => !p.portfolioId || p.portfolioId === id,
      );

      set({
        summary: summary ?? get().summary,
        positions: filtered,
        isLoading: false,
        _lastFetchedAt: Date.now(),
      });
    } catch {
      set({ isLoading: false });
    }
  },

  refreshActivePortfolio: async () => {
    const current = get().activePortfolio;
    if (current) {
      await get().selectPortfolio(current.id, true);
    }
  },

  fetchPositions: async () => {
    try {
      const { data } = await tradingApi.positions();
      const allPositions = (data ?? []) as any[];
      const activeId = get().activePortfolio?.id;
      const filtered = activeId
        ? allPositions.filter((p: any) => !p.portfolioId || p.portfolioId === activeId)
        : allPositions;
      set({ positions: filtered });
    } catch (err) { console.warn('[Portfolio] Positions fetch failed:', (err as Error)?.message); }
  },

  fetchOrders: async () => {
    try {
      const { data } = await tradingApi.listOrders();
      const orders = Array.isArray(data) ? data : (data as any)?.orders ?? [];
      set({ orders });
    } catch (err) { console.warn('[Portfolio] Orders fetch failed:', (err as Error)?.message); }
  },

  cancelOrder: async (id) => {
    await tradingApi.cancelOrder(id);
    set((state) => ({
      orders: state.orders.map((o: any) =>
        o.id === id ? { ...o, status: 'CANCELLED' } : o
      ),
    }));
  },
}));
