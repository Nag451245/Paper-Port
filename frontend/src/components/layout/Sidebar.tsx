import { useEffect, useState } from 'react';
import { NavLink, useLocation } from 'react-router-dom';
import { useAuthStore } from '@/stores/auth';
import {
  LayoutDashboard,
  Monitor,
  Bot,
  Brain,
  Briefcase,
  FlaskConical,
  History,
  BookOpen,
  Settings,
  ChevronLeft,
  ChevronRight,
  Users,
  Layers,
  Grid3X3,
  BarChart3,
  GraduationCap,
  Rocket,
  Target,
  ShieldAlert,
  Flame,
  LayoutGrid,
  X,
  TrendingUp,
  UserCog, FlaskRound } from 'lucide-react';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', color: 'from-amber-500 to-yellow-500' },
  { to: '/command-center', icon: Target, label: 'Command Center', color: 'from-emerald-500 to-green-500' },
  { to: '/risk-dashboard', icon: ShieldAlert, label: 'Risk Dashboard', color: 'from-red-500 to-orange-500' },
  { to: '/terminal', icon: Monitor, label: 'Trading Terminal', color: 'from-blue-500 to-cyan-500' },
  { to: '/movers', icon: TrendingUp, label: 'Market Movers', color: 'from-green-500 to-emerald-500' },
  { to: '/ai-agent', icon: Bot, label: 'AI Agent', color: 'from-emerald-500 to-teal-500' },
  { to: '/bots', icon: Users, label: 'Bot Team', color: 'from-amber-500 to-orange-500' },
  { to: '/intelligence', icon: Brain, label: 'Market Intel', color: 'from-pink-500 to-rose-500' },
  { to: '/portfolio', icon: Briefcase, label: 'Portfolio', color: 'from-indigo-500 to-purple-500' },
  { to: '/heatmap', icon: Flame, label: 'Heat Map', color: 'from-amber-500 to-orange-500' },
  { to: '/strategy-builder', icon: Layers, label: 'Strategy Builder', color: 'from-violet-500 to-purple-500' },
  { to: '/options-lab', icon: FlaskRound, label: 'Options Lab', color: 'from-indigo-500 to-sky-500' },
  { to: '/option-chain', icon: Grid3X3, label: 'Option Chain', color: 'from-sky-500 to-blue-500' },
  { to: '/fno-analytics', icon: BarChart3, label: 'F&O Analytics', color: 'from-teal-500 to-cyan-500' },
  { to: '/learning', icon: GraduationCap, label: 'Learning AI', color: 'from-fuchsia-500 to-pink-500' },
  { to: '/edge-lab', icon: Rocket, label: 'Edge Lab', color: 'from-orange-500 to-red-500' },
  { to: '/backtest', icon: FlaskConical, label: 'Backtest', color: 'from-cyan-500 to-blue-500' },
  { to: '/replay', icon: History, label: 'Replay Lab', color: 'from-sky-500 to-indigo-500' },
  { to: '/journal', icon: BookOpen, label: 'Trade Journal', color: 'from-teal-500 to-emerald-500' },
  { to: '/settings', icon: Settings, label: 'Settings', color: 'from-slate-500 to-slate-600' },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

/** The administrator also sees Admin (user approvals). The server enforces it either way. */
const ADMIN_ITEM = { to: '/admin', icon: UserCog, label: 'Admin · Users', color: 'from-slate-600 to-slate-800' };
function useNavItems() {
  const isAdmin = useAuthStore((s) => s.user?.role === 'ADMIN');
  return isAdmin ? [...navItems, ADMIN_ITEM] : navItems;
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  const items = useNavItems();
  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden sidenav:flex flex-col fixed top-14 left-0 bottom-0 z-30 border-r border-slate-200/60 bg-white transition-all duration-300 ${
          collapsed ? 'w-16' : 'w-56'
        }`}
      >
        <nav className="flex-1 py-4 space-y-0.5 overflow-y-auto px-2">
          {items.map(({ to, icon: Icon, label, color }) => (
            <NavLink
              key={to}
              to={to}
              className={({ isActive }) =>
                `flex items-center gap-3 px-3 py-2.5 rounded-xl text-sm font-medium transition-all duration-200 ${
                  isActive
                    ? 'bg-gradient-to-r ' + color + ' text-white shadow-md shadow-teal-500/15'
                    : 'text-slate-500 hover:bg-slate-50 hover:text-slate-700'
                } ${collapsed ? 'justify-center px-2' : ''}`
              }
              title={collapsed ? label : undefined}
            >
              <Icon className="w-5 h-5 flex-shrink-0" />
              {!collapsed && <span>{label}</span>}
            </NavLink>
          ))}
        </nav>

        <button
          onClick={onToggle}
          className="flex items-center justify-center py-3 border-t border-slate-200/60 text-slate-400 hover:text-[#4a6b52] hover:bg-emerald-50/50 transition-colors"
        >
          {collapsed ? <ChevronRight className="w-4 h-4" /> : <ChevronLeft className="w-4 h-4" />}
        </button>
      </aside>

      <MobileNav />
    </>
  );
}

/** The four pages a phone gets one tap away; everything else is under "More". */
const MOBILE_PRIMARY: { to: string; short: string }[] = [
  { to: '/dashboard', short: 'Home' },
  { to: '/terminal', short: 'Trade' },
  { to: '/portfolio', short: 'Portfolio' },
  { to: '/option-chain', short: 'Options' },
];

function MobileNav() {
  const items = useNavItems();
  const [open, setOpen] = useState(false);
  const location = useLocation();
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [open]);

  const primary = MOBILE_PRIMARY.map((m) => ({ ...navItems.find((n) => n.to === m.to)!, short: m.short }));
  const inMore = !MOBILE_PRIMARY.some((m) => location.pathname.startsWith(m.to));

  return (
    <>
      {/* Bottom bar: phones only */}
      <nav
        className="sidenav:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-xl border-t border-slate-200/60 flex shadow-lg"
        style={{ paddingBottom: 'env(safe-area-inset-bottom, 0px)' }}
      >
        {primary.map(({ to, icon: Icon, short }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center gap-0.5 py-2 min-h-[56px] justify-center text-[11px] transition-colors ${
                isActive ? 'text-teal-600 font-semibold' : 'text-slate-500'
              }`
            }
          >
            <Icon className="w-5 h-5" />
            <span>{short}</span>
          </NavLink>
        ))}
        <button
          onClick={() => setOpen(true)}
          aria-label="All pages"
          className={`flex-1 flex flex-col items-center gap-0.5 py-2 min-h-[56px] justify-center text-[11px] ${inMore ? 'text-teal-600 font-semibold' : 'text-slate-500'}`}
        >
          <LayoutGrid className="w-5 h-5" />
          <span>More</span>
        </button>
      </nav>

      {/* Every page, as a sheet from the bottom */}
      {open && (
        // Above the floating assistant (z-index 9999), which would otherwise sit on the tiles.
        <div className="sidenav:hidden fixed inset-0" style={{ zIndex: 10000 }} role="dialog" aria-modal="true" aria-label="All pages">
          <button className="absolute inset-0 bg-slate-900/40" aria-label="Close" onClick={() => setOpen(false)} />
          <div
            className="absolute bottom-0 left-0 right-0 bg-white rounded-t-2xl shadow-2xl max-h-[80dvh] overflow-y-auto"
            style={{ paddingBottom: 'calc(env(safe-area-inset-bottom, 0px) + 12px)' }}
          >
            <div className="sticky top-0 bg-white flex items-center justify-between px-4 pt-4 pb-2">
              <p className="text-sm font-semibold text-slate-800">All pages</p>
              <button onClick={() => setOpen(false)} className="p-2 -m-2 text-slate-400 hover:text-slate-600" aria-label="Close">
                <X className="w-5 h-5" />
              </button>
            </div>
            <div className="grid grid-cols-3 gap-2 px-4 pb-2">
              {items.map(({ to, icon: Icon, label, color }) => (
                <NavLink
                  key={to}
                  to={to}
                  onClick={() => setOpen(false)}
                  className={({ isActive }) =>
                    `flex flex-col items-center gap-1.5 rounded-xl p-3 text-center text-[11px] font-medium leading-tight transition-colors ${
                      isActive ? 'bg-gradient-to-br ' + color + ' text-white' : 'bg-slate-50 text-slate-600 active:bg-slate-100'
                    }`
                  }
                >
                  <Icon className="w-5 h-5" />
                  <span>{label}</span>
                </NavLink>
              ))}
            </div>
          </div>
        </div>
      )}
    </>
  );
}
