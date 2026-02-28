import { create } from 'zustand';
import type { MarketQuote, IndexData, FIIDIIData, Watchlist } from '@/types';
import { marketApi, watchlistApi } from '@/services/api';
import { priceFeed } from '@/services/websocket';

interface MarketDataState {
  quotes: Record<string, MarketQuote>;
  indices: IndexData[];
  vix: { value: number; change: number; changePercent: number } | null;
  fiiDii: FIIDIIData | null;
  watchlists: Watchlist[];
  isMarketOpen: boolean;
  isLoading: boolean;

  updateQuote: (quote: MarketQuote) => void;
  fetchIndices: () => Promise<void>;
  fetchVIX: () => Promise<void>;
  fetchFIIDII: () => Promise<void>;
  fetchWatchlists: () => Promise<void>;
  subscribeSymbol: (symbol: string) => void;
  unsubscribeSymbol: (symbol: string) => void;
  checkMarketStatus: () => void;
}

function isMarketHours(exchange?: string): boolean {
  const now = new Date();
  const ist = new Date(now.toLocaleString('en-US', { timeZone: 'Asia/Kolkata' }));
  const day = ist.getDay();
  const hours = ist.getHours();
  const minutes = ist.getMinutes();
  const totalMins = hours * 60 + minutes;

  if (exchange === 'MCX') {
    if (day === 0) return false;
    return totalMins >= 540 && totalMins <= 1410; // 9:00 AM - 11:30 PM (MCX)
  }

  if (exchange === 'CDS') {
    if (day === 0 || day === 6) return false;
    return totalMins >= 540 && totalMins <= 1020; // 9:00 AM - 5:00 PM (CDS)
  }

  // NSE/BSE
  if (day === 0 || day === 6) return false;
  return totalMins >= 555 && totalMins <= 930; // 9:15 AM - 3:30 PM
}

export const useMarketDataStore = create<MarketDataState>((set) => ({
  quotes: {},
  indices: [],
  vix: null,
  fiiDii: null,
  watchlists: [],
  isMarketOpen: isMarketHours(),
  isLoading: false,

  updateQuote: (quote) => {
    set((state) => ({
      quotes: { ...state.quotes, [quote.symbol]: quote },
    }));
  },

  fetchIndices: async () => {
    try {
      const { data } = await marketApi.indices();
      set({ indices: data });
    } catch {
      /* silently fail */
    }
  },

  fetchVIX: async () => {
    try {
      const { data } = await marketApi.vix();
      // Backend returns { value, change, change_pct } — normalize to frontend shape
      const raw = data as any;
      set({
        vix: {
          value: raw.value ?? 0,
          change: raw.change ?? 0,
          changePercent: raw.changePercent ?? raw.change_pct ?? 0,
        },
      });
    } catch {
      /* silently fail */
    }
  },

  fetchFIIDII: async () => {
    try {
      const { data } = await marketApi.fiiDii();
      set({ fiiDii: data });
    } catch {
      /* silently fail */
    }
  },

  fetchWatchlists: async () => {
    try {
      const { data } = await watchlistApi.list();
      set({ watchlists: data });
    } catch {
      /* silently fail */
    }
  },

  subscribeSymbol: (symbol) => {
    priceFeed.subscribe(symbol, (quote) => {
      set((state) => ({
        quotes: { ...state.quotes, [quote.symbol]: quote },
      }));
    });
  },

  unsubscribeSymbol: (symbol) => {
    priceFeed.unsubscribe(symbol);
  },

  checkMarketStatus: () => {
    set({ isMarketOpen: isMarketHours() });
  },
}));
