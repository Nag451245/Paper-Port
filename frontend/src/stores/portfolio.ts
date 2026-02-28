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
      if (data.length > 0 && !get().activePortfolio) {
        await get().selectPortfolio(data[0].id);
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
      const summary: PortfolioSummary | null = raw
        ? {
            totalNav: Number(raw.current_nav ?? raw.totalNav ?? 0),
            dayPnl: Number(raw.day_pnl ?? raw.dayPnl ?? 0),
            dayPnlPercent: Number(raw.day_pnl_pct ?? raw.dayPnlPercent ?? 0),
            totalPnl: Number(raw.total_pnl ?? raw.totalPnl ?? 0),
            totalPnlPercent: Number(raw.total_pnl_pct ?? raw.totalPnlPercent ?? 0),
            investedValue: Number(raw.initial_capital ?? raw.investedValue ?? 0),
            currentValue: Number(raw.current_nav ?? raw.currentValue ?? 0),
            availableMargin: Number(raw.availableMargin ?? 0),
            usedMargin: Number(raw.usedMargin ?? 0),
          }
        : null;
      set({
        summary,
        positions: (positionsRes.data ?? []) as any[],
        isLoading: false,
      });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchPositions: async () => {
    try {
      const { data } = await tradingApi.positions();
      set({ positions: (data ?? []) as any[] });
    } catch { /* silent */ }
  },

  fetchOrders: async () => {
    try {
      const { data } = await tradingApi.listOrders();
      const orders = Array.isArray(data) ? data : (data as any)?.orders ?? [];
      set({ orders });
    } catch { /* silent */ }
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
