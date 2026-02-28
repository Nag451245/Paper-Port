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
  };
}

interface AuthState {
  user: User | null;
  token: string | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  error: string | null;

  login: (email: string, password: string) => Promise<void>;
  register: (data: { fullName: string; email: string; password: string; riskAppetite: string; virtualCapital: number }) => Promise<void>;
  logout: () => void;
  loadUser: () => Promise<void>;
  clearError: () => void;
}

export const useAuthStore = create<AuthState>((set) => ({
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
      const token = res.access_token;
      localStorage.setItem('token', token);
      const user = normalizeUser(res.user as unknown as Record<string, unknown>);
      set({ user, token, isAuthenticated: true, isLoading: false });
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
    set({ isLoading: true });
    try {
      const { data } = await authApi.me();
      const user = normalizeUser(data as unknown as Record<string, unknown>);
      set({ user, isAuthenticated: true, isLoading: false });
    } catch {
      localStorage.removeItem('token');
      set({ user: null, token: null, isAuthenticated: false, isLoading: false });
    }
  },

  clearError: () => set({ error: null }),
}));
