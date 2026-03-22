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

  useEffect(() => {
    console.log('[AppShell] SafeGuardianWrapper mounted');
  }, []);

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
    console.log('[AppShell] GuardianWrapperInner mounted — all Guardian chunks loaded');
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

  useEffect(() => {
    console.log('[AppShell] Mounted');
  }, []);

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

      {/* Inline test avatar — if this shows, the layout supports fixed positioning */}
      <div
        id="chitti-test-beacon"
        style={{
          position: 'fixed',
          bottom: 24,
          right: 24,
          zIndex: 99999,
          width: 60,
          height: 60,
          borderRadius: '50%',
          background: 'linear-gradient(135deg, #0d9488, #2563eb)',
          boxShadow: '0 0 20px rgba(45,212,191,0.6), 0 4px 12px rgba(0,0,0,0.3)',
          display: 'flex',
          alignItems: 'center',
          justifyContent: 'center',
          cursor: 'pointer',
          border: '2px solid rgba(255,255,255,0.3)',
          animation: 'guardian-breathe 3s ease-in-out infinite',
        }}
      >
        <svg viewBox="0 0 56 56" style={{ width: 44, height: 44, overflow: 'visible' }}>
          <circle cx="28" cy="20" r="11" fill="#fcd9b6" />
          <ellipse cx="28" cy="12" rx="13" ry="7" fill="#4a3728" />
          <path d="M19 20 Q23 16 27 20" stroke="#1e293b" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <path d="M29 20 Q33 16 37 20" stroke="#1e293b" strokeWidth="1.8" fill="none" strokeLinecap="round" />
          <path d="M24 26 Q28 29 32 26" stroke="#1e293b" strokeWidth="1.2" fill="none" strokeLinecap="round" />
          <path d="M19 33 L15 52 L41 52 L37 33 Q28 37 19 33Z" fill="#1e293b" />
        </svg>
      </div>
      <style dangerouslySetInnerHTML={{ __html: `
        @keyframes guardian-breathe {
          0%, 100% { transform: scale(1); }
          50% { transform: scale(1.06); }
        }
      ` }} />

      <SafeGuardianWrapper />
    </div>
  );
}
