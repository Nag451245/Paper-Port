import { useEffect, lazy, Suspense } from 'react';
import { Routes, Route, Navigate } from 'react-router-dom';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';

import { useAuthStore } from '@/stores/auth';
import AppShell from '@/components/layout/AppShell';
import { ErrorBoundary } from '@/components/ErrorBoundary';
import { liveSocket } from '@/services/websocket';

import Login from '@/pages/Login';
import Register from '@/pages/Register';

const Dashboard = lazy(() => import('@/pages/Dashboard'));
const TradingTerminal = lazy(() => import('@/pages/TradingTerminal'));
const AIAgentPanel = lazy(() => import('@/pages/AIAgentPanel'));
const PortfolioPage = lazy(() => import('@/pages/Portfolio'));
const Settings = lazy(() => import('@/pages/Settings'));
const BotManagement = lazy(() => import('@/pages/BotManagement'));
const Backtest = lazy(() => import('@/pages/Backtest'));
const TradeJournal = lazy(() => import('@/pages/TradeJournal'));
const IntelligenceDashboard = lazy(() => import('@/pages/IntelligenceDashboard'));
const StrategyBuilder = lazy(() => import('@/pages/StrategyBuilder'));
const OptionChain = lazy(() => import('@/pages/OptionChain'));
const FnOAnalytics = lazy(() => import('@/pages/FnOAnalytics'));
const LearningIntelligence = lazy(() => import('@/pages/LearningIntelligence'));
const EdgeLab = lazy(() => import('@/pages/EdgeLab'));
const CommunityTab = lazy(() => import('@/pages/CommunityTab'));
const Onboarding = lazy(() => import('@/pages/Onboarding'));

const queryClient = new QueryClient({
  defaultOptions: {
    queries: { retry: 1, refetchOnWindowFocus: false },
  },
});

function PageLoader() {
  return (
    <div className="flex items-center justify-center h-64">
      <div className="flex flex-col items-center gap-3">
        <div className="w-8 h-8 border-2 border-teal-500 border-t-transparent rounded-full animate-spin" />
        <p className="text-xs text-slate-400">Loading...</p>
      </div>
    </div>
  );
}

function ProtectedRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated, isLoading, user, loadUser } = useAuthStore();

  useEffect(() => {
    loadUser();
  }, []);

  useEffect(() => {
    if (isAuthenticated) {
      try { liveSocket.connect(); } catch { /* WS optional */ }
      return () => { try { liveSocket.disconnect(); } catch { /* ignore */ } };
    }
  }, [isAuthenticated]);

  const hasToken = !!localStorage.getItem('token');
  const stillVerifying = hasToken && !user && !isLoading;

  if (isLoading || stillVerifying) {
    return (
      <div className="min-h-screen bg-gradient-to-br from-slate-50 via-white to-teal-50 flex items-center justify-center">
        <div className="flex flex-col items-center gap-3">
          <div className="w-10 h-10 border-3 border-[#4a6b52] border-t-transparent rounded-full animate-spin" />
          <p className="text-sm text-slate-500 font-medium">Loading PaperPort...</p>
        </div>
      </div>
    );
  }

  if (!isAuthenticated) {
    return <Navigate to="/login" replace />;
  }

  return <>{children}</>;
}

function PublicRoute({ children }: { children: React.ReactNode }) {
  const { isAuthenticated } = useAuthStore();
  if (isAuthenticated) return <Navigate to="/dashboard" replace />;
  return <>{children}</>;
}

export default function App() {
  return (
    <ErrorBoundary>
      <QueryClientProvider client={queryClient}>
        <Routes>
          <Route path="/login" element={<PublicRoute><Login /></PublicRoute>} />
          <Route path="/register" element={<PublicRoute><Register /></PublicRoute>} />

          <Route
            path="/onboarding"
            element={
              <ProtectedRoute>
                <Suspense fallback={<PageLoader />}><Onboarding /></Suspense>
              </ProtectedRoute>
            }
          />

          <Route
            element={
              <ProtectedRoute>
                <AppShell />
              </ProtectedRoute>
            }
          >
            <Route path="/dashboard" element={<Suspense fallback={<PageLoader />}><Dashboard /></Suspense>} />
            <Route path="/terminal" element={<Suspense fallback={<PageLoader />}><TradingTerminal /></Suspense>} />
            <Route path="/ai-agent" element={<Suspense fallback={<PageLoader />}><AIAgentPanel /></Suspense>} />
            <Route path="/portfolio" element={<Suspense fallback={<PageLoader />}><PortfolioPage /></Suspense>} />
            <Route path="/bots" element={<Suspense fallback={<PageLoader />}><BotManagement /></Suspense>} />
            <Route path="/settings" element={<Suspense fallback={<PageLoader />}><Settings /></Suspense>} />
            <Route path="/backtest" element={<Suspense fallback={<PageLoader />}><Backtest /></Suspense>} />
            <Route path="/journal" element={<Suspense fallback={<PageLoader />}><TradeJournal /></Suspense>} />
            <Route path="/intelligence" element={<Suspense fallback={<PageLoader />}><IntelligenceDashboard /></Suspense>} />
            <Route path="/strategy-builder" element={<Suspense fallback={<PageLoader />}><StrategyBuilder /></Suspense>} />
            <Route path="/option-chain" element={<Suspense fallback={<PageLoader />}><OptionChain /></Suspense>} />
            <Route path="/fno-analytics" element={<Suspense fallback={<PageLoader />}><FnOAnalytics /></Suspense>} />
            <Route path="/learning" element={<Suspense fallback={<PageLoader />}><LearningIntelligence /></Suspense>} />
            <Route path="/edge-lab" element={<Suspense fallback={<PageLoader />}><EdgeLab /></Suspense>} />
            <Route path="/community" element={<Suspense fallback={<PageLoader />}><CommunityTab /></Suspense>} />
          </Route>

          <Route path="*" element={<Navigate to="/dashboard" replace />} />
        </Routes>
      </QueryClientProvider>
    </ErrorBoundary>
  );
}
