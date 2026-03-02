import { create } from 'zustand';
import type { AIAgentConfig, AISignal, PreMarketBriefing } from '@/types';
import { aiAgentApi } from '@/services/api';

interface AIAgentState {
  config: AIAgentConfig | null;
  status: { isActive: boolean; mode: string; uptime: number; todaySignals?: number; todayTrades?: number } | null;
  signals: AISignal[];
  briefing: PreMarketBriefing | null;
  strategies: { id: string; name: string; description: string; isActive: boolean }[];
  capitalRules: { id: string; name: string; status: 'green' | 'amber' | 'red'; detail: string }[];
  isLoading: boolean;

  fetchConfig: () => Promise<void>;
  updateConfig: (config: Partial<AIAgentConfig>) => Promise<void>;
  fetchStatus: () => Promise<void>;
  startAgent: () => Promise<void>;
  stopAgent: () => Promise<void>;
  fetchSignals: () => Promise<void>;
  addSignal: (signal: AISignal) => void;
  fetchBriefing: () => Promise<void>;
  fetchStrategies: () => Promise<void>;
  fetchCapitalRules: () => Promise<void>;
}

export const useAIAgentStore = create<AIAgentState>((set) => ({
  config: null,
  status: null,
  signals: [],
  briefing: null,
  strategies: [],
  capitalRules: [],
  isLoading: false,

  fetchConfig: async () => {
    try {
      const { data } = await aiAgentApi.getConfig();
      set({ config: data });
    } catch {
      /* silently fail */
    }
  },

  updateConfig: async (configUpdate) => {
    try {
      const { data } = await aiAgentApi.updateConfig(configUpdate);
      set({ config: data });
    } catch {
      /* silently fail */
    }
  },

  fetchStatus: async () => {
    try {
      const { data } = await aiAgentApi.status();
      const raw = data as any;
      set({
        status: {
          isActive: Boolean(raw.isActive ?? false),
          mode: raw.mode ?? 'ADVISORY',
          uptime: raw.uptime ?? 0,
          todaySignals: raw.todaySignals ?? 0,
          todayTrades: raw.todayTrades ?? 0,
          rustEngine: Boolean(raw.rustEngine ?? false),
        },
      });
    } catch { /* silently fail */ }
  },

  startAgent: async () => {
    set({ isLoading: true });
    try {
      await aiAgentApi.start();
      const { data } = await aiAgentApi.status();
      const raw = data as any;
      set({
        status: {
          isActive: Boolean(raw.isActive ?? false),
          mode: raw.mode ?? 'ADVISORY',
          uptime: raw.uptime ?? 0,
          todaySignals: raw.todaySignals ?? 0,
          todayTrades: raw.todayTrades ?? 0,
        },
        isLoading: false,
      });
    } catch {
      set({ isLoading: false });
    }
  },

  stopAgent: async () => {
    set({ isLoading: true });
    try {
      await aiAgentApi.stop();
      const { data } = await aiAgentApi.status();
      const raw = data as any;
      set({
        status: {
          isActive: Boolean(raw.isActive ?? false),
          mode: raw.mode ?? 'ADVISORY',
          uptime: raw.uptime ?? 0,
          todaySignals: raw.todaySignals ?? 0,
          todayTrades: raw.todayTrades ?? 0,
        },
        isLoading: false,
      });
    } catch {
      set({ isLoading: false });
    }
  },

  fetchSignals: async () => {
    try {
      const { data } = await aiAgentApi.signals({ limit: 50 });
      const raw = Array.isArray(data) ? data : (data as any)?.signals ?? [];
      const signals = raw.map((s: any) => ({
        ...s,
        gateScores: typeof s.gateScores === 'string' ? JSON.parse(s.gateScores) : (s.gateScores ?? {}),
        compositeScore: Number(s.compositeScore ?? 0),
      }));
      set({ signals });
    } catch {
      /* silently fail */
    }
  },

  addSignal: (signal) => {
    set((state) => ({ signals: [signal, ...state.signals].slice(0, 100) }));
  },

  fetchBriefing: async () => {
    try {
      const { data } = await aiAgentApi.preMarketBriefing();
      set({ briefing: data });
    } catch {
      /* silently fail */
    }
  },

  fetchStrategies: async () => {
    try {
      const { data } = await aiAgentApi.strategies();
      set({ strategies: data });
    } catch {
      /* silently fail */
    }
  },

  fetchCapitalRules: async () => {
    try {
      const { data } = await aiAgentApi.capitalRules();
      set({ capitalRules: data });
    } catch {
      /* silently fail */
    }
  },
}));
