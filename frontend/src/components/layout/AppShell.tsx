import { useState } from 'react';
import { Outlet, useLocation } from 'react-router-dom';
import Sidebar from './Sidebar';
import TopBar from './TopBar';
import GuardianAvatar from '@/components/guardian/GuardianAvatar';
import GuardianChatPanel from '@/components/guardian/GuardianChatPanel';
import ThoughtBubble from '@/components/guardian/ThoughtBubble';
import { useGuardianStore } from '@/stores/guardian';

function GuardianPageTracker() {
  const location = useLocation();
  const setPageContext = useGuardianStore((s) => s.setPageContext);
  const page = location.pathname.replace('/', '') || 'dashboard';
  if (useGuardianStore.getState().pageContext !== page) {
    setPageContext(page);
  }
  return null;
}

export default function AppShell() {
  const [sidebarCollapsed, setSidebarCollapsed] = useState(false);

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
      <GuardianAvatar />
      <GuardianChatPanel />
      <ThoughtBubble />
    </div>
  );
}
