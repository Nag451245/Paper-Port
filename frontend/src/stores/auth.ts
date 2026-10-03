import { create } from 'zustand';
import type { User } from '@/types';
import { authApi } from '@/services/api';

function normalizeUser(raw: Record<string, unknown>): User {
  return {
    id: String(raw.id ?? ''),
    email: String(raw.email ?? ''),
    fullName: String(raw.fullName ?? raw.full_name ?? ''),
    avatarUrl: raw.avatarUrl as string | undefined,
    riskAppetite: (raw.riskAppetite ?? raw.risk_appetite ?? 'moderate') as User['riskAppetite'],
    virtualCapital: Number(raw.virtualCapital ?? raw.virtual_capital ?? 0),
    isOnboarded: Boolean(raw.isOnboarded ?? raw.is_onboarded ?? true),
    createdAt: String(raw.createdAt ?? raw.created_at ?? ''),
    role: raw.role ? String(raw.role) : undefined,
  };
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  /** Resolves with `pending` when the account waits for the administrator's approval (no sign-in yet). */
  register: (data: { fullName: string; email: string; password: string; riskAppetite: string; virtualCapital: number }) => Promise<{ pending: boolean; message?: string }>;
  logout: () => void;
  loadUser: () => Promise<void>;
  clearError: () => void;
}

/** Quiet retries of the session check after a network or server hiccup (5 s apart, ~1 minute). */
let sessionRetries = 0;

export const useAuthStore = create<AuthState>((set, get) => ({
  user: null,
  token: localStorage.getItem('token'),
  isAuthenticated: !!localStorage.getItem('token'),
  isLoading: false,
  error: null,

  login: async (email, password) => {
    set({ isLoading: true, error: null });
    try {
      const { data } = await authApi.login(email, password);
      const token = data.access_token;
      localStorage.setItem('token', token);
      const user = normalizeUser(data.user as unknown as Record<string, unknown>);
      set({ user, token, isAuthenticated: true, isLoading: false });
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string; detail?: string; message?: string } } })?.response?.data;
      const message = errData?.error || errData?.detail || errData?.message || 'Login failed';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  register: async (data) => {
    set({ isLoading: true, error: null });
    try {
      const { data: res } = await authApi.register(data);
      if ('pending' in res && res.pending) {
        set({ isLoading: false });
        return { pending: true, message: res.message };
      }
      const token = res.access_token;
      localStorage.setItem('token', token);
      const user = normalizeUser(res.user as unknown as Record<string, unknown>);
      set({ user, token, isAuthenticated: true, isLoading: false });
      return { pending: false };
    } catch (err: unknown) {
      const errData = (err as { response?: { data?: { error?: string; detail?: string; message?: string } } })?.response?.data;
      const message = errData?.error || errData?.detail || errData?.message || 'Registration failed';
      set({ error: message, isLoading: false });
      throw err;
    }
  },

  logout: () => {
    localStorage.removeItem('token');
    set({ user: null, token: null, isAuthenticated: false });
  },

  loadUser: async () => {
    const token = localStorage.getItem('token');
    if (!token) {
      set({ isAuthenticated: false, isLoading: false });
      return;
    }
    // Only the first check shows the full-page loader; quiet retries keep the screen as it is.
    if (!get().isAuthenticated || sessionRetries === 0) set({ isLoading: true });
    try {
      const { data } = await authApi.me();
      const user = normalizeUser(data as unknown as Record<string, unknown>);
      sessionRetries = 0;
      set({ user, isAuthenticated: true, isLoading: false });
    } catch (err) {
      const status = (err as { response?: { status?: number } })?.response?.status;
      if (status === 401) {
        // The server rejected the session: sign out.
        localStorage.removeItem('token');
        set({ user: null, token: null, isAuthenticated: false, isLoading: false });
        return;
      }
      // Network drop, timeout, or the server restarting: keep the session and
      // try again shortly, rather than throwing the user back to the login page.
      set({ isAuthenticated: true, isLoading: false });
      if (++sessionRetries <= 12) setTimeout(() => { void get().loadUser(); }, 5000);
    }
  },

  clearError: () => set({ error: null }),
}));
