import { create } from 'zustand';
import type { Portfolio, PortfolioSummary } from '@/types';
import { portfolioApi, tradingApi } from '@/services/api';

/* eslint-disable @typescript-eslint/no-explicit-any */

interface PortfolioState {
  portfolios: Portfolio[];
  activePortfolio: Portfolio | null;
  positions: any[];
  orders: any[];
  summary: PortfolioSummary | null;
  isLoading: boolean;

  fetchPortfolios: () => Promise<void>;
  selectPortfolio: (id: string) => Promise<void>;
  refreshActivePortfolio: () => Promise<void>;
  fetchPositions: () => Promise<void>;
  fetchOrders: () => Promise<void>;
  cancelOrder: (id: string) => Promise<void>;
}

export const usePortfolioStore = create<PortfolioState>((set, get) => ({
  portfolios: [],
  activePortfolio: null,
  positions: [],
  orders: [],
  summary: null,
  isLoading: false,

  fetchPortfolios: async () => {
    set({ isLoading: true });
    try {
      const { data } = await portfolioApi.list();
      set({ portfolios: data, isLoading: false });
      const current = get().activePortfolio;
      if (data.length > 0) {
        const targetId = current ? current.id : data[0].id;
        await get().selectPortfolio(targetId);
      }
    } catch {
      set({ isLoading: false });
    }
  },

  selectPortfolio: async (id) => {
    const portfolio = get().portfolios.find((p) => p.id === id);
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
        summary = {
          totalNav: Number(raw.totalNav ?? raw.current_nav ?? fallbackNav),
          dayPnl: Number(raw.dayPnl ?? raw.day_pnl ?? 0),
          dayPnlPercent: Number(raw.dayPnlPercent ?? raw.day_pnl_pct ?? 0),
          totalPnl: Number(raw.totalPnl ?? raw.total_pnl ?? 0),
          totalPnlPercent: Number(raw.totalPnlPercent ?? raw.total_pnl_pct ?? 0),
          investedValue: Number(raw.investedValue ?? raw.invested_value ?? 0),
          currentValue: Number(raw.currentValue ?? raw.totalNav ?? fallbackNav),
          availableMargin: Number(raw.availableMargin ?? raw.available_margin ?? fallbackNav),
          usedMargin: Number(raw.usedMargin ?? raw.used_margin ?? 0),
        };
      }

      const allPositions = (positionsRes.data ?? []) as any[];
      const filtered = allPositions.filter(
        (p: any) => !p.portfolioId || p.portfolioId === id,
      );

      set({
        summary: summary ?? get().summary,
        positions: filtered,
        isLoading: false,
      });
    } catch {
      set({ isLoading: false });
    }
  },

  refreshActivePortfolio: async () => {
    const current = get().activePortfolio;
    if (current) {
      await get().selectPortfolio(current.id);
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
