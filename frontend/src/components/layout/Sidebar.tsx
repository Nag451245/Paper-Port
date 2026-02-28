import { NavLink } from 'react-router-dom';
import {
  LayoutDashboard,
  Monitor,
  Bot,
  Brain,
  Briefcase,
  FlaskConical,
  BookOpen,
  Settings,
  ChevronLeft,
  ChevronRight,
  Users,
} from 'lucide-react';

const navItems = [
  { to: '/dashboard', icon: LayoutDashboard, label: 'Dashboard', color: 'from-amber-500 to-yellow-500' },
  { to: '/terminal', icon: Monitor, label: 'Trading Terminal', color: 'from-blue-500 to-cyan-500' },
  { to: '/ai-agent', icon: Bot, label: 'AI Agent', color: 'from-emerald-500 to-teal-500' },
  { to: '/bots', icon: Users, label: 'Bot Team', color: 'from-amber-500 to-orange-500' },
  { to: '/intelligence', icon: Brain, label: 'Intelligence', color: 'from-pink-500 to-rose-500' },
  { to: '/portfolio', icon: Briefcase, label: 'Portfolio', color: 'from-indigo-500 to-purple-500' },
  { to: '/backtest', icon: FlaskConical, label: 'Backtest', color: 'from-cyan-500 to-blue-500' },
  { to: '/journal', icon: BookOpen, label: 'Trade Journal', color: 'from-teal-500 to-emerald-500' },
  { to: '/settings', icon: Settings, label: 'Settings', color: 'from-slate-500 to-slate-600' },
];

interface SidebarProps {
  collapsed: boolean;
  onToggle: () => void;
}

export default function Sidebar({ collapsed, onToggle }: SidebarProps) {
  return (
    <>
      {/* Desktop sidebar */}
      <aside
        className={`hidden md:flex flex-col fixed top-14 left-0 bottom-0 z-30 border-r border-slate-200/60 bg-white transition-all duration-300 ${
          collapsed ? 'w-16' : 'w-56'
        }`}
      >
        <nav className="flex-1 py-4 space-y-0.5 overflow-y-auto px-2">
          {navItems.map(({ to, icon: Icon, label, color }) => (
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

      {/* Mobile bottom nav */}
      <nav className="md:hidden fixed bottom-0 left-0 right-0 z-40 bg-white/95 backdrop-blur-xl border-t border-slate-200/60 flex shadow-lg">
        {navItems.slice(0, 5).map(({ to, icon: Icon, label }) => (
          <NavLink
            key={to}
            to={to}
            className={({ isActive }) =>
              `flex-1 flex flex-col items-center gap-0.5 py-2 text-[10px] transition-colors ${
                isActive ? 'text-teal-600 font-semibold' : 'text-slate-400'
              }`
            }
          >
            <Icon className="w-5 h-5" />
            <span>{label}</span>
          </NavLink>
        ))}
      </nav>
    </>
  );
}
