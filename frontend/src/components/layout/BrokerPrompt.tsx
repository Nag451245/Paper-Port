import { useCallback, useEffect, useRef, useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { PlugZap } from 'lucide-react';
import { brokersApi } from '@/services/api';
import { useAuthStore } from '@/stores/auth';

type State = 'unknown' | 'connected' | 'saved' | 'none';

/**
 * Each account uses its own broker. Until this account's broker is connected
 * for the day, the server gives it no broker data and places no new orders, so
 * say so at the top of every page instead of leaving pages empty.
 */
export default function BrokerPrompt() {
  const token = useAuthStore((s) => s.token);
  const { pathname } = useLocation();
  const [state, setState] = useState<State>('unknown');

  const lastCheck = useRef(0);
  const check = useCallback(async () => {
    // A page can be refused many requests at once; one look is enough.
    if (Date.now() - lastCheck.current < 3_000) return;
    lastCheck.current = Date.now();
    try {
      const { data } = await brokersApi.list();
      const brokers = data?.brokers ?? [];
      setState(brokers.some((b) => b.connected) ? 'connected' : brokers.some((b) => b.saved) ? 'saved' : 'none');
    } catch { /* leave what is shown */ }
  }, []);

  // On sign-in, on every page change, and when the server refuses a request for this reason.
  useEffect(() => {
    if (!token) return;
    const t = setTimeout(check, 0);
    const onRefused = () => { void check(); };
    window.addEventListener('broker-required', onRefused);
    return () => { clearTimeout(t); window.removeEventListener('broker-required', onRefused); };
  }, [token, pathname, check]);

  if (!token || state === 'unknown' || state === 'connected') return null;
  return (
    <div role="alert" className="mb-4 flex flex-wrap items-center gap-3 rounded-xl border border-amber-300 bg-amber-50 px-4 py-3 text-sm text-amber-900">
      <PlugZap className="w-5 h-5 shrink-0 text-amber-600" />
      <div className="flex-1 min-w-[16rem]">
        <p className="font-semibold">{state === 'none' ? 'Connect your own broker to use this account' : 'Log in to your broker for today'}</p>
        <p className="text-xs text-amber-800">
          {state === 'none'
            ? 'Every account uses its own broker login. Until yours is connected there is no live market data, no new orders and no bot trading on this account. Your portfolio and past trades are still shown.'
            : 'Your broker is set up, but today\u2019s session is missing or has expired. Until you log in there is no live market data, no new orders and no bot trading on this account.'}
        </p>
      </div>
      {pathname !== '/settings' && (
        <Link to="/settings" className="px-3 py-1.5 rounded-lg bg-amber-600 text-white text-xs font-semibold hover:bg-amber-500">
          {state === 'none' ? 'Set up a broker' : 'Open Settings to log in'}
        </Link>
      )}
    </div>
  );
}
