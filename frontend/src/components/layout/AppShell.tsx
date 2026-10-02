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
  // Icons-only on tablets and small laptops, so the page keeps its width; the
  // user's own choice wins once they toggle it.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => {
    try {
      const saved = localStorage.getItem('sidebar.collapsed');
      if (saved !== null) return saved === '1';
    } catch { /* private mode */ }
    return window.innerWidth < 1280;
  });
  const toggleSidebar = () => setSidebarCollapsed((c) => {
    try { localStorage.setItem('sidebar.collapsed', c ? '0' : '1'); } catch { /* private mode */ }
    return !c;
  });

  return (
    <div className="min-h-screen bg-gradient-to-br from-slate-50 via-blue-50/30 to-indigo-50/20 text-slate-900">
      <TopBar />
      <Sidebar
        collapsed={sidebarCollapsed}
        onToggle={toggleSidebar}
      />
      <main
        className={`transition-all duration-300 ${
          sidebarCollapsed ? 'sidenav:pl-16' : 'sidenav:pl-56'
        }`}
        style={{ paddingTop: 'calc(3.5rem + env(safe-area-inset-top, 0px))', paddingBottom: 'var(--mobile-nav-space)' }}
      >
        <div className="p-3 sm:p-4 lg:p-6 max-w-[1920px] mx-auto">
          <Outlet />
        </div>
      </main>

      <GuardianPageTracker />
      <SafeGuardianWrapper />
    </div>
  );
}
