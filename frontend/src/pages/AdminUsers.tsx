import { useCallback, useEffect, useState } from 'react';
import { Navigate } from 'react-router-dom';
import { Loader2, UserCog, Check, Ban, RotateCcw, Trash2 } from 'lucide-react';
import { adminApi, type AdminUser } from '@/services/api';
import { useAuthStore } from '@/stores/auth';

const STATUS = {
  PENDING: { label: 'Waiting for approval', cls: 'bg-amber-50 text-amber-700 border-amber-200' },
  ACTIVE: { label: 'Active', cls: 'bg-emerald-50 text-emerald-700 border-emerald-200' },
  BLOCKED: { label: 'Blocked', cls: 'bg-red-50 text-red-700 border-red-200' },
} as const;

const FILTERS = ['ALL', 'PENDING', 'ACTIVE', 'BLOCKED'] as const;
type Filter = typeof FILTERS[number];

const errorText = (err: unknown, fallback: string) =>
  (err as { response?: { data?: { error?: string } } })?.response?.data?.error ?? fallback;

const btn = 'inline-flex items-center gap-1 rounded-lg px-2.5 py-1.5 text-xs font-medium disabled:opacity-40';

/** Administrator only: approve sign-ups, block / unblock / delete users. The server enforces this too. */
export default function AdminUsers() {
  const me = useAuthStore((s) => s.user);
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [filter, setFilter] = useState<Filter>('ALL');

  const load = useCallback(async () => {
    try {
      const { data } = await adminApi.users();
      setUsers(data.users);
      setError(null);
    } catch (err) {
      setError(errorText(err, 'Could not load users.'));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { void load(); }, [load]);

  if (me && me.role !== 'ADMIN') return <Navigate to="/dashboard" replace />;

  const act = async (u: AdminUser, action: 'approve' | 'block' | 'unblock' | 'remove') => {
    if (action === 'remove' && !window.confirm(`Delete ${u.fullName} (${u.email}) and all their data? This cannot be undone.`)) return;
    if (action === 'block' && !window.confirm(`Block ${u.email}? They are signed out at once and their bots stop.`)) return;
    setBusy(u.id);
    try {
      await adminApi[action](u.id);
      await load();
    } catch (err) {
      setError(errorText(err, 'That did not work.'));
    } finally {
      setBusy(null);
    }
  };

  const counts = Object.fromEntries(FILTERS.map((f) => [f, f === 'ALL' ? users.length : users.filter((u) => u.status === f).length]));
  const shown = filter === 'ALL' ? users : users.filter((u) => u.status === filter);

  return (
    <div className="space-y-4">
      <div>
        <h1 className="text-xl font-bold text-slate-800 flex items-center gap-2"><UserCog className="w-5 h-5 text-indigo-600" /> Users</h1>
        <p className="text-sm text-slate-500 mt-0.5">New sign-ups wait here until you approve them. Blocked users are signed out at once and their bots stop.</p>
      </div>

      <div className="flex flex-wrap gap-1.5">
        {FILTERS.map((f) => (
          <button key={f} onClick={() => setFilter(f)}
            className={`px-3 py-1.5 rounded-lg text-xs font-medium ${filter === f ? 'bg-indigo-600 text-white' : 'bg-slate-100 text-slate-600 hover:bg-slate-200'}`}>
            {f === 'ALL' ? 'All' : STATUS[f].label} ({counts[f]})
          </button>
        ))}
      </div>

      {error && <p className="text-xs text-red-600 bg-red-50 border border-red-200 rounded-lg px-3 py-2">{error}</p>}

      <div className="rounded-2xl border border-slate-200 bg-white shadow-sm overflow-hidden">
        {loading ? (
          <div className="flex justify-center py-16"><Loader2 className="w-6 h-6 animate-spin text-slate-400" /></div>
        ) : !shown.length ? (
          <p className="text-center text-sm text-slate-400 py-16">No users here.</p>
        ) : (
          <ul className="divide-y divide-slate-100">
            {shown.map((u) => {
              const s = STATUS[u.status] ?? STATUS.ACTIVE;
              const self = u.role === 'ADMIN';
              return (
                <li key={u.id} className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3">
                  <div className="min-w-0 flex-1">
                    <p className="text-sm font-semibold text-slate-800 truncate">{u.fullName}{self && <span className="ml-2 text-[10px] font-medium text-indigo-600">ADMIN</span>}</p>
                    <p className="text-xs text-slate-500 truncate">{u.email} · joined {new Date(u.createdAt).toLocaleDateString('en-IN', { dateStyle: 'medium' })}</p>
                  </div>
                  <span className={`text-[11px] border rounded-full px-2 py-0.5 ${s.cls}`}>{s.label}</span>
                  {!self && (
                    <div className="flex gap-1.5">
                      {u.status === 'PENDING' && (
                        <button disabled={busy === u.id} onClick={() => act(u, 'approve')} className={`${btn} bg-emerald-600 text-white hover:bg-emerald-500`}><Check className="w-3.5 h-3.5" /> Approve</button>
                      )}
                      {u.status === 'BLOCKED' ? (
                        <button disabled={busy === u.id} onClick={() => act(u, 'unblock')} className={`${btn} bg-slate-100 text-slate-700 hover:bg-slate-200`}><RotateCcw className="w-3.5 h-3.5" /> Unblock</button>
                      ) : (
                        <button disabled={busy === u.id} onClick={() => act(u, 'block')} className={`${btn} bg-amber-50 text-amber-700 hover:bg-amber-100`}><Ban className="w-3.5 h-3.5" /> Block</button>
                      )}
                      <button disabled={busy === u.id} onClick={() => act(u, 'remove')} className={`${btn} bg-red-50 text-red-700 hover:bg-red-100`}><Trash2 className="w-3.5 h-3.5" /> Delete</button>
                    </div>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </div>
    </div>
  );
}
