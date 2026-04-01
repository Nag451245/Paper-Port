import { useState, useEffect, lazy, Suspense } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import { useGuardianStore } from '@/stores/guardian';

const GuardianAvatar = lazy(() => import('@/components/guardian/GuardianAvatar'));
const GuardianChatPanel = lazy(() => import('@/components/guardian/GuardianChatPanel'));
const ThoughtBubble = lazy(() => import('@/components/guardian/ThoughtBubble'));

function GuardianPageTracker() {
  const location = useLocation();
  const setPageContext = useGuardianStore((s) => s.setPageContext);
  const page = location.pathname.replace('/', '') || 'dashboard';
  if (useGuardianStore.getState().pageContext !== page) {
    setPageContext(page);
  }
  return null;
}

function GuardianLoadFallback() {
  return null;
}

function GuardianErrorFallback() {
  useEffect(() => {
    console.error('[Guardian] Failed to load Guardian components');
  }, []);
  return null;
}

function SafeGuardianWrapper() {
  const [hasError, setHasError] = useState(false);

  useEffect(() => {}, []);

  if (hasError) {
    return <GuardianErrorFallback />;
  }

  return (
    <Suspense fallback={<GuardianLoadFallback />}>
      <GuardianWrapperInner onError={() => setHasError(true)} />
    </Suspense>
  );
}

function GuardianWrapperInner({ onError }: { onError: () => void }) {
  useEffect(() => {
    window.addEventListener('error', (e) => {
      if (e.message?.includes('Guardian') || e.message?.includes('guardian')) {
        onError();
      }
    });
  }, [onError]);

  return (
    <>
      <GuardianAvatar />
      <GuardianChatPanel />
      <ThoughtBubble />
    </>
  );
}

export default function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

  useEffect(() => {}, []);

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/20 text-slate-900">
      <TopBar />
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={() => setSidebarCollapsed(!sidebarCollapsed)}
      />
      <main
        className={`pt-14 pb-16 md:pb-0 transition-all duration-300 ${
          sidebarCollapsed ? 'md:pl-16' : 'md:pl-56'
        }`}
      >
        <div className="p-4 lg:p-6">
          <Outlet />
        </div>
      </main>

      <GuardianPageTracker />
      <SafeGuardianWrapper />
    </div>
  );
}
