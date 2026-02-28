import { useEffect } from 'react';
import { Link } from 'react-router-dom';
import {
  Activity,
  TrendingUp,
  TrendingDown,
  User,
  LogOut,
  ChevronDown,
  Wifi,
  WifiOff,
} from 'lucide-react';
import { useAuthStore } from '@/stores/auth';
import { useMarketDataStore } from '@/stores/market-data';

export default function TopBar() {
  const { user, logout } = useAuthStore();
  const { indices, vix, isMarketOpen, fetchIndices, fetchVIX, checkMarketStatus } = useMarketDataStore();

  useEffect(() => {
    fetchIndices();
    fetchVIX();
    checkMarketStatus();
    const interval = setInterval(() => {
      fetchIndices();
      fetchVIX();
      checkMarketStatus();
    }, 60_000);
    return () => clearInterval(interval);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const nifty = indices.find((i) => i.name === 'NIFTY 50');
  const bankNifty = indices.find((i) => i.name === 'NIFTY BANK');

  return (
    <header className="fixed top-0 left-0 right-0 z-40 h-14 bg-white/90 backdrop-blur-xl border-b border-slate-200/60 flex items-center px-4 gap-4 shadow-sm">
      {/* Logo */}
      <Link to="/dashboard" className="flex items-center gap-2.5 mr-4 flex-shrink-0 group">
        <div className="w-9 h-9 rounded-xl flex items-center justify-center shadow-lg shadow-[#4a6b52]/20 group-hover:shadow-[#4a6b52]/35 transition-shadow" style={{ background: 'linear-gradient(135deg, #5a7d63, #3d5a47)' }}>
          <svg viewBox="0 0 120 100" className="w-6 h-5" fill="none">
            <path d="M15 65 L60 85 L105 65 L95 70 L60 78 L25 70 Z" fill="#fff" opacity="0.9" />
            <path d="M20 62 L60 80 L100 62 L105 65 L60 85 L15 65 Z" fill="#fff" />
            <path d="M58 20 L58 65 L28 65 Z" fill="#fff" opacity="0.85" />
            <path d="M62 20 L62 65 L92 65 Z" fill="#fff" opacity="0.7" />
            <path d="M72 35 L80 18 L76 22 M80 18 L84 22" stroke="#fff" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round" opacity="0.9" />
          </svg>
        </div>
        <div className="hidden sm:flex flex-col">
          <span className="text-base font-bold leading-tight text-[#3d5a47]">PaperPort</span>
          <span className="text-[9px] font-medium text-stone-400 tracking-widest uppercase -mt-0.5">Paper Trading</span>
        </div>
      </Link>

      {/* Market status */}
      <div className={`flex items-center gap-1.5 px-3 py-1 rounded-full border text-xs flex-shrink-0 ${
        isMarketOpen
          ? 'border-emerald-200 bg-emerald-50'
          : 'border-slate-200 bg-white'
      }`}>
        {isMarketOpen ? (
          <>
            <Wifi className="w-3 h-3 text-emerald-600" />
            <span className="text-emerald-700 font-semibold">LIVE</span>
          </>
        ) : (
          <>
            <WifiOff className="w-3 h-3 text-slate-400" />
            <span className="text-slate-400 font-medium">CLOSED</span>
          </>
        )}
      </div>

      {/* Index tickers */}
      <div className="hidden lg:flex items-center gap-4 ml-2 overflow-x-auto">
        {nifty && (
          <IndexTicker name="NIFTY" value={nifty.value} change={nifty.change} changePercent={nifty.changePercent} />
        )}
        {bankNifty && (
          <IndexTicker name="BANKNIFTY" value={bankNifty.value} change={bankNifty.change} changePercent={bankNifty.changePercent} />
        )}
        {vix && (
          <div className="flex items-center gap-1.5 text-xs">
            <Activity className="w-3.5 h-3.5 text-amber-500" />
            <span className="text-slate-500 font-medium">VIX</span>
            <span className={`font-mono font-semibold ${vix.value > 20 ? 'text-red-600' : 'text-emerald-600'}`}>
              {vix.value.toFixed(2)}
            </span>
          </div>
        )}
      </div>

      {/* Data freshness */}
      <div className="hidden md:flex items-center gap-1.5 ml-auto mr-4 text-[11px] text-slate-400">
        <div className="w-1.5 h-1.5 rounded-full bg-emerald-500 animate-pulse" />
        <span>Real-time</span>
      </div>

      {/* User menu */}
      <div className="relative group ml-auto md:ml-0 flex-shrink-0">
        <button className="flex items-center gap-2 px-2 py-1.5 rounded-lg hover:bg-slate-100 transition-colors">
          <div className="w-8 h-8 rounded-full flex items-center justify-center text-xs font-bold text-white shadow-sm" style={{ background: 'linear-gradient(135deg, #5a7d63, #3d5a47)' }}>
            {user?.fullName?.charAt(0) || <User className="w-4 h-4" />}
          </div>
          <span className="text-sm text-slate-700 hidden sm:block max-w-[100px] truncate font-medium">{user?.fullName || 'User'}</span>
          <ChevronDown className="w-3.5 h-3.5 text-slate-400 hidden sm:block" />
        </button>

        <div className="absolute right-0 top-full mt-1 w-48 bg-white border border-slate-200 rounded-xl shadow-xl opacity-0 invisible group-hover:opacity-100 group-hover:visible transition-all duration-200">
          <Link to="/settings" className="flex items-center gap-2 px-4 py-2.5 text-sm text-slate-600 hover:bg-slate-50 rounded-t-xl">
            <User className="w-4 h-4" />
            Profile & Settings
          </Link>
          <button
            onClick={logout}
            className="flex items-center gap-2 px-4 py-2.5 text-sm text-red-600 hover:bg-red-50 w-full rounded-b-xl"
          >
            <LogOut className="w-4 h-4" />
            Logout
          </button>
        </div>
      </div>
    </header>
  );
}

function IndexTicker({ name, value, change, changePercent }: { name: string; value: number; change: number; changePercent: number }) {
  const isPositive = change >= 0;
  return (
    <div className="flex items-center gap-1.5 text-xs bg-slate-50 px-2.5 py-1 rounded-lg">
      {isPositive ? (
        <TrendingUp className="w-3.5 h-3.5 text-emerald-600" />
      ) : (
        <TrendingDown className="w-3.5 h-3.5 text-red-600" />
      )}
      <span className="text-slate-500 font-medium">{name}</span>
      <span className="font-mono font-semibold text-slate-800">{value.toLocaleString('en-IN', { maximumFractionDigits: 0 })}</span>
      <span className={`font-mono font-semibold ${isPositive ? 'text-emerald-600' : 'text-red-600'}`}>
        {isPositive ? '+' : ''}{changePercent.toFixed(2)}%
      </span>
    </div>
  );
}
